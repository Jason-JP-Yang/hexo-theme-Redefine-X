"use strict";

/**
 * The `deploy:` block, and the one value every page of a build shares.
 *
 * ── The settings ────────────────────────────────────────────────────────────
 *
 * The workflow runs in the public repository and reads nothing of the source,
 * so what it needs from this block travels with the artifact as
 * `ci/deploy.json` (scripts/events/export-github-workflow.js): the platform,
 * the address it polls, and the two identities it commits as — the admin for
 * every commit of the site, the bot for emptying the publish and editor-queue
 * branches. Nothing about a particular site is written into the theme.
 *
 * ── The build id ────────────────────────────────────────────────────────────
 *
 * One random id per build process, printed in every footer and published as
 * `version.json`. It is the only thing that tells two deployments of the same
 * site apart, so it is deliberately NOT derived from the source: a rebuild of an
 * unchanged commit still produces a new artifact (every vault blob draws a new
 * nonce), and a deploy check that could not tell the two apart would report the
 * old deployment as the new one.
 */

const crypto = require("crypto");

const PLATFORMS = ["github-pages", "vercel", "cloudflare-pages"];

function text(value) {
  return value == null ? "" : String(value).trim();
}

/** An address with a scheme and one trailing slash, or "". */
function address(value) {
  const raw = text(value).replace(/\/+$/, "");
  if (!raw) return "";
  return (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`) + "/";
}

function resolve(theme, siteUrl) {
  const config = theme || {};
  const raw = config.deploy || {};
  const platform = text(raw.platform).toLowerCase();
  const email = text(raw.email);
  return {
    enable: raw.enable === true,
    platform: PLATFORMS.includes(platform) ? platform : "github-pages",
    ci_url: address(raw.ci_url) || address(siteUrl),
    author: text(raw.author) || text((config.info || {}).author),
    email,
    bot_email: text(raw.bot_email) || email,
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
