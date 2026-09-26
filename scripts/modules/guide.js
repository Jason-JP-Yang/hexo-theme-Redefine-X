"use strict";

/**
 * {% guide [title] %} … {% endguide %}
 *
 * An author's note, presented by the virtual cursor once the reader reaches the
 * block that FOLLOWS the tag (source/js/plugins/guide/tips.js, notes()). Nothing
 * is printed: the note travels in data attributes, so a feed reader, a search
 * index and a reader without JavaScript see the article as if it were not there.
 *
 * The id hashes the post's source path with the note itself, so editing a note
 * shows it again to readers who understood the old wording. The path is taken
 * with forward slashes: one commit must hash alike on Windows and on the runner.
 */

const crypto = require("crypto");

const render = (text) => hexo.render.renderSync({ text, engine: "markdown" });

const attr = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

hexo.extend.tag.register(
  "guide",
  function (args, content) {
    const title = args.join(" ").trim();
    const text = String(content || "").trim();
    const body = text ? render(text).trim() : "";
    const source = String((this && (this.source || this.path)) || "").replace(/\\/g, "/");
    const id = crypto.createHash("sha1").update(`${source}\n${title}\n${text}`).digest("hex").slice(0, 12);
    return (
      `<div class="guide-note" hidden data-guide-id="${id}"` +
      ` data-guide-title="${attr(title)}" data-guide-body="${attr(body)}"></div>`
    );
  },
  { ends: true },
);
