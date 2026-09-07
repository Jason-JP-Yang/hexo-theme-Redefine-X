"use strict";

/**
 * Content-addressed index for everything cached in `source/build/`.
 *
 * Keys are site-relative POSIX paths; values carry the source's content hash.
 * The caches this replaces keyed on mtime (and, for accents, an absolute path),
 * neither of which survives a git checkout — so a runner re-derived a cache
 * sitting right there, and a backup-restored image kept serving a stale AVIF.
 *
 * `mtime`/`size` are a fast path only: when they match, the recorded hash is
 * trusted and the file is not read.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const VERSION = 1;

function hashFile(absPath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(absPath))
    .digest("hex")
    .slice(0, 16);
}

class BuildIndex {
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

  /** Current content hash, reusing the recorded one when the file is untouched. */
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

    // Re-stamp so the next build takes the fast path — the checkout case.
    if (entry && entry.hash === hash) {
      entry.size = stat.size;
      entry.mtime = stat.mtimeMs;
      this.dirty = true;
    }
    return hash;
  }

  /** `verify` decides whether the cached PRODUCT is still intact. */
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
    // Sorted, so two machines doing the same work write the same bytes.
    const sorted = {};
    for (const key of Object.keys(this.entries).sort()) sorted[key] = this.entries[key];
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ version: VERSION, entries: sorted }), "utf8");
      this.dirty = false;
    } catch (e) {
      /* a cache that cannot be written is slow, not wrong */
    }
  }
}

/** Site-relative POSIX key for a path under `source/` or the theme's `source/`. */
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

/* ─── how this build was started ───────────────────────────────────────────── */

/**
 * Encoding is the ONE thing a local build and a CI build may disagree about.
 *
 * AVIF bytes depend on the machine's ffmpeg and libaom, so a runner that
 * encoded would publish different bytes for the same picture every time its
 * image changed. It therefore serves only what `source/build/` already holds,
 * and an image with no cached transcode is published in its original format —
 * heavier, never broken.
 *
 * Three ways to say so, in order of authority. The env var is explicit and
 * wins both ways, so `RDFX_SKIP_AVIF=0` forces encoding on even in CI; the
 * `--action` flag is what a workflow that wants to be obvious about it passes;
 * and CI is detected on its own, so `npm run build` alone is correct on a
 * runner without anything having to remember to set anything.
 */
const BOOL = /^(1|true|yes|on)$/i;
const OFF = /^(0|false|no|off)$/i;

let flagged = false;

/** Called once by scripts/events/build-pipeline.js with the generator's args. */
function setRunMode(args) {
  flagged = !!(args && (args.action || args.ci));
}

function inCI() {
  for (const key of ["GITHUB_ACTIONS", "GITEA_ACTIONS", "CI"]) {
    const value = String(process.env[key] || "").trim();
    if (value && !OFF.test(value)) return true;
  }
  return false;
}

/** AVIF transcoding is skipped entirely — the CI contract. */
function skipAvif() {
  const raw = String(process.env.RDFX_SKIP_AVIF || "").trim();
  if (BOOL.test(raw)) return true;
  if (OFF.test(raw)) return false;
  return flagged || inCI();
}

/** Why, for the one line the build prints about it. */
function skipReason() {
  const raw = String(process.env.RDFX_SKIP_AVIF || "").trim();
  if (BOOL.test(raw)) return "RDFX_SKIP_AVIF";
  if (flagged) return "--action";
  if (inCI()) return "CI";
  return "";
}

module.exports = { BuildIndex, hashFile, relKey, skipAvif, skipReason, setRunMode, VERSION };
