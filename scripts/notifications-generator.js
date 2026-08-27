/* main hexo */

"use strict";

/**
 * Build-time half of the notification subsystem. Emits two files:
 *
 *   changelog.json — the ONLY source the backend reads on its own. A GitHub
 *                    webhook fires on push to the deploy repo, the Worker reads
 *                    this file at the pushed commit, and every entry in it
 *                    becomes a notification exactly once (dedupe is by `id`).
 *   manifest.json  — a minimal PWA manifest. Not decoration: iOS delivers Web
 *                    Push only to a site installed to the Home Screen, and a
 *                    site cannot be installed without a manifest.
 *
 * Why a separate file rather than reusing atom.xml: the feed is generated with
 * `content: true`, so it carries every post's full body — megabytes, rewritten
 * wholesale on each build. This file is small, stable, and diffable, which is
 * what makes "did this push add anything?" a cheap question to answer.
 *
 * A post is announced unless it opts out with `notify: false` in front matter.
 * Hand-written entries in source/_data/changelog.yml are merged on top and may
 * override any field of an auto-generated one (matched by `id`).
 */

const DEFAULT_LIMIT = 30;

// ─── helpers ────────────────────────────────────────────────
function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text, max) {
  const clean = stripHtml(text);
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + "…";
}

function toIso(value) {
  if (!value) return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const date = value.toDate ? value.toDate() : new Date(value);
  if (isNaN(date.getTime())) return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The Home Screen label. Cut on a word boundary, never mid-word: this string is
 * what sits under the icon on a phone, where a truncated word is the difference
 * between an installed app and a broken-looking one.
 */
function shortName(title) {
  const clean = String(title || "Blog").trim();
  if (clean.length <= 12) return clean;

  const words = clean.split(/\s+/);
  let out = "";
  for (const word of words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > 12) break;
    out = next;
  }
  // A single word longer than the budget has no boundary to cut on.
  return out || clean.slice(0, 12);
}

/** Absolute URL — a notification is read outside the site, so nothing may be relative. */
function absolute(siteUrl, path) {
  const base = String(siteUrl || "").replace(/\/+$/, "");
  const rel = String(path || "").replace(/^\/+/, "");
  return `${base}/${rel}`;
}

// ─── changelog ──────────────────────────────────────────────
function buildPostEntries(posts, config) {
  const entries = [];

  posts.forEach((post) => {
    if (!post || post.notify === false) return;
    if (post.hidden === true || post.published === false) return;

    entries.push({
      // Path-based, so the id survives a title edit — which is exactly the case
      // where resending would be most annoying.
      id: `post:${String(post.path || "").replace(/\/index\.html$/, "").replace(/\/$/, "")}`,
      type: "post",
      topic: "posts",
      title: String(post.title || "Untitled"),
      body: truncate(post.excerpt || post.description || post.content || "", 160),
      url: absolute(config.url, post.path),
      image: post.cover || post.thumbnail || "",
      tag: "posts",
      audience: { kind: "topic" },
      published_at: toIso(post.date),
    });
  });

  return entries;
}

/**
 * Hand-written entries, normalised but NOT defaulted.
 *
 * Only the keys the author actually wrote come back. That is what makes a
 * partial override work: writing just `{id, body}` against a post's generated id
 * replaces the excerpt and leaves title, url, cover and date alone. Filling in
 * defaults here would instead clobber all four with placeholder values.
 */
function buildManualEntries(data, config) {
  const raw = data && data.changelog;
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.entries) ? raw.entries : [];

  return list
    .filter((entry) => entry && entry.id)
    .map((entry) => {
      const out = Object.assign({}, entry);

      if (out.url) {
        // A hand-written entry may point off-site; only site-relative paths get
        // the origin prepended.
        out.url = /^https?:\/\//i.test(out.url) ? out.url : absolute(config.url, out.url);
      }
      if (out.published_at || out.date) {
        out.published_at = toIso(out.published_at || out.date);
        delete out.date;
      }
      return out;
    });
}

/**
 * Fill in what neither source supplied. Runs after the merge so an override
 * never has to restate a field it does not want to change.
 */
function applyDefaults(entry) {
  const type = entry.type || "announcement";
  const topic = entry.topic || (type === "post" ? "posts" : "announcements");
  return Object.assign(
    {
      type,
      topic,
      body: "",
      image: "",
      tag: topic,
      audience: { kind: "topic" },
      published_at: toIso(null),
    },
    entry,
    { type, topic }
  );
}

hexo.extend.generator.register("redefine_changelog", function (locals) {
  // Read through the module-level `hexo`, not `this`: scripts/data-handle.js can
  // REPLACE hexo.theme.config wholesale on generateBefore (the _data/_config
  // override), so the live object is the only one worth reading.
  const theme = hexo.theme.config || {};
  const notifications = theme.notifications || {};
  if (!notifications.enable || notifications.changelog === false) return [];

  const config = hexo.config;
  const limit = Number(notifications.changelog_limit) || DEFAULT_LIMIT;

  const posts = locals.posts.sort("-date").toArray();
  const auto = buildPostEntries(posts, config);
  const manual = buildManualEntries(locals.data, config);

  // Hand-written entries win field by field: the whole point of writing one for
  // a post that already generates an entry is to say something the excerpt does
  // not, without restating everything else.
  const byId = new Map();
  auto.forEach((entry) => byId.set(entry.id, entry));
  manual.forEach((entry) => {
    byId.set(entry.id, Object.assign({}, byId.get(entry.id) || {}, entry));
  });

  const entries = Array.from(byId.values())
    .map(applyDefaults)
    // An entry with no title or nowhere to go cannot be shown in a notification,
    // and silently sending a blank one is worse than dropping it here.
    .filter((entry) => entry.title && entry.url)
    .sort((a, b) => (a.published_at < b.published_at ? 1 : -1))
    .slice(0, limit);

  return [
    {
      path: "changelog.json",
      data: JSON.stringify(
        {
          version: 1,
          generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          entries,
        },
        null,
        2
      ),
    },
  ];
});

// ─── manifest ───────────────────────────────────────────────
hexo.extend.generator.register("redefine_manifest", function () {
  const theme = hexo.theme.config || {};
  const notifications = theme.notifications || {};
  if (!notifications.enable) return [];

  const config = hexo.config;
  const icon = (theme.defaults && (theme.defaults.logo || theme.defaults.favicon)) || "";
  const colors = theme.colors || {};

  const title = (theme.info && theme.info.title) || config.title || "Blog";

  const manifest = {
    name: title,
    short_name: shortName(title),
    description: config.description || "",
    start_url: config.root || "/",
    scope: config.root || "/",
    // "standalone" is what makes iOS treat the Home Screen entry as an installed
    // app, which is the precondition for it delivering push at all.
    display: "standalone",
    theme_color: colors.primary || "#A31F34",
    background_color: colors.default_mode === "dark" ? "#1a1a1a" : "#ffffff",
    icons: icon
      ? [
          {
            src: absolute(config.url, icon),
            // No size is asserted: the theme's logo is whatever the author set,
            // and claiming "192x192" for an image that is not would make the
            // install prompt reject it.
            sizes: "any",
            type: /\.svg$/i.test(icon) ? "image/svg+xml" : "image/png",
            purpose: "any",
          },
        ]
      : [],
  };

  return [{ path: "manifest.json", data: JSON.stringify(manifest, null, 2) }];
});
