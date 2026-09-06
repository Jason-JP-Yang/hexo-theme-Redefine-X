#!/usr/bin/env node
"use strict";

/**
 * Apply the editor's picture moves, from outside a build.
 *
 *   npm run images:moves
 *
 * Run BEFORE `hexo generate`, and before `images:index --check` reports on the
 * cache: `_config*.yml` and everything in `source/_data` are parsed while Hexo
 * initialises, so a sweep that happens inside the build renders that build from
 * addresses it has just made stale. Run from the SITE root. Silent and free
 * when there is no note to apply.
 */

const { applyMoves } = require("../scripts/lib/image-moves");
const siteConfig = require("../scripts/lib/site-config");

const cfg = siteConfig.load();
const log = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
};

const result = applyMoves({ baseDir: cfg.root, sourceDir: cfg.sourceDir, log });

if (!result) process.exit(0);
if (!result.applied.length && !result.held.length) console.log("[image-moves] the note was empty; cleared it.");
