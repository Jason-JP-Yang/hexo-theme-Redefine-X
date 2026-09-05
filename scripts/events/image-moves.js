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
 * The rewrite lands in the working tree, which means the build that performs it
 * is also the build that has to commit it: `.github/workflows/deploy.yml`
 * returns `source/` along with the keyring and the artifact pointer. Pulling and
 * generating locally does the same job, and the same commit closes it.
 */

const fs = require("fs");
const path = require("path");

const JOURNAL = "_data/image-moves.json";
const SCAN = [".md", ".yml", ".yaml"];

/** `source/images/a/b.png` → `/images/a/b.png`, which is what a post writes. */
function address(repoPath) {
  return "/" + String(repoPath).replace(/^source\//, "");
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

/** The pairs this build is applying, so the posts already in memory get them too. */
let live = [];

function rewrite(text) {
  let out = text;
  for (const move of live) out = out.split(move.from).join(move.to);
  return out;
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
  if (!Array.isArray(moves) || !moves.length) {
    fs.unlinkSync(journal);
    return;
  }

  live = moves
    .filter((m) => m && m.from && m.to)
    .map((m) => ({ from: address(m.from), to: address(m.to) }))
    .filter((m) => m.from !== m.to);

  if (!live.length) {
    fs.unlinkSync(journal);
    return;
  }

  let touched = 0;
  for (const file of walk(sourceDir, [])) {
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
    `[image-moves] applied ${live.length} move(s) to ${touched} file(s) and cleared ${JOURNAL}.`
  );
}, 5);

/**
 * The posts for THIS build were read off disk before the rewrite above ran, so
 * they still hold the old addresses. Applying the same pairs to the content on
 * its way to the renderer means the build that performs the move is already
 * correct, rather than the one after it.
 */
hexo.extend.filter.register("before_post_render", function (data) {
  if (!live.length || typeof data.content !== "string") return data;
  data.content = rewrite(data.content);
  return data;
}, 1);
