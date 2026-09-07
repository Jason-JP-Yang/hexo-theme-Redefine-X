"use strict";

const fs = require("fs");
const path = require("path");
const { BuildIndex, relKey } = require("../lib/build-index");

/**
 * Redefine-X — build-time cover accent colour.
 *
 * Every home tile that has a cover gets one number written into its markup: the
 * dominant colour of that cover, as `r g b`. The grid then tints the tile's rim
 * light, its index numeral and its text-forward variants with it, so a page of
 * tiles reads as one palette drawn from the images themselves instead of a wall
 * of identical grey cards.
 *
 * It runs once per build, before generation, and is cached against the source
 * file's CONTENT — a rebuild with unchanged covers does no image work at all.
 * Doing it here rather than in the browser is the point: no runtime canvas
 * sampling, no flash of the untinted colour, and no cost on a page view.
 *
 * Keyed on content, not on an absolute path plus mtime — that key never hit on
 * a machine other than the one that wrote it. See scripts/lib/build-index.js.
 *
 * `sharp` is a site dependency (it is what `img-optimizer` transcodes with) and
 * is required lazily, so a site without it simply gets no accents.
 */

const CACHE_FILE = ".accents.json";

// Relative luminance the accent is pulled towards when a cover is nearly black
// or nearly white. Outside this band a tint is either invisible against the
// card or too heavy to sit behind text; inside it, the same alpha reads
// consistently on every tile.
const LUMA_MIN = 0.18;
const LUMA_MAX = 0.62;

const accents = new Map();

/**
 * The cover this post shows in the home grid.
 *
 * Deliberately the same precedence the home template uses — `thumbnail` exists
 * to override the cover in the list, so the accent has to follow whichever one
 * is actually on screen.
 */
function coverOf(post) {
  if (post.thumbnail === false) return "";
  const raw = post.thumbnail || post.cover || post.banner;
  if (!raw || typeof raw !== "string") return "";

  const value = raw.replace(/\\/g, "/").trim();
  if (!value) return "";
  if (/^(https?:)?\/\//.test(value)) return "";

  if (!value.includes("/") && hexo.config.marked && hexo.config.marked.postAsset === true) {
    return [post.path, value].join("/");
  }
  return value;
}

/** Absolute path of a site-relative asset, in the source dir or the theme's. */
function resolveFile(rel) {
  const raw = rel.replace(/^\//, "");
  // Front matter holds paths as they were typed, so most are already literal —
  // but a `%` in a filename would make decoding throw rather than return the
  // name it is already holding.
  let clean = raw;
  try {
    clean = decodeURIComponent(raw);
  } catch (e) {
    /* not percent-encoded */
  }

  const candidates = [
    path.join(hexo.source_dir, clean),
    hexo.theme_dir ? path.join(hexo.theme_dir, "source", clean) : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (e) {
      /* next candidate */
    }
  }
  return "";
}

function luminance(r, g, b) {
  // Rec. 709 on the raw sRGB values. The exact transfer function does not
  // matter here — this only decides whether a colour needs pulling back into
  // the usable band, and the correction below is a scale, not a conversion.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Pull a colour into the usable band while keeping its hue.
 *
 * Dark covers are lifted towards white and bright ones pushed towards black,
 * both by interpolating rather than by scaling channels: scaling a near-black
 * pixel amplifies whatever noise decided its hue, while interpolating keeps the
 * ratio between the channels intact.
 */
function normalise(rgb) {
  const luma = luminance(rgb.r, rgb.g, rgb.b);
  let target = luma;
  if (luma < LUMA_MIN) target = LUMA_MIN;
  else if (luma > LUMA_MAX) target = LUMA_MAX;
  if (target === luma) return rgb;

  // Mixing every channel towards the same endpoint by `t` moves the luminance
  // by exactly t of the distance to that endpoint's luminance, so solving for
  // `t` lands the result on the band edge in one step. Neither denominator can
  // be zero: `target` is only ever a bound the luminance is already outside of.
  const towards = target > luma ? 255 : 0;
  const t = Math.abs(target - luma) / Math.abs(towards / 255 - luma);
  const mix = (c) => Math.round(c + (towards - c) * Math.min(1, Math.max(0, t)));

  return { r: mix(rgb.r), g: mix(rgb.g), b: mix(rgb.b) };
}

async function extract(file) {
  const sharp = require("sharp");
  // `stats()` returns the dominant colour of a 4-bit-per-channel histogram,
  // which is what a reader would call "the colour of this photo" — an average
  // would return the mud between the subject and the background.
  const { dominant } = await sharp(file).stats();
  const { r, g, b } = normalise(dominant);
  return `${r} ${g} ${b}`;
}

async function buildAccents() {
  const posts = hexo.locals.get("posts");
  if (!posts || !posts.length) return;

  const index = new BuildIndex(path.join(hexo.source_dir, "build"), CACHE_FILE);
  const live = new Set();
  let computed = 0;

  for (const post of posts.toArray()) {
    const cover = coverOf(post);
    if (!cover) continue;

    const file = resolveFile(cover);
    if (!file) continue;

    const key = relKey(file, hexo.source_dir, hexo.theme_dir);
    if (!key) continue;
    live.add(key);

    let accent = index.hit(key, file, (entry) => !!entry.accent) ? index.get(key).accent : "";
    if (!accent) {
      try {
        accent = await extract(file);
        computed++;
      } catch (e) {
        // An unreadable or unrasterisable cover (an SVG without librsvg, say)
        // simply has no accent; the tile falls back to the theme colour.
        hexo.log.debug(`[cover-accent] skipped ${cover}: ${e.message}`);
        continue;
      }
      index.record(key, file, { accent });
    }

    accents.set(post.path, accent);
  }

  index.prune(live);
  index.flush();

  if (computed) {
    hexo.log.info(`[cover-accent] extracted ${computed} cover colour${computed === 1 ? "" : "s"}`);
  }
}

hexo.extend.filter.register("before_generate", buildAccents);

/** `r g b` for a post's cover, or "" — consumed as `rgb(var(--tile-accent) / a)`. */
hexo.extend.helper.register("coverAccent", function (post) {
  return (post && accents.get(post.path)) || "";
});
