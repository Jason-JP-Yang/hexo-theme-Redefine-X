"use strict";

/**
 * Catch the site up with a picture the editor moved.
 *
 * The browser editor can rename and move files under `source/images`, and it
 * rewrites the addresses in the post it had open — but not in the other forty,
 * because finding them would mean pulling the whole site into a browser tab. So
 * it leaves a note instead: `source/_data/image-moves.json`, a list of
 * `{ from, to }` committed alongside the move itself.
 *
 * ── A note is a REQUEST, not a fact ─────────────────────────────────────────
 *
 * This is the whole of what was wrong before. The sweep trusted the note: it
 * rewrote every reference to the new path and re-keyed the AVIF cache without
 * ever asking whether the file had actually arrived there. When the rename did
 * not land — a Gitea that would not take a `from_path` rename, a commit that
 * was rejected after the note had already been written — the build produced a
 * site whose posts all pointed at a path with no file, no route and no cached
 * transcode, while the picture sat untouched at its old address. Renaming one
 * picture broke it everywhere.
 *
 * So every pair is now classified against what is ON DISK:
 *
 *   settled   the file is at `to` and gone from `from` — apply everything.
 *   copied    it is at BOTH — rewrite to `to`, but leave `from` its cache.
 *   pending   it is still at `from` — the move never happened. Touch nothing
 *             and KEEP the note, so the build that does carry the rename is
 *             the build that sweeps for it.
 *   vanished  it is at neither — deleted after the move was staged. Rewrite to
 *             the author's intent and drop the note; the orphan pass in
 *             img-optimizer clears the cache.
 *
 * ── Why the AVIF cache travels with the file ────────────────────────────────
 *
 * A renamed image is a new cache key, so without this the next build re-encodes
 * it — and a CI runner never starts an encoder, which would publish that one
 * picture uncompressed at its original path until somebody built locally. The
 * product is renamed alongside its source and its index entry re-keyed, so a
 * rename costs nothing and changes nothing about what gets published.
 *
 * ── Why this runs BEFORE Hexo, not inside it ────────────────────────────────
 *
 * `_config.yml`, `_config.<theme>.yml` and everything in `source/_data` are
 * parsed while Hexo initialises and loads — long before any filter can run. A
 * sweep inside the build therefore rewrote those files on disk and then
 * rendered the site from the copies already in memory, so a cover, an avatar or
 * an album named in one of them stayed at the old address for exactly one
 * build: the build that had just deleted the file it named.
 *
 * `bin/image-moves.js` runs this before `hexo generate` is started at all, and
 * `scripts/events/image-moves.js` keeps a copy of the call at `before_generate`
 * for anyone who runs the generator directly. Whichever gets there first, the
 * other finds no note and costs one `existsSync`.
 */

const fs = require("fs");
const path = require("path");
const { BuildIndex } = require("./build-index");

const JOURNAL = "_data/image-moves.json";
const INDEX_FILE = ".images.json";
const SCAN = [".md", ".yml", ".yaml", ".json"];
const CONFIG = /^_config([.-][^/\\]+)?\.ya?ml$/i;
const BITMAP = /\.(png|jpe?g|gif|webp)$/i;

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

/**
 * Carry each applied move's cached product across, and re-key its index entry.
 *
 * `copy` is the pair whose source is still at both ends: its product is copied
 * rather than renamed and the old key kept, because an image that is still
 * there still needs the transcode the index promises for it.
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
      try {
        fs.mkdirSync(path.dirname(toFile), { recursive: true });
        if (move.copy) fs.copyFileSync(fromFile, toFile);
        else fs.renameSync(fromFile, toFile);
        carried += 1;
      } catch (e) {
        continue;
      }
    }

    // Only now, with a product sitting at the new key, is it safe to say the
    // index has one. Re-keying first is how the cache came to promise a file
    // that the very next orphan pass deleted.
    if (!entry) continue;
    index.entries[toKey] = Object.assign({}, entry, { out: productOf(toKey) });
    if (!move.copy) delete index.entries[fromKey];
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
 * Apply `source/_data/image-moves.json`, as far as the working tree allows.
 *
 * @param {object} opts { baseDir, sourceDir, log }
 * @returns {object|null} null when there was no note at all; otherwise
 *   `{ applied, held, touched, carried }` where `applied` is the pairs whose
 *   references were rewritten — which is what the in-build copy needs to catch
 *   up the posts it has already read.
 */
function applyMoves(opts) {
  const baseDir = opts.baseDir;
  const sourceDir = opts.sourceDir;
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
    return { applied: [], held: [], touched: 0, carried: 0 };
  }

  // `from`/`to` are repository paths. Anything that resolves outside the source
  // tree is not this build's business, whatever the note says.
  const inside = (repoPath) => {
    const abs = path.resolve(baseDir, repoPath);
    return abs === sourceDir || abs.startsWith(sourceDir + path.sep) ? abs : null;
  };

  const applied = [];
  const held = [];

  for (const move of pairs) {
    const from = inside(move.from);
    const to = inside(move.to);
    if (!from || !to) continue;

    const left = fs.existsSync(from);
    const landed = fs.existsSync(to);

    if (landed && !left) applied.push({ from: move.from, to: move.to });
    else if (landed && left) applied.push({ from: move.from, to: move.to, copy: true });
    else if (left) held.push(move);
    else applied.push({ from: move.from, to: move.to, gone: true });
  }

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

  // What is still waiting on a rename that never landed stays in the note, so
  // the build that finally carries it is the build that sweeps for it.
  if (held.length) fs.writeFileSync(journal, JSON.stringify(held, null, 2) + "\n");
  else fs.unlinkSync(journal);

  if (applied.length) {
    log.info(
      `[image-moves] applied ${applied.length} move(s) to ${touched} file(s), ` +
        `carried ${carried} cached transcode(s).`
    );
  }
  if (held.length) {
    log.warn(
      `[image-moves] ${held.length} move(s) are still at their old path — the rename was not ` +
        `committed. Nothing was rewritten for them; the note is kept for the next build:\n` +
        held.map((m) => `    ${m.from} -> ${m.to}`).join("\n")
    );
  }

  return { applied, held, touched, carried };
}

module.exports = { applyMoves, rewriteWith, JOURNAL };
