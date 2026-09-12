/**
 * Where a picture actually lives.
 *
 * Three questions, and getting any of them wrong shows a broken image:
 *
 * 1. IS IT STAGED? An image added in this session exists only as bytes in the
 *    tab until the commit that carries it. It rides a blob: URL.
 *
 * 2. WAS IT COMPRESSED? The build transcodes what it can to AVIF and WITHDRAWS
 *    the original's route, so `/images/x.png` stops being served the moment
 *    `/build/images/x.avif` exists — while an image it declined to convert has
 *    no AVIF at all and keeps its original route. Guessing is wrong half the
 *    time, so the editor asks: `build/manifest.json` is written by the same
 *    pass that decides, and lists exactly what was transcoded and to where.
 *
 * 3. IS IT ENCRYPTED? A picture used only by an encrypted post is published at
 *    NEITHER path — the vault seals the bytes to `<prefix>/a/<path>.bin` and
 *    withholds the plaintext route, which is the whole point. It can only be
 *    fetched and decrypted, and it is named by the hash of its contents, which
 *    the markdown does not carry. The post's sealed metadata carries the
 *    `route -> hash` map, and `setVaultAssets` hands it over when a document
 *    opens. An image shared with a public post is still public, has no map
 *    entry, and correctly falls through to (2).
 *
 * The manifest is the PUBLISHED state, not the repository's cache — the right
 * question, because a picture on the canvas is loaded from the site.
 */

import { assetURL, dropAssetKeys, registerAssetKey } from "../../tools/vaultCrypto.js";
import { blobURL } from "./repo.js";

let manifest = null;
let sealed = null;
let sealedSizes = null;
let vaultIndex = null;

export function siteRoot() {
  return String((window.config && window.config.root) || "/").replace(/\/+$/, "");
}

/** Fetched once per editing session; a miss simply means nothing is rewritten. */
export async function loadManifest(force) {
  if (manifest && !force) return manifest;
  try {
    const res = await fetch(`${siteRoot()}/build/manifest.json`, {
      cache: force ? "reload" : "no-cache",
    });
    manifest = res.ok ? await res.json() : {};
  } catch (err) {
    manifest = {};
  }
  return manifest;
}

/** `source path -> [route, width, height, bytes]`, for callers that want it all. */
export function manifestRows() {
  return manifest || {};
}

/**
 * Erase what this module learned, down to the decryption keys.
 *
 * The manifest is public and the sealed maps are not: the vault-wide index
 * carries a key for every withheld picture on the site, and it was registered
 * for the browser's benefit. It goes with the session. The OPEN DOCUMENT's own
 * hashes are left alone — the page behind the editor is still showing that
 * article, and plugins/vault.js registered the same keys for it.
 */
export function forgetAssets() {
  if (vaultIndex) {
    const mine = new Set(sealed ? Object.values(sealed) : []);
    dropAssetKeys(Object.values(vaultIndex).map((row) => row.hash).filter((hash) => !mine.has(hash)));
  }
  manifest = null;
  vaultIndex = null;
}

/**
 * Which sealed images this document owns, and the key that opens them.
 * Called with no map for a public post, which clears the previous document's.
 */
export function setVaultAssets(grant, assets, sizes) {
  sealed = grant && assets && Object.keys(assets).length ? assets : null;
  sealedSizes = sealed ? sizes || null : null;
  if (!sealed) return;
  for (const hash of Object.values(sealed)) registerAssetKey(hash, grant.raw);
}

/**
 * Every sealed image in the vault, not just this document's.
 *
 * The picture browser is a browser over the whole library, so it previews
 * pictures belonging to posts other than the open one — and a withheld image is
 * published at NO plaintext route, so asking the site for one is a guaranteed
 * 404 followed by the browser's broken-picture glyph. This is what stops that
 * request being made: consulted only when the public manifest does not list the
 * image, which is exactly the withheld case. See session.js `sealedIndex`.
 */
export function setVaultIndex(rows) {
  vaultIndex = rows && Object.keys(rows).length ? rows : null;
}

/**
 * The vault-wide record for an image the public manifest does not carry.
 * `at` is already where the bytes ARE — see `here`, which must not run twice.
 */
function withheld(at) {
  if (!vaultIndex || record(at)) return null;
  return vaultIndex[routeFor(at)] || vaultIndex[manifestKey(at)] || null;
}

/** `/source/images/a.png`, `images/a.png`, `/images/a.png` → `images/a.png`. */
export function manifestKey(src) {
  return String(src || "")
    .replace(/^\/+/, "")
    .replace(/^source\//, "")
    .split(/[?#]/)[0];
}

/* ─── a picture that is about to be renamed is still at its old address ────── */

/**
 * Where the bytes are RIGHT NOW, whatever the markdown has been changed to say.
 *
 * Renaming a picture in the browser does not rename anything: it records a move
 * and rewrites the addresses in the post, and the file only arrives at its new
 * name when the commit lands and the next build sweeps the rest of the site.
 * Until then the site — and the repository — still serve the OLD path.
 *
 * So there are two different questions about one picture, and conflating them
 * is what made every renamed image break the moment it was renamed:
 *
 *   what the document SAYS   → the new address, which is what gets committed
 *   where the bytes ARE      → the old one, which is what a request must use
 *
 * Every fetching path below asks this first, and nothing else in the editor has
 * to know that a rename is pending. The editor installs the mapping when it
 * opens (it is the staged tidy-up, run backwards) and clears it when it closes.
 */
let rewind = null;

export function registerRewind(fn) {
  rewind = fn;
}

function here(src) {
  const value = String(src || "");
  if (!rewind || !value) return value;
  try {
    return rewind(value) || value;
  } catch (err) {
    return value;
  }
}

/** `[route, width, height, bytes]`, or null when the build never touched this image. */
function record(src) {
  const row = manifest && manifest[manifestKey(src)];
  return Array.isArray(row) ? row : null;
}

/** The path this image is published at, compressed or not. */
function routeFor(src) {
  const row = record(src);
  return row ? row[0] : manifestKey(src);
}

/**
 * The intrinsic size the BUILD measured, so the editor can reserve the same box
 * the published page reserves. Zeros mean unknown — a staged image, or one no
 * page referenced — and the caller leaves the aspect ratio to the browser.
 */
export function imageSize(src) {
  const at = here(src);
  const row = record(at);
  if (row && row[1] && row[2]) return { width: row[1], height: row[2] };

  // A withheld image is not in the public manifest at all; its size travels in
  // the post's own sealed metadata instead — or, for one belonging to another
  // post, in the vault-wide index the browser builds from every grant.
  const key = manifestKey(at);
  const wh = sealedSizes && (sealedSizes[routeFor(at)] || sealedSizes[key]);
  if (wh && wh[0]) return { width: wh[0], height: wh[1] };

  const row2 = withheld(at);
  return row2 && row2.width ? { width: row2.width, height: row2.height } : null;
}

/** `/images/a.png` → `source/images/a.png`, which is what the repository calls it. */
export function repoPath(src) {
  const key = manifestKey(here(src));
  return key ? "source/" + key : "";
}

/**
 * The same picture, read out of the repository instead of off the site.
 *
 * Used only after the site has said it does not have it — the minutes between
 * committing an image and the deploy that publishes it, which is exactly when
 * the author is most likely to be looking at it.
 */
export function repoURL(src, list) {
  const value = here(src);
  if (!value || /^(blob:|data:|https?:|\/\/)/i.test(value)) return Promise.resolve("");
  if (staged(value, list)) return Promise.resolve("");
  return blobURL(repoPath(value));
}

function staged(src, list) {
  return (list || []).find((a) => a.site === src || a.path === src) || null;
}

/**
 * @param {string} src   what the markdown says
 * @param {Array}  list  assets added this session, not yet committed
 */
export function resolveAsset(src, list) {
  const value = here(src);
  if (!value) return "";
  if (/^(blob:|data:|https?:|\/\/)/i.test(value)) return value;

  const pending = staged(value, list);
  if (pending) return pending.url;

  return `${siteRoot()}/${routeFor(value)}`;
}

/**
 * The hash of the sealed copy of this image, if this document has one.
 *
 * Two spellings, because a withheld image is deliberately absent from the
 * public manifest: the published route when it is listed there, and the source
 * path when it is not. The sealed map carries both keys.
 */
function sealedHash(src, list) {
  const at = here(src);
  if (staged(at, list) || /^(blob:|data:|https?:|\/\/)/i.test(at)) return null;
  const mine = sealed && (sealed[routeFor(at)] || sealed[manifestKey(at)]);
  if (mine) return mine;
  const other = withheld(at);
  return (other && other.hash) || null;
}

// What the build reserves for an image it could not measure.
const FALLBACK = { width: 1000, height: 500 };

/**
 * The image, as the published page builds it.
 *
 * Not an `<img>`: every image in an article is a `.img-preloader` that the
 * lazyload observer turns into one when it is about to be seen. Emitting the
 * same node is what makes the editor load, size, skeleton and open images the
 * way the page does — anything else is a second image pipeline that will drift.
 *
 * Mirrors `buildPreloaderDiv` in scripts/filters/lazyload-handle.js.
 */
export function buildPreloader(src, alt, list) {
  const el = document.createElement("div");
  el.className = "img-preloader";
  el.dataset.alt = alt || "";
  // What the markdown says, kept beside what it resolved to: the repository
  // fallback needs the address, and `data-src` by then is a published route.
  el.dataset.edSrc = String(src || "");

  // A sealed image has no URL until its bytes are decrypted, so it carries the
  // hash instead and the registered resolver opens it — the same path an
  // encrypted post's images take for a reader.
  const hash = sealedHash(String(src || ""), list);
  if (hash) el.dataset.vaultAsset = hash;
  else el.dataset.src = resolveAsset(src, list);

  const staging = staged(String(src || ""), list);
  const dims = (staging && staging.width ? staging : imageSize(src)) || FALLBACK;
  el.dataset.width = dims.width;
  el.dataset.height = dims.height;
  el.style.aspectRatio = (dims.width / dims.height).toFixed(6);
  el.style.maxWidth = "100%";

  el.innerHTML =
    `<svg viewBox="0 0 ${dims.width} ${dims.height}" class="img-preloader-shim"` +
    ` style="width:100%;height:auto;display:block;opacity:0;pointer-events:none"></svg>` +
    `<div class="img-preloader-skeleton"></div>`;

  return el;
}

/**
 * Point an `<img>` at this source, decrypting first where that is the only way
 * to see it.
 *
 * Sealed images cannot be resolved synchronously and must not be requested at
 * their plaintext path in the meantime — that path 404s, and a broken image is
 * what the reader would be left looking at. So `src` is cleared and filled in
 * when the bytes arrive; `assetURL` fetches and decrypts each blob once however
 * many callers ask.
 *
 * `data-ready` is set here and nowhere else — "0" while there is nothing to
 * show, "1" once it decodes, "err" when every route has been tried. It belongs
 * here because only this function knows a failure is not final: the repository
 * retry below clears `src` and asks again, and a caller watching `error` called
 * that the end and dropped its skeleton onto a picture that was about to
 * arrive. Clearing `src` first is what takes the browser's broken-picture glyph
 * out of the box while that second question is being asked.
 */
export function bindImage(img, src, list) {
  if (!img) return;
  const value = String(src || "");

  img.dataset.ready = "0";
  img.onload = () => (img.dataset.ready = "1");
  delete img.dataset.edSealed;
  delete img.dataset.edSrc;

  if (!value) {
    img.onerror = null;
    img.removeAttribute("src");
    img.dataset.ready = "err";
    return;
  }

  const hash = sealedHash(value, list);

  if (!hash) {
    img.dataset.edSrc = value;
    img.onerror = () => {
      img.onerror = null;
      img.removeAttribute("src");
      repoURL(value, list).then((url) => {
        if (img.dataset.edSrc !== value) return;
        if (url) img.src = url;
        else img.dataset.ready = "err";
      });
    };
    img.src = resolveAsset(value, list);
    return;
  }

  img.onerror = null;
  img.removeAttribute("src");
  img.dataset.edSealed = hash;
  assetURL(hash).then((url) => {
    // The element may have been re-pointed at something else while we waited.
    if (img.dataset.edSealed !== hash) return;
    if (url) img.src = url;
    else img.dataset.ready = "err";
  });
}

/**
 * The intrinsic pixels of a picture, whether the build measured it or this
 * session did. The picker sizes its preview from this rather than letting the
 * image size itself, so the skeleton reserves the shape the picture will be.
 */
export function naturalSize(src, list) {
  const pending = staged(here(src), list);
  if (pending && pending.width) return { width: pending.width, height: pending.height };
  return imageSize(src);
}
