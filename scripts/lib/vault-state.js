"use strict";

/**
 * The in-memory stash that carries an encrypted post from the render filter to
 * the generator, and the ONLY place its plaintext ever exists.
 *
 * `after_post_render` is where a post's body is finished — AVIF paths rewritten
 * (img-optimizer, priority 5), lazyload markup applied (priority 10) — but the
 * AVIF FILES do not exist yet: they are produced at `before_generate`, which
 * runs later. So the body is parked here at priority 1000 and the generator,
 * which runs after those files exist, is what encrypts it.
 *
 * Nothing here is ever handed to a route. A route is a file, and a file is the
 * one thing the plaintext must never become.
 */

const stash = new Map(); // postId -> { post, plain, key, slug }

// Route paths whose plaintext must not be published. Removing the route is not
// enough: img-optimizer's `after_generate` copies its output straight into
// public/ with fs, bypassing the route table entirely.
const withheld = new Set();

function put(id, entry) {
  stash.set(id, entry);
}

function get(id) {
  return stash.get(id);
}

function all() {
  return Array.from(stash.values());
}

/** Encrypted POSTS, newest first — the order every listing in the theme uses.
 *  Albums and generated pages are stashed in the same map and carry no date. */
function sorted() {
  return all()
    .filter((entry) => entry.kind === "post")
    .sort((a, b) => b.post.date.valueOf() - a.post.date.valueOf());
}

/** Encrypted masonry albums, in the order masonry.yml lists them. */
function albums() {
  return all().filter((entry) => entry.kind === "album");
}

/** Sealed generated pages — the admin console and the composer. */
function pages() {
  return all().filter((entry) => entry.kind === "page");
}

/**
 * PUBLIC posts, sealed only so the editor can open their source.
 *
 * These are not withheld from anything. The article is published exactly as it
 * always was; what is added is a sealed copy of the markdown beside it, under a
 * key of its own, so that editing a post no longer requires a credential for
 * the repository it lives in. A key here opens one file and nothing else — it
 * is not the key to the site, and it is not the key to a neighbouring post.
 */
function sources() {
  return all()
    .filter((entry) => entry.kind === "source")
    .sort((a, b) => b.post.date.valueOf() - a.post.date.valueOf());
}

/** The same for a public album: its slice of masonry.yml, sealed on its own. */
function albumSources() {
  return all().filter((entry) => entry.kind === "album-source");
}

/** Every album, encrypted or not, in the order masonry.yml lists them. */
function everyAlbum() {
  return albums().concat(albumSources());
}

function withhold(routePath) {
  withheld.add(routePath);
}

function withheldPaths() {
  return Array.from(withheld);
}

function clear() {
  stash.clear();
  withheld.clear();
}

module.exports = {
  put,
  get,
  all,
  sorted,
  albums,
  pages,
  sources,
  albumSources,
  everyAlbum,
  withhold,
  withheldPaths,
  clear,
};
