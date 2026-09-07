"use strict";

/**
 * The build's idea of "now". SOURCE_DATE_EPOCH (unix seconds) pins it so two
 * builds of one commit agree; unset, this is the wall clock and nothing changes.
 * Read by bento-helpers (recency weighting), notifications-generator
 * (changelog.json) and the footer year — all three reach published files.
 *
 * The value is read on FIRST USE rather than when this module is required.
 * Hexo loads theme scripts in directory order, so a module that stamped itself
 * at require time was pinned or not depending on whether the script that sets
 * the variable happened to sort earlier — which is not a thing a reproducible
 * build may depend on. Reading late means `pin()` at `after_init` is always in
 * time, and nothing renders before that.
 */

let resolved;

function read() {
  if (resolved !== undefined) return resolved;
  const raw = String(process.env.SOURCE_DATE_EPOCH || "").trim();
  resolved = /^\d+$/.test(raw) ? Number(raw) * 1000 : null;
  return resolved;
}

/** Pin the clock to a unix-seconds timestamp. An explicit env var still wins. */
function pin(seconds) {
  if (!/^\d+$/.test(String(seconds))) return false;
  if (String(process.env.SOURCE_DATE_EPOCH || "").trim()) return false;
  process.env.SOURCE_DATE_EPOCH = String(seconds);
  resolved = undefined;
  return true;
}

function now() {
  const pinned = read();
  return pinned === null ? Date.now() : pinned;
}

function date() {
  return new Date(now());
}

/** ISO 8601 to the second — the shape every timestamp this theme emits uses. */
function iso(value) {
  return (value || date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

module.exports = {
  now,
  date,
  iso,
  pin,
  get pinned() {
    return read() !== null;
  },
};
