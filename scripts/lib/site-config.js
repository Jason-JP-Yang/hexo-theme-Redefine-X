"use strict";

/**
 * Site and theme config, read the way Hexo resolves them, for the CLI tools in
 * bin/ — which run outside a Hexo instance and so have no `hexo.config`.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

function readYaml(file) {
  try {
    return yaml.load(fs.readFileSync(file, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

/** @param {string} [root] site root; defaults to the working directory. */
function load(root) {
  const base = root || process.cwd();
  const site = readYaml(path.join(base, "_config.yml"));
  const name = site.theme || "";
  const themeDir = name ? path.join(base, "themes", name) : "";

  // Hexo's alternate-config convention: `_config.<theme>.yml` at the site root
  // REPLACES the theme's own file wholesale rather than merging into it.
  const override = name ? readYaml(path.join(base, `_config.${name}.yml`)) : {};
  const theme = Object.keys(override).length
    ? override
    : themeDir
      ? readYaml(path.join(themeDir, "_config.yml"))
      : {};

  return {
    root: base,
    site,
    theme,
    themeDir,
    sourceDir: path.join(base, site.source_dir || "source"),
    publicDir: path.join(base, site.public_dir || "public"),
  };
}

module.exports = { load, readYaml };
