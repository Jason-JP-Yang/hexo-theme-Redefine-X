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

import { assetURL, registerAssetKey } from "../../tools/vaultCrypto.js";

let manifest = null;
let sealed = null;
let sealedSizes = null;

export function siteRoot() {
  return String((window.config && window.config.root) || "/").replace(/\/+$/, "");
}

/** Fetched once per editing session; a miss simply means nothing is rewritten. */
export async function loadManifest() {
  if (manifest) return manifest;
  try {
    const res = await fetch(`${siteRoot()}/build/manifest.json`, { cache: "no-cache" });
    manifest = res.ok ? await res.json() : {};
  } catch (err) {
    manifest = {};
  }
  return manifest;
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

/** `/source/images/a.png`, `images/a.png`, `/images/a.png` → `images/a.png`. */
export function manifestKey(src) {
  return String(src || "")
    .replace(/^\/+/, "")
    .replace(/^source\//, "")
    .split(/[?#]/)[0];
}

/** `[route, width, height]`, or null when the build never touched this image. */
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
  const row = record(src);
  if (row && row[1] && row[2]) return { width: row[1], height: row[2] };

  // A withheld image is not in the public manifest at all; its size travels in
  // the post's own sealed metadata instead.
  const key = manifestKey(src);
  const wh = sealedSizes && (sealedSizes[routeFor(src)] || sealedSizes[key]);
  return wh && wh[0] ? { width: wh[0], height: wh[1] } : null;
}

/** True once the build has an AVIF (or optimised SVG) for this source image. */
export function isTranscoded(src) {
  return !!record(src);
}

function staged(src, list) {
  return (list || []).find((a) => a.site === src || a.path === src) || null;
}

/**
 * @param {string} src   what the markdown says
 * @param {Array}  list  assets added this session, not yet committed
 */
export function resolveAsset(src, list) {
  const value = String(src || "");
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
  if (!sealed || staged(src, list) || /^(blob:|data:|https?:|\/\/)/i.test(src)) return null;
  return sealed[routeFor(src)] || sealed[manifestKey(src)] || null;
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
 */
export function bindImage(img, src, list) {
  if (!img) return;
  const value = String(src || "");

  if (!value) {
    img.removeAttribute("src");
    return;
  }

  const hash = sealedHash(value, list);

  if (!hash) {
    img.src = resolveAsset(value, list);
    return;
  }

  img.removeAttribute("src");
  img.dataset.edSealed = hash;
  assetURL(hash).then((url) => {
    // The element may have been re-pointed at something else while we waited.
    if (url && img.dataset.edSealed === hash) img.src = url;
  });
}
