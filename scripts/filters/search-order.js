"use strict";

/**
 * Put the search index in a fixed order.
 *
 * hexo-generator-searchdb walks `locals.posts` and `locals.pages` with a bare
 * `forEach` and no ordering at all (its lib/database.js). Hexo reads source
 * files concurrently, so that collection is in whatever order the reads
 * happened to finish in — which makes search.json a different permutation of
 * the same entries on every machine, and in principle between two runs on one
 * machine. Same length, same content, different bytes, for no reason anyone
 * chose. It was the only file in the whole artifact that could not be
 * reproduced.
 *
 * Sorting by `url` costs nothing and changes nothing the reader sees: the
 * client scores and ranks matches itself, so the order on disk was never
 * meaningful.
 *
 * Priority 5 — before anything else that rewrites routes.
 */

/** Route payloads come back as strings, Buffers, streams or thunks. */
function readRoute(routePath) {
  const data = hexo.route.get(routePath);
  if (!data) return Promise.resolve(null);
  if (Buffer.isBuffer(data)) return Promise.resolve(data.toString("utf8"));
  if (typeof data === "string") return Promise.resolve(data);

  return new Promise((resolve) => {
    const chunks = [];
    const stream = typeof data === "function" ? data() : data;
    if (!stream || typeof stream.on !== "function") {
      if (typeof stream === "string") return resolve(stream);
      return resolve(Buffer.isBuffer(stream) ? stream.toString("utf8") : null);
    }
    stream.on("data", (c) => chunks.push(Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(null));
  });
}

hexo.extend.filter.register(
  "after_generate",
  async function () {
    const routePath = (hexo.config.search && hexo.config.search.path) || "search.json";
    if (!routePath.endsWith(".json")) return;

    const raw = await readRoute(routePath);
    if (!raw) return;

    let entries;
    try {
      entries = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!Array.isArray(entries) || entries.length < 2) return;

    // Code-unit order, NOT localeCompare: collation depends on the runner's
    // locale, which would put the nondeterminism straight back.
    entries.sort((a, b) => {
      const x = String(a.url || "");
      const y = String(b.url || "");
      return x < y ? -1 : x > y ? 1 : 0;
    });
    hexo.route.set(routePath, JSON.stringify(entries));
  },
  5
);
