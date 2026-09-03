"use strict";

/**
 * Vault — the emit half. Runs as a generator, which is the earliest point at
 * which the AVIF files exist (img-optimizer produces them at `before_generate`)
 * and still early enough that nothing plaintext has to become a file.
 *
 * What lands in public/, all of it opaque:
 *
 *   <prefix>/<slug>/index.html   the gate. Carries the slug and NOTHING else —
 *                                no title, no date, no tags, no excerpt.
 *   <prefix>/<slug>/b.bin        iv ‖ AES-256-GCM(postKey) of the article body
 *   <prefix>/<slug>/c.bin        the same sealing of a JSON record: the post's
 *                                HOME CARD plus the metadata every OTHER listing
 *                                is built from — title, date, href, taxonomy. The
 *                                Worker therefore holds no metadata at all, and
 *                                one fetch serves every listing on the site.
 *   <prefix>/a/<hash>.bin        one image, sealed under HKDF(postKey, hash)
 *   <prefix>/g/<variant>.bin     one pre-solved bento geometry (see below)
 *   <prefix>/l/index.html        the taxonomy gate: ONE page, carrying no name.
 *                                Which tag or category it is showing arrives in
 *                                the URL fragment, which never leaves the
 *                                browser, and as a hash rather than a name, so a
 *                                forwarded link discloses nothing either.
 *
 * ── Why the geometry is pre-solved ──────────────────────────────────────────
 *
 * The home grid is a constraint solve (helpers/bento-helpers.js), far too heavy
 * to redo in a Worker inside 10ms and too big to ship to a browser. But the grid
 * an authorized reader sees is NOT the public one — a reader who can see two
 * extra posts needs a different arrangement from one who can see none, and the
 * admin can change who sees what without a rebuild.
 *
 * So every arrangement is solved HERE, one per SUBSET of the encrypted posts
 * that fall in a page's date range, and each is sealed under the very keys that
 * subset is made of. A browser holding those keys derives both the path and the
 * key with no index to look at and no second request; a browser holding none
 * cannot tell the files apart from noise, or learn how many there are.
 *
 * Cards are NOT duplicated into a variant — a variant is geometry only, a few
 * hundred bytes — so the cost is 2^k small files per page, not 2^k pages.
 *
 * The OTHER listings — archive, tags, categories — are not pre-solved at all.
 * Their markup is a function of the metadata and nothing else, so the client
 * builds it from the same record it already had to fetch.
 */

const path = require("path");
const vc = require("./lib/vault-crypto");
const state = require("./lib/vault-state");
const store = require("./lib/vault-store");

// A page whose date range holds more encrypted posts than this would need more
// pre-solved arrangements than it is worth writing to disk (2^k). Raising it is
// a decision about build time and public/ size, so it fails loudly rather than
// quietly skipping the reflow.
const MAX_VARIANT_POSTS = 8;

const EXCERPT_CHARS = 220;

function prefix() {
  return String(hexo.theme.config?.backend?.vault_prefix || "/v").replace(/^\/+|\/+$/g, "");
}

function enabled() {
  return hexo.theme.config?.backend?.vault_enable === true && state.all().length > 0;
}

/**
 * Locals for a view rendered outside the route pipeline.
 *
 * `view.render()` binds only REGISTERED helpers. `__` and `_p` are not helpers —
 * Hexo injects them through the `template_locals` filter, which a generator has
 * to run for itself or every `__('…')` in the template is a ReferenceError.
 */
function cardLocals(extra) {
  // Including `site`, which the route pipeline's Locals exposes and filters on
  // this hook reach into without checking (recommendation-helpers reads
  // site.posts directly).
  // `view_dir` is what partial() slices the current view's path against; without
  // it every `partial(...)` inside the card throws before it resolves anything.
  const site = hexo.locals.toObject();
  const locals = Object.assign(
    site,
    {
      site,
      config: hexo.config,
      theme: hexo.theme.config,
      page: {},
      path: "",
      url: "",
      view_dir: path.join(hexo.theme_dir, "layout") + path.sep,
    },
    extra
  );
  return hexo.execFilterSync("template_locals", locals, { context: hexo });
}

/** Route payloads come back as Buffers, strings, streams or thunks. */
function readRoute(routePath) {
  const data = hexo.route.get(routePath);
  if (!data) return Promise.resolve(null);
  if (Buffer.isBuffer(data)) return Promise.resolve(data);
  if (typeof data === "string") return Promise.resolve(Buffer.from(data));

  return new Promise((resolve) => {
    const chunks = [];
    const stream = typeof data === "function" ? data() : data;
    if (!stream || typeof stream.on !== "function") {
      resolve(Buffer.isBuffer(stream) ? stream : null);
      return;
    }
    stream.on("data", (c) => chunks.push(Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", () => resolve(null));
  });
}

/* ─── Assets ───────────────────────────────────────────────────────────────── */

const ASSET_ATTR = /\b(src|data-src)\s*=\s*("|')([^"']+)\2/gi;

let routeToSource = null;

/** `build/images/x.avif` → `images/x.png`, from img-optimizer's own record. */
function sourceOfRoute(routePath) {
  if (!routeToSource) {
    routeToSource = new Map();
    const transcodes = hexo.extend.helper.get("avifTranscodeMap");
    const map = transcodes ? transcodes() : {};
    for (const [rel, route] of Object.entries(map)) routeToSource.set(route, rel);
  }
  return routeToSource.get(routePath) || routePath;
}

/**
 * Record one sealed image, every way it can be named.
 *
 * The Set drives withholding — which plaintext routes must stop being published.
 * The map goes into the post's sealed metadata and is the only way the editor
 * can ever find these bytes: it opens the MARKDOWN, so all it has is a source
 * path, while a sealed image is named by the hash of what it contains.
 *
 * Keyed by BOTH the published route and that source path, so the editor never
 * has to consult `build/manifest.json` for an encrypted post — which is what
 * lets the withheld images be pruned out of that public file entirely.
 */
function noteAsset(entry, routePath, hash) {
  entry.assets = entry.assets || new Set();
  entry.assets.add(routePath);
  entry.assetMap = entry.assetMap || {};
  entry.assetMap[routePath] = hash;
  entry.assetMap[sourceOfRoute(routePath)] = hash;
}

/**
 * Seal every local image the body points at and rewrite the reference to the
 * sealed blob. `data-original-src` is stripped on the way through: img-optimizer
 * adds it to preserve the pre-AVIF path, and that path is the post's own file
 * name — the one piece of plaintext that would otherwise survive encryption.
 */
async function sealAssets(entry, html, routes) {
  const root = String(hexo.config.root || "/");
  const jobs = [];

  let out = html.replace(ASSET_ATTR, (whole, attr, quote, value) => {
    if (/^(data:|blob:|https?:|\/\/|#)/i.test(value)) return whole;
    const routePath = decodeURI(value.split("#")[0].split("?")[0])
      .replace(new RegExp("^" + root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "")
      .replace(/^\/+/, "");
    if (!routePath) return whole;

    const token = `__VAULT_ASSET_${jobs.length}__`;
    jobs.push({ routePath, token, attr });
    return `${attr}="${token}"`;
  });

  out = out.replace(/\s+data-original-src\s*=\s*("|')[^"']*\1/gi, "");

  for (const job of jobs) {
    const bytes = await readRoute(job.routePath);
    if (!bytes) {
      // Not an image this build produced (a theme asset, an external mount).
      // Leave the reference alone rather than breaking it.
      out = out.replace(job.token, job.routePath ? "/" + job.routePath : "");
      continue;
    }

    const hash = vc.assetHash(bytes);
    const key = vc.assetKey(entry.key, hash);
    // Named by the POST KEY as well as the bytes: two encrypted items sharing an
    // image would otherwise claim one path and seal it under two keys.
    routes.set(`${prefix()}/a/${vc.assetPath(entry.key, hash)}.bin`, vc.seal(key, bytes));
    // The reference carries the hash only. `src` is emptied so nothing is
    // requested before the blob has been fetched and decrypted.
    out = out.replace(`${job.attr}="${job.token}"`, `${job.attr}="" data-vault-asset="${hash}"`);
    noteAsset(entry, job.routePath, hash);
  }

  return out;
}

/**
 * The public posts either side of this one by date. Hexo fills `prev`/`next`
 * from `locals.posts`, which an encrypted post is no longer in — without this
 * its footer navigation is simply missing. Both neighbours are public posts, so
 * naming them gives nothing away.
 */
function neighbours(post) {
  const when = post.date.valueOf();
  const ordered = orderedPosts().filter((p) => !p.sticky);
  let next = null; // newer
  let prev = null; // older
  for (const candidate of ordered) {
    const at = candidate.date.valueOf();
    if (at > when) next = candidate;
    else if (at < when && !prev) prev = candidate;
  }
  return { prev, next };
}

/** The post's own cover, sealed and named by hash. Mirrors home-content's
 *  `resolveCover`, minus the branches a vault post cannot take. */
async function sealCover(entry, routes) {
  const post = entry.post;
  if (post.thumbnail === false) return "";
  const raw = post.thumbnail || post.cover || post.banner;
  if (!raw || typeof raw !== "string" || !raw.includes("/")) return "";
  if (/^(data:|https?:|\/\/)/i.test(raw)) return "";

  const root = String(hexo.config.root || "/");
  const direct = raw.replace(new RegExp("^" + root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "")
    .replace(/^\/+/, "");

  // img-optimizer publishes the AVIF derivative at its own route; the source
  // path only resolves when it declined to convert.
  let bytes = null;
  let matched = "";
  for (const candidate of avifCandidates(direct)) {
    bytes = await readRoute(candidate);
    if (bytes) {
      matched = candidate;
      break;
    }
  }
  if (!bytes) return "";

  const hash = vc.assetHash(bytes);
  routes.set(
    `${prefix()}/a/${vc.assetPath(entry.key, hash)}.bin`,
    vc.seal(vc.assetKey(entry.key, hash), bytes)
  );
  // The route that was actually read, not the front-matter path: withholding
  // the wrong one would leave the real derivative published.
  noteAsset(entry, matched, hash);
  return hash;
}

/** The route a public post's cover resolves to, for the shared-image check. */
async function publicCoverRoutes() {
  const root = String(hexo.config.root || "/");
  const out = new Set();

  for (const post of hexo.locals.get("posts").toArray()) {
    if (post.thumbnail === false) continue;
    const raw = post.thumbnail || post.cover || post.banner;
    if (!raw || typeof raw !== "string" || !raw.includes("/")) continue;
    if (/^(data:|https?:|\/\/)/i.test(raw)) continue;

    const direct = raw
      .replace(new RegExp("^" + root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "")
      .replace(/^\/+/, "");
    for (const candidate of avifCandidates(direct)) {
      if (hexo.route.get(candidate)) {
        out.add(candidate);
        break;
      }
    }
  }
  return out;
}

/**
 * Every image the PUBLIC albums point at. An encrypted album shares its
 * category's avatar with them, and often a thumbnail directory too; withholding
 * one of those would blank a public card without protecting anything.
 * `locals.data` is already the masked copy (filters/vault.js), so what it names
 * is by definition public.
 */
function addPublicMasonryRoutes(into) {
  const masonry = (hexo.locals.get("data") || {}).masonry;
  if (!Array.isArray(masonry)) return;

  const add = (value) => {
    if (!value || typeof value !== "string") return;
    const rel = value.replace(/^\/+/, "");
    for (const candidate of avifCandidates(rel)) {
      if (hexo.route.get(candidate)) {
        into.add(candidate);
        break;
      }
    }
  };

  for (const category of masonry) {
    for (const item of (category && category.list) || []) {
      add(item.avatar);
      add(item.thumbnail);
      for (const image of item.images || []) add("masonry/" + image.image);
    }
  }
}

/**
 * Images named by the theme config — the default avatar, the banner, the OG
 * card. They belong to every page on the site, so an album that happens to use
 * one must not take it away from the rest.
 */
function addThemeConfigRoutes(into) {
  const seen = new Set();
  const walk = (node, depth) => {
    if (depth > 6 || node == null) return;
    if (typeof node === "string") {
      if (!node.includes("/") || /^(https?:|data:|\/\/)/i.test(node)) return;
      const rel = node.replace(/^\/+/, "");
      if (seen.has(rel)) return;
      seen.add(rel);
      for (const candidate of avifCandidates(rel)) {
        if (hexo.route.get(candidate)) {
          into.add(candidate);
          break;
        }
      }
      return;
    }
    if (typeof node !== "object") return;
    for (const value of Array.isArray(node) ? node : Object.values(node)) walk(value, depth + 1);
  };
  // `masonry` is skipped: data-handle.js copies the album list onto the theme
  // config, and albums are covered — from the MASKED list — by
  // addPublicMasonryRoutes. Walking the copy would call an encrypted album's own
  // photograph site furniture and publish it.
  const { masonry, ...rest } = hexo.theme.config || {};
  walk(rest, 0);
}

/** Where an image may have ended up once img-optimizer had a turn at it. */
function avifCandidates(relPath) {
  const stripped = relPath.replace(/\.[^./]+$/, "");
  return [
    `build/${stripped}.avif`,
    `build/${relPath}`,
    relPath.replace(/\.[^./]+$/, ".avif"),
    relPath,
  ];
}

/* ─── Metadata ─────────────────────────────────────────────────────────────── */

/**
 * The taxonomy snapshot, shaped like the Query the templates were written
 * against. `filters/vault.js` empties the relation index that backs `post.tags`
 * and `post.categories`, which is what withholds the taxonomy from the public
 * build; every template that renders THIS post is handed the snapshot instead.
 */
function taxList(items) {
  const list = (items || []).slice();
  list.toArray = () => list.slice();
  return list;
}

function plainExcerpt(post, body) {
  const source = post.excerpt && post.excerpt !== "false" ? post.excerpt : body || "";
  const text = String(source)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > EXCERPT_CHARS ? text.slice(0, EXCERPT_CHARS).trimEnd() + "…" : text;
}

/**
 * What every listing OTHER than the home grid is drawn from. Names and paths
 * only: the client re-creates the theme's own markup around them, so archive,
 * tag and category pages need nothing pre-rendered and cannot drift from the
 * public ones.
 */
function withRoot(p) {
  return (String(hexo.config.root || "/") + String(p)).replace(/\/{2,}/g, "/");
}

/**
 * Where a link to this post's tag or category has to point.
 *
 * A taxonomy the post SHARES with a public one still has its page, and the link
 * is the ordinary one. A taxonomy only encrypted posts carry has no page at all
 * — generating one would disclose its name to anyone who guessed the URL — so
 * the link goes to the taxonomy gate, naming it by hash in a fragment.
 *
 * `locals.tags` and `locals.categories` are already the withheld view (the
 * relation index behind their counts was emptied in filters/vault.js), so
 * presence in them IS the test for "a page exists for this".
 */
function taxTarget(kind, name) {
  const published = hexo.locals.get(kind === "tag" ? "tags" : "categories");
  const live = published.findOne ? published.findOne({ name }) : null;
  if (live) return { href: withRoot(live.path), published: true };
  return {
    href: `${withRoot(prefix())}/l/#${kind === "tag" ? "t" : "c"}=${vc.taxHash(kind, name)}`,
    published: false,
  };
}

function metaFor(entry, href, coverAsset, body) {
  const Category = hexo.model("Category");

  const categories = (entry.categories || []).map((cat) => {
    const parent = cat.parent ? Category.findById(cat.parent) : null;
    return {
      name: cat.name,
      path: withRoot(cat.path),
      parent: parent ? withRoot(parent.path) : "",
      ...taxTarget("category", cat.name),
    };
  });

  return {
    id: entry.id,
    slug: entry.slug,
    title: entry.post.title || "",
    date: entry.post.date ? entry.post.date.toISOString() : null,
    updated: entry.post.updated ? entry.post.updated.toISOString() : null,
    href,
    // The editor's two extra facts. `source` is Hexo's own source-relative path
    // (`_posts/x.md`), NOT a repository path — the editor normalises it, and
    // must, because blobs sealed before it did are still out there. `supersedes`
    // is the permalink of the published post this draft stands in for, and the
    // reader uses it to take that post's card out of every listing before
    // putting this one in its place.
    source: entry.post.source || "",
    // Published route -> content hash, for every image this post sealed. The
    // editor walks source path -> route (build/manifest.json) -> hash (here).
    assets: entry.assetMap || {},
    draft: entry.post.draft === true,
    supersedes: entry.post.supersedes || "",
    cover: coverAsset || "",
    excerpt: plainExcerpt(entry.post, body),
    tags: (entry.tags || []).map((tag) => ({
      name: tag.name,
      path: withRoot(tag.path),
      ...taxTarget("tag", tag.name),
    })),
    categories,
  };
}

/**
 * The templates write every taxonomy link with `url_for(tag.path)`, which for a
 * tag only this post carries is a link to a page that was deliberately never
 * generated. Rewriting them here rather than in the browser keeps ONE answer to
 * "where does this tag go" and keeps the client from having to probe for pages.
 */
function retargetTaxonomy(html, meta) {
  let out = html;
  for (const item of meta.tags.concat(meta.categories)) {
    if (item.published) continue;
    out = out.split(`href="${item.path}"`).join(`href="${item.href}"`);
  }
  return out;
}

/* ─── Pagination model ─────────────────────────────────────────────────────── */

/**
 * Exactly what hexo-generator-index does: sort by `order_by`, then a STABLE
 * pass that lifts sticky posts to the front. Getting this wrong solves the grid
 * against a different set of posts than the page actually renders.
 */
function orderedPosts() {
  const cfg = hexo.config.index_generator || {};
  const posts = hexo.locals.get("posts").sort(cfg.order_by || "-date").toArray().slice();
  posts.sort((a, b) => (b.sticky || 0) - (a.sticky || 0));
  return posts;
}

function publicPages() {
  const cfg = hexo.config.index_generator || {};
  const perPage = Number(cfg.per_page != null ? cfg.per_page : hexo.config.per_page) || 10;
  const posts = orderedPosts();

  if (perPage <= 0) return [{ index: 1, posts }];

  const pages = [];
  for (let i = 0; i < posts.length; i += perPage) {
    pages.push({ index: pages.length + 1, posts: posts.slice(i, i + perPage) });
  }
  return pages.length ? pages : [{ index: 1, posts: [] }];
}

/**
 * Which page an encrypted post joins — the one whose date range contains it, so
 * it never displaces a public post onto the next page and cascades through the
 * paginator.
 *
 * STICKY POSTS ARE EXCLUDED FROM THE RANGE. They are pinned to the front
 * regardless of date, so counting them would make page 1's range run back to
 * whenever the oldest pinned post was written. The client applies the same rule
 * against the same cards (source/js/plugins/vault.js), and the two must agree.
 */
function pageRanges(pages) {
  return pages.map((page) => {
    const dates = page.posts.filter((p) => !p.sticky).map((p) => p.date.valueOf());
    return dates.length ? { oldest: Math.min(...dates), newest: Math.max(...dates) } : null;
  });
}

function assignToPages(pages, entries) {
  const buckets = pages.map(() => []);
  const ranges = pageRanges(pages);
  const last = pages.length - 1;

  for (const entry of entries) {
    const when = entry.post.date.valueOf();
    let target = last;
    for (let i = 0; i < pages.length; i++) {
      const range = ranges[i];
      if (!range) continue;
      // Page 1 is open at the top and the final page open at the bottom, so a
      // post newer than everything, or older, still lands somewhere.
      if (when >= range.oldest || i === last) {
        target = i;
        break;
      }
    }
    buckets[target].push(entry);
  }
  return buckets;
}

function subsets(items) {
  const out = [];
  const total = 1 << items.length;
  for (let mask = 1; mask < total; mask++) {
    const pick = [];
    for (let i = 0; i < items.length; i++) if (mask & (1 << i)) pick.push(items[i]);
    out.push(pick);
  }
  return out;
}

/* ─── Generator ────────────────────────────────────────────────────────────── */

hexo.extend.generator.register("redefine_vault", async function (locals) {
  if (!enabled()) return [];

  const routes = new Map();
  const pages = [];
  const entries = state.sorted();
  const p = prefix();

  const cardView = hexo.theme.getView("pages/home/home-article-card.ejs");
  const articleView = hexo.theme.getView("pages/post/article-content.ejs");
  const avifRewrite = hexo.extend.helper.get("avifRewriteHtml");

  // ── articles, assets, cards and metadata ──────────────────────────────────
  for (const entry of entries) {
    // Only the BODY's images are sealed, never the surrounding chrome: the
    // author avatar and other template assets are public site-wide, and
    // withholding one would break every page that uses it.
    const body = await sealAssets(entry, entry.plain, routes);
    const coverAsset = await sealCover(entry, routes);
    const href = `${hexo.config.root || "/"}${p}/${entry.slug}/`.replace(/\/{2,}/g, "/");

    // The whole article, not just its text — banner, title, author, meta, tags,
    // copyright, recommendations, prev/next and the table of contents. A reader
    // who is authorized should see the page every other post gets.
    const page = Object.create(entry.post);
    page.__post = true;
    page.comment = false; // encrypted posts carry no comment thread
    page.content = body;
    Object.assign(page, neighbours(entry.post));
    // The taxonomy getters are backed by the relation index this build has
    // already emptied for this post (filters/vault.js). Hand back the snapshot
    // taken before it went, or the article renders with no tags and no category.
    Object.defineProperty(page, "tags", { value: taxList(entry.tags), enumerable: true });
    Object.defineProperty(page, "categories", { value: taxList(entry.categories), enumerable: true });

    let article = await articleView.render(cardLocals({ page, post: page }));

    // The banner cover is written by the template as a plain path. Swapping it
    // for the sealed hash BEFORE the filter chain below leaves it with an empty
    // src, which img-optimizer then skips — a blanket rewrite afterwards would
    // catch the author avatar too.
    if (coverAsset) {
      article = article.replace(
        /<img\b[^>]*\bclass="[^"]*article-cover-image[^"]*"[^>]*>/i,
        (tag) =>
          tag
            .replace(/\bsrc\s*=\s*("|')[^"']*\1/i, 'src=""')
            .replace(/<img\b/i, `<img data-vault-asset="${coverAsset}"`)
      );
    }

    // THE ORDER THAT MATTERS. A sealed article never becomes a route, so it
    // never passes through `after_render:html` — the pass that rewrites every
    // remaining image to its AVIF derivative. Left out, the author avatar still
    // pointed at /images/avatar.png, whose route img-optimizer had already
    // withdrawn: a 404 on every encrypted post.
    if (avifRewrite) article = avifRewrite(article);

    const meta = metaFor(entry, href, coverAsset, body);
    routes.set(`${p}/${entry.slug}/b.bin`, vc.seal(entry.key, retargetTaxonomy(article, meta)));

    // The MARKDOWN, front matter and all, sealed under the same key as the body.
    // The rendered blob is what a reader gets; this is what the editor opens,
    // and it is the only copy of the source that exists outside the repository.
    routes.set(`${p}/${entry.slug}/s.bin`, vc.seal(entry.key, entry.post.raw || ""));

    const card = await cardView.render(
      cardLocals({
        page: {},
        post: page,
        contentOverride: body,
        isVault: true,
        vaultId: entry.id,
        tile: null,
        cover: "",
        coverAsset,
        href,
        postNumber: 0,
        bentoEnabled: false,
        excerptChars: 1400,
      })
    );

    // One blob, two consumers: the home grid takes `card`, every other listing
    // is built from `meta`. Splitting them would have cost a second fetch per
    // post on the archive, tag and category pages.
    routes.set(
      `${p}/${entry.slug}/c.bin`,
      vc.seal(entry.key, JSON.stringify({ card: retargetTaxonomy(card, meta), meta }))
    );

    // Goes through the normal theme chain, so the gate carries the real navbar,
    // footer and scripts — an unauthorized visitor sees an ordinary 404.
    pages.push({
      path: `${p}/${entry.slug}/index.html`,
      layout: "page",
      data: { type: "vault", vault_slug: entry.slug, title: "", comment: false },
    });
  }

  // ── masonry albums ────────────────────────────────────────────────────────
  // The same three artefacts a post gets — page, card, images — rendered from
  // the theme's own masonry templates so a decrypted album is not a lookalike of
  // the public ones but literally the same markup.
  // page-template, NOT pages/masonry/masonry. A masonry page is a `default`
  // layout (helpers/page-helpers), which means the router renders it through
  // page-template and every rule the gallery has — the CSS columns, the item
  // break-inside, the overlay captions — is written against
  // `.page-template-container`. Sealing the inner partial alone produced an
  // album with no layout at all once it was decrypted.
  const albumView = hexo.theme.getView("pages/page-template.ejs");
  const albumCardView = hexo.theme.getView("pages/masonry/masonry-collection-card.ejs");
  const masonryImages = hexo.extend.helper.get("masonryImages");
  const lazyloadMasonry = hexo.extend.helper.get("lazyloadMasonryHtml");

  for (const entry of state.albums()) {
    const item = entry.item;
    const href = `${hexo.config.root || "/"}${p}/${entry.slug}/`.replace(/\/{2,}/g, "/");
    const images = masonryImages ? masonryImages(item) : item.images || [];

    let album = await albumView.render(
      cardLocals({
        page: {
          type: "masonry",
          title: entry.title,
          images,
          content: "",
          comment: false,
          // No public discussion for an encrypted album, and no public like
          // counts either: both live in a GitHub Discussion whose title and
          // image filenames would sit in the clear. `vault` is what puts the
          // notice in their place (pages/page-template.ejs).
          vault: true,
          masonryReactions: null,
        },
      })
    );

    // The order a routed masonry page gets: AVIF rewrite first (priority 10),
    // then the pass that turns every <img> into an img-preloader (priority 15),
    // which is what puts the album on the lazy pipeline.
    if (avifRewrite) album = avifRewrite(album);
    if (lazyloadMasonry) album = await lazyloadMasonry(album, null);

    routes.set(`${p}/${entry.slug}/b.bin`, vc.seal(entry.key, await sealAssets(entry, album, routes)));

    let card = await albumCardView.render(
      cardLocals({
        f: Object.assign({}, item, { link: href }),
        hasThumbnail: entry.category.has_thumbnail === true,
        isVault: true,
      })
    );
    if (avifRewrite) card = avifRewrite(card);
    card = await sealAssets(entry, card, routes);

    routes.set(
      `${p}/${entry.slug}/c.bin`,
      vc.seal(
        entry.key,
        JSON.stringify({
          card,
          meta: {
            kind: "album",
            id: entry.id,
            slug: entry.slug,
            title: entry.title,
            name: item.name || entry.title,
            description: item.description || "",
            category: entry.category.links_category,
            thumbs: entry.category.has_thumbnail === true,
            href,
            // Where the card goes back, sealed so the public build discloses no
            // gap in the sequence. See markedAlbums in scripts/filters/vault.js.
            index: entry.index,
            pos: entry.pos,
            catIndex: entry.catIndex,
            catPos: entry.catPos,
          },
        })
      )
    );

    pages.push({
      path: `${p}/${entry.slug}/index.html`,
      layout: "page",
      data: {
        type: "vault",
        vault_slug: entry.slug,
        vault_kind: "masonry",
        title: "",
        comment: false,
      },
    });
  }

  // The taxonomy gate. One page for every tag and every category, carrying no
  // name of either: which one it is showing travels in the URL fragment, as a
  // hash, and the fragment is never sent to a server.
  pages.push({
    path: `${p}/l/index.html`,
    layout: "page",
    data: { type: "vault-listing", title: "", comment: false },
  });

  // ── pre-solved geometry ───────────────────────────────────────────────────
  const bentoPlan = hexo.extend.helper.get("bentoPlan");
  const bentoRows = hexo.extend.helper.get("bentoRows");
  const bentoStyle = hexo.extend.helper.get("bentoStyle");
  const bentoClasses = hexo.extend.helper.get("bentoClasses");
  const bentoOn = hexo.theme.config?.home?.bento !== false;

  if (bentoOn && bentoPlan) {
    const pages = publicPages();
    // A draft that supersedes a published post is NOT a new tile: it takes the
    // one that post already holds, on a grid the build already solved. Leaving
    // it in would double the arrangement count for a subset the reader can
    // never ask for — it derives the variant path from the keys of the posts
    // that actually change the grid, and a superseding draft is not one.
    const buckets = assignToPages(
      pages,
      entries.filter((entry) => !entry.post.supersedes)
    );
    const withFeatures = hexo.theme.config?.home?.sidebar?.enable === true;

    for (let i = 0; i < pages.length; i++) {
      const here = buckets[i];
      if (!here.length) continue;
      if (here.length > MAX_VARIANT_POSTS) {
        store.fail(
          `home page ${pages[i].index} has ${here.length} encrypted posts in its date range, ` +
            `over the ${MAX_VARIANT_POSTS} this pre-solves (2^k arrangements). ` +
            `Raise index_generator.per_page, or raise MAX_VARIANT_POSTS in scripts/vault-generator.js.`
        );
      }

      for (const subset of subsets(here)) {
        // Same two passes the index generator applies, so the tile order the
        // client is handed is the order the page would have had all along.
        const merged = pages[i].posts.concat(subset.map((e) => e.post));
        merged.sort((a, b) => b.date.valueOf() - a.date.valueOf());
        merged.sort((a, b) => (b.sticky || 0) - (a.sticky || 0));

        // Identity comes from the stash, never from the model: nothing is
        // written onto a post, so nothing can leak through db.json.
        const vaultIds = new Map(subset.map((e) => [e.post, e.id]));
        const idOf = (post) => vaultIds.get(post) || post.path;

        const plan = bentoPlan(merged, { features: withFeatures });
        const tiles = {};
        // The site cards are laid out by the SAME solve, and a different set of
        // posts moves them: their row on each grid is part of the arrangement,
        // not furniture. Leaving them on the public plan's rows is what dropped
        // tiles behind them when the grid reflowed.
        const features = [];
        for (const tile of plan) {
          if (tile.kind === "feature") {
            features.push({ style: bentoStyle(tile), classes: bentoClasses(tile) });
            continue;
          }
          const post = merged[tile.postIndex];
          tiles[idOf(post)] = {
            tier: tile.tier,
            style: bentoStyle(tile),
            classes: bentoClasses(tile),
            vault: vaultIds.has(post),
          };
        }

        const keys = subset.map((e) => e.key);
        routes.set(
          `${p}/g/${vc.variantPath(pages[i].index, keys)}.bin`,
          vc.seal(vc.variantKey(pages[i].index, keys), JSON.stringify({
            tiles,
            features,
            lgRows: bentoRows(plan, "lg"),
            mdRows: bentoRows(plan, "md"),
            order: plan
              .filter((t) => t.kind !== "feature")
              .map((t) => idOf(merged[t.postIndex])),
          }))
        );
      }
    }
  }

  // ── withhold the plaintext images ─────────────────────────────────────────
  // These routes are the AVIF originals the sealed blobs were made from. Left
  // in place they would be published beside the ciphertext at a guessable path,
  // which is the cheapest possible way around the whole scheme.
  // An image a PUBLIC post also uses is already public, so withholding it would
  // break that post without protecting anything. Bodies AND covers: a cover
  // comes from front matter and never appears in any post's rendered content.
  //
  // The route itself is dropped in filters/vault.js at `after_generate`, not
  // here: Hexo sets every generator's routes AFTER all of them have run, so a
  // removal made from inside a generator is undone before it can take effect.
  const shared = await publicCoverRoutes();
  addPublicMasonryRoutes(shared);
  addThemeConfigRoutes(shared);

  const publicHtml = hexo.locals
    .get("posts")
    .toArray()
    .map((post) => post.content || "")
    .join("");

  const sealedEntries = state.all();
  for (const entry of sealedEntries) {
    for (const routePath of entry.assets || []) {
      if (publicHtml.includes(routePath)) shared.add(routePath);
    }
  }

  let withheld = 0;
  for (const entry of sealedEntries) {
    for (const routePath of entry.assets || []) {
      if (shared.has(routePath)) continue;
      state.withhold(routePath);
      withheld++;
    }
  }

  hexo.log.info(
    `[vault] sealed ${entries.length} post(s) and ${state.albums().length} album(s), ` +
      `${routes.size} blob(s); withholding ${withheld} image(s)`
  );

  return pages.concat(Array.from(routes, ([path, data]) => ({ path, data })));
});
