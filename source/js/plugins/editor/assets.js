/**
 * Where a picture actually lives.
 *
 * The build transcodes what it can to AVIF and WITHDRAWS the original's route,
 * so `/images/x.png` stops being served the moment `/build/images/x.avif`
 * exists. An image it could not transcode keeps its original route and has no
 * AVIF at all. Guessing either way produces a broken picture half the time, so
 * the editor asks: `build/manifest.json` is written by the same pass that makes
 * the decision, and lists exactly what was transcoded and to where.
 *
 * The manifest is the PUBLISHED state, not the repository's cache — which is
 * the right question, because a picture on the canvas is loaded from the site.
 * An image added in this session is in neither and rides a blob URL until the
 * commit that carries it.
 */

let manifest = null;

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

/** `/source/images/a.png`, `images/a.png`, `/images/a.png` → `images/a.png`. */
export function manifestKey(src) {
  return String(src || "")
    .replace(/^\/+/, "")
    .replace(/^source\//, "")
    .split(/[?#]/)[0];
}

/**
 * @param {string} src   what the markdown says
 * @param {Array}  staged  assets added this session, not yet committed
 */
export function resolveAsset(src, staged) {
  const value = String(src || "");
  if (!value) return "";
  if (/^(blob:|data:|https?:|\/\/)/i.test(value)) return value;

  const pending = (staged || []).find((a) => a.site === value || a.path === value);
  if (pending) return pending.url;

  const key = manifestKey(value);
  const out = manifest && manifest[key];
  return `${siteRoot()}/${out || key}`;
}

/** True once the build has an AVIF (or optimised SVG) for this source image. */
export function isTranscoded(src) {
  return !!(manifest && manifest[manifestKey(src)]);
}
