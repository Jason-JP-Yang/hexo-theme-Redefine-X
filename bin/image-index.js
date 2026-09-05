#!/usr/bin/env node
"use strict";

/**
 * The `source/build/` transcode manifest, from outside a build.
 *
 *   npm run images:index              rebuild it from what is on disk
 *   npm run images:index -- --check   list what has no cached product
 *
 * `--check` is what CI runs, and it is a REPORT rather than a gate: a runner
 * builds with RDFX_SKIP_AVIF and never starts an encoder, because AVIF bytes
 * depend on the machine's ffmpeg and libaom — and an image with no cached
 * transcode is published in its original format, which the page and the editor
 * both already resolve. Heavier, never broken. Run from the SITE root.
 */

const fs = require("fs");
const path = require("path");
const { BuildIndex, relKey } = require("../scripts/lib/build-index");
const siteConfig = require("../scripts/lib/site-config");

const BITMAP = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
const INDEX_FILE = ".images.json";
const LEGACY_ACCENTS = ".cover-accent.json";

const check = process.argv.includes("--check");
const cfg = siteConfig.load();
const opts = (cfg.theme.plugins && cfg.theme.plugins.minifier && cfg.theme.plugins.minifier.imagesOptimize) || {};
const enableAvif = opts.AVIF_COMPRESS !== false;
const enableSvg = opts.SVGO_COMPRESS === true;
const exclude = Array.isArray(opts.EXCLUDE) ? opts.EXCLUDE : [];
const buildDir = path.join(cfg.sourceDir, "build");

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
      if (entry.name === "build") continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/** img-optimizer's own test: regex against the leading-slash path, else substring. */
function excluded(rel) {
  const withSlash = "/" + rel;
  for (const pattern of exclude) {
    try {
      if (new RegExp(pattern).test(withSlash)) return true;
    } catch (e) {
      if (withSlash.includes(pattern)) return true;
    }
  }
  return false;
}

function outputFor(rel, isBitmap) {
  const ext = path.posix.extname(rel);
  const dir = path.posix.dirname(rel);
  const stem = path.posix.basename(rel, ext);
  const relDir = dir === "." ? "" : dir;
  const outRel = path.posix.join("build", relDir, stem + (isBitmap ? ".avif" : ext));
  return { outRel, outPath: path.join(cfg.sourceDir, outRel) };
}

const roots = [cfg.sourceDir, cfg.themeDir ? path.join(cfg.themeDir, "source") : ""].filter(Boolean);
const files = [];
for (const root of roots) walk(root, files);

const index = new BuildIndex(buildDir, INDEX_FILE);
const live = new Set();
const missing = [];
let recorded = 0;
let held = 0;

for (const abs of files) {
  const ext = path.extname(abs).toLowerCase();
  const isBitmap = BITMAP.includes(ext);
  const isSvg = ext === ".svg";
  if ((!isBitmap && !isSvg) || (isBitmap && !enableAvif) || (isSvg && !enableSvg)) continue;

  const rel = relKey(abs, cfg.sourceDir, cfg.themeDir);
  if (!rel || rel.startsWith("build/") || excluded(rel)) continue;

  live.add(rel);
  const { outRel, outPath } = outputFor(rel, isBitmap);

  let outStat;
  try {
    outStat = fs.statSync(outPath);
  } catch (e) {
    missing.push(rel);
    continue;
  }
  if (!outStat.size) {
    missing.push(rel);
    continue;
  }

  if (index.hit(rel, abs, (entry) => entry.outSize === outStat.size)) {
    held++;
    continue;
  }
  if (check) {
    missing.push(rel);
    continue;
  }

  index.record(rel, abs, { out: outRel, outSize: outStat.size });
  recorded++;
}

if (check) {
  if (missing.length) {
    console.log(
      `[images:index] ${missing.length} of ${live.size} image(s) have no cached transcode ` +
        `and will be published in their original format:\n` +
        missing.map((p) => `    ${p}`).join("\n") +
        `\n\n  Encode them in a local build and commit source/build/ if the weight matters.\n`
    );
    process.exit(0);
  }
  console.log(`[images:index] ${live.size} image(s), all cached.`);
  process.exit(0);
}

const pruned = index.prune(live);
index.flush();

const legacy = path.join(buildDir, LEGACY_ACCENTS);
if (fs.existsSync(legacy)) {
  fs.unlinkSync(legacy);
  console.log(`[images:index] removed the obsolete ${LEGACY_ACCENTS}`);
}

console.log(
  `[images:index] ${recorded} recorded, ${held} already current, ${pruned} stale entr${pruned === 1 ? "y" : "ies"} dropped.`
);
if (missing.length) {
  console.log(
    `[images:index] ${missing.length} image(s) have no transcode yet — the next local build encodes them:\n` +
      missing.map((p) => `    ${p}`).join("\n")
  );
}
