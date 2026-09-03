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
export function setVaultAssets(grant, assets) {
  sealed = grant && assets && Object.keys(assets).length ? assets : null;
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

/** The path this image is published at, compressed or not. */
function routeFor(src) {
  const key = manifestKey(src);
  return (manifest && manifest[key]) || key;
}

/** True once the build has an AVIF (or optimised SVG) for this source image. */
export function isTranscoded(src) {
  return !!(manifest && manifest[manifestKey(src)]);
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

  // Two spellings, because a withheld image is deliberately absent from the
  // public manifest: the published route when it is listed there, and the
  // source path when it is not. The sealed map carries both keys.
  const hash =
    sealed && !staged(value, list) && !/^(blob:|data:|https?:|\/\/)/i.test(value)
      ? sealed[routeFor(value)] || sealed[manifestKey(value)]
      : null;

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
