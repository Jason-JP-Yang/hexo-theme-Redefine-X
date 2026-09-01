"use strict";

/**
 * The build's idea of "now". SOURCE_DATE_EPOCH (unix seconds) pins it so two
 * builds of one commit agree; unset, this is the wall clock and nothing changes.
 * Read by bento-helpers (recency weighting), notifications-generator
 * (changelog.json) and the footer year — all three reach published files.
 */

const raw = String(process.env.SOURCE_DATE_EPOCH || "").trim();
const pinnedMs = /^\d+$/.test(raw) ? Number(raw) * 1000 : null;

function now() {
  return pinnedMs === null ? Date.now() : pinnedMs;
}

function date() {
  return new Date(now());
}

/** ISO 8601 to the second — the shape every timestamp this theme emits uses. */
function iso(value) {
  return (value || date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

module.exports = { now, date, iso, pinned: pinnedMs !== null };
