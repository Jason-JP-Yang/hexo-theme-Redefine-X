"use strict";

/**
 * The `deploy:` block, and the one value every page of a build shares.
 *
 * ── The platform ────────────────────────────────────────────────────────────
 *
 * GitHub Pages is published BY the workflow; Vercel and Cloudflare Pages
 * publish themselves on every push to the branch they watch, so the workflow
 * only waits for them. Anything unrecognised falls back to GitHub Pages, which
 * is the one platform that cannot be left doing nothing.
 *
 * ── The build id ────────────────────────────────────────────────────────────
 *
 * One random id per build process, printed in every footer and published as
 * `version.json`. It is the only thing that tells two deployments of the same
 * site apart, so it is deliberately NOT derived from the source: a rebuild of an
 * unchanged commit still produces a new artifact (every vault blob draws a new
 * nonce), and a deploy check that could not tell the two apart would report the
 * old deployment as the new one. It is the single intended per-build difference
 * between two builds of one commit.
 */

const crypto = require("crypto");

const PLATFORMS = ["github-pages", "vercel", "cloudflare-pages"];

function resolve(theme) {
  const raw = (theme && theme.deploy) || {};
  const platform = String(raw.platform || "").trim().toLowerCase();
  return {
    enable: raw.enable === true,
    platform: PLATFORMS.includes(platform) ? platform : "github-pages",
  };
}

let current = null;

function build() {
  if (!current) {
    current = {
      id: crypto.randomBytes(20).toString("hex"),
      time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  }
  return current;
}

module.exports = { resolve, build, PLATFORMS };
