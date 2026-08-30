#!/usr/bin/env node
"use strict";

/**
 * Purge the image optimizer's derivatives. Run from the SITE root:
 * `npm run clean:avif`.
 *
 * Deliberately NOT a branch of `hexo clean` any more. Rebuilding every AVIF is
 * minutes of CPU on a media-heavy site, and a routine clean — which happens
 * before most builds — must never pay it by accident.
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const TARGETS = [
  path.join(ROOT, "source", "build"),
  path.join(ROOT, "public", "build"),
];

let removed = 0;
for (const dir of TARGETS) {
  const label = path.relative(ROOT, dir).replace(/\\/g, "/");
  if (!fs.existsSync(dir)) {
    console.log(`[clean:avif] ${label} — not there`);
    continue;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[clean:avif] removed ${label}`);
    removed++;
  } catch (err) {
    console.error(`[clean:avif] could not remove ${label}: ${err.message}`);
    process.exitCode = 1;
  }
}

console.log(
  removed
    ? `[clean:avif] ${removed} director${removed === 1 ? "y" : "ies"} removed. The next build re-encodes everything.`
    : "[clean:avif] nothing to remove."
);
