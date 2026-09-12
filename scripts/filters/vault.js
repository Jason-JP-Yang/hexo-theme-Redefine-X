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
 * The admin surface — Blog Management and the composer — is sealed like any
 * other item, under ONE key with a fixed identity.
 *
 * Both pages are for exactly one reader, and until now the only thing standing
 * between a visitor and their markup was a panel that painted nothing. Sealing
 * them makes the wait real: the Worker has to release the key (authorization)
 * AND the blob has to open under it (decryption), and neither alone is enough.
 * The key is only ever granted to an admin — `grantedPosts` hands an admin
 * every row and everyone else only what their own grant names, and nothing in
 * Posts Management offers this one to anybody.
 */
function adminPageId() {
  const theme = hexo.theme.config || {};
  if (!vaultEnabled() || !theme.notifications || theme.notifications.enable !== true) return null;
  return vc.pageId("admin");
}

// Whether this build owes the backend a reconcile. Set while the keyring is
// being decided, acted on once public/ is written: a build that sealed nothing
// but retired something still has to say so.
let syncOwed = false;

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
 *
 * ── Where it goes BACK ──────────────────────────────────────────────────────
 *
 * Each album also carries the two numbers a reader needs to put it back where it
 * belongs instead of at the end of the list:
 *
 *   pos     how many PUBLIC albums precede it inside its category. Independent
 *           of which encrypted albums this particular reader may open, so one
 *           number is correct for every audience.
 *   index   its position in the unmasked list, which orders encrypted albums
 *           against each other when several share a `pos`.
 *
 * and the same pair one level up (`catPos` / `catIndex`) for a category that has
 * no public album at all and therefore no heading in the public build. Both
 * pairs travel INSIDE the sealed metadata, so nothing about them is published —
 * a gap in the public sequence is exactly the disclosure this scheme avoids.
 */
function markedAlbums() {
  const masonry = (hexo.locals.get("data") || {}).masonry;
  if (!Array.isArray(masonry)) return [];

  const out = [];
  let catIndex = 0;
  let catPos = 0;

  for (const category of masonry) {
    if (!category || !category.links_category || !Array.isArray(category.list)) continue;

    let pos = 0;
    for (let index = 0; index < category.list.length; index++) {
      const item = category.list[index];
      if (item && item.vault === true) out.push({ category, item, index, pos, catIndex, catPos });
      else pos++;
    }

    // `pos` has finished counting this category's public albums, which is also
    // the test maskMasonry applies: a category with none of them is not on the
    // public collection page and so occupies no slot on it.
    if (pos) catPos++;
    catIndex++;
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
    syncOwed = false;

    const albums = markedAlbums();
    const adminId = adminPageId();

    if (!marked.length && !albums.length && !adminId) {
      // The last `vault:` flag on the site has just been removed. The keyring
      // still names every post that ever carried one, so it is reconciled here
      // too — this is the one build that would otherwise never look at it.
      if (vaultEnabled() && store.prune(new Set()).length) syncOwed = true;
      return;
    }

    if (!vaultEnabled()) {
      store.fail(
        `${marked.length + albums.length} item(s) carry \`vault:\` but backend.vault_enable is false. ` +
          `Refusing to build them in the clear — set backend.vault_enable: true, or remove the flag.`
      );
    }

    const hidden = new Set();
    const live = new Set();
    for (const post of marked) {
      const id = vc.postId(post.source);
      const { key, slug, rekeyed } = store.ensurePost(id);
      if (rekeyed) {
        hexo.log.warn(
          `[vault] "${post.title || id}" was flagged for regeneration: a NEW key was minted and ` +
            `the slug (${slug}) kept. Everything sealed under the old key is now unreadable.`
        );
      }
      state.put(id, { kind: "post", id, key, slug, post, plain: post.content || "" });
      hidden.add(post.source);
      live.add(id);
    }

    for (const { category, item, index, pos, catIndex, catPos } of albums) {
      const title = item["page-title"] || item.name;
      const id = vc.albumId(title);
      const { key, slug, rekeyed } = store.ensurePost(id);
      if (rekeyed) {
        hexo.log.warn(
          `[vault] album "${item.name || title}" was flagged for regeneration: a NEW key was ` +
            `minted and the slug (${slug}) kept. The old ciphertext opens for nobody.`
        );
      }
      state.put(id, {
        kind: "album",
        id,
        key,
        slug,
        item,
        category,
        title,
        index,
        pos,
        catIndex,
        catPos,
      });
      live.add(id);
    }

    if (adminId) {
      const { key, slug } = store.ensurePost(adminId);
      state.put(adminId, { kind: "page", id: adminId, key, slug });
      live.add(adminId);
    }

    // A key whose post has since dropped the flag is a key for content that is
    // no longer sealed. It goes now, before the keyring is written; `sync` is
    // what takes the wrapped copy out of D1 at the end of the same build.
    store.prune(live);
    syncOwed = true;

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
/**
 * Take the withheld images back out of `build/manifest.json`.
 *
 * The manifest names every source image the build transcoded, which for an
 * image only an encrypted post uses would publish its FILE NAME beside the
 * ciphertext — the same leak `data-original-src` is stripped to prevent, and a
 * file name is often the most descriptive thing about a picture. The editor
 * does not need them there: an encrypted post's images are addressed through
 * the `assets` map in its own sealed metadata, which is keyed by both the
 * published route and the source path exactly so this file can stay public.
 */
function pruneManifest() {
  // Rebuilt through img-optimizer's own builder rather than read back off the
  // route: `route.get` hands out a stream, not the string that was put in.
  const build = hexo.extend.helper.get("avifManifestBody");
  if (!build) return;

  const hidden = new Set(state.withheldPaths());
  if (!hidden.size) return;

  hexo.route.set("build/manifest.json", () => build(hidden));
  hexo.log.info(`[vault] kept ${hidden.size} withheld image(s) out of build/manifest.json`);
}

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
      pruneEmptyDirs(path.dirname(target));
    } catch (e) {
      hexo.log.error(`[vault] could NOT withhold ${routePath} — it is published in the clear`);
    }
  }

  pruneManifest();
  return { unrouted, removed };
}

/**
 * Take back what an album left in public/ when it was still published.
 *
 * Hexo removes a file whose route has gone, but only for files its own cache
 * remembers writing — and it never removes the DIRECTORY, so
 * `public/masonry/<title>/` survives with the album's title for a name. An empty
 * directory is not a file anyone can fetch, but it is the album's title sitting
 * in a deploy tree, which is the same disclosure by a slower route.
 *
 * The album's own images are covered by `withholdPlaintextImages`: they live
 * under the image folder named in masonry.yml, which is routinely shared with
 * public albums and must survive if it is.
 */
function withholdAlbumPages() {
  let removed = 0;

  for (const entry of state.albums()) {
    const dir = path.join(hexo.public_dir, "masonry", entry.title);
    try {
      // Only the generated page, never the directory wholesale: an album whose
      // page title happens to match an image folder would take the photographs
      // of every album sharing it down with it.
      const page = path.join(dir, "index.html");
      if (fs.existsSync(page)) {
        fs.unlinkSync(page);
        removed++;
      }
      pruneEmptyDirs(dir);
    } catch (e) {
      hexo.log.error(
        `[vault] could NOT remove the published page of album "${entry.title}" from public/`
      );
    }
  }

  return removed;
}

/** Walk up from `from`, removing directories that are now empty. Stops at
 *  public/ itself, and at the first directory that still holds something. */
function pruneEmptyDirs(from) {
  const root = path.resolve(hexo.public_dir);
  let dir = path.resolve(from);

  while (dir !== root && dir.startsWith(root + path.sep)) {
    try {
      if (fs.readdirSync(dir).length) return;
      fs.rmdirSync(dir);
    } catch (e) {
      return;
    }
    dir = path.dirname(dir);
  }
}

hexo.extend.filter.register(
  "after_generate",
  async function () {
    if (state.all().length) {
      const { unrouted, removed } = withholdPlaintextImages();
      const pages = withholdAlbumPages();
      hexo.log.info(
        `[vault] withheld ${unrouted} plaintext image route(s), deleted ${removed} stale file(s)` +
          (pages ? ` and ${pages} previously published album page(s)` : "")
      );
    }

    if (!syncOwed || !vaultEnabled()) return;

    // Reconciling, then sealing — both part of building rather than commands to
    // remember. A commit must never carry a post's ciphertext without the key
    // that opens it, and a key nobody has registered opens nothing.
    //
    // The sync runs first because it MARKS the entries it registered, and the
    // seal has to capture that state.
    const opened = store.load().opened;
    if (opened) hexo.log.info(`[vault] opened ${opened} key(s) from .vault/keys.enc`);

    // Which ids are drafts, so the Worker can refuse to grant one an audience.
    // A draft is the author's unfinished copy and has exactly one reader.
    const drafts = new Set(
      state.sorted().filter((entry) => entry.post.draft === true).map((entry) => entry.id)
    );

    const api = String(hexo.theme.config.backend?.api_url || "");
    try {
      const done = await store.sync(api, drafts);
      if (done) {
        hexo.log.info(
          `[vault] backend reconciled: ${done.registered} key(s) registered` +
            (done.revoked ? `, ${done.revoked} revoked` : "")
        );
      }
    } catch (err) {
      hexo.log.warn(
        `[vault] could not reach ${api} to reconcile the keyring — ${err.message}. ` +
          `The next build that can reach it will put D1 right; nothing has to be done by hand.`
      );
    }

    const sealed = store.seal();
    if (sealed && sealed.changed) {
      hexo.log.info(`[vault] sealed ${sealed.count} key(s) into .vault/keys.enc`);
    }
  },
  20
);

// A build interrupted between the route walk and here would leave a plaintext
// image on disk; this is the last chance to take it back. It also runs after
// Hexo's own stale-file sweep, which is what can empty an album's directory
// AFTER the pass above pruned it.
hexo.on("exit", function () {
  if (!state.all().length) return;
  const { removed } = withholdPlaintextImages();
  const pages = withholdAlbumPages();
  if (removed || pages) {
    hexo.log.info(
      `[vault] withheld ${removed} plaintext image(s) and ${pages} album page(s) from public/`
    );
  }
});
