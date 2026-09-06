"use strict";

/**
 * The picture moves, for a generator started directly.
 *
 * The sweep itself lives in scripts/lib/image-moves.js and belongs BEFORE Hexo
 * — `npm run build` and the deploy workflow both run `npm run images:moves`
 * first, because `_config*.yml` and `source/_data` are parsed while Hexo
 * initialises and a rewrite after that point is a build rendering from
 * addresses it has just made stale.
 *
 * This is what happens when somebody runs `npx hexo generate` on its own. It
 * catches the posts, which are re-read every build, and says plainly that the
 * config and the data files were already in memory. When the CLI has been run
 * there is no note left and this costs one `existsSync`.
 */

const { applyMoves, rewriteWith } = require("../lib/image-moves");

/** The pairs this build applied, so the posts already in memory get them too. */
let live = [];

hexo.extend.filter.register("before_generate", function () {
  const result = applyMoves({
    baseDir: this.base_dir,
    sourceDir: this.source_dir,
    log: this.log,
  });
  if (!result || !result.applied.length) return;

  live = result.applied;
  this.log.warn(
    "[image-moves] the note was applied inside the build, so anything named in _config*.yml or " +
      "source/_data was already read at the old address. Run `npm run images:moves` before " +
      "`hexo generate` — `npm run build` does."
  );
}, 5);

/**
 * The posts for THIS build were read off disk before the sweep above ran, so
 * they still hold the old addresses. Applying the same pairs to the content on
 * its way to the renderer means the build that performs the move is already
 * correct, rather than the one after it.
 */
const FRONT_KEYS = ["cover", "thumbnail", "banner", "top_img", "image"];

hexo.extend.filter.register("before_post_render", function (data) {
  if (!live.length) return data;
  if (typeof data.content === "string") data.content = rewriteWith(live, data.content);
  // A cover lives in the front matter, which never reaches `content`.
  for (const key of FRONT_KEYS) {
    if (typeof data[key] === "string") data[key] = rewriteWith(live, data[key]);
  }
  return data;
}, 1);
