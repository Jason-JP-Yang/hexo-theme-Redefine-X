"use strict";

/**
 * Everything Posts Management shows, decided at build time.
 *
 * The console used to learn what existed by asking the Worker for a registry
 * that holds no metadata, then fetching and decrypting one card per encrypted
 * post to find out what it was called — a request per post to rebuild facts the
 * build already had in hand. All of it is settled here instead and sealed into
 * the console page, so opening the console costs ONE blob and one small answer
 * about who may read what, which is the only question a build cannot answer.
 *
 * ── The states an article can be in ─────────────────────────────────────────
 *
 * Three independent axes, and every combination that can exist is described by
 * the same row:
 *
 *   published / unpublished   is there a post readers can reach at all
 *   draft / no draft          is there an unfinished copy standing in front of it
 *   encrypted / public        does the PUBLISHED version carry `vault:`
 *
 * A draft is always encrypted — that is machinery, not a decision, so it is not
 * an axis. `unpublished` is therefore exactly "a draft with nothing behind it",
 * which is what a post that has never been published looks like on disk.
 */

const clock = require("./build-clock");

const EXCERPT_CHARS = 150;

/** Hexo's `:year/:month/:day/:title/`, from the file rather than from the
 *  routed path — the editor writes `supersedes` with this same rule, and the
 *  two have to agree on a string to match on. */
function permalinkOf(post) {
  const date = post.date;
  if (!date || !date.format) return "";
  const stem = String(post.source || "")
    .split("/")
    .pop()
    .replace(/\.draft\.md$/i, "")
    .replace(/\.md$/i, "");
  return `/${date.format("YYYY/MM/DD")}/${stem}/`;
}

function normalize(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function plainText(html, limit) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? text.slice(0, limit).trimEnd() + "…" : text;
}

function excerptOf(post) {
  const source = post.excerpt && post.excerpt !== "false" ? post.excerpt : post.content;
  return plainText(source, EXCERPT_CHARS);
}

function taxonomyNames(list) {
  if (!list) return [];
  const items = typeof list.toArray === "function" ? list.toArray() : list;
  return (items || []).map((item) => item.name).filter(Boolean);
}

/**
 * One row per ARTICLE, not per file.
 *
 * A draft and the post it supersedes are two files and one article: showing
 * them as two rows is how an admin ends up editing the copy nobody is reading.
 * The draft is folded into its target's row and carries its own identity there.
 *
 * @param {object} hexo
 * @param {Array}  sealed   state.sorted() — every encrypted post, drafts included
 * @param {Array}  albums   state.albums()
 * @param {string} prefix   the vault path prefix, without slashes
 */
function build(hexo, sealed, albums, prefix) {
  const root = String(hexo.config.root || "/");
  const withRoot = (p) => (root + String(p)).replace(/\/{2,}/g, "/");
  const vaultHref = (slug) => withRoot(`${prefix}/${slug}/`);

  const rows = [];
  const byPermalink = new Map();

  const add = (row) => {
    rows.push(row);
    if (row.permalink) byPermalink.set(normalize(row.permalink), row);
    return row;
  };

  // ── published articles ────────────────────────────────────────────────────
  for (const post of hexo.locals.get("posts").toArray()) {
    add({
      key: post.source,
      kind: "post",
      title: post.title || "",
      date: post.date ? post.date.toISOString() : null,
      updated: post.updated ? post.updated.toISOString() : null,
      excerpt: excerptOf(post),
      categories: taxonomyNames(post.categories),
      tags: taxonomyNames(post.tags),
      source: post.source || "",
      href: withRoot(post.path),
      permalink: permalinkOf(post),
      published: true,
      encrypted: false,
      sticky: !!post.sticky,
      vaultId: "",
      slug: "",
      draft: null,
    });
  }

  for (const entry of sealed) {
    if (entry.post.draft === true) continue;
    const post = entry.post;
    add({
      key: entry.id,
      kind: "post",
      title: post.title || "",
      date: post.date ? post.date.toISOString() : null,
      updated: post.updated ? post.updated.toISOString() : null,
      excerpt: excerptOf(post),
      categories: (entry.categories || []).map((c) => c.name),
      tags: (entry.tags || []).map((t) => t.name),
      source: post.source || "",
      href: vaultHref(entry.slug),
      permalink: permalinkOf(post),
      published: true,
      encrypted: true,
      sticky: !!post.sticky,
      vaultId: entry.id,
      slug: entry.slug,
      draft: null,
    });
  }

  // ── drafts ────────────────────────────────────────────────────────────────
  // Folded into the article they stand in front of; a draft that supersedes
  // nothing IS its article, and is the one thing here nobody can read yet.
  for (const entry of sealed) {
    if (entry.post.draft !== true) continue;
    const post = entry.post;
    const draft = {
      id: entry.id,
      slug: entry.slug,
      href: vaultHref(entry.slug),
      source: post.source || "",
      date: post.date ? post.date.toISOString() : null,
      updated: post.updated ? post.updated.toISOString() : null,
    };

    const target = post.supersedes ? byPermalink.get(normalize(post.supersedes)) : null;
    if (target) {
      target.draft = draft;
      continue;
    }

    add({
      key: entry.id,
      kind: "post",
      title: post.title || "",
      date: draft.date,
      updated: draft.updated,
      excerpt: excerptOf(post),
      categories: (entry.categories || []).map((c) => c.name),
      tags: (entry.tags || []).map((t) => t.name),
      source: post.source || "",
      href: draft.href,
      permalink: permalinkOf(post),
      published: false,
      encrypted: false,
      sticky: false,
      vaultId: "",
      slug: entry.slug,
      draft,
    });
  }

  // ── albums ────────────────────────────────────────────────────────────────
  // Public ones come from the masked `locals.data` and encrypted ones from the
  // stash, which is the same split every other listing on the site makes.
  const masonry = (hexo.locals.get("data") || {}).masonry;
  for (const category of Array.isArray(masonry) ? masonry : []) {
    for (const item of (category && category.list) || []) {
      const title = item["page-title"] || item.name || "";
      rows.push({
        key: "album:" + title,
        kind: "album",
        title: item.name || title,
        date: null,
        excerpt: plainText(item.description, EXCERPT_CHARS),
        categories: [category.links_category || ""].filter(Boolean),
        tags: [],
        source: "",
        href: withRoot(`masonry/${title}/`),
        permalink: "",
        published: true,
        encrypted: false,
        sticky: false,
        vaultId: "",
        slug: "",
        draft: null,
      });
    }
  }

  for (const entry of albums) {
    rows.push({
      key: entry.id,
      kind: "album",
      title: entry.item.name || entry.title,
      date: null,
      excerpt: plainText(entry.item.description, EXCERPT_CHARS),
      categories: [entry.category.links_category || ""].filter(Boolean),
      tags: [],
      source: "",
      href: vaultHref(entry.slug),
      permalink: "",
      published: true,
      encrypted: true,
      sticky: false,
      vaultId: entry.id,
      slug: entry.slug,
      draft: null,
    });
  }

  // Encrypted items and albums first — they are the ones whose access has to be
  // decided, and the ones no other page on the site can show. Everything else
  // falls back to the order the blog itself uses.
  const weight = (row) => (row.encrypted || row.kind === "album" ? 0 : 1);
  rows.sort(
    (a, b) =>
      weight(a) - weight(b) ||
      String(b.date || "").localeCompare(String(a.date || "")) ||
      String(a.title).localeCompare(String(b.title))
  );

  return { generated: clock.iso(), items: rows };
}

module.exports = { build, permalinkOf };
