"use strict";

/**
 * Everything a build does before it renders anything — inside the generator.
 *
 * ── One build, two machines ─────────────────────────────────────────────────
 *
 * A site is deployed two ways: `hexo generate` on this machine, and the same
 * command on a CI runner. Those two have to be the SAME build, and the only
 * thing they are allowed to disagree about is whether an image is transcoded —
 * AVIF bytes depend on the machine's ffmpeg and libaom, so a runner that
 * encoded would produce different bytes for the same picture.
 *
 * Everything else the deploy used to do — apply the editor's picture moves,
 * reconcile the album discussions, pin the build clock, keep the transcode
 * index honest — lived in the workflow as its own `npm run` step. That is what
 * made the two builds different: a local build simply never did any of it, and
 * a step that runs in one place and not the other is a bug waiting for the
 * first person who deploys from a laptop. So it all lives here, and both are
 * `npm run clean && npm run build`.
 *
 * ── Why `after_init` ────────────────────────────────────────────────────────
 *
 * The first moment a theme script can act, and still before `hexo.load()` walks
 * `source/`. Posts and `source/_data` are therefore read AFTER the picture
 * moves land and are simply correct. `_config*.yml` is the one thing already
 * parsed by then, which is why the sweep also catches up `hexo.config` in
 * memory — see scripts/lib/image-moves.js.
 *
 * The pipeline's order is the order below, and it is the order the pictures
 * need:  move → encode → seal → point every reference at what was published.
 * Encoding is scripts/filters/img-optimizer.js at `before_generate`; sealing is
 * scripts/filters/vault.js; the references are rewritten from what the encoder
 * actually produced, at `after_post_render`.
 */

const { spawnSync } = require("child_process");
const { applyMoves, rewriteDeep } = require("../lib/image-moves");
const { setRunMode, skipAvif, skipReason } = require("../lib/build-index");
const clock = require("../lib/build-clock");

/** The command as its full name, so `hexo g` and `hexo generate` are one thing. */
function command(ctx) {
  const cmd = String(ctx.env.cmd || "");
  return (ctx.extend.console.alias || {})[cmd] || cmd;
}

function watching(ctx) {
  const args = ctx.env.args || {};
  return !!(args.w || args.watch);
}

/**
 * The source commit's timestamp, so the home grid's recency weighting, the
 * changelog and the footer year describe the CONTENT rather than the moment a
 * runner happened to pick the job up. Two builds of one commit then agree.
 */
function pinClock(ctx) {
  if (process.env.SOURCE_DATE_EPOCH) return;
  let out;
  try {
    out = spawnSync("git", ["log", "-1", "--format=%ct"], {
      cwd: ctx.base_dir,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (e) {
    return;
  }
  const stamp = out && out.status === 0 ? String(out.stdout || "").trim() : "";
  if (clock.pin(stamp)) {
    ctx.log.info(`[build] clock pinned to the source commit (${clock.iso()}).`);
  }
}

/** The editor's renames, applied to the tree and to the config already in hand. */
function pictureMoves(ctx) {
  const result = applyMoves({
    baseDir: ctx.base_dir,
    sourceDir: ctx.source_dir,
    log: ctx.log,
  });
  if (!result || !result.applied.length) return;

  const patched = rewriteDeep(result.applied, ctx.config);
  if (patched) ctx.log.info(`[image-moves] caught up ${patched} config value(s) already in memory.`);
}

hexo.extend.filter.register(
  "after_init",
  function () {
    const cmd = command(this);
    if (cmd !== "generate" && cmd !== "server" && cmd !== "deploy") return;

    setRunMode(this.env.args);
    const why = skipReason();
    if (skipAvif()) {
      this.log.info(
        `[build] image encoding is off (${why}); only what source/build/ already holds is served.`
      );
    }

    if (cmd === "generate" && !watching(this)) pinClock(this);

    pictureMoves(this);
  },
  1
);

/**
 * The albums' GitHub Discussions, reconciled with `masonry.yml`.
 *
 * Gated on the command, not on a separate entry point: this creates, edits and
 * deletes comments in a real repository, and `hexo server` re-runs its filters
 * on every keystroke that touches a file. It is also a no-op without
 * GISCUS_AUTHOR_PAT in `.env`, which is what makes it free on a runner.
 */
hexo.extend.filter.register(
  "before_generate",
  async function () {
    if (command(this) !== "generate" || watching(this)) return;

    const { sync } = require("../masonry-reactions");
    const data = this.locals.get("data") || {};
    try {
      await sync({
        theme: this.theme.config,
        config: this.config,
        masonry: Array.isArray(data.masonry) ? data.masonry : null,
        log: this.log,
      });
    } catch (err) {
      // Never fatal. The album pages are published either way; what is out of
      // date is a discussion thread nobody has opened yet.
      this.log.warn(`[masonry-reactions] ${err.message}`);
    }
  },
  15
);
