"use strict";

/**
 * Move the pictures the editor asked to move, and catch the site up.
 *
 * The browser can rename and move files under `source/images`. What it CANNOT
 * do is carry them: Gitea's contents API takes a file as base64 in a JSON body,
 * so moving a folder of two hundred photographs would mean downloading and
 * re-uploading every one of them through the tab — hundreds of megabytes, each
 * a third larger for being base64, for a commit that changes no bytes at all.
 * Git already stores one blob however many paths point at it.
 *
 * So a save commits the REQUEST and nothing else: `source/_data/image-moves.json`,
 * a list of `{ from, to }`, a few hundred bytes however large the move is. The
 * build is where the files actually move — it has the whole tree on disk, where
 * a rename costs nothing — and the deploy commits the result back. That commit
 * is the one git records as R100.
 *
 * The editor rewrites the addresses in the post it had open, because that post
 * is in front of it. The other forty are rewritten here.
 *
 * ── What is on disk decides, every time ─────────────────────────────────────
 *
 * The note says what should be true, so each pair is checked against what IS:
 *
 *   waiting   at `from`, nothing at `to` — the ordinary case. Move it, then
 *             apply everything.
 *   settled   already at `to` and gone from `from` — a previous build did it,
 *             or somebody moved it by hand. Apply everything.
 *   doubled   at BOTH. Identical bytes is a move that was interrupted after the
 *             copy: drop `from` and carry on. DIFFERENT bytes is a collision,
 *             and overwriting would destroy a picture — nothing is touched, the
 *             note is kept, and the build says so on every run until it is
 *             fixed by hand.
 *   vanished  at neither — deleted after the move was staged. Rewrite to the
 *             author's intent and drop the note; the orphan pass in
 *             img-optimizer clears the cache.
 *
 * An earlier version simply trusted the note, rewrote every reference and
 * re-keyed the AVIF cache without asking whether the file had arrived. When it
 * had not, the site pointed at a path with no file, no route and no transcode,
 * while the picture sat untouched at its old address.
 *
 * ── Why the AVIF cache travels with the file ────────────────────────────────
 *
 * A renamed image is a new cache key, so without this the next build re-encodes
 * it — and a CI runner never starts an encoder, which would publish that one
 * picture uncompressed at its original path until somebody built locally. The
 * product is renamed alongside its source and its index entry re-keyed, so a
 * rename costs nothing and changes nothing about what gets published.
 *
 * ── When this runs, and why it is early ─────────────────────────────────────
 *
 * At `after_init`, from scripts/events/build-pipeline.js — the first moment a
 * theme script can act, and still before `hexo.load()` walks `source/`. So the
 * posts and everything in `source/_data` are read off disk AFTER the sweep and
 * are simply correct.
 *
 * `_config.yml` and `_config.<theme>.yml` are the exception: Hexo parses those
 * while it initialises, before any filter exists. Rewriting them on disk is
 * therefore not enough — the copy in `hexo.config` is already stale — so
 * `rewriteDeep` catches that one up in memory as well. A cover, an avatar or an
 * album named in a config file used to stay at its old address for exactly one
 * build: the build that had just moved the file it named.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { BuildIndex } = require("./build-index");

const JOURNAL = "_data/image-moves.json";
const INDEX_FILE = ".images.json";
const SCAN = [".md", ".yml", ".yaml", ".json"];
const CONFIG = /^_config([.-][^/\\]+)?\.ya?ml$/i;
const BITMAP = /\.(png|jpe?g|gif|webp)$/i;

/** A directory path with no trailing separator, whoever handed it over. */
function trim(dir) {
  const value = String(dir || "");
  return value.length > 1 ? value.replace(/[\\/]+$/, "") : value;
}

/** `source/images/a/b.png` → `images/a/b.png`, which is what the cache keys on. */
function cacheKey(repoPath) {
  return String(repoPath).replace(/^source\//, "");
}

/** Where the build keeps this image's compressed product. */
function productOf(key) {
  return BITMAP.test(key) ? "build/" + key.replace(/\.[^.]+$/, ".avif") : "build/" + key;
}

/**
 * The three ways one picture is spelled, longest first.
 *
 * `/images/a.png` is what a post writes, `source/images/a.png` is what the
 * repository calls it, and the bare `images/a.png` turns up in config files
 * where the leading slash was left off. Applying them longest-first means the
 * shorter spellings only ever see what the longer ones did not already claim.
 */
function spellings(repoPath) {
  const key = cacheKey(repoPath);
  return ["source/" + key, "/" + key, key];
}

// A path abutting one of these is part of a longer token: the tail of a CDN
// URL, or a name that merely starts the same way.
const WORD = /[A-Za-z0-9_%~+\-]/;

function replaceOne(text, from, to, bare) {
  let out = "";
  let at = 0;
  for (;;) {
    const hit = text.indexOf(from, at);
    if (hit < 0) return out + text.slice(at);

    const before = hit > 0 ? text[hit - 1] : "";
    const end = hit + from.length;
    const after = text[end] || "";
    // A trailing dot is a full stop when a space follows it and a second
    // extension when a letter does — `a.png.bak` is a different file.
    const extended = after === "." && WORD.test(text[end + 1] || "");
    // A bare `images/a.png` preceded by a slash is the tail of a longer path
    // that the slash spelling has already had its chance at.
    const ok =
      (!before || (!WORD.test(before) && !(bare && before === "/"))) &&
      (!after || (!WORD.test(after) && !extended));

    out += text.slice(at, hit) + (ok ? to : from);
    at = hit + from.length;
  }
}

/** Rewrite every spelling of every applied pair, in order. */
function rewriteWith(pairs, text) {
  let out = text;
  for (const move of pairs) {
    const from = spellings(move.from);
    const to = spellings(move.to);
    for (let i = 0; i < from.length; i++) {
      if (from[i] !== to[i]) out = replaceOne(out, from[i], to[i], i === 2);
    }
  }
  return out;
}

/**
 * The same rewriting, applied to a live object graph — `hexo.config`, whose
 * `theme_config` branch is `_config.<theme>.yml` and is deep-merged into
 * `hexo.theme.config` a moment later. Mutated in place: everything downstream
 * already holds a reference to it.
 */
function rewriteDeep(pairs, value, seen) {
  if (!pairs.length || !value || typeof value !== "object") return 0;
  const visited = seen || new Set();
  if (visited.has(value)) return 0;
  visited.add(value);

  let changed = 0;
  for (const key of Object.keys(value)) {
    const held = value[key];
    if (typeof held === "string") {
      const next = rewriteWith(pairs, held);
      if (next !== held) {
        value[key] = next;
        changed += 1;
      }
    } else if (held && typeof held === "object") {
      changed += rewriteDeep(pairs, held, visited);
    }
  }
  return changed;
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Neither the build cache nor the pictures themselves hold references.
      if (entry.name === "build" || entry.name === "images") continue;
      walk(full, out);
    } else if (SCAN.includes(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/** The site's own configuration files, which name covers, avatars and banners. */
function configs(baseDir) {
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && CONFIG.test(entry.name))
    .map((entry) => path.join(baseDir, entry.name));
}

/* ─── moving the file itself ───────────────────────────────────────────────── */

function digest(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch (e) {
    return null;
  }
}

/** Same bytes at both ends: a move that was interrupted, not a collision. */
function identical(a, b) {
  try {
    if (fs.statSync(a).size !== fs.statSync(b).size) return false;
  } catch (e) {
    return false;
  }
  const one = digest(a);
  return !!one && one === digest(b);
}

function carry(from, to) {
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return true;
  } catch (e) {
    // Across devices `rename` refuses; a copy-then-unlink is the same result.
    try {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
      return true;
    } catch (err) {
      return false;
    }
  }
}

/** A folder a move emptied is a folder git does not have either. */
function pruneEmpty(dirs, sourceDir) {
  for (const start of dirs) {
    let dir = start;
    while (dir.startsWith(sourceDir + path.sep)) {
      let rest;
      try {
        rest = fs.readdirSync(dir);
      } catch (e) {
        break;
      }
      if (rest.length) break;
      try {
        fs.rmdirSync(dir);
      } catch (e) {
        break;
      }
      dir = path.dirname(dir);
    }
  }
}

/**
 * Carry each applied move's cached product across, and re-key its index entry.
 */
function moveCache(sourceDir, applied) {
  const buildDir = path.join(sourceDir, "build");
  if (!fs.existsSync(buildDir)) return 0;

  const index = new BuildIndex(buildDir, INDEX_FILE);
  let carried = 0;

  for (const move of applied) {
    const fromKey = cacheKey(move.from);
    const toKey = cacheKey(move.to);
    if (fromKey === toKey) continue;

    const fromFile = path.join(sourceDir, productOf(fromKey));
    const toFile = path.join(sourceDir, productOf(toKey));
    const entry = index.get(fromKey);

    if (!fs.existsSync(toFile)) {
      if (!fs.existsSync(fromFile)) continue;
      if (!carry(fromFile, toFile)) continue;
      carried += 1;
    }

    // Only now, with a product sitting at the new key, is it safe to say the
    // index has one. Re-keying first is how the cache came to promise a file
    // that the very next orphan pass deleted.
    if (!entry) continue;
    index.entries[toKey] = Object.assign({}, entry, { out: productOf(toKey) });
    delete index.entries[fromKey];
    index.dirty = true;
  }

  index.flush();
  return carried;
}

function readJournal(file) {
  let moves;
  try {
    moves = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
  if (!Array.isArray(moves)) return [];
  return moves.filter((m) => m && m.from && m.to && m.from !== m.to);
}

/**
 * Apply `source/_data/image-moves.json`: move the files, then the references.
 *
 * @param {object} opts { baseDir, sourceDir, log }
 * @returns {object|null} null when there was no note at all; otherwise
 *   `{ applied, held, moved, touched, carried }` where `applied` is the pairs
 *   whose references were rewritten.
 */
function applyMoves(opts) {
  // Hexo's `base_dir` and `source_dir` end in a separator and nobody else's do.
  // The containment test below compares assembled paths, and one trailing
  // backslash made every pair look like it pointed outside the source tree — so
  // the note was cleared having applied nothing, which is silently the worst
  // possible outcome: the file has moved and the site still names the old path.
  const baseDir = trim(opts.baseDir);
  const sourceDir = trim(opts.sourceDir);
  const log = opts.log || { info() {}, warn() {} };

  const journal = path.join(sourceDir, JOURNAL);
  if (!fs.existsSync(journal)) return null;

  const pairs = readJournal(journal);
  if (pairs === null) {
    log.warn(`[image-moves] ${JOURNAL} is not readable JSON; leaving it alone.`);
    return null;
  }
  if (!pairs.length) {
    fs.unlinkSync(journal);
    return { applied: [], held: [], moved: 0, touched: 0, carried: 0 };
  }

  // `from`/`to` are repository paths. Anything that resolves outside the source
  // tree is not this build's business, whatever the note says.
  const inside = (repoPath) => {
    const abs = path.resolve(baseDir, repoPath);
    return abs === sourceDir || abs.startsWith(sourceDir + path.sep) ? abs : null;
  };

  const applied = [];
  const held = [];
  const clashes = [];
  const emptied = new Set();
  let moved = 0;

  for (const move of pairs) {
    const from = inside(move.from);
    const to = inside(move.to);
    if (!from || !to) continue;

    const pair = { from: move.from, to: move.to };
    const left = fs.existsSync(from);
    const landed = fs.existsSync(to);

    if (!left && !landed) {
      applied.push(Object.assign(pair, { gone: true }));
      continue;
    }
    if (!left) {
      applied.push(pair);
      continue;
    }
    if (landed) {
      // Both ends exist. Same bytes is an interrupted move; anything else is a
      // picture that would be destroyed by finishing this one.
      if (!identical(from, to)) {
        held.push(move);
        clashes.push(move);
        continue;
      }
      try {
        fs.unlinkSync(from);
        emptied.add(path.dirname(from));
      } catch (e) {
        /* the duplicate stays; the reference is still correct */
      }
      applied.push(pair);
      continue;
    }
    if (!carry(from, to)) {
      held.push(move);
      continue;
    }
    emptied.add(path.dirname(from));
    moved += 1;
    applied.push(pair);
  }

  pruneEmpty(emptied, sourceDir);
  const carried = moveCache(sourceDir, applied.filter((m) => !m.gone));

  let touched = 0;
  if (applied.length) {
    for (const file of walk(sourceDir, []).concat(configs(baseDir))) {
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (e) {
        continue;
      }
      const next = rewriteWith(applied, text);
      if (next === text) continue;
      fs.writeFileSync(file, next);
      touched += 1;
    }
  }

  // What could not be done stays in the note, so the build that can do it is
  // the build that does.
  if (held.length) fs.writeFileSync(journal, JSON.stringify(held, null, 2) + "\n");
  else fs.unlinkSync(journal);

  if (applied.length) {
    log.info(
      `[image-moves] moved ${moved} picture(s), rewrote ${touched} file(s), ` +
        `carried ${carried} cached transcode(s).`
    );
  }
  if (clashes.length) {
    log.warn(
      `[image-moves] ${clashes.length} move(s) would overwrite a DIFFERENT picture and were ` +
        `refused. Nothing was moved or rewritten for them; rename one side by hand:\n` +
        clashes.map((m) => `    ${m.from} -> ${m.to}`).join("\n")
    );
  }
  const stuck = held.length - clashes.length;
  if (stuck > 0) {
    log.warn(`[image-moves] ${stuck} move(s) could not be written to disk; the note is kept.`);
  }

  return { applied, held, moved, touched, carried };
}

module.exports = { applyMoves, rewriteWith, rewriteDeep, JOURNAL };
