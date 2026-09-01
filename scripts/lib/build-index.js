"use strict";

/**
 * The content-addressed index behind everything cached in `source/build/`.
 *
 * Both caches this replaces were keyed on mtime — `out.mtimeMs >= in.mtimeMs`
 * for the AVIF transcodes, and an ABSOLUTE path plus mtime for the cover
 * accents. Neither key survives leaving the machine that wrote it:
 *
 *   • git stores no mtimes, so a fresh checkout gives every file the same new
 *     timestamp and the comparison becomes a coin toss — which is why a CI build
 *     re-derives a cache that is sitting right there, and why the AVIF bytes it
 *     produces are its ffmpeg's rather than the ones already published.
 *   • an absolute Windows path never matches on Linux, so the accent cache is a
 *     guaranteed total miss on a runner.
 *   • restoring an image from a backup gives it an OLD mtime, and the stale
 *     AVIF is then served forever with no warning. That one is a live bug on
 *     the authoring machine, not only in CI.
 *
 * So the key is the site-relative POSIX path and the value carries the source's
 * content hash. Both travel, which is what makes one machine's cache every
 * machine's cache.
 *
 * `mtime` and `size` are kept alongside the hash purely as a fast path: when
 * they still match, the recorded hash is taken on trust and the file is not
 * read. A checkout invalidates that on every file exactly once, which is the
 * correct amount of work, and no build after it re-reads anything unchanged.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const VERSION = 1;

/** 64 bits of SHA-256. Collisions are not a threat model here; drift is. */
function hashFile(absPath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(absPath))
    .digest("hex")
    .slice(0, 16);
}

class BuildIndex {
  /**
   * @param {string} buildDir  usually <source>/build
   * @param {string} name      file inside it, e.g. ".images.json"
   */
  constructor(buildDir, name) {
    this.file = path.join(buildDir, name);
    this.entries = {};
    this.dirty = false;

    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed && parsed.version === VERSION && parsed.entries) {
        this.entries = parsed.entries;
      }
    } catch (e) {
      /* absent or unreadable — every lookup simply misses */
    }
  }

  get(key) {
    return this.entries[key];
  }

  /**
   * The source's current content hash, reusing the recorded one when the file
   * has not been touched. Returns null when the file cannot be read.
   */
  hashOf(key, absPath) {
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (e) {
      return null;
    }

    const entry = this.entries[key];
    if (entry && entry.size === stat.size && entry.mtime === stat.mtimeMs) {
      return entry.hash;
    }

    let hash;
    try {
      hash = hashFile(absPath);
    } catch (e) {
      return null;
    }

    // Re-stamp so the next build takes the fast path even though nothing about
    // the CONTENT changed — this is the checkout case.
    if (entry && entry.hash === hash) {
      entry.size = stat.size;
      entry.mtime = stat.mtimeMs;
      this.dirty = true;
    }
    return hash;
  }

  /**
   * Is `key`'s cached product still the right one for the source as it stands?
   * `verify` is handed the entry and decides whether the PRODUCT is intact —
   * an existing file of the recorded size, a value that is still present.
   */
  hit(key, absPath, verify) {
    const entry = this.entries[key];
    if (!entry) return false;
    const hash = this.hashOf(key, absPath);
    if (!hash || hash !== entry.hash) return false;
    return verify ? verify(entry) === true : true;
  }

  record(key, absPath, extra) {
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (e) {
      return;
    }
    const hash = hashFile(absPath);
    this.entries[key] = Object.assign({ hash, size: stat.size, mtime: stat.mtimeMs }, extra || {});
    this.dirty = true;
  }

  /** Drop every key not in `live`. Returns how many went. */
  prune(live) {
    let removed = 0;
    for (const key of Object.keys(this.entries)) {
      if (live.has(key)) continue;
      delete this.entries[key];
      removed++;
    }
    if (removed) this.dirty = true;
    return removed;
  }

  flush() {
    if (!this.dirty) return;
    // Sorted, so the file is diffable and two machines that did the same work
    // produce the same bytes.
    const sorted = {};
    for (const key of Object.keys(this.entries).sort()) sorted[key] = this.entries[key];
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ version: VERSION, entries: sorted }, null, 0), "utf8");
      this.dirty = false;
    } catch (e) {
      /* the caller logs; a cache that cannot be written is slow, not wrong */
    }
  }
}

/**
 * The site-relative POSIX key for an absolute path under `source/` or the
 * theme's `source/`, or null for anything outside both.
 */
function relKey(absPath, sourceDir, themeDir) {
  const roots = [sourceDir, themeDir ? path.join(themeDir, "source") : ""].filter(Boolean);
  for (const root of roots) {
    if (!absPath.startsWith(root)) continue;
    let rel = absPath.slice(root.length);
    if (rel.startsWith(path.sep) || rel.startsWith("/")) rel = rel.slice(1);
    return rel.replace(/\\/g, "/");
  }
  return null;
}

/** AVIF transcoding is skipped entirely — the CI contract. */
function skipAvif() {
  return /^(1|true|yes)$/i.test(String(process.env.RDFX_SKIP_AVIF || "").trim());
}

module.exports = { BuildIndex, hashFile, relKey, skipAvif, VERSION };
