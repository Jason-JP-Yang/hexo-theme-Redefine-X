"use strict";

/**
 * The build's idea of "now".
 *
 * Three things in this theme read the wall clock while rendering and put the
 * answer into a published file: the home grid's recency weighting, which is an
 * input to a cost function and can therefore change the ARRANGEMENT of the page
 * as posts age; changelog.json's `generated_at`; and the footer's year. Two
 * builds of the same commit on two different days do not produce the same bytes,
 * so no pipeline can prove it reproduced what was published.
 *
 * SOURCE_DATE_EPOCH is the reproducible-builds convention for exactly this:
 * unix SECONDS, and when it is set the build reads it instead of the clock.
 * Unset — every ordinary local build — nothing changes.
 *
 * https://reproducible-builds.org/specs/source-date-epoch/
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
