"use strict";

/**
 * An image's intrinsic pixels, measured in a way that does not give up early.
 *
 * `image-size` handed a PATH reads only the first 512 KB of the file. A camera
 * JPEG whose EXIF, XMP, ICC profile or maker notes run past that has its frame
 * header beyond the cut, and comes back as "Corrupt JPG, exceeded buffer
 * limits" — a perfectly good picture laid out at the 1000×500 fallback. Handed
 * the whole file as a buffer it reads to the end. What it still cannot parse
 * (an unusual AVIF, CMYK, a malformed-but-decodable header) goes to sharp.
 *
 * Shared by img-optimizer (every source image) and lazyload-handle (every
 * `<img>` a page renders), so one file is read and measured once per build.
 */

const fs = require("fs");
const imageSize = require("image-size");

const cache = new Map();

function fromHeader(buf) {
  try {
    const size = imageSize(buf);
    if (size && size.width && size.height) return { width: size.width, height: size.height };
  } catch (e) {
    /* the decoder below reads more than the header */
  }
  return null;
}

async function fromDecoder(buf) {
  try {
    const m = await require("sharp")(buf, { failOn: "none" }).metadata();
    const height = m.pageHeight || m.height;
    if (m.width && height) return { width: m.width, height };
  } catch (e) {
    /* genuinely unreadable */
  }
  return null;
}

async function measureBuffer(buf) {
  if (!buf || !buf.length) return null;
  return fromHeader(buf) || (await fromDecoder(buf));
}

/** Keyed by size and mtime too, so `hexo server` sees a replaced file. */
function measureFile(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (e) {
    return Promise.resolve(null);
  }
  if (!stat.isFile() || !stat.size) return Promise.resolve(null);

  const key = `${absPath}|${stat.size}|${stat.mtimeMs}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      fs.promises.readFile(absPath).then(measureBuffer, () => null)
    );
  }
  return cache.get(key);
}

module.exports = { measureFile, measureBuffer };
