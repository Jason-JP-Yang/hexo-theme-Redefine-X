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

const fs = require("fs");
const path = require("path");
const vc = require("./lib/vault-crypto");
const state = require("./lib/vault-state");
const store = require("./lib/vault-store");
const inventory = require("./lib/post-inventory");
const backend = require("./lib/backend");

// A page whose date range holds more encrypted posts than this would need more
// pre-solved arrangements than it is worth writing to disk (2^k). Raising it is
// a decision about build time and public/ size, so it fails loudly rather than
// quietly skipping the reflow.
const MAX_VARIANT_POSTS = 8;

const EXCERPT_CHARS = 220;

function prefix() {
  return String(backend.resolve(hexo.theme.config).encryption.prefix).replace(/^\/+|\/+$/g, "");
}

function enabled() {
  return backend.resolve(hexo.theme.config).encryption.enable && state.all().length > 0;
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

/**
 * The file a route WOULD be served from, for a route that does not exist yet.
 *
 * Hexo collects every generator's result before it sets a single route, so the
 * built-in asset generator's routes are not in the table while this generator
 * runs — only img-optimizer's, which are set at `before_generate`. An image the
 * optimizer declined to transcode (a CI runner never starts an encoder, and an
 * image added since the last local build has no cached AVIF) therefore looked
 * to this file like an image the build had never produced: its reference was
 * left pointing at its plaintext address, its bytes were never sealed, and
 * `noteAsset` was never called — so it was never withheld either. The
 * photograph was published in the clear beside the ciphertext.
 *
 * Reading it off disk is the same answer the asset generator will give, one
 * pass earlier.
 */
function diskPath(routePath) {
  const rel = String(routePath || "").replace(/^\/+/, "");
  if (!rel || rel.includes("..")) return "";
  // PICTURES only. A sealed article also carries stylesheets and scripts, and
  // those are site furniture: sealing one would take the theme's own JavaScript
  // out of the build and hand every encrypted post a blob where a script tag
  // belongs. The route table is the right answer for them and always was —
  // they are never withheld, so never having found them changed nothing.
  if (!IMAGE_EXT.test(rel)) return "";
  for (const dir of [hexo.source_dir, path.join(hexo.theme_dir, "source")]) {
    const file = path.join(dir, rel);
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    } catch (e) {}
  }
  return "";
}

/** Is this route published at all — by a route already set, or by the file the
 *  asset generator will publish from. */
function routeExists(routePath) {
  return !!(hexo.route.get(routePath) || diskPath(routePath));
}

/** Route payloads come back as Buffers, strings, streams or thunks. */
function readRoute(routePath) {
  const data = hexo.route.get(routePath);
  if (!data) {
    const file = diskPath(routePath);
    if (!file) return Promise.resolve(null);
    try {
      return Promise.resolve(fs.readFileSync(file));
    } catch (e) {
      return Promise.resolve(null);
    }
  }
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
  const source = sourceOfRoute(routePath);

  entry.assets = entry.assets || new Set();
  entry.assets.add(routePath);
  entry.assetMap = entry.assetMap || {};
  entry.assetMap[routePath] = hash;
  entry.assetMap[source] = hash;

  // The size too, from the pass that measured it. A withheld image is kept out
  // of the public manifest on purpose, so this is the only place the editor can
  // learn the box to reserve for it.
  const lookup = hexo.extend.helper.get("lazyloadSizes");
  const sizes = lookup ? lookup() : null;
  const dims = sizes && (sizes.get(routePath) || sizes.get(source));
  if (!dims) return;
  entry.assetSizes = entry.assetSizes || {};
  entry.assetSizes[routePath] = [dims.width, dims.height];
  entry.assetSizes[source] = [dims.width, dims.height];
}

/** A reference as a route path: root stripped, query and fragment gone. */
function routeOf(value) {
  const root = String(hexo.config.root || "/");
  if (!value || /^(data:|blob:|https?:|\/\/|#)/i.test(value)) return "";
  let decoded;
  try {
    decoded = decodeURI(String(value).split("#")[0].split("?")[0]);
  } catch (e) {
    decoded = String(value).split("#")[0].split("?")[0];
  }
  return decoded
    .replace(new RegExp("^" + root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "")
    .replace(/^\/+/, "");
}

/** The published address of a route, as a reference an `<img>` can carry. */
function hrefOf(routePath) {
  return encodeURI(withRoot(routePath));
}

/** Which of this reference's candidate routes is already published in the
 *  clear, or "" when none of them is. */
function publicRouteFor(relPath, shared) {
  if (!shared || !shared.size) return "";
  for (const candidate of assetCandidates(relPath)) {
    if (shared.has(candidate)) return candidate;
  }
  return "";
}

/**
 * Seal every local image the body points at and rewrite the reference to the
 * sealed blob. `data-original-src` is stripped on the way through: img-optimizer
 * adds it to preserve the pre-AVIF path, and that path is the post's own file
 * name — the one piece of plaintext that would otherwise survive encryption.
 *
 * `shared` is every route the PUBLIC build already points at. An image in it is
 * left exactly where it is and the reference points straight at it: sealing a
 * second copy of bytes anybody can already fetch costs a blob per encrypted
 * item and protects nothing, and withholding the route would blank the public
 * page that is entitled to show it.
 */
async function sealAssets(entry, html, routes, shared) {
  const jobs = [];

  let out = html.replace(ASSET_ATTR, (whole, attr, quote, value) => {
    const routePath = routeOf(value);
    if (!routePath) return whole;

    const token = `__VAULT_ASSET_${jobs.length}__`;
    jobs.push({ routePath, token, attr });
    return `${attr}="${token}"`;
  });

  out = out.replace(/\s+data-original-src\s*=\s*("|')[^"']*\1/gi, "");

  for (const job of jobs) {
    const open = publicRouteFor(job.routePath, shared);
    if (open) {
      out = out.replace(`${job.attr}="${job.token}"`, `${job.attr}="${hrefOf(open)}"`);
      continue;
    }

    // The reference can still name the PRE-AVIF path: avifRewriteHtml rewrites
    // only what it can resolve back to a source file, so a path spelled
    // differently from the file on disk — a masonry avatar given the wrong
    // extension in masonry.yml — arrives here untouched. Reading it directly
    // then failed, the reference was left pointing at a withdrawn route, and the
    // derivative was never noted and so never withheld: the picture stayed
    // published in the clear while the card that wanted it showed nothing.
    let bytes = null;
    let matched = "";
    for (const candidate of assetCandidates(job.routePath)) {
      bytes = await readRoute(candidate);
      if (bytes) {
        matched = candidate;
        break;
      }
    }
    if (!bytes) {
      // Not an image this build produced (a theme asset, an external mount).
      // Leave the reference alone rather than breaking it.
      out = out.replace(`${job.attr}="${job.token}"`, `${job.attr}="${hrefOf(job.routePath)}"`);
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
    // The route that was actually READ, not the reference the template wrote:
    // withholding the wrong one leaves the real derivative published.
    noteAsset(entry, matched, hash);
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

/**
 * The post's own cover, sealed and named by hash. Mirrors home-content's
 * `resolveCover`, minus the branches a vault post cannot take.
 *
 * A cover a PUBLIC post also uses comes back as a plain href instead — same
 * rule as `sealAssets`, and the card template takes either.
 *
 * @returns {{hash: string, href: string}}
 */
async function sealCover(entry, routes, shared) {
  const none = { hash: "", href: "" };
  const post = entry.post;
  if (post.thumbnail === false) return none;
  const raw = post.thumbnail || post.cover || post.banner;
  if (!raw || typeof raw !== "string" || !raw.includes("/")) return none;
  if (/^(data:|https?:|\/\/)/i.test(raw)) return none;

  const direct = routeOf(raw);
  if (!direct) return none;

  const open = publicRouteFor(direct, shared);
  if (open) return { hash: "", href: hrefOf(open) };

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
  if (!bytes) return none;

  const hash = vc.assetHash(bytes);
  routes.set(
    `${prefix()}/a/${vc.assetPath(entry.key, hash)}.bin`,
    vc.seal(vc.assetKey(entry.key, hash), bytes)
  );
  // The route that was actually read, not the front-matter path: withholding
  // the wrong one would leave the real derivative published.
  noteAsset(entry, matched, hash);
  return { hash, href: "" };
}

/** The route a public post's cover resolves to, for the shared-image check. */
function addPublicCoverRoutes(into) {
  for (const post of hexo.locals.get("posts").toArray()) {
    if (post.thumbnail === false) continue;
    const raw = post.thumbnail || post.cover || post.banner;
    if (!raw || typeof raw !== "string" || !raw.includes("/")) continue;
    if (/^(data:|https?:|\/\/)/i.test(raw)) continue;

    const direct = routeOf(raw);
    if (!direct) continue;
    for (const candidate of avifCandidates(direct)) {
      if (routeExists(candidate)) {
        into.add(candidate);
        break;
      }
    }
  }
}

/** Every image a PUBLIC post's rendered body points at. Read off the finished
 *  HTML rather than off the markdown, so it names the route the reader is
 *  actually served — AVIF derivative, lazyload `data-src` and all. */
function addPublicBodyRoutes(into) {
  for (const post of hexo.locals.get("posts").toArray()) {
    const html = String(post.content || "");
    if (!html) continue;
    ASSET_ATTR.lastIndex = 0;
    let match;
    while ((match = ASSET_ATTR.exec(html))) {
      const rel = routeOf(match[3]);
      if (rel) into.add(rel);
    }
  }
}

/**
 * Every route the public build already publishes an image at.
 *
 * Settled BEFORE anything is sealed, because both halves of the decision need
 * it: `sealAssets` leaves a shared image where it is rather than sealing a
 * second copy, and the withholding pass must not take it away from the page
 * that is entitled to show it.
 */
function publicRoutes() {
  const out = new Set();
  addPublicCoverRoutes(out);
  addPublicBodyRoutes(out);
  addPublicMasonryRoutes(out);
  addThemeConfigRoutes(out);
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
    const rel = routeOf(value) || value.replace(/^\/+/, "");
    for (const candidate of avifCandidates(rel)) {
      if (routeExists(candidate)) {
        into.add(candidate);
        break;
      }
    }
  };

  for (const category of masonry) {
    for (const item of (category && category.list) || []) {
      add(item.avatar);
      add(item.thumbnail);
      // A leading slash is an absolute site path, not a name inside the album
      // folder — the same rule masonry.ejs's buildImagePath applies. Prefixing
      // it anyway named a route that does not exist, so a public album written
      // that way lost any picture it shares with an encrypted one.
      for (const image of item.images || []) {
        const rel = String(image.image || "");
        add(rel.startsWith("/") ? rel : "masonry/" + rel);
      }
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
      const rel = routeOf(node) || node.replace(/^\/+/, "");
      if (!rel || seen.has(rel)) return;
      seen.add(rel);
      for (const candidate of avifCandidates(rel)) {
        if (routeExists(candidate)) {
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

const IMAGE_EXT = /\.(avif|png|jpe?g|gif|webp|bmp|svg|ico)$/i;

/**
 * The same search for a reference taken out of rendered markup, where `src` may
 * name something that is not a picture at all. A non-image keeps its one exact
 * route: probing `build/js/…` for a script would be a lookup that can only ever
 * find the wrong file.
 */
function assetCandidates(relPath) {
  if (!IMAGE_EXT.test(relPath)) return [relPath];
  return avifCandidates(relPath);
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

/**
 * Where a draft's "view the published version" control points.
 *
 * `supersedes` is the published post's PERMALINK, which is the right address
 * only while that post is public. An encrypted one was never generated at its
 * permalink — its page is `/<prefix>/<slug>/` — so the control 404'd on every
 * draft of an encrypted article. The pairing is by permalink because that is
 * what the draft carries, and both halves are in this same list.
 */
function supersededHref(entries) {
  const published = new Map();
  for (const entry of entries) {
    if (entry.post.draft === true) continue;
    const link = inventory.permalinkOf(entry.post);
    if (link) published.set(link.replace(/^\/+|\/+$/g, ""), entry.slug);
  }

  return function (entry) {
    if (!entry.supersedes) return "";
    const slug = published.get(String(entry.supersedes).replace(/^\/+|\/+$/g, ""));
    return slug ? `${withRoot(prefix())}/${slug}/`.replace(/\/{2,}/g, "/") : "";
  };
}

/**
 * The same question for an album, whose `supersedes` is a page TITLE rather
 * than a permalink: `/masonry/<title>/` when the published album is public,
 * the vault gate when it carries `vault:`.
 */
function supersededAlbumHref() {
  const sealed = new Map();
  for (const entry of state.albums()) {
    if (entry.item && entry.item.draft === true) continue;
    sealed.set(String(entry.title), entry.slug);
  }

  return function (title) {
    const wanted = String(title || "");
    if (!wanted) return "";
    const slug = sealed.get(wanted);
    if (slug) return `${withRoot(prefix())}/${slug}/`.replace(/\/{2,}/g, "/");
    return encodeURI(withRoot(`masonry/${wanted}/`).replace(/\/{2,}/g, "/"));
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
    // Published route -> content hash, and the same keys -> [w, h], for every
    // image this post sealed. The editor walks source path -> route
    // (build/manifest.json) -> hash, and takes the size from here because a
    // withheld image is deliberately absent from that public file.
    assets: entry.assetMap || {},
    sizes: entry.assetSizes || {},
    draft: entry.post.draft === true,
    // Who worked on it. The home card's collaborator pages add this post to
    // their counts only for a reader who holds the key that opened this record
    // — which is the whole reason the number is not settled at build time.
    contributor: entry.post.contributor || "",
    supersedes: entry.supersedes || "",
    // The published post's real page, which is the vault gate when it carries
    // `vault:` — see `supersededHref`.
    supersedesHref: entry.supersedesHref || "",
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

/**
 * What the editor needs to know about a PUBLIC post, in the shape an encrypted
 * one's record already has.
 *
 * Only the fields the document list reads. There is no card and no sealed
 * image: the article is published, so its body and its pictures are wherever
 * the reader gets them, and duplicating either behind a key would double the
 * size of the site to protect something the site already serves.
 */
function sourceMeta(entry) {
  const post = entry.post;
  const href = withRoot(post.path || "");
  return {
    id: entry.id,
    slug: entry.slug,
    title: post.title || "",
    date: post.date ? post.date.toISOString() : null,
    updated: post.updated ? post.updated.toISOString() : null,
    href,
    source: post.source || "",
    draft: false,
    supersedes: "",
    supersedesHref: "",
    contributor: post.contributor || "",
    cover: "",
    excerpt: plainExcerpt(post, post.content || ""),
    assets: {},
    sizes: {},
    tags: post.tags.toArray().map((tag) => ({ name: tag.name, path: withRoot(tag.path), href: withRoot(tag.path), published: true })),
    categories: post.categories.toArray().map((cat) => ({ name: cat.name, path: withRoot(cat.path), href: withRoot(cat.path), published: true })),
  };
}

/**
 * Seal the two copies of masonry.yml the editor opens.
 *
 * `strip` and the runner's merge share one scanner (workflows/ci/lib/masonry.mjs),
 * which is the whole reason this imports from there rather than cutting the file
 * up here: the two have to agree about where an album's block begins and ends,
 * or a round trip through the editor would put one album's lines over another's.
 */
async function sealMasonrySource(routes, p) {
  const pages = state.pages().filter((entry) => entry.page === "masonry" || entry.page === "masonry-open");
  if (!pages.length) return;

  const file = path.join(hexo.source_dir, "_data", "masonry.yml");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return; // a site with no albums has nothing to seal
  }

  const hidden = new Set(state.albums().map((entry) => entry.id));
  const yaml = require("js-yaml");
  // Hexo loads scripts in a VM without a dynamic-import callback.  Use the
  // CommonJS loader instead; recent Node versions can synchronously load this
  // ESM module and this also keeps the generator compatible with Hexo's VM.
  const { strip } = require("../workflows/ci/lib/masonry.mjs");

  let masked = text;
  try {
    masked = hidden.size ? strip(yaml, text, hidden) : text;
  } catch (err) {
    // A file the shared scanner cannot read is one the runner could not merge
    // back either, so failing here is the earlier and louder of the two.
    store.fail(`masonry.yml cannot be split per album — ${err.message}`);
  }

  for (const entry of pages) {
    routes.set(`${p}/${entry.slug}/y.bin`, vc.seal(entry.key, entry.page === "masonry" ? text : masked));
  }
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

  // Settled once, before a single blob is sealed — see `publicRoutes`.
  const shared = publicRoutes();
  const swapHref = supersededHref(entries);

  // ── articles, assets, cards and metadata ──────────────────────────────────
  for (const entry of entries) {
    // Only the BODY's images are sealed, never the surrounding chrome: the
    // author avatar and other template assets are public site-wide, and
    // withholding one would break every page that uses it.
    const body = await sealAssets(entry, entry.plain, routes, shared);
    const cover = await sealCover(entry, routes, shared);
    const coverAsset = cover.hash;
    const href = `${hexo.config.root || "/"}${p}/${entry.slug}/`.replace(/\/{2,}/g, "/");

    // The whole article, not just its text — banner, title, author, meta, tags,
    // copyright, recommendations, prev/next and the table of contents. A reader
    // who is authorized should see the page every other post gets.
    const page = Object.create(entry.post);
    page.__post = true;
    page.comment = false; // encrypted posts carry no comment thread
    page.content = body;
    // Resolved by filters/vault from the draft's file name, and shadowed onto
    // the derived object rather than written back onto the model. The article's
    // version control and the card's badge both read it from here.
    page.supersedes = entry.supersedes || "";
    // Where "view the published version" actually goes. A published post that
    // carries `vault:` has no public permalink at all — its page is the vault
    // gate — so linking to `supersedes` was a 404 on exactly the drafts whose
    // published half is encrypted. Resolved here because only the build knows
    // which slug that post was sealed under.
    entry.supersedesHref = swapHref(entry) || "";
    page.supersedesHref = entry.supersedesHref;
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
        cover: cover.href,
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
  const albumSwapHref = supersededAlbumHref();

  for (const entry of state.albums()) {
    const item = entry.item;
    const href = `${hexo.config.root || "/"}${p}/${entry.slug}/`.replace(/\/{2,}/g, "/");
    const images = masonryImages ? masonryImages(item) : item.images || [];

    let album = await albumView.render(
      cardLocals({
        page: {
          type: "masonry",
          title: entry.title,
          contributor: item.contributor || "",
          images,
          content: "",
          comment: false,
          // No public discussion for an encrypted album, and no public like
          // counts either: both live in a GitHub Discussion whose title and
          // image filenames would sit in the clear. `vault` is what puts the
          // notice in their place (pages/page-template.ejs).
          vault: true,
          masonryReactions: null,
          // Only a sealed page ever carries these: a draft album is withheld
          // from the public build entirely, so the banner they draw exists
          // nowhere a reader could reach.
          albumDraft: item.draft === true,
          albumSupersedes: item.supersedes || "",
          albumSupersedesHref: albumSwapHref(item.supersedes),
        },
      })
    );

    // The order a routed masonry page gets: AVIF rewrite first (priority 10),
    // then the pass that turns every <img> into an img-preloader (priority 15),
    // which is what puts the album on the lazy pipeline.
    if (avifRewrite) album = avifRewrite(album);
    if (lazyloadMasonry) album = await lazyloadMasonry(album, null);

    routes.set(
      `${p}/${entry.slug}/b.bin`,
      vc.seal(entry.key, await sealAssets(entry, album, routes, shared))
    );

    let card = await albumCardView.render(
      cardLocals({
        f: Object.assign({}, item, { link: href }),
        hasThumbnail: entry.category.has_thumbnail === true,
        isVault: true,
        isDraft: item.draft === true,
        supersedes: item.supersedes || "",
      })
    );
    if (avifRewrite) card = avifRewrite(card);
    card = await sealAssets(entry, card, routes, shared);

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
            // Same as a post's: an album counts towards its collaborators' Posts
            // number, for the readers who can open it.
            contributor: item.contributor || "",
            // What this album IS, for the one reader who holds the key: a draft
            // standing in front of a published album, an album never published,
            // or an encrypted album. The editor opens the draft rather than the
            // album behind it on the strength of these two, and Posts Management
            // badges the row from them.
            draft: item.draft === true,
            supersedes: item.supersedes ? String(item.supersedes) : "",
            supersedesHref: albumSwapHref(item.supersedes),
            // The same two the post branch writes, and for the same reason: an
            // album's photographs are withheld from build/manifest.json, so
            // this is the ONLY record of what they are called and what they
            // weigh. Written after `b.bin` above, which is the pass that seals
            // them and fills the map. Without it the editor's picture browser
            // showed an album with most of its photographs missing.
            assets: entry.assetMap || {},
            sizes: entry.assetSizes || {},
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

  // ── the editor's copy of everything it may open ───────────────────────────
  //
  // Two blobs per item, under that item's own key, and neither is ever fetched
  // by a reader:
  //
  //   s.bin  the markdown, front matter and all (posts). Already written above
  //          for an encrypted post; written here for every other one.
  //   y.bin  the album's slice of masonry.yml, plus where in the file it sits.
  //          The editor sends a PATCH naming this album, never the whole file,
  //          which is what makes a per-album permission enforceable at all.
  //   r.bin  the Posts Management row. Identical in shape to a row in the
  //          admin's sealed inventory because it IS one — indexed out of the
  //          same build, so the two can never describe the same post
  //          differently.
  //
  // This is what replaced the repository token the browser used to hold. A key
  // released here opens one item; it is not the key to the site, and holding
  // one says nothing about how many others exist.
  const keyed = {
    posts: new Map(state.sources().map((e) => [e.post.source, { id: e.id, slug: e.slug }])),
    albums: new Map(state.albumSources().map((e) => [e.title, { id: e.id, slug: e.slug }])),
  };
  const inv = inventory.build(hexo, entries, state.albums(), p, keyed);

  const rowFor = new Map();
  for (const row of inv.items) {
    if (row.vaultId) rowFor.set(row.vaultId, row);
    // A draft is folded INTO the row of the article it stands in front of, so
    // it has no row of its own to find. The editor addresses it by its own id,
    // and gets the row that describes both halves — which is the row Posts
    // Management draws for it either way.
    if (row.draft && row.draft.id) rowFor.set(row.draft.id, row);
  }

  for (const entry of state.sources()) {
    routes.set(`${p}/${entry.slug}/s.bin`, vc.seal(entry.key, entry.post.raw || ""));
    // The same `meta` an encrypted post's c.bin carries, so the editor's
    // document list reads one shape rather than two. A public post has no
    // sealed images and no card — its body is on the site — so `assets` and
    // `sizes` are empty here by construction rather than by omission.
    routes.set(
      `${p}/${entry.slug}/c.bin`,
      vc.seal(entry.key, JSON.stringify({ meta: sourceMeta(entry) }))
    );
  }

  for (const entry of state.albumSources()) {
    routes.set(
      `${p}/${entry.slug}/c.bin`,
      vc.seal(
        entry.key,
        JSON.stringify({
          meta: {
            kind: "album",
            id: entry.id,
            slug: entry.slug,
            title: entry.title,
            name: entry.item.name || entry.title,
            description: entry.item.description || "",
            category: entry.category.links_category || "",
            thumbs: entry.category.has_thumbnail === true,
            href: withRoot(`masonry/${entry.title}/`),
            contributor: entry.item.contributor || "",
            draft: false,
            supersedes: "",
            supersedesHref: "",
            assets: {},
            sizes: {},
            index: entry.index,
            pos: entry.pos,
            catIndex: entry.catIndex,
            catPos: entry.catPos,
          },
        })
      )
    );
  }

  for (const entry of state.all()) {
    const row = rowFor.get(entry.id);
    if (!row) continue;
    routes.set(`${p}/${entry.slug}/r.bin`, vc.seal(entry.key, JSON.stringify(row)));
  }

  // masonry.yml itself, twice: as it is, and with every withheld album cut out
  // of it. The album editor works on a whole file because its parser keeps the
  // comments and the ordering, and the runner merges whichever version comes
  // back one album at a time — so the masked copy is a complete, valid file
  // that simply does not mention what its reader may not see.
  await sealMasonrySource(routes, p);

  // ── the admin surface ─────────────────────────────────────────────────────
  //
  //   b.bin  the console's markup. Under the ADMIN key it also carries the post
  //          inventory, which names every article on the site and is the one
  //          thing a scoped collaborator must never be handed.
  //   e.bin  the composer, which is the article layout with nothing in it.
  //   m.bin  the same for an album: the gallery layout with nothing in it.
  //   o.bin  who the collaborators are — a login and an address each, the
  //          identity a commit is signed with.
  //
  // ── Why the markup is sealed TWICE ────────────────────────────────────────
  //
  // Once under a key every collaborator holds, and once under the admin's. It
  // is a few kilobytes, and what it buys is that the admin's console depends on
  // exactly one key: the one they have held since before collaborators existed.
  // Sealing it only under the collaborator key made the owner of the blog
  // reliant on a row a build had to have registered and a request that had to
  // have answered — so a half-applied deploy, or a reconcile that had not run
  // yet, locked the admin out of the page they would use to find out why.
  const resolved = backend.resolve(hexo.theme.config);
  const editor = resolved.online_editor;
  const adminEntry = state.pages().find((entry) => !entry.page);
  const consoleEntry = state.pages().find((entry) => entry.page === "console");

  const consoleView = hexo.theme.getView("pages/management/blog-management.ejs");
  const shell = await consoleView.render(cardLocals({ page: { type: "blog-management" } }));
  const shellHTML = avifRewrite ? avifRewrite(shell) : shell;

  let composerHTML = "";
  let albumHTML = "";
  if (editor.enable) {
    const composerView = hexo.theme.getView("pages/management/editor.ejs");
    const composer = await composerView.render(cardLocals({ page: { type: "blog-editor" } }));
    composerHTML = avifRewrite ? avifRewrite(composer) : composer;

    const albumComposerView = hexo.theme.getView("pages/management/album.ejs");
    const albumComposer = await albumComposerView.render(cardLocals({ page: { type: "album-editor" } }));
    albumHTML = avifRewrite ? avifRewrite(albumComposer) : albumComposer;
  }

  // The MARKUP, under the key every collaborator holds. It is the theme's own
  // layout with nothing in it — what a person is shown inside it is decided by
  // the Worker's grades and painted by blog-management.js — so there is nothing
  // here to withhold from somebody who has been given a section of it.
  if (consoleEntry) {
    routes.set(
      `${p}/${consoleEntry.slug}/b.bin`,
      vc.seal(consoleEntry.key, JSON.stringify({ shell: shellHTML }))
    );
    if (editor.enable) {
      routes.set(`${p}/${consoleEntry.slug}/e.bin`, vc.seal(consoleEntry.key, composerHTML));
      routes.set(`${p}/${consoleEntry.slug}/m.bin`, vc.seal(consoleEntry.key, albumHTML));
    }
  }

  // The same markup AND the inventory, under the admin's. The inventory names
  // every post on the site, which is precisely what a collaborator scoped to
  // three articles must not be handed — they build their own list from the
  // items they were actually given (`r.bin`), a request each for three rows.
  if (adminEntry) {
    routes.set(
      `${p}/${adminEntry.slug}/b.bin`,
      vc.seal(adminEntry.key, JSON.stringify({ shell: shellHTML, inventory: inv }))
    );
    if (editor.enable) {
      routes.set(`${p}/${adminEntry.slug}/e.bin`, vc.seal(adminEntry.key, composerHTML));
      routes.set(`${p}/${adminEntry.slug}/m.bin`, vc.seal(adminEntry.key, albumHTML));
    }
    // The roster, and nothing else. It used to carry the private repository's
    // coordinates too — the editor needed them to commit there. Nothing commits
    // there from a browser now, so the only private thing left is who the
    // collaborators are: a login and an address each, which is the identity a
    // commit is signed with and not something to put in a public page.
    routes.set(
      `${p}/${adminEntry.slug}/o.bin`,
      vc.seal(adminEntry.key, JSON.stringify({ collaborators: resolved.collaborators }))
    );
  }

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
      entries.filter((entry) => !entry.supersedes)
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
  // These routes are the originals the sealed blobs were made from. Left in
  // place they would be published beside the ciphertext at a guessable path,
  // which is the cheapest possible way around the whole scheme.
  //
  // Everything a public page shows was taken out before sealing began, so
  // `entry.assets` already holds only what nothing public points at — the
  // second test here is belt and braces against a spelling the two passes
  // resolved differently.
  //
  // The route itself is dropped in filters/vault.js at `after_generate`, not
  // here: Hexo sets every generator's routes AFTER all of them have run, so a
  // removal made from inside a generator is undone before it can take effect.
  let withheld = 0;
  for (const entry of state.all()) {
    for (const routePath of entry.assets || []) {
      if (shared.has(routePath)) continue;
      state.withhold(routePath);
      withheld++;
      // The pre-AVIF file is still on disk and still under `source/`, so Hexo's
      // asset generator would publish it at its own route however thoroughly
      // the derivative was withheld.
      const origin = sourceOfRoute(routePath);
      if (origin !== routePath && !shared.has(origin)) state.withhold(origin);
    }
  }

  hexo.log.info(
    `[vault] sealed ${entries.length} post(s) and ${state.albums().length} album(s), ` +
      `${routes.size} blob(s); withholding ${withheld} image(s)`
  );

  return pages.concat(Array.from(routes, ([path, data]) => ({ path, data })));
});
