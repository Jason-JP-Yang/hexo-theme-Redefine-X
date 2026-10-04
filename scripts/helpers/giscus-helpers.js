"use strict";

/**
 * The native giscus widget's build-time half (source/js/plugins/comments): its
 * configuration, the configured language's strings and the comment order,
 * sealed into the page so the reader's browser fetches none of them.
 *
 * Strings are giscus's own locales (data/giscus-locales, MIT) over English —
 * outside scripts/, where Hexo would run every file as a script. A plural
 * entry is taken whole from the language: its categories are its own.
 * The order is the comments repository's giscus.json, which is published from
 * source/giscus.json; giscus reads `defaultCommentOrder` there.
 */

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "../../data/giscus-locales");
const FALLBACKS = { gsw: "de", "zh-Hans": "zh-CN", "zh-Hant": "zh-TW" };
const cache = new Map();

function read(lang) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, `${lang}.json`), "utf8"));
  } catch (e) {
    return null;
  }
}

function strings(lang) {
  if (!cache.has(lang)) cache.set(lang, { ...read("en"), ...read(FALLBACKS[lang] || lang) });
  return cache.get(lang);
}

function commentOrder(sourceDir) {
  try {
    const repo = JSON.parse(fs.readFileSync(path.join(sourceDir, "giscus.json"), "utf8"));
    return repo.defaultCommentOrder === "newest" ? "newest" : "oldest";
  } catch (e) {
    return "oldest";
  }
}

hexo.extend.helper.register("giscus_widget", function () {
  const g = (this.theme.comment && this.theme.comment.config && this.theme.comment.config.giscus) || {};
  const lang = String(g.lang || "en");
  return JSON.stringify({
    repo: g.repo,
    repoId: g.repo_id,
    category: g.category || "",
    categoryId: g.category_id,
    mapping: g.mapping || "pathname",
    term: g.term || "",
    strict: String(g.strict ?? "0"),
    reactionsEnabled: String(g.reactions_enabled ?? "1"),
    inputPosition: g.input_position === "top" ? "top" : "bottom",
    lang,
    strings: strings(lang),
    defaultCommentOrder: commentOrder(hexo.source_dir),
  });
});
