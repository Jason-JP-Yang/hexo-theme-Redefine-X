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
 * This reads that note on the next build, rewrites every reference it finds,
 * and DELETES the note — so the sweep happens exactly once per move, and a
 * build with nothing to do costs one `existsSync`.
 *
 * ── Everywhere a picture can be named ───────────────────────────────────────
 *
 * Posts and pages, the data files behind friend links and the photo albums, the
 * masonry album definitions, the site's own `_config.yml` and the theme config
 * beside it — a cover, an avatar, a banner or a favicon is an address like any
 * other, and missing one leaves a broken picture nobody looks at until months
 * later. The pictures themselves and the build cache hold no references and are
 * skipped; the cache is MOVED instead, below.
 *
 * ── Why the AVIF cache travels with the file ────────────────────────────────
 *
 * A renamed image is a new cache key, so without this the next build re-encodes
 * it — and a CI runner never starts an encoder, which would publish that one
 * picture uncompressed at its original path until somebody built locally. The
 * product is renamed alongside its source and its index entry re-keyed, so a
 * rename costs nothing and changes nothing about what gets published.
 *
 * The rewrite lands in the working tree, which means the build that performs it
 * is also the build that has to commit it: `.github/workflows/deploy.yml`
 * returns `source/` along with the keyring and the artifact pointer. Pulling and
 * generating locally does the same job, and the same commit closes it.
 */

const fs = require("fs");
const path = require("path");
const { BuildIndex } = require("../lib/build-index");

const JOURNAL = "_data/image-moves.json";
const INDEX_FILE = ".images.json";
const SCAN = [".md", ".yml", ".yaml", ".json"];
const CONFIG = /^_config([.-][^/\\]+)?\.ya?ml$/i;
const BITMAP = /\.(png|jpe?g|gif|webp)$/i;

/** `source/images/a/b.png` → `/images/a/b.png`, which is what a post writes. */
function address(repoPath) {
  return "/" + String(repoPath).replace(/^source\//, "");
}

/** `source/images/a/b.png` → `images/a/b.png`, which is what the cache keys on. */
function cacheKey(repoPath) {
  return String(repoPath).replace(/^source\//, "");
}

/** Where the build keeps this image's compressed product. */
function productOf(key) {
  return BITMAP.test(key) ? "build/" + key.replace(/\.[^.]+$/, ".avif") : "build/" + key;
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

/** The pairs this build is applying, so the posts already in memory get them too. */
let live = [];

function rewrite(text) {
  let out = text;
  for (const move of live) out = out.split(move.from).join(move.to);
  return out;
}

/** Rename each moved image's cached product and re-key its index entry. */
function moveCache(sourceDir, moves) {
  const buildDir = path.join(sourceDir, "build");
  if (!fs.existsSync(buildDir)) return 0;

  const index = new BuildIndex(buildDir, INDEX_FILE);
  let carried = 0;

  for (const move of moves) {
    const fromKey = cacheKey(move.from);
    const toKey = cacheKey(move.to);
    if (fromKey === toKey) continue;

    const fromFile = path.join(sourceDir, productOf(fromKey));
    const toFile = path.join(sourceDir, productOf(toKey));
    try {
      if (!fs.existsSync(fromFile) || fs.existsSync(toFile)) continue;
      fs.mkdirSync(path.dirname(toFile), { recursive: true });
      fs.renameSync(fromFile, toFile);
      carried += 1;
    } catch (e) {
      continue;
    }

    const entry = index.get(fromKey);
    if (!entry) continue;
    index.entries[toKey] = Object.assign({}, entry, { out: productOf(toKey) });
    delete index.entries[fromKey];
    index.dirty = true;
  }

  index.flush();
  return carried;
}

hexo.extend.filter.register("before_generate", function () {
  const sourceDir = this.source_dir;
  const journal = path.join(sourceDir, JOURNAL);
  if (!fs.existsSync(journal)) return;

  let moves;
  try {
    moves = JSON.parse(fs.readFileSync(journal, "utf8"));
  } catch (e) {
    this.log.warn(`[image-moves] ${JOURNAL} is not readable JSON; leaving it alone.`);
    return;
  }
  if (!Array.isArray(moves)) moves = [];

  const pairs = moves.filter((m) => m && m.from && m.to && m.from !== m.to);
  if (!pairs.length) {
    fs.unlinkSync(journal);
    return;
  }

  live = pairs.map((m) => ({ from: address(m.from), to: address(m.to) })).filter((m) => m.from !== m.to);
  const carried = moveCache(sourceDir, pairs);

  let touched = 0;
  for (const file of walk(sourceDir, []).concat(configs(this.base_dir))) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      continue;
    }
    const next = rewrite(text);
    if (next === text) continue;
    fs.writeFileSync(file, next);
    touched += 1;
  }

  fs.unlinkSync(journal);
  this.log.info(
    `[image-moves] applied ${live.length} move(s) to ${touched} file(s), carried ${carried} cached transcode(s), cleared ${JOURNAL}.`
  );
}, 5);

/**
 * The posts for THIS build were read off disk before the rewrite above ran, so
 * they still hold the old addresses. Applying the same pairs to the content on
 * its way to the renderer means the build that performs the move is already
 * correct, rather than the one after it.
 */
const FRONT_KEYS = ["cover", "thumbnail", "banner", "top_img", "image"];

hexo.extend.filter.register("before_post_render", function (data) {
  if (!live.length) return data;
  if (typeof data.content === "string") data.content = rewrite(data.content);
  // A cover lives in the front matter, which never reaches `content`.
  for (const key of FRONT_KEYS) {
    if (typeof data[key] === "string") data[key] = rewrite(data[key]);
  }
  return data;
}, 1);
