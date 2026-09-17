"use strict";

/**
 * The activity archive — the site's own copy of Umami's daily numbers.
 *
 * WHY IT EXISTS. The home page's activity card used to ask Umami for two years of
 * daily buckets from the READER's browser: several requests per visitor behind a
 * half-hour cache, against the same instance that was recording the visit. A
 * calendar of finished days is not live data, and every one of those requests
 * made the analytics database re-aggregate a year that had not changed since the
 * last time it was asked. The build asks instead — once, only for the days it does
 * not already hold — and the page carries the answer. A reader makes no analytics
 * request at all.
 *
 * THE ARCHIVE IS THE RECORD, not a cache: it is committed, and it outlives
 * whatever retention the instance is set to. Three rules follow from that.
 *
 *   TODAY IS NEVER STORED. The current UTC day is still being counted, so a
 *   number read out of it is wrong by however much of the day is left. The
 *   archive ends at yesterday, and nothing may write past it.
 *
 *   NOTHING IS OVERWRITTEN BLIND. A build with no credential, or against an
 *   instance that is down, leaves every stored day exactly as it is. A failed
 *   fetch must never be able to publish an empty calendar.
 *
 *   ONE LINE PER DAY, so the commit that carries a new day is a one-line diff
 *   instead of a rewritten file.
 */

const fs = require("fs");
const path = require("path");
const { env } = require("./secrets");

// Umami refuses a `unit` finer than the span allows: getMinimumUnit returns
// `month` once a range covers more than seven calendar months, and the request
// layer then silently substitutes it — a year asked for in one go comes back as
// twelve monthly totals. So a long span is asked for in pieces.
const CHUNK = 180;

// The first build has no archive and asks for everything. The ceiling is only
// here so a mis-read creation date cannot ask for a century.
const BOOTSTRAP_MAX = 3650;

// What the page carries. The archive keeps every day forever; the home page is
// handed only the tail the card could possibly draw (pulseCard.js MAX_DAYS).
const PAGE_DAYS = 730;

const TIMEOUT = 20000;

const DAY = 86400000;

/* ─── UTC days ────────────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, "0");

/** A UTC instant to its day key. */
function keyOf(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
}

/** A day key back to the UTC midnight that starts it. */
function msOf(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || "").trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

const shift = (ms, days) => ms + days * DAY;

/** Yesterday, UTC — the last day whose count is finished. */
function lastFinished(now) {
  const d = new Date(now);
  return shift(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), -1);
}

/* ─── the file ────────────────────────────────────────────────────────────── */

function read(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && parsed.days ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One day per line, dates ascending. The shape is not cosmetic: this file gets a
 * commit every night, and a single-line diff is the difference between a history
 * that can be read in a log and one that cannot.
 */
function write(file, data) {
  const keys = Object.keys(data.days).sort();
  const lines = keys.map((k) => `    "${k}": [${data.days[k][0]}, ${data.days[k][1]}]`);
  const text =
    "{\n" +
    `  "updated": ${JSON.stringify(data.updated)},\n` +
    `  "website": ${JSON.stringify(data.website)},\n` +
    `  "timezone": "UTC",\n` +
    `  "metric": ["views", "visits"],\n` +
    `  "through": ${JSON.stringify(data.through)},\n` +
    `  "days": {\n${lines.join(",\n")}\n  }\n` +
    "}\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

/* ─── Umami ───────────────────────────────────────────────────────────────── */

async function ask(url, token) {
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    throw new Error("unreachable (" + (e && e.name === "TimeoutError" ? "timed out" : e.message) + ")");
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/** The website's own creation date — where "all of it" starts. */
async function firstDay(host, id, token) {
  const site = await ask(host + "/api/websites/" + encodeURIComponent(id), token);
  const at = site && (site.createdAt || site.created_at);
  const ms = at ? Date.parse(at) : NaN;
  return isNaN(ms) ? null : msOf(keyOf(ms));
}

/**
 * Daily counts for one window, gaps filled with zero.
 *
 * Umami returns only the buckets that had rows, so a quiet Tuesday is ABSENT
 * rather than zero — and an archive that stored only what came back could never
 * tell "no traffic" from "never asked". The window is known, so every day in it
 * is written.
 *
 * `x` is a wall-clock string in the requested timezone, not an instant: the first
 * ten characters are the day, and parsing it as a date would shift the edges.
 */
async function chunk(host, id, token, from, to) {
  const url =
    host +
    "/api/websites/" +
    encodeURIComponent(id) +
    "/pageviews?" +
    new URLSearchParams({
      startAt: String(from),
      endAt: String(to + DAY - 1),
      unit: "day",
      timezone: "UTC",
    });

  const data = await ask(url, token);
  const views = new Map();
  const visits = new Map();
  const collect = (rows, into) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = String(row.x || "").slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(key)) into.set(key, (into.get(key) || 0) + Number(row.y || 0));
    }
  };
  collect(data && data.pageviews, views);
  collect(data && data.sessions, visits);

  const out = {};
  for (let at = from; at <= to; at = shift(at, 1)) {
    const key = keyOf(at);
    out[key] = [views.get(key) || 0, visits.get(key) || 0];
  }
  return out;
}

/* ─── the one entry point ─────────────────────────────────────────────────── */

/**
 * Bring the archive up to yesterday.
 *
 * @param {object} options
 * @param {string} options.file       source/_data/analytics.json
 * @param {string} options.host       Umami base URL
 * @param {string} options.websiteId  which site's numbers
 * @param {Function} [options.log]
 * @returns {Promise<{ok: boolean, added: number, through: string|null, why: string}>}
 */
async function refresh({ file, host, websiteId, log = () => {} }) {
  const base = String(host || "").replace(/\/+$/, "");
  const id = String(websiteId || "");
  const stored = read(file);
  const have = stored ? stored.days : {};

  // A different website is a different archive. Keeping the old days would mix
  // two sites' traffic into one calendar, silently.
  const fresh = !stored || (stored.website && id && stored.website !== id);
  const days = fresh ? {} : { ...have };

  const token = env("UMAMI_TOKEN");
  if (!base || !id) return { ok: false, added: 0, through: stored && stored.through, why: "not configured" };
  if (!token) {
    return {
      ok: false,
      added: 0,
      through: stored && stored.through,
      why: "no UMAMI_TOKEN — keeping " + Object.keys(days).length + " stored day(s)",
    };
  }

  const end = lastFinished(Date.now());
  const keys = Object.keys(days).sort();
  let start;
  if (keys.length) {
    start = shift(msOf(keys[keys.length - 1]), 1);
  } else {
    let from = null;
    try {
      from = await firstDay(base, id, token);
    } catch (e) {
      log("could not read the website's start date (" + e.message + "), taking two years");
    }
    start = from === null ? shift(end, -(PAGE_DAYS - 1)) : from;
    if (end - start > BOOTSTRAP_MAX * DAY) start = shift(end, -(BOOTSTRAP_MAX - 1));
  }

  if (start > end) {
    return { ok: true, added: 0, through: stored && stored.through, why: "already through yesterday" };
  }

  // Oldest window first, and the file is written after each one: a fetch that
  // dies halfway through a two-year bootstrap has still made progress, and the
  // next build picks up where it stopped rather than starting again.
  let added = 0;
  for (let at = start; at <= end; at = shift(at, CHUNK)) {
    const to = Math.min(shift(at, CHUNK - 1), end);
    let got;
    try {
      got = await chunk(base, id, token, at, to);
    } catch (e) {
      if (added) break;
      return {
        ok: false,
        added: 0,
        through: stored && stored.through,
        why: keyOf(at) + ".." + keyOf(to) + " failed: " + e.message,
      };
    }
    Object.assign(days, got);
    added += Object.keys(got).length;
    write(file, {
      updated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      website: id,
      through: keyOf(to),
      days,
    });
  }

  return { ok: true, added, through: keyOf(end), why: fresh && stored ? "website changed, archive restarted" : "" };
}

/**
 * The tail the page carries: one start date and a dense run of daily view counts.
 *
 * Dense rather than keyed, because the page's copy is read by a calendar and not
 * by a human — and because the archive may have holes in it, which a calendar
 * cannot have.
 */
function sealed(archive, maxDays = PAGE_DAYS) {
  const days = (archive && archive.days) || {};
  const keys = Object.keys(days).sort();
  if (!keys.length) return null;

  const end = msOf(keys[keys.length - 1]);
  if (isNaN(end)) return null;
  const first = msOf(keys[0]);
  const span = Math.min(maxDays, Math.round((end - first) / DAY) + 1);
  const from = shift(end, -(span - 1));

  const views = [];
  for (let at = from; at <= end; at = shift(at, 1)) {
    const row = days[keyOf(at)];
    views.push(row ? Number(row[0]) || 0 : 0);
  }
  return { from: keyOf(from), views };
}

module.exports = { refresh, sealed, read, keyOf, PAGE_DAYS };
