#!/usr/bin/env node
"use strict";

/**
 * Reconcile the masonry albums' GitHub Discussions with `masonry.yml`.
 * Run from the SITE root: `npm run masonry:sync`.
 *
 * This used to run as a `before_generate` filter, which meant every `hexo
 * generate` and every save under `hexo server` could create, edit and delete
 * comments in a real repository. It reads config straight off disk rather than
 * booting Hexo — the four files below are everything it needs.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { sync } = require("../scripts/masonry-reactions");

const ROOT = process.cwd();

function readYaml(file) {
  try {
    return yaml.load(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

/** Hexo's alternate-config convention: `_config.<theme>.yml` at the site root
 *  overrides the theme's own defaults, key by key. */
function merge(base, override) {
  if (override === undefined) return base;
  if (!override || typeof override !== "object" || Array.isArray(override)) return override;
  const out = Object.assign({}, base);
  for (const key of Object.keys(override)) {
    out[key] = merge(base ? base[key] : undefined, override[key]);
  }
  return out;
}

const config = readYaml(path.join(ROOT, "_config.yml")) || {};
const themeName = config.theme || "redefine-x";
const theme = merge(
  readYaml(path.join(ROOT, "themes", themeName, "_config.yml")) || {},
  readYaml(path.join(ROOT, `_config.${themeName}.yml`)) || {}
);
const masonry = readYaml(path.join(ROOT, "source", "_data", "masonry.yml"));

const log = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

sync({ theme, config, masonry: Array.isArray(masonry) ? masonry : null, log }).catch((err) => {
  console.error(`[masonry-reactions] ${err.message}`);
  process.exit(1);
});
