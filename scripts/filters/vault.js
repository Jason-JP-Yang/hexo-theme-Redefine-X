"use strict";

/**
 * Vault — taking an encrypted post out of the public build.
 *
 * NOT an after_post_render filter, deliberately. Hexo skips that hook when
 * `db.json` is warm, so a vault living there protects a post on the first build
 * and publishes it in the clear on every build after — fail-open, and exactly
 * what `hexo server` exposed. `before_generate` runs on every build, and
 * `post.content` is already the finished body (AVIF paths, lazyload, boxes,
 * MathJax all applied by then). Nothing here mutates the model, so nothing can
 * be persisted into the cache either.
 *
 * Priority 100: last, so anything precomputing over the post list still sees
 * every post, and the removal lands immediately before the generators run.
 */

const fs = require("fs");
const path = require("path");
const store = require("../lib/vault-store");
const state = require("../lib/vault-state");
const vc = require("../lib/vault-crypto");

function vaultEnabled() {
  return hexo.theme.config?.backend?.vault_enable === true;
}

/**
 * Withhold the post's TAXONOMY as well as the post.
 *
 * Dropping the post from `locals.posts` is not enough. `Tag.length` and
 * `Category.length` are counted straight off Hexo's in-memory relation index,
 * NOT off the post list, so a tag carried only by an encrypted post survived
 * `locals.tags` (which filters on `length`) and published its name in the tag
 * cloud with a count of zero and a link to a page that was never generated. A
 * tag SHARED with a public post leaked less loudly and worse: its count was the
 * one that included the hidden post.
 *
 * The index is derived state, rebuilt from the PostTag/PostCategory models at
 * every load and never written to `db.json`, so removing rows from it withholds
 * the taxonomy for this build without touching what is on disk. `Category.posts`
 * and `Tag.posts` read the same index, so the whole taxonomy surface —
 * generators, helpers, feed, tag cloud, category tree — goes quiet at once.
 *
 * The post's OWN tags come from the same index, so they are snapshotted first
 * and handed back to the sealed render (vault-generator).
 */
function withholdTaxonomy(entries) {
  const rel = hexo._binaryRelationIndex;
  const postTag = rel && rel.post_tag;
  const postCategory = rel && rel.post_category;

  if (!postTag || !postCategory || typeof postTag.removeHook !== "function") {
    store.fail(
      "Hexo's taxonomy relation index (hexo._binaryRelationIndex) is not where this build " +
        "expects it. Refusing to continue — an encrypted post's tags and categories would be " +
        "published in the clear."
    );
  }

  for (const entry of entries) {
    const post = entry.post;
    // Read before the rows go: both getters are backed by the index.
    entry.tags = post.tags.toArray();
    entry.categories = post.categories.toArray();

    for (const row of postTag.find({ post_id: post._id })) postTag.removeHook(row);
    for (const row of postCategory.find({ post_id: post._id })) postCategory.removeHook(row);
  }
}

/**
 * Masonry albums carrying `vault: true` in masonry.yml.
 *
 * An album is withheld the same way a post is, and for the same reasons: the
 * collection page would otherwise publish its name, description, thumbnail and
 * avatar, and its own page would sit at `/masonry/<title>/` — a path anybody can
 * type. Both go, and the album comes back only for a reader holding the key.
 */
function markedAlbums() {
  const masonry = (hexo.locals.get("data") || {}).masonry;
  if (!Array.isArray(masonry)) return [];

  const out = [];
  for (const category of masonry) {
    if (!category || !category.links_category || !Array.isArray(category.list)) continue;
    for (const item of category.list) {
      if (item && item.vault === true) out.push({ category, item });
    }
  }
  return out;
}

/** The masonry data with every encrypted album — and any category left empty by
 *  their removal — taken out of it. */
function maskMasonry(data) {
  const masonry = [];
  for (const category of data.masonry || []) {
    if (!category || !category.links_category || !Array.isArray(category.list)) {
      masonry.push(category);
      continue;
    }
    const list = category.list.filter((item) => !item || item.vault !== true);
    // A category whose albums are ALL encrypted does not exist publicly either:
    // its name is as much of a disclosure as the album's.
    if (list.length) masonry.push(Object.assign({}, category, { list }));
  }
  return Object.assign({}, data, { masonry });
}

hexo.extend.filter.register(
  "before_generate",
  function () {
    const posts = hexo.locals.get("posts");
    const marked = posts.filter((post) => !!post.vault).toArray();

    // Rebuilt every pass: `hexo server` regenerates on each change, and a stale
    // stash would seal a body that is no longer the one on disk.
    state.clear();

    const albums = markedAlbums();
    if (!marked.length && !albums.length) return;

    if (!vaultEnabled()) {
      store.fail(
        `${marked.length + albums.length} item(s) carry \`vault:\` but backend.vault_enable is false. ` +
          `Refusing to build them in the clear — set backend.vault_enable: true, or remove the flag.`
      );
    }

    const hidden = new Set();
    for (const post of marked) {
      const id = vc.postId(post.source);
      const { key, slug, rekeyed } = store.ensurePost(id, post.title || "");
      if (rekeyed) {
        hexo.log.warn(
          `[vault] "${post.title || id}" was flagged for regeneration: a NEW key was minted and ` +
            `the slug (${slug}) kept. Nobody can open it until the line below is pasted into ` +
            `Blog Management -> Encrypted Posts.`
        );
      }
      state.put(id, { kind: "post", id, key, slug, post, plain: post.content || "" });
      hidden.add(post.source);
    }

    for (const { category, item } of albums) {
      const title = item["page-title"] || item.name;
      const id = vc.albumId(title);
      const { key, slug, rekeyed } = store.ensurePost(id, item.name || title);
      if (rekeyed) {
        hexo.log.warn(
          `[vault] album "${item.name || title}" was flagged for regeneration: a NEW key was ` +
            `minted and the slug (${slug}) kept. Paste the line below into Blog Management.`
        );
      }
      state.put(id, { kind: "album", id, key, slug, item, category, title });
    }

    // Before anything is sealed: a key that reached public/ but not the keyring
    // would leave the post encrypted under a key that exists nowhere.
    store.flush();

    if (hidden.size) withholdTaxonomy(state.sorted());

    // Anything already materialised from the old index or the old post list is
    // now wrong in the one direction that matters.
    hexo.locals.invalidate();

    // One exclusion covers the index, archive, every tag and category page, the
    // post's own permalink, the feed, the sitemap and search.json — every
    // generator takes its copy from this Query.
    if (hidden.size) {
      hexo.locals.set("posts", function () {
        return posts.filter((post) => !hidden.has(post.source));
      });
    }

    // Same idea one layer up: the masonry generator builds BOTH the collection
    // page and every album page out of this one object.
    if (albums.length) {
      const masked = maskMasonry(hexo.locals.get("data") || {});
      hexo.locals.set("data", function () {
        return masked;
      });
      // data-handle.js copies the album list onto the theme config at
      // `generateBefore`, which is EARLIER than this filter. Left alone that
      // copy still names every encrypted album — and it is a copy templates and
      // build passes read as though it were public.
      if (Array.isArray(hexo.theme.config.masonry)) {
        hexo.theme.config.masonry = masked.masonry;
      }
    }

    hexo.log.info(
      `[vault] ${hidden.size} encrypted post(s) and ${albums.length} encrypted album(s) ` +
        `withheld from the public build`
    );
  },
  100
);

/**
 * Withhold the plaintext of every sealed image.
 *
 * Both halves have to happen HERE rather than in the generator. Hexo collects
 * every generator's result before it sets a single route, so a `route.remove()`
 * called from inside a generator is undone moments later when the built-in asset
 * generator re-registers the file — which is exactly how `hexo server` went on
 * serving the unencrypted AVIF at a guessable path. `after_generate` is past
 * that, and it is also past img-optimizer's own `after_generate` (priority 10),
 * which copies its output straight into public/ with fs, consulting no route
 * table.
 *
 * Removing the route here is what stops the file being written at all: Hexo
 * walks the route list to disk only after this hook has run.
 */
function withholdPlaintextImages() {
  let unrouted = 0;
  let removed = 0;

  for (const routePath of state.withheldPaths()) {
    if (hexo.route.get(routePath)) {
      hexo.route.remove(routePath);
      unrouted++;
    }

    const target = path.join(hexo.public_dir, routePath);
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed++;
      }
    } catch (e) {
      hexo.log.error(`[vault] could NOT withhold ${routePath} — it is published in the clear`);
    }
  }

  return { unrouted, removed };
}

hexo.extend.filter.register(
  "after_generate",
  function () {
    if (!state.all().length) return;
    const { unrouted, removed } = withholdPlaintextImages();
    hexo.log.info(
      `[vault] withheld ${unrouted} plaintext image route(s), deleted ${removed} stale file(s)`
    );
    store.report(hexo.log);
  },
  20
);

// A build interrupted between the route walk and here would leave a plaintext
// image on disk; this is the last chance to take it back.
//
// One thing this cannot reach: an album that USED to be public leaves its old
// `public/masonry/<title>/` folder behind, emptied of its index.html but still
// named after the album. Hexo never removes a directory it has emptied. Run
// `npm run clean` once after encrypting an album that was already published.
hexo.on("exit", function () {
  if (!state.all().length) return;
  const { removed } = withholdPlaintextImages();
  if (removed) hexo.log.info(`[vault] withheld ${removed} plaintext image(s) from public/`);
});
