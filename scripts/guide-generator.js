/* main hexo */

"use strict";

/**
 * The guide's strings, as a route: guide-i18n.json.
 *
 * Not part of every page's config block — a reader who has already understood
 * every tip never downloads them. English is the base table and the site
 * language is laid over it key by key, so a partly translated language still
 * says everything.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

function table(file) {
  try {
    return (yaml.load(fs.readFileSync(file, "utf8")) || {}).guide || {};
  } catch (e) {
    return {};
  }
}

function merge(base, over) {
  const out = Object.assign({}, base);
  for (const [key, value] of Object.entries(over || {})) {
    const nested = value && typeof value === "object" && base[key] && typeof base[key] === "object";
    out[key] = nested ? merge(base[key], value) : value;
  }
  return out;
}

hexo.extend.generator.register("redefine_guide", function () {
  const theme = hexo.theme.config || {};
  if (theme.global && theme.global.guide === false) return [];

  const dir = path.join(__dirname, "../languages");
  const lang = [].concat(hexo.config.language || "en")[0] || "en";
  let strings = table(path.join(dir, "en.yml"));
  const own = path.join(dir, `${lang}.yml`);
  if (lang !== "en" && fs.existsSync(own)) strings = merge(strings, table(own));

  return [{ path: "guide-i18n.json", data: JSON.stringify(strings) }];
});
