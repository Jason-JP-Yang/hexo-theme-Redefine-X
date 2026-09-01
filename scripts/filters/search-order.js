"use strict";

/**
 * Sort the search index.
 *
 * hexo-generator-searchdb walks `locals.posts` with a bare forEach and no
 * ordering, and Hexo reads sources concurrently — so search.json was a
 * different permutation of the same entries on every machine. The client ranks
 * matches itself, so the order on disk was never meaningful.
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

    // Code-unit order, not localeCompare: collation depends on the locale.
    entries.sort((a, b) => {
      const x = String(a.url || "");
      const y = String(b.url || "");
      return x < y ? -1 : x > y ? 1 : 0;
    });
    hexo.route.set(routePath, JSON.stringify(entries));
  },
  5
);
