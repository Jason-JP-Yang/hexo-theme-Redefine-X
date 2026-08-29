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

hexo.extend.filter.register(
  "before_generate",
  function () {
    const posts = hexo.locals.get("posts");
    const marked = posts.filter((post) => !!post.vault).toArray();

    // Rebuilt every pass: `hexo server` regenerates on each change, and a stale
    // stash would seal a body that is no longer the one on disk.
    state.clear();
    if (!marked.length) return;

    if (!vaultEnabled()) {
      store.fail(
        `${marked.length} post(s) carry \`vault:\` front matter but backend.vault_enable is false. ` +
          `Refusing to build them in the clear — set backend.vault_enable: true, or remove the front matter.`
      );
    }

    const hidden = new Set();
    for (const post of marked) {
      const id = vc.postId(post.source);
      const { key, slug } = store.ensurePost(id, post.title || "");
      state.put(id, { id, key, slug, post, plain: post.content || "" });
      hidden.add(post.source);
    }

    // Before anything is sealed: a key that reached public/ but not the keyring
    // would leave the post encrypted under a key that exists nowhere.
    store.flush();

    // One exclusion covers the index, archive, every tag and category page, the
    // post's own permalink, the feed, the sitemap and search.json — every
    // generator takes its copy from this Query.
    hexo.locals.set("posts", function () {
      return posts.filter((post) => !hidden.has(post.source));
    });

    hexo.log.info(`[vault] ${hidden.size} encrypted post(s) withheld from the public build`);
  },
  100
);

/**
 * Delete the plaintext of every sealed image from public/. Removing the route is
 * not enough twice over: img-optimizer's `after_generate` copies its output
 * straight into public/ with fs, consulting no route table, and Hexo writes the
 * route list to disk AFTER every `after_generate` filter. Only `exit` is past
 * both, so this runs in both places.
 */
function withholdPlaintextImages() {
  let removed = 0;
  for (const routePath of state.withheldPaths()) {
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
  return removed;
}

hexo.extend.filter.register(
  "after_generate",
  function () {
    if (!state.all().length) return;
    withholdPlaintextImages();
    store.report(hexo.log);
  },
  20
);

hexo.on("exit", function () {
  if (!state.withheldPaths().length) return;
  const removed = withholdPlaintextImages();
  if (removed) hexo.log.info(`[vault] withheld ${removed} plaintext image(s) from public/`);
});
