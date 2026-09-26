/* main hexo */

"use strict";

/**
 * The guide's strings, as a route: guide-i18n.json.
 *
 * Not part of every page's config block — a reader who has already understood
 * every tip never downloads them. English is the base table and the site
 * language is laid over it key by key, so a partly translated language still
 * says everything.
 *
 * `newest` rides along: the latest post a reader can open — not sticky-first
 * like the home page, never one behind the vault or a draft — as its
 * notification would announce it, for the follow walkthrough to show.
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

function plain(html, max) {
  const text = String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// The same selection and body as notifications-generator.js's post entries.
function newest(posts) {
  const post = posts
    .sort("-date")
    .toArray()
    .find((p) => p && !p.vault && p.draft !== true && p.hidden !== true && p.published !== false && p.notify !== false);
  if (!post) return null;
  return { title: String(post.title || ""), body: plain(post.excerpt || post.description || post.content || "", 160) };
}

hexo.extend.generator.register("redefine_guide", function (locals) {
  const theme = hexo.theme.config || {};
  if (theme.global && theme.global.guide === false) return [];

  const dir = path.join(__dirname, "../languages");
  const lang = [].concat(hexo.config.language || "en")[0] || "en";
  let strings = table(path.join(dir, "en.yml"));
  const own = path.join(dir, `${lang}.yml`);
  if (lang !== "en" && fs.existsSync(own)) strings = merge(strings, table(own));
  const post = newest(locals.posts);
  if (post) strings.newest = post;

  return [{ path: "guide-i18n.json", data: JSON.stringify(strings) }];
});
