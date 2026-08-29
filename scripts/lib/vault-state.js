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

/** Newest first, the order every listing in the theme uses. */
function sorted() {
  return all().sort((a, b) => b.post.date.valueOf() - a.post.date.valueOf());
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

module.exports = { put, get, all, sorted, withhold, withheldPaths, clear };
