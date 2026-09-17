/**
 * The console's Analytics section — Umami's own dashboard, rebuilt in the
 * theme's vocabulary, panel for panel.
 *
 *   Overview     five headline metrics against the previous period; the traffic
 *                chart with its compare lines; Pages, Sources, Environment and
 *                Location as tabbed ranked tables; the compare table; and the
 *                world map beside the weekly traffic grid.
 *   Events       four metrics, the event series stacked by name, the ranked
 *                event list, the sortable activity log, the property explorer.
 *   Sessions     five metrics, the sortable session table, the property explorer.
 *   Performance  a percentile picker, the five web vitals as selectable cards,
 *                the p50/p75/p95 chart, the pages and environment tables.
 *   Breakdown    any combination of dimensions, crossed, with every metric.
 *
 * The browser talks to Umami DIRECTLY with the bearer the Worker released.
 *
 * Three things this file is built around:
 *
 *   THE CHART IS DRAWN AT MEASURED PIXEL SIZE rather than in a stretched
 *   viewBox. That is what makes an axis possible: a stretched box cannot carry a
 *   tick, a gridline or a label without deforming them.
 *
 *   EVERY BUCKET IS DRAWN. The API returns only the buckets it has rows for, so
 *   a quiet Tuesday is absent rather than zero. Left as it comes back, the
 *   chart silently closes the gap and a week of nothing reads as a week of
 *   traffic. The series are aligned onto a generated calendar instead.
 *
 *   NOTHING IS WIPED TO BE REDRAWN. A repaint diffs the new markup against what
 *   is on screen by key and touches only the parts that actually changed, so
 *   picking a tab does not blank the page and a chart that did not change is
 *   never redrawn. Nothing is disabled while it waits either: the wait is drawn
 *   on the panel that is waiting, and every other control stays live.
 *
 *   NOTHING IS ASKED FOR TWICE. Both the answers and the markup built from them
 *   are kept for the session, so a tab, a range or a sort already looked at comes
 *   back with no request and no frame in between. Memory only — it goes when the
 *   session does.
 */

import { escapeHTML } from "./notifications-inbox.js";
import { adminQuery, adminReport, adminToken, timezone } from "../tools/analytics.js";

const VIEWS = ["overview", "events", "sessions", "performance", "breakdown"];

// [days, default unit, label]
const RANGES = [
  [1, "hour", "24h"],
  [7, "day", "7d"],
  [30, "day", "30d"],
  [90, "day", "90d"],
  [180, "day", "6m"],
  [365, "month", "1y"],
];

const UNITS = ["hour", "day", "month"];

// The four tabbed panels of the overview, exactly as Umami groups them.
const PANELS = [
  [
    "pages",
    [
      ["path", "a_f_path"],
      ["fullPath", "a_f_url"],
      ["entry", "a_entry"],
      ["exit", "a_exit"],
    ],
  ],
  [
    "sources",
    [
      ["referrer", "a_f_referrer"],
      ["channel", "a_channel"],
    ],
  ],
  [
    "environment",
    [
      ["browser", "a_f_browser"],
      ["os", "a_f_os"],
      ["device", "a_f_device"],
    ],
  ],
  [
    "location",
    [
      ["country", "a_f_country"],
      ["region", "a_f_region"],
      ["city", "a_f_city"],
    ],
  ],
];

const VITALS = [
  ["lcp", "LCP", 2500, 4000],
  ["inp", "INP", 200, 500],
  ["cls", "CLS", 0.1, 0.25],
  ["fcp", "FCP", 1800, 3000],
  ["ttfb", "TTFB", 800, 1800],
];

const VITAL_NAMES = {
  lcp: "Largest Contentful Paint",
  inp: "Interaction to Next Paint",
  cls: "Cumulative Layout Shift",
  fcp: "First Contentful Paint",
  ttfb: "Time to First Byte",
};

const PERCENTILES = ["p50", "p75", "p95"];

const FIELDS = [
  ["path", "a_f_path"],
  ["entry", "a_entry"],
  ["exit", "a_exit"],
  ["title", "a_f_title"],
  ["query", "a_f_query"],
  ["referrer", "a_f_referrer"],
  ["channel", "a_channel"],
  ["hostname", "a_f_hostname"],
  ["browser", "a_f_browser"],
  ["os", "a_f_os"],
  ["device", "a_f_device"],
  ["screen", "a_f_screen"],
  ["language", "a_f_language"],
  ["country", "a_f_country"],
  ["region", "a_f_region"],
  ["city", "a_f_city"],
  ["tag", "a_f_tag"],
];

// Breakdown is validated against Umami's own `fieldsParam` enum, which is a
// SHORTER list: entry, exit, screen and channel are not groupable, and sending
// them is a 400 rather than an empty table.
const BREAKDOWN_FIELDS = FIELDS.filter(
  ([f]) => !["entry", "exit", "screen", "channel"].includes(f),
);

const PAGE_SIZE = 10;
const LIST_LIMIT = 10;
const LIST_MORE = 30;

// Rendered views kept for the session. Sixty is more than a reader reaches in one
// sitting and small enough that the whole thing is a few hundred kilobytes.
const CACHE_MAX = 60;

// Traffic and the weekly grid open on a log axis, where one outlying day does not
// flatten the other twenty-nine. A count of events has no decades to spread, so
// that chart has no scale picker at all.
const SCALES = { traffic: "log", weekly: "log", events: "linear", vitals: "linear" };

// Umami's own CHART_COLORS, in Umami's own order. A chart palette is not a brand
// palette: these twelve are picked to stay apart from each other at a two-pixel
// bar width, which is a different job from matching the site accent, and mixing
// the accent into all of them is what made the last attempt read as mud.
// Resolved through the stylesheet so the three that need it can be re-tuned per
// colour scheme.
const SERIES = Array.from({ length: 12 }, (_, i) => `var(--bma-p${i + 1})`);

// Traffic keeps the accent, as Umami does — two alphas of one hue, the bar's
// height the views and the split the repeat reading.
const TRAFFIC = ["var(--bma-visitors)", "var(--bma-views)"];
const TRAFFIC_PREV = [SERIES[3], SERIES[2]];

let section = null;
let t = (k, f) => f;
let state = null;
let charts = new Map();
let chartObserver = null;
let scrollObserver = null;
let geo = { map: null, region: null, asked: false };

// Renders in flight, so the wait can be drawn where it belongs: `bodyRuns` for a
// change that moves the whole view, `panelRuns` keyed by the panel that asked.
let bodyRuns = 0;
let panelRuns = new Map();

/* ─── formatting ──────────────────────────────────────────────────────────── */

const num = (v) => Number(v || 0);

function compact(v) {
  const n = num(v);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(n * 100) / 100);
}

const full = (v) => Math.round(num(v)).toLocaleString();

function duration(seconds) {
  const s = Math.max(0, Math.round(num(seconds)));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

function vital(key, value) {
  const n = num(value);
  if (key === "cls") return n.toFixed(3);
  return n >= 1000 ? (n / 1000).toFixed(2) + "s" : Math.round(n) + "ms";
}

const share = (part, whole) => (num(whole) ? Math.round((num(part) / num(whole)) * 100) : 0);

function delta(now, before) {
  const a = num(now);
  const b = num(before);
  if (!b) return a ? null : 0;
  return Math.round(((a - b) / b) * 100);
}

function when(value) {
  const d = new Date(value);
  if (isNaN(d)) return "";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return t("a_now", "just now");
  if (diff < 3600) return Math.floor(diff / 60) + "m";
  if (diff < 86400) return Math.floor(diff / 3600) + "h";
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + "d";
  return d.toLocaleDateString();
}

const stamp = (value) => {
  const d = new Date(value);
  return isNaN(d) ? 0 : d.getTime();
};

function locale() {
  return document.documentElement.lang || undefined;
}

/* ─── time buckets ────────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, "0");

function bucketKey(date, unit) {
  const month = date.getFullYear() + "-" + pad(date.getMonth() + 1);
  if (unit === "month") return month;
  const day = month + "-" + pad(date.getDate());
  return unit === "hour" ? day + " " + pad(date.getHours()) : day;
}

/**
 * The API's `x` is a local wall-clock string, not an instant — the request
 * carries the timezone. Reading it with `new Date(string)` would let a trailing
 * Z or an offset shift the bucket by a whole day at the ends of the range, so
 * the parts are taken literally.
 */
function parseBucket(x) {
  const s = String(x == null ? "" : x);
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[ T](\d{2}))?/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 1, m[4] ? +m[4] : 0);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function bucketsBetween(from, to, unit) {
  const cursor = new Date(from);
  if (unit === "month") {
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);
  } else if (unit === "hour") {
    cursor.setMinutes(0, 0, 0);
  } else {
    cursor.setHours(0, 0, 0, 0);
  }

  const keys = [];
  // 400 daily, 745 hourly or 13 monthly buckets is the widest any range here
  // asks for; the ceiling is only there so a bad clock cannot spin forever.
  while (cursor <= to && keys.length < 1000) {
    keys.push(bucketKey(cursor, unit));
    if (unit === "hour") cursor.setHours(cursor.getHours() + 1);
    else if (unit === "month") cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

/** The buckets the current range covers, whether or not the API returned them. */
function bucketsFor(unit) {
  const { start, end } = rangeOf(state.days);
  return bucketsBetween(start, end, unit);
}

/** Rows onto a calendar: an absent bucket becomes a zero rather than a gap. */
function align(list, keys, unit) {
  const by = new Map();
  for (const r of list || []) {
    const d = parseBucket(r.x != null ? r.x : r.t);
    if (!d) continue;
    const k = bucketKey(d, unit);
    by.set(k, (by.get(k) || 0) + num(r.y));
  }
  return keys.map((k) => ({ x: k, y: by.get(k) || 0 }));
}

/**
 * Drop the buckets before the first reading.
 *
 * Only the LEADING run: a quiet stretch in the middle is a fact about the site
 * and closing it up would be a lie about when the traffic happened.
 */
function trimLead(series) {
  const points = series.reduce((m, s) => Math.max(m, s.data.length), 0);
  let first = 0;
  while (first < points - 1 && series.every((s) => !num(s.data[first] && s.data[first].y))) {
    first++;
  }
  if (!first) return series;
  return series.map((s) => Object.assign({}, s, { data: s.data.slice(first) }));
}

function bucketLabel(x, unit) {
  const s = String(x);
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[ ](\d{2}))?/.exec(s);
  if (!m) return s;
  if (unit === "hour") return String(+m[4]) + ":00";
  if (unit === "month") return m[1].slice(2) + "/" + m[2];
  return m[2] + "/" + m[3];
}

function rangeOf(days) {
  const end = new Date();
  const start = new Date(end);
  if (days <= 1) {
    // Quantised to the minute. The range goes into every request's cache key, so
    // a millisecond-accurate "now" would give each panel of the 24-hour view its
    // own key and turn one dashboard into a dozen requests.
    end.setSeconds(0, 0);
    start.setTime(end.getTime() - 24 * 3600e3);
  } else {
    end.setHours(23, 59, 59, 999);
    start.setTime(end.getTime());
    start.setDate(start.getDate() - (days - 1));
    start.setHours(0, 0, 0, 0);
  }
  return { startAt: start.getTime(), endAt: end.getTime(), start, end };
}

/**
 * Which units are worth offering for the current span.
 *
 * The floor is Umami's: it clamps anything finer than the range allows
 * (lib/date.getAllowedUnits), so `hour` over a year would be a button that
 * silently does nothing. The ceiling is this file's: `month` over 24 hours is a
 * button that works and draws one bar.
 */
function allowedUnits() {
  const d = state.days;
  const min = d <= 30 ? "hour" : d <= 180 ? "day" : "month";
  const max = d <= 2 ? "hour" : d <= 90 ? "day" : "month";
  return UNITS.slice(UNITS.indexOf(min), UNITS.indexOf(max) + 1);
}

function unitFor() {
  const allowed = allowedUnits();
  if (state.unit && allowed.includes(state.unit)) return state.unit;
  const fallback = (RANGES.find(([d]) => d === state.days) || [0, "day"])[1];
  return allowed.includes(fallback) ? fallback : allowed[0];
}

/* ─── names and icons ─────────────────────────────────────────────────────── */

const display = {};

/** Intl carries every country and language name already; a table would be dead weight. */
function named(kind, code) {
  const value = String(code || "").trim();
  if (!value) return "";
  try {
    if (!display[kind]) display[kind] = new Intl.DisplayNames([locale() || "en"], { type: kind });
    return display[kind].of(kind === "region" ? value.toUpperCase() : value) || value;
  } catch {
    return value;
  }
}

function flag(code) {
  const c = String(code || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  return String.fromCodePoint(...[...c].map((ch) => 127397 + ch.charCodeAt(0)));
}

// Umami's own display names, so `chrome` reads as Chrome and `Mac OS` as macOS.
const BROWSER_NAMES = {
  android: "Android",
  aol: "AOL",
  bb10: "BlackBerry 10",
  beaker: "Beaker",
  browser: "Unknown",
  chrome: "Chrome",
  "chromium-webview": "Chrome (webview)",
  crios: "Chrome (iOS)",
  curl: "Curl",
  edge: "Edge",
  "edge-chromium": "Edge (Chromium)",
  "edge-ios": "Edge (iOS)",
  facebook: "Facebook",
  firefox: "Firefox",
  fxios: "Firefox (iOS)",
  ie: "IE",
  instagram: "Instagram",
  ios: "iOS",
  "ios-webview": "iOS (webview)",
  kakaotalk: "KakaoTalk",
  miui: "MIUI",
  opera: "Opera",
  "opera-mini": "Opera Mini",
  phantomjs: "PhantomJS",
  safari: "Safari",
  samsung: "Samsung",
  searchbot: "Searchbot",
  silk: "Silk",
  yandexbrowser: "Yandex",
};

const OS_DISPLAY = {
  "Android OS": "Android",
  "Chrome OS": "ChromeOS",
  "Mac OS": "macOS",
  "Sun OS": "SunOS",
  "Windows 10": "Windows 10/11",
};

// Font Awesome is already on every page of this site, brands included, so the
// icons cost nothing and match the rest of the console's iconography.
const BROWSER_ICONS = [
  [/edge/, "fa-brands fa-edge"],
  [/(chrome|chromium|crios)/, "fa-brands fa-chrome"],
  [/(firefox|fxios)/, "fa-brands fa-firefox-browser"],
  [/(safari|^ios)/, "fa-brands fa-safari"],
  [/opera/, "fa-brands fa-opera"],
  [/(samsung|miui|huawei|oppo|vivo)/, "fa-solid fa-mobile-screen"],
  [/(yandex|qq|uc|baidu|sogou|maxthon|360)/, "fa-solid fa-compass"],
  [/(curl|bot|phantom)/, "fa-solid fa-robot"],
  [/(facebook|instagram|kakaotalk)/, "fa-solid fa-share-nodes"],
];

const OS_ICONS = [
  [/windows/, "fa-brands fa-windows"],
  [/(mac|ios|ipad|iphone)/, "fa-brands fa-apple"],
  [/android/, "fa-brands fa-android"],
  [/ubuntu/, "fa-brands fa-ubuntu"],
  [/(linux|debian|fedora|centos|arch|suse)/, "fa-brands fa-linux"],
  [/chrome/, "fa-brands fa-chrome"],
];

const DEVICE_ICONS = {
  desktop: "fa-solid fa-display",
  laptop: "fa-solid fa-laptop",
  mobile: "fa-solid fa-mobile-screen",
  tablet: "fa-solid fa-tablet-screen-button",
  tv: "fa-solid fa-tv",
  wearable: "fa-solid fa-stopwatch",
  console: "fa-solid fa-gamepad",
  embedded: "fa-solid fa-microchip",
};

const CHANNEL_ICONS = {
  direct: "fa-solid fa-arrow-right-to-bracket",
  search: "fa-solid fa-magnifying-glass",
  organic: "fa-solid fa-magnifying-glass",
  social: "fa-solid fa-share-nodes",
  referral: "fa-solid fa-link",
  email: "fa-solid fa-envelope",
  paid: "fa-solid fa-tag",
  affiliate: "fa-solid fa-handshake",
  video: "fa-solid fa-play",
  llm: "fa-solid fa-robot",
  shopping: "fa-solid fa-cart-shopping",
  unknown: "fa-solid fa-circle-question",
};

const FIELD_ICONS = {
  path: "fa-regular fa-file-lines",
  fullPath: "fa-solid fa-link",
  entry: "fa-solid fa-right-to-bracket",
  exit: "fa-solid fa-right-from-bracket",
  title: "fa-solid fa-heading",
  query: "fa-solid fa-question",
  hostname: "fa-solid fa-server",
  screen: "fa-solid fa-ruler-combined",
  language: "fa-solid fa-language",
  tag: "fa-solid fa-hashtag",
  event: "fa-solid fa-bolt",
  session: "fa-solid fa-fingerprint",
};

const match = (table, value) => {
  const v = String(value || "").toLowerCase();
  for (const [re, cls] of table) if (re.test(v)) return cls;
  return null;
};

const dot = (cls) => `<span class="bma-ico"><i class="${cls}" aria-hidden="true"></i></span>`;

/**
 * The mark that goes in front of a value.
 *
 * A referrer gets its real favicon and anything with a country gets that
 * country's flag — including a region and a city, which is the whole reason
 * those rows carry a `country` alongside the name.
 */
function mark(type, value, row) {
  const v = String(value == null ? "" : value);
  const country = row && row.country;

  if (type === "country") {
    const f = flag(v);
    return f ? `<span class="bma-ico bma-flag">${f}</span>` : dot("fa-solid fa-globe");
  }
  if (type === "region" || type === "city") {
    const f = flag(country);
    return f ? `<span class="bma-ico bma-flag">${f}</span>` : dot("fa-solid fa-location-dot");
  }
  if (type === "browser") return dot(match(BROWSER_ICONS, v) || "fa-solid fa-window-maximize");
  if (type === "os") return dot(match(OS_ICONS, v) || "fa-solid fa-desktop");
  if (type === "device") return dot(DEVICE_ICONS[v.toLowerCase()] || "fa-solid fa-display");
  if (type === "channel") return dot(CHANNEL_ICONS[v.toLowerCase()] || CHANNEL_ICONS.unknown);
  if (type === "referrer") {
    if (!v) return dot("fa-solid fa-arrow-right-to-bracket");
    const host = v.replace(/^https?:\/\//, "").split("/")[0];
    if (!host.includes(".")) return dot("fa-solid fa-link");
    return (
      `<span class="bma-ico"><img loading="lazy" alt="" src="https://icons.duckduckgo.com/ip3/${
        encodeURIComponent(host)
      }.ico" onerror="this.remove()"></span>`
    );
  }
  return FIELD_ICONS[type] ? dot(FIELD_ICONS[type]) : "";
}

/** The readable form of a raw dimension value. */
function valueName(type, value, row) {
  const v = value == null || value === "" ? "" : String(value);
  const country = row && row.country;

  if (type === "region") {
    const code = v.includes("-") || !country ? v : country + "-" + v;
    const region = geo.region ? geo.region(code) : "";
    const where = named("region", (code.split("-")[0] || "").toUpperCase());
    if (region) return where ? region + ", " + where : region;
    return v || t("a_direct", "Direct / none");
  }
  if (type === "city") {
    if (!v) return t("a_direct", "Direct / none");
    const where = country ? named("region", country) : "";
    return where ? v + ", " + where : v;
  }

  if (!v) return t("a_direct", "Direct / none");
  if (type === "country") return named("region", v) || v;
  if (type === "language") return named("language", v.split("-")[0]) || v;
  if (type === "channel") return t("a_ch_" + v.toLowerCase(), v);
  if (type === "browser") return BROWSER_NAMES[v.toLowerCase()] || v;
  if (type === "os") return OS_DISPLAY[v] || v;
  if (type === "device") return v.charAt(0).toUpperCase() + v.slice(1);
  return v;
}

/** Icon plus name, the one shape a dimension value is printed in anywhere here. */
function chip(type, value, row, text) {
  const shown = text !== undefined ? text : valueName(type, value, row);
  const icon = mark(type, value, row);
  if (!icon) return escapeHTML(shown || "");
  return `<span class="bma-cell" title="${escapeHTML(shown)}">${icon}<span>${escapeHTML(
    shown,
  )}</span></span>`;
}

/* ─── fetching ────────────────────────────────────────────────────────────── */

function get(path, params) {
  const { startAt, endAt } = rangeOf(state.days);
  const body = { startAt, endAt, ...params };
  const key = path + "?" + JSON.stringify(body);
  if (state.cache.has(key)) return state.cache.get(key);

  const promise = adminQuery(path, body);
  state.cache.set(key, promise);
  return promise;
}

function report(type, parameters) {
  const { start, end } = rangeOf(state.days);
  const body = { startDate: start.toISOString(), endDate: end.toISOString(), ...parameters };
  const key = "report:" + type + JSON.stringify(body);
  if (state.cache.has(key)) return state.cache.get(key);

  const promise = adminReport(type, body);
  state.cache.set(key, promise);
  return promise;
}

const rows = (res) => (res && res.ok && Array.isArray(res.data) ? res.data : []);

function failure(res) {
  const status = res && res.status;
  if (status === 401 || status === 403) {
    return blank(t("a_denied", "The analytics credential was refused."));
  }
  return blank(t("a_offline", "Umami did not answer.") + (status ? ` (${status})` : ""));
}

/* ─── small builders ──────────────────────────────────────────────────────── */

const blank = (m) => `<p class="bm-blank">${escapeHTML(m)}</p>`;

/**
 * A picker. The signature is the group and what is chosen in it — nothing else —
 * so a repaint keeps the box, and the press that is marked on it the instant it
 * happens is not taken back and re-applied when the answer lands.
 */
function seg(group, items, active, extra = "") {
  return `<div class="bm-seg bma-seg${extra}" data-seg="${group}" data-k="seg:${group}"
    data-sig="seg:${group}|${escapeHTML(String(active))}" role="group">${items
    .map(
      ([id, text]) =>
        `<button type="button" data-seg-id="${escapeHTML(String(id))}"${
          String(id) === String(active) ? ' class="is-on"' : ""
        }>${escapeHTML(text)}</button>`,
    )
    .join("")}</div>`;
}

function metric(text, value, options = {}) {
  const change = options.change;
  const has = change !== null && change !== undefined;
  const good = options.inverse ? change < 0 : change > 0;
  const tone = !has || change === 0 ? "" : good ? " is-up" : " is-down";

  return `
    <div class="bma-metric${options.tone ? " tone-" + options.tone : ""}${
      options.on ? " is-on" : ""
    }" data-k="m:${escapeHTML(options.pick || text)}"${
      options.pick ? ` data-pick="${escapeHTML(options.pick)}" tabindex="0" role="button"` : ""
    }>
      <div class="bma-metric-label">${escapeHTML(text)}</div>
      <div class="bma-metric-value">${escapeHTML(String(value))}</div>
      ${
        has
          ? `<div class="bma-metric-change${tone}"><i class="fa-solid fa-caret-${
              change >= 0 ? "up" : "down"
            }" aria-hidden="true"></i>${Math.abs(change)}%</div>`
          : `<div class="bma-metric-change is-empty">${escapeHTML(options.note || "")}</div>`
      }
    </div>`;
}

const metricsBar = (tiles) => `<div class="bma-metrics" data-k="metrics">${tiles.join("")}</div>`;

/**
 * A panel. The key is not decoration — it is what lets a repaint replace this
 * panel's body without touching its frame, and leave the panel alone entirely
 * when nothing in it moved.
 */
function panel(key, title, inner, options = {}) {
  return `
    <section class="bm-card bma-panel${options.span ? " span-" + options.span : ""}" data-k="${key}">
      ${
        title || options.aside
          ? `<div class="bma-panel-head" data-k="${key}.head">
              <h3 class="bm-sub-title">${escapeHTML(title || "")}</h3>
              ${options.aside || ""}
            </div>`
          : ""
      }
      <div class="bma-panel-body" data-k="${key}.body">${inner}</div>
    </section>`;
}

const grid = (key, inner, extra = "") =>
  `<div class="bma-grid${extra}" data-k="${key}">${inner}</div>`;

function tabsOf(group, items, active) {
  return `<div class="bma-tabs" data-k="tabs:${group}" data-sig="tabs:${group}|${escapeHTML(
    String(active),
  )}" data-tabs="${group}" role="tablist">${items
    .map(
      ([id, text]) =>
        `<button type="button" role="tab" data-tab-id="${id}"${
          id === active ? ' class="is-on" aria-selected="true"' : ""
        }>${escapeHTML(text)}</button>`,
    )
    .join("")}</div>`;
}

/**
 * A ranked list: icon, name, count, share of the returned set — the one shape
 * every dimension in Umami is shown in, with the bar drawn INTO the row rather
 * than beside it so the proportion costs no column.
 */
function listTable(items, options = {}) {
  const all = items || [];
  if (!all.length) return blank(t("a_nodata", "Nothing in this range"));

  const key = options.more;
  const expanded = key ? !!state.more[key] : false;
  const list = all.slice(0, options.limit || (expanded ? LIST_MORE : LIST_LIMIT));

  const max = list.reduce((m, r) => Math.max(m, num(r.y)), 0) || 1;
  const total = all.reduce((s, r) => s + num(r.y), 0) || 1;
  const format = options.format || full;
  const type = options.type;

  const body = list
    .map((r) => {
      const name = options.label ? options.label(r) : valueName(type, r.x, r);
      const icon = options.icon === false ? "" : mark(type, r.x, r);
      return `
        <li class="bma-row" style="--bma-bar:${((num(r.y) / max) * 100).toFixed(2)}%">
          <span class="bma-row-name" title="${escapeHTML(name)}">${icon}<span>${escapeHTML(
            name,
          )}</span></span>
          <span class="bma-row-value">${escapeHTML(format(r.y))}</span>
          ${
            options.share === false
              ? ""
              : `<span class="bma-row-share">${share(r.y, total)}%</span>`
          }
        </li>`;
    })
    .join("");

  const more =
    key && all.length > LIST_LIMIT
      ? `<button type="button" class="bma-more" data-more="${key}">
           <i class="fa-solid fa-${expanded ? "chevron-up" : "chevron-down"}" aria-hidden="true"></i>
           ${escapeHTML(expanded ? t("a_less", "Less") : t("a_more", "More"))}
         </button>`
      : "";

  // The head and every row are separate grids, so they only line up while they
  // are told the SAME track sizes — two `auto` columns size to their own content
  // and leave each header floating somewhere over the middle of its column.
  return `
    <div class="bma-list${options.share === false ? " is-2" : ""}" data-k="list">
      <div class="bma-list-head">
        <span>${escapeHTML(options.head || t("a_name", "Name"))}</span>
        <span>${escapeHTML(options.metric || t("a_visitors", "Visitors"))}</span>
        ${options.share === false ? "" : "<span></span>"}
      </div>
      <ol class="bma-rows">${body}</ol>
      ${more}
    </div>`;
}

const alignOf = (c) => c.align || (c.num ? "right" : "left");

/**
 * A sideways scroller with a fade at each end — the same hint a display equation
 * gets when it runs off the side of the page, drawn in the surface's own colour so
 * it reads as the table running out rather than as a shadow.
 *
 * The fades live on the OUTER box, which does not scroll, so they stay at the
 * edges instead of travelling with the content, and each one is only shown while
 * there is something past it. The box is keyed and SIGNED on the table's markup,
 * so a repaint that did not change the table keeps the node — which is what keeps
 * both the reader's scroll position and the two edge classes written onto it.
 */
function scrollBox(key, inner) {
  return `<div class="bma-scrollbox" data-k="${key}" data-sig="${sign(inner)}" data-scrollbox>
    <div class="bma-scroll" data-scroller>${inner}</div>
    <span class="bma-scroll-fade is-left" aria-hidden="true"></span>
    <span class="bma-scroll-fade is-right" aria-hidden="true"></span>
  </div>`;
}

/** Which end has something past it. Two reads, no writes unless it changed. */
function edges(box) {
  const scroller = box.querySelector("[data-scroller]");
  if (!scroller) return;
  const max = scroller.scrollWidth - scroller.clientWidth;
  const at = scroller.scrollLeft;
  box.classList.toggle("has-left", max > 2 && at > 2);
  box.classList.toggle("has-right", max > 2 && max - at > 2);
}

function wireScrollers() {
  const boxes = section.querySelectorAll("[data-scrollbox]");
  if (scrollObserver) scrollObserver.disconnect();
  if (!boxes.length) return;

  if (!scrollObserver && typeof ResizeObserver !== "undefined") {
    scrollObserver = new ResizeObserver((entries) => {
      for (const entry of entries) edges(entry.target);
    });
  }
  boxes.forEach((box) => {
    edges(box);
    if (scrollObserver) scrollObserver.observe(box);
  });
}

/**
 * A sortable, scrollable data table.
 *
 * `cols` is `[{ key, label, num, strong, wide }]` and each row is
 * `{ [key]: { html, v } }` — `html` is what is printed, `v` is what is sorted
 * on, so a "3h ago" cell orders by its timestamp and a flag-and-name cell
 * orders by the name rather than by its markup.
 *
 * `min` is the width below which the columns stop being readable; under it the
 * table scrolls sideways rather than crushing every column to an ellipsis.
 *
 * A column's alignment is decided ONCE, by `align` or by `num`, and written onto
 * the header and the cells from the same call — a heading that sits over a column
 * it is not aligned with is a heading for the column next to it.
 */
function dataTable(name, cols, list, options = {}) {
  if (!list || !list.length) return blank(t("a_nodata", "Nothing in this range"));

  const sort = state.sort[name];
  let sorted = list;
  if (sort) {
    const col = cols.find((c) => c.key === sort.key);
    if (col) {
      const dir = sort.dir === "asc" ? 1 : -1;
      sorted = list.slice().sort((a, b) => {
        const x = a[col.key] ? a[col.key].v : null;
        const y = b[col.key] ? b[col.key].v : null;
        if (col.num) return (num(x) - num(y)) * dir;
        return String(x == null ? "" : x).localeCompare(String(y == null ? "" : y), locale()) * dir;
      });
    }
  }

  const head = cols
    .map((c) => {
      const on = sort && sort.key === c.key;
      const arrow = on && sort.dir === "asc" ? "up" : "down";
      return `<th class="bma-sortable bma-a-${alignOf(c)}${c.num ? " bma-num" : ""}${
        on ? " is-on" : ""
      }"
        data-sort="${name}" data-sort-key="${escapeHTML(c.key)}"${c.num ? ' data-num="1"' : ""}
        tabindex="0" role="button" aria-sort="${
          on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
        }"><span>${escapeHTML(c.label)}</span><i class="fa-solid fa-arrow-${arrow}-long" aria-hidden="true"></i></th>`;
    })
    .join("");

  const body = sorted
    .map(
      (r) =>
        `<tr>${cols
          .map(
            (c) =>
              `<td class="bma-a-${alignOf(c)}${c.num ? " bma-num" : ""}${
                c.strong ? " bma-strong" : ""
              }${c.wide ? " is-wide" : ""}">${(r[c.key] && r[c.key].html) || ""}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");

  return scrollBox(
    "tbl:" + name,
    `<table class="bma-table" style="--bma-tmin:${options.min || 640}px">
       <thead><tr>${head}</tr></thead>
       <tbody>${body}</tbody>
     </table>`,
  );
}

function pager(name, page, count) {
  const pages = Math.max(1, Math.ceil(num(count) / PAGE_SIZE));
  if (pages <= 1 && page <= 1) return "";
  return `
    <div class="bma-pager" data-k="pager:${name}" data-sig="${page}/${pages}/${num(
      count,
    )}" data-pager="${name}">
      <button type="button" data-step="-1"${page <= 1 ? " disabled" : ""} aria-label="${escapeHTML(
        t("a_prev", "Previous"),
      )}"><i class="fa-solid fa-chevron-left"></i></button>
      <span>${page} / ${pages}</span>
      <button type="button" data-step="1"${
        page >= pages ? " disabled" : ""
      } aria-label="${escapeHTML(t("a_next", "Next"))}"><i class="fa-solid fa-chevron-right"></i></button>
      <span class="bma-pager-count">${escapeHTML(full(count))}</span>
    </div>`;
}

/**
 * The box carries a signature that never changes, so a repaint KEEPS it rather
 * than re-creating it — which is what lets a reader type a word without the
 * caret being taken away and handed back on every settled keystroke.
 */
function search(name, value) {
  return `<label class="bma-search" data-k="search:${name}" data-sig="search:${name}">
    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
    <input type="search" data-search="${name}" value="${escapeHTML(value || "")}"
           placeholder="${escapeHTML(t("a_search", "Search"))}" />
  </label>`;
}

/**
 * The axis is per plot, not per page: traffic and the weekly grid want the log
 * axis they open on, and the reader who switched one of them to linear did not
 * ask for the other one to follow.
 */
const scaleOf = (id) => (state.scale[id] === "log" ? "log" : "linear");

const scaleSeg = (id, extra = "") =>
  seg(
    "scale:" + id,
    [["linear", t("a_linear", "Linear")], ["log", t("a_log", "Log")]],
    scaleOf(id),
    extra,
  );

/** The unit and scale pickers a chart panel carries in its head. */
function chartControls(id, options = {}) {
  const units = allowedUnits().map((u) => [u, t("a_u_" + u, u)]);
  return (
    `<div class="bma-controls">` +
    (options.unit === false || units.length < 2 ? "" : seg("unit", units, unitFor())) +
    (options.scale === false ? "" : scaleSeg(id)) +
    `</div>`
  );
}

/* ─── the chart ───────────────────────────────────────────────────────────── */

/** FNV-1a, only ever compared against itself. */
function sign(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function chart(id, spec) {
  spec.id = id;
  charts.set(id, spec);
  const sig = sign(
    id +
      "|" +
      scaleOf(id) +
      "|" +
      (spec.unit || "") +
      "|" +
      spec.series
        .map((s) => s.name + ":" + s.color + ":" + s.type + ":" + s.data.map((d) => d.y).join(","))
        .join("|"),
  );
  return `<div class="bma-chart" data-k="${id}.chart" data-chart="${id}" data-sig="${sig}" style="--bma-chart-h:${
    spec.height || 320
  }px"></div>`;
}

/**
 * A tick step that lands close above the peak.
 *
 * The naive round-to-a-power-of-ten leaves a chart whose tallest bar reaches
 * two thirds of the box — the whitespace this list of steps exists to remove.
 */
const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

function niceScale(peak) {
  if (!(peak > 0)) return { top: 1, step: 1, count: 1 };
  const raw = peak / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = (STEPS.find((s) => raw / mag <= s) || 10) * mag;
  const top = Math.ceil(peak / step) * step;
  return { top, step, count: Math.max(1, Math.round(top / step)) };
}

/** Decade ticks for a log axis, plus the zero line the bars sit on. */
function logTicks(peak) {
  const top = Math.max(1, Math.pow(10, Math.ceil(Math.log10(Math.max(1, peak)))));
  const ticks = [0];
  for (let v = 1; v <= top; v *= 10) ticks.push(v);
  return { top, ticks };
}

const hiddenOf = (id) => state.hidden[id] || (state.hidden[id] = new Set());

function drawChart(host, spec) {
  const width = host.clientWidth;
  if (!width) return;

  const all = (spec.series || []).filter((s) => s.data && s.data.length);
  host.dataset.w = String(width);
  host.dataset.drawn = host.dataset.sig || "1";

  if (!all.length) {
    host.innerHTML = blank(t("a_nodata", "Nothing in this range"));
    return;
  }

  const off = hiddenOf(spec.id);
  const series = all.filter((s) => !off.has(s.name));

  const log = scaleOf(spec.id) === "log" && spec.log !== false;
  const points = all.reduce((m, s) => Math.max(m, s.data.length), 0);

  // The box is drawn at its measured pixel size, so its HEIGHT has to follow the
  // width as well — a 340px plot on a 360px phone is a letterbox, and letting
  // CSS squash it instead would deform every tick and label in it.
  const height = Math.round(Math.max(200, Math.min(spec.height || 320, width * 0.68)));
  host.style.setProperty("--bma-chart-h", height + "px");

  const padT = 12;
  const padB = 40;
  const padR = 14;
  const format = spec.format || compact;

  const bars = series.filter((s) => s.type !== "line");
  const lines = series.filter((s) => s.type === "line");

  // Stacked bars: the peak is the tallest TOTAL, not the tallest segment.
  const totals = [];
  for (let i = 0; i < points; i++) {
    totals.push(bars.reduce((sum, s) => sum + num(s.data[i] && s.data[i].y), 0));
  }
  const peak = Math.max(
    totals.reduce((m, v) => Math.max(m, v), 0),
    lines.reduce((m, s) => s.data.reduce((n, d) => Math.max(n, num(d.y)), m), 0),
  );

  const axis = log ? logTicks(peak) : niceScale(peak);
  const top = axis.top;
  const ticks = log ? axis.ticks : Array.from({ length: axis.count + 1 }, (_, i) => axis.step * i);

  const lg = (v) => Math.log10(num(v) + 1);
  const frac = (v) => (log ? lg(v) / lg(top) : num(v) / top);

  const padL = Math.max(38, ticks.reduce((m, v) => Math.max(m, format(v).length), 1) * 7 + 14);
  const plotW = Math.max(10, width - padL - padR);
  const plotH = Math.max(10, height - padT - padB);
  const band = plotW / Math.max(1, points);
  const y = (v) => padT + plotH - frac(v) * plotH;

  const parts = [];

  for (const value of ticks) {
    const py = y(value);
    parts.push(
      `<line class="bma-gridline" x1="${padL}" y1="${py.toFixed(1)}" x2="${
        padL + plotW
      }" y2="${py.toFixed(1)}"/>`,
      `<text class="bma-axis-y" x="${padL - 9}" y="${(py + 4).toFixed(1)}">${escapeHTML(
        format(value),
      )}</text>`,
    );
  }

  // One label per 70px at most, so the date axis never overprints itself.
  const every = Math.max(1, Math.ceil(points / Math.max(2, Math.floor(plotW / 70))));
  const labels = (all[0] && all[0].data) || [];
  for (let i = 0; i < points; i++) {
    if (i % every || !labels[i]) continue;
    const px = padL + (i + 0.5) * band;
    parts.push(
      `<text class="bma-axis-x" x="${px.toFixed(1)}" y="${height - padB + 18}">${escapeHTML(
        bucketLabel(labels[i].x, spec.unit),
      )}</text>`,
    );
  }

  // Wide bars with a hairline between them, which is what makes a month of data
  // read as a run rather than as a picket fence.
  const bw = Math.max(1, band * (band > 6 ? 0.84 : 0.96));
  const bx = (i) => padL + i * band + (band - bw) / 2;

  for (let i = 0; i < points; i++) {
    let below = 0;
    for (const s of bars) {
      const value = num(s.data[i] && s.data[i].y);
      if (value <= 0) continue;
      const yTop = y(below + value);
      const yBottom = y(below);
      below += value;
      parts.push(
        `<rect class="bma-col" fill="${s.color}" x="${bx(i).toFixed(2)}" y="${yTop.toFixed(
          2,
        )}" width="${bw.toFixed(2)}" height="${Math.max(1, yBottom - yTop).toFixed(2)}"/>`,
      );
    }
  }

  for (const s of lines) {
    const d = s.data
      .map((p, i) => (i ? "L" : "M") + (padL + (i + 0.5) * band).toFixed(2) + " " + y(p.y).toFixed(2))
      .join(" ");
    parts.push(`<path class="bma-line" stroke="${s.color}" d="${d}"/>`);
  }

  parts.push(
    `<line class="bma-axis" x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${
      padT + plotH
    }"/>`,
    `<rect class="bma-cursor" data-cursor x="0" y="${padT}" width="${Math.max(band, 2).toFixed(
      2,
    )}" height="${plotH}" hidden/>`,
  );

  const svg =
    `<svg class="bma-chart-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `role="img" aria-label="${escapeHTML(spec.label || "")}">${parts.join("")}</svg>`;

  // Every series stays in the legend whether it is drawn or not — a key that
  // vanishes when you switch it off is a key you cannot switch back on.
  const legend = `<div class="bma-legend">${all
    .map(
      (s) =>
        `<button type="button" class="bma-key${off.has(s.name) ? " is-off" : ""}" data-series="${
          escapeHTML(s.name)
        }" aria-pressed="${off.has(s.name) ? "false" : "true"}"><i class="${
          s.type === "line" ? "is-line" : ""
        }" style="background:${s.color}"></i>${escapeHTML(s.name)}</button>`,
    )
    .join("")}</div>`;

  host.innerHTML = svg + legend + '<div class="bma-chart-tip" data-chart-tip></div>';
  wireChartHover(host, { series: all, off, padL, band, points, format, unit: spec.unit });
}

/**
 * The read-out.
 *
 * Pointer events rather than mouse events, so one code path serves a mouse, a
 * pen and a finger. On touch the tooltip is PINNED by the tap and released by
 * the next one anywhere else — a hover read-out that needs the finger held
 * still on the bar is unusable on a phone.
 */
function wireChartHover(host, ctx) {
  const svg = host.querySelector("svg");
  const cursor = host.querySelector("[data-cursor]");
  const tip = host.querySelector("[data-chart-tip]");
  if (!svg || !cursor || !tip || !ctx.points) return;

  let pinned = false;

  const leave = () => {
    if (pinned) return;
    cursor.setAttribute("hidden", "");
    tip.classList.remove("is-on");
  };

  const at = (clientX) => {
    const box = svg.getBoundingClientRect();
    const scale = box.width / (svg.viewBox.baseVal.width || box.width) || 1;
    const i = Math.floor(((clientX - box.left) / scale - ctx.padL) / ctx.band);
    if (i < 0 || i >= ctx.points) return false;

    cursor.setAttribute("x", (ctx.padL + i * ctx.band).toFixed(2));
    cursor.removeAttribute("hidden");

    const head = ctx.series.find((s) => s.data[i]);
    tip.innerHTML =
      `<b>${escapeHTML(bucketLabel(head ? head.data[i].x : "", ctx.unit))}</b>` +
      ctx.series
        .filter((s) => !ctx.off.has(s.name))
        .map(
          (s) =>
            `<span><i style="background:${s.color}"></i>${escapeHTML(s.name)}<em>${escapeHTML(
              ctx.format(s.data[i] ? s.data[i].y : 0),
            )}</em></span>`,
        )
        .join("");
    tip.classList.add("is-on");

    const px = (ctx.padL + (i + 0.5) * ctx.band) * scale;
    const half = tip.offsetWidth / 2;
    tip.style.left = Math.min(Math.max(px, half + 4), box.width - half - 4) + "px";
    return true;
  };

  svg.addEventListener("pointermove", (event) => {
    if (pinned && event.pointerType !== "mouse") return;
    if (!at(event.clientX)) leave();
  });

  svg.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse") return;
    pinned = false;
    pinned = at(event.clientX);
  });

  svg.addEventListener("pointerleave", leave);

  // Tapping anywhere else lets the pinned read-out go. The host outlives the
  // draw, so the previous draw's listener has to come off with it.
  if (host.release) host.removeEventListener("bma:release", host.release);
  host.release = () => {
    pinned = false;
    leave();
  };
  host.addEventListener("bma:release", host.release);
}

function paintCharts() {
  const hosts = section.querySelectorAll("[data-chart]");
  if (chartObserver) chartObserver.disconnect();
  if (!hosts.length) return;

  if (!chartObserver && typeof ResizeObserver !== "undefined") {
    // Redraw on a real width change only: the draw replaces the host's
    // contents, and a redraw that reacted to its own output would never settle.
    chartObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const host = entry.target;
        const spec = charts.get(host.getAttribute("data-chart"));
        if (spec && host.clientWidth && host.dataset.w !== String(host.clientWidth)) {
          drawChart(host, spec);
        }
      }
    });
  }

  hosts.forEach((host) => {
    const spec = charts.get(host.getAttribute("data-chart"));
    if (!spec) return;
    // A host the diff kept is already drawn from this very spec; redrawing it
    // would be the flicker the diff exists to avoid.
    if (host.dataset.drawn !== host.dataset.sig || !host.firstElementChild) {
      drawChart(host, spec);
    }
    if (chartObserver) chartObserver.observe(host);
  });
}

/* ─── overview ────────────────────────────────────────────────────────────── */

async function viewOverview() {
  const unit = unitFor();
  const [stats, chartRes] = await Promise.all([
    get("/api/websites/:id/stats", { compare: "prev" }),
    get("/api/websites/:id/pageviews", { unit, timezone: timezone(), compare: "prev" }),
  ]);

  if (!stats.ok) return failure(stats);

  const s = stats.data || {};
  const p = s.comparison || {};
  const rate = (b, v) => (num(v) ? (Math.min(num(b), num(v)) / num(v)) * 100 : 0);
  const each = (v) => (num(v.visits) ? num(v.totaltime) / num(v.visits) : 0);

  const bar = metricsBar([
    metric(t("a_visitors", "Visitors"), full(s.visitors), {
      change: delta(s.visitors, p.visitors),
    }),
    metric(t("a_visits", "Visits"), full(s.visits), { change: delta(s.visits, p.visits) }),
    metric(t("a_views", "Views"), full(s.pageviews), { change: delta(s.pageviews, p.pageviews) }),
    metric(t("a_bounce", "Bounce rate"), Math.round(rate(s.bounces, s.visits)) + "%", {
      change: delta(rate(s.bounces, s.visits), rate(p.bounces, p.visits)),
      // A bounce rate going DOWN is the good direction, so the tone flips.
      inverse: true,
    }),
    metric(t("a_duration", "Visit duration"), duration(each(s)), {
      change: delta(each(s), each(p)),
    }),
  ]);

  const keys = bucketsFor(unit);
  const d = chartRes.data || {};
  const views = align(d.pageviews, keys, unit);
  const sessions = align(d.sessions, keys, unit);

  // Visitors at the bottom, the rest of the views above: the bar's full height
  // is the views, and the split says how much of it was repeat reading. Two
  // separate bars per bucket would say neither.
  let series = [
    { name: t("a_visitors", "Visitors"), data: sessions, color: TRAFFIC[0] },
    {
      name: t("a_views", "Views"),
      data: views.map((r, i) => ({ x: r.x, y: Math.max(0, num(r.y) - num(sessions[i].y)) })),
      color: TRAFFIC[1],
    },
  ];

  // The previous period, relabelled onto this one's buckets — the comparison is
  // between the two spans, so the x axis stays the current dates.
  if (d.compare) {
    const { start, end } = rangeOf(state.days);
    const span = end.getTime() - start.getTime();
    const back = bucketsBetween(new Date(start.getTime() - span), new Date(start.getTime() - 1), unit);
    const onto = (list) => {
      const prev = align(list, back, unit);
      return keys.map((k, i) => ({ x: k, y: prev[i] ? prev[i].y : 0 }));
    };
    series.push(
      {
        name: t("a_prev_views", "Views (previous)"),
        data: onto(d.compare.pageviews),
        color: TRAFFIC_PREV[0],
        type: "line",
      },
      {
        name: t("a_prev_visitors", "Visitors (previous)"),
        data: onto(d.compare.sessions),
        color: TRAFFIC_PREV[1],
        type: "line",
      },
    );
  }

  series = trimLead(series);

  const plot = panel(
    "traffic",
    t("a_traffic_over_time", "Traffic"),
    chart("traffic", { series, unit, height: 340, label: t("a_views", "Views") }),
    { aside: chartControls("traffic") },
  );

  const [panels, compare, geoRow] = await Promise.all([
    overviewPanels(),
    compareTable(),
    geoPanels(),
  ]);

  return bar + plot + panels + compare + geoRow;
}

async function overviewPanels() {
  const picks = PANELS.map(([group, tabs]) => [group, tabs, state.tab[group] || tabs[0][0]]);
  const results = await Promise.all(
    picks.map(([, , type]) => get("/api/websites/:id/metrics", { type, limit: 30 })),
  );

  const cards = picks
    .map(([group, tabs, type], i) => {
      const res = results[i];
      const head = tabs.find(([f]) => f === type);
      const body = res.ok
        ? listTable(rows(res), { type, head: t(head ? head[1] : type, type), more: group })
        : failure(res);
      return panel(
        group,
        t("a_" + group, group),
        tabsOf(group, tabs.map(([f, key]) => [f, t(key, f)]), type) + body,
      );
    })
    .join("");

  return grid("panels", cards);
}

async function geoPanels() {
  const [weekly, map] = await Promise.all([
    get("/api/websites/:id/sessions/weekly", { timezone: timezone() }),
    get("/api/websites/:id/metrics", { type: "country", limit: 250 }),
  ]);

  return grid(
    "geo",
    panel("map", t("a_map", "Visitors by country"), worldMapPanel(rows(map)), { span: 2 }) +
      panel("weekly", t("a_weekly", "Weekly traffic"), weeklyGrid(weekly.ok ? weekly.data : null), {
        aside: scaleSeg("weekly", " is-mini"),
      }),
    " is-two-one",
  );
}

/* ─── world map ───────────────────────────────────────────────────────────── */

/**
 * The choropleth. Six steps rather than a continuous ramp: a country's exact
 * share is what the list beside it is for, and a continuous fill on 174 shapes
 * reads as noise at this size.
 */
function worldMapPanel(list) {
  if (!geo.map) return `<div class="bma-map is-waiting"></div>`;

  const total = list.reduce((s, r) => s + num(r.y), 0);
  const byCode = new Map(list.map((r) => [String(r.x || "").toUpperCase(), num(r.y)]));
  const peak = list.reduce((m, r) => Math.max(m, num(r.y)), 0) || 1;

  const shapes = Object.entries(geo.map.PATHS)
    .map(([code, d]) => {
      const value = byCode.get(code) || 0;
      // Logarithmic, because one country is almost always an order of magnitude
      // ahead and a linear ramp paints every other country the same empty grey.
      const level = value
        ? Math.max(1, Math.min(6, Math.ceil((Math.log1p(value) / Math.log1p(peak)) * 6)))
        : 0;
      return (
        `<path class="bma-land l${level}" d="${d}" data-c="${code}"` +
        ` data-n="${escapeHTML(named("region", code) || code)}"` +
        ` data-v="${value}" data-s="${share(value, total)}"/>`
      );
    })
    .join("");

  // Signed, so the 174 shapes are parsed once and then left alone — and the
  // read-out stays up while the panel beside it repaints.
  return `
    <div class="bma-map" data-k="mapshapes" data-sig="${sign(shapes)}" data-map>
      <svg viewBox="${geo.map.VIEWBOX}" preserveAspectRatio="xMidYMid meet"
           role="img" aria-label="${escapeHTML(t("a_map", "Visitors by country"))}">${shapes}</svg>
      <div class="bma-map-tip" data-map-tip></div>
    </div>`;
}

let mapOn = false;

/**
 * Delegated from the section, so the map survives a repaint without being
 * re-wired. The flag is what keeps this off the critical path: a pointermove
 * anywhere else costs one `closest` and nothing more.
 */
function wireMap(event) {
  const host = event.target.closest && event.target.closest("[data-map]");
  if (!host) {
    if (!mapOn) return;
    mapOn = false;
    const stale = section.querySelector("[data-map-tip]");
    if (stale) stale.classList.remove("is-on");
    return;
  }

  const tip = host.querySelector("[data-map-tip]");
  if (!tip) return;

  const land = event.target.closest(".bma-land");
  if (!land) {
    mapOn = false;
    tip.classList.remove("is-on");
    return;
  }
  mapOn = true;

  tip.innerHTML =
    `<b>${escapeHTML(land.getAttribute("data-n"))}</b>` +
    `<span>${escapeHTML(full(land.getAttribute("data-v")))} ${escapeHTML(
      t("a_visitors", "Visitors").toLowerCase(),
    )} · ${land.getAttribute("data-s")}%</span>`;
  tip.classList.add("is-on");

  const box = host.getBoundingClientRect();
  tip.style.left =
    Math.min(
      Math.max(event.clientX - box.left, tip.offsetWidth / 2 + 4),
      box.width - tip.offsetWidth / 2 - 4,
    ) + "px";
  tip.style.top = Math.max(0, event.clientY - box.top - tip.offsetHeight - 12) + "px";
}

/* ─── weekly traffic ──────────────────────────────────────────────────────── */

/**
 * Days across, hours down, each cell a dot whose size and opacity carry the
 * count — Umami's own grid.
 *
 * A count of one gets a floor rather than its true 2% of the peak: the question
 * this grid answers is WHEN, and an hour that is invisible answers it wrongly.
 */
function weeklyGrid(data) {
  if (!Array.isArray(data) || data.length !== 7) {
    return blank(t("a_nodata", "Nothing in this range"));
  }

  let peak = 0;
  data.forEach((day) => day.forEach((v) => (peak = Math.max(peak, num(v)))));

  const log = scaleOf("weekly") === "log";
  const ratio = (v) => {
    const n = num(v);
    if (!n || !peak) return 0;
    const raw = log ? Math.log1p(n) / Math.log1p(peak) : n / peak;
    return 0.34 + 0.66 * Math.min(1, raw);
  };

  const days = t("a_weekdays", "Sun,Mon,Tue,Wed,Thu,Fri,Sat").split(",");
  const hour = (h) => (h === 0 ? "12am" : h < 12 ? h + "am" : h === 12 ? "12pm" : h - 12 + "pm");

  const head = `<div class="bma-week-row is-head"><span></span>${days
    .map((d) => `<span>${escapeHTML(d)}</span>`)
    .join("")}</div>`;

  const body = Array.from({ length: 24 }, (_, h) => {
    const cells = data
      .map((day, i) => {
        const v = num(day[h]);
        return `<i class="${v ? "is-live" : ""}" style="--bma-dot:${ratio(v).toFixed(
          3,
        )}" title="${escapeHTML(days[i] + " " + hour(h) + " · " + full(v))}"></i>`;
      })
      .join("");
    // Every third hour is labelled; all 24 would not fit beside the map.
    return `<div class="bma-week-row"><span>${h % 3 ? "" : hour(h)}</span>${cells}</div>`;
  }).join("");

  return `<div class="bma-week" data-k="weekgrid" data-sig="${sign(body)}">${head}${body}</div>`;
}

/* ─── compare ─────────────────────────────────────────────────────────────── */

/**
 * The dimension table against the previous period.
 *
 * It lives in the overview rather than behind a tab of its own: the chart above
 * it already draws the comparison, and a page that shows the lines but hides
 * the table that explains them is two clicks away from every reading.
 */
async function compareTable() {
  const type = state.compareField;
  const { start, startAt, endAt } = rangeOf(state.days);
  const span = endAt - startAt;

  const [now, before] = await Promise.all([
    get("/api/websites/:id/metrics", { type, limit: 30 }),
    adminQuery("/api/websites/:id/metrics", {
      type,
      limit: 30,
      startAt: start.getTime() - span,
      endAt: start.getTime(),
    }),
  ]);

  if (!now.ok) return panel("compare", t("a_compare", "Compare"), failure(now));

  const prev = new Map(rows(before).map((r) => [String(r.x), num(r.y)]));
  const list = rows(now).map((r) => {
    const name = valueName(type, r.x, r);
    const was = num(prev.get(String(r.x)));
    const change = delta(r.y, was);
    return {
      name: { html: chip(type, r.x, r, name), v: name },
      prev: { html: escapeHTML(full(was)), v: was },
      now: { html: escapeHTML(full(r.y)), v: num(r.y) },
      change: {
        html: `<span class="bma-delta${
          change === null || change === 0 ? "" : change > 0 ? " is-up" : " is-down"
        }">${change === null ? "—" : (change > 0 ? "+" : "") + change + "%"}</span>`,
        v: change === null ? -Infinity : change,
      },
    };
  });

  return panel(
    "compare",
    t("a_compare", "Compare"),
    `<div class="bma-bar" data-k="compareBar">${seg(
      "compareField",
      FIELDS.map(([f, key]) => [f, t(key, f)]),
      type,
    )}</div>` +
      dataTable(
        "compare",
        [
          { key: "name", label: t("a_name", "Name"), wide: true },
          { key: "prev", label: t("a_previous", "Previous"), num: true },
          { key: "now", label: t("a_current", "Current"), num: true, strong: true },
          { key: "change", label: t("a_change", "Change"), num: true },
        ],
        list,
        { min: 520 },
      ),
  );
}

/* ─── events ──────────────────────────────────────────────────────────────── */

async function viewEvents() {
  const tab = state.tab.events || "chart";
  const stats = await get("/api/websites/:id/events/stats");
  if (!stats.ok) return failure(stats);

  const s = (stats.data && stats.data.data) || stats.data || {};
  const p = s.comparison || {};
  const bar = metricsBar([
    metric(t("a_visitors", "Visitors"), full(s.visitors), {
      change: delta(s.visitors, p.visitors),
    }),
    metric(t("a_visits", "Visits"), full(s.visits), { change: delta(s.visits, p.visits) }),
    metric(t("a_events_fired", "Events"), full(s.events), { change: delta(s.events, p.events) }),
    metric(t("a_event_types", "Unique events"), full(s.uniqueEvents), {
      change: delta(s.uniqueEvents, p.uniqueEvents),
    }),
  ]);

  const head = tabsOf(
    "events",
    [
      ["chart", t("a_chart", "Chart")],
      ["activity", t("a_activity", "Activity")],
      ["properties", t("a_properties", "Properties")],
    ],
    tab,
  );

  let body;
  let aside = "";
  if (tab === "activity") body = await eventsActivity();
  else if (tab === "properties") body = await eventProperties();
  else {
    body = await eventsChart();
    aside = chartControls("events", { scale: false });
  }

  return bar + panel("events", t("a_events", "Events"), head + body, { aside });
}

async function eventsChart() {
  const unit = unitFor();
  const [series, totals] = await Promise.all([
    get("/api/websites/:id/events/series", { unit, timezone: timezone(), limit: 10 }),
    get("/api/websites/:id/metrics", { type: "event", limit: 50 }),
  ]);

  if (!series.ok) return failure(series);

  // One row per (name, bucket). Stacked by name is the shape Umami draws, and
  // the only one that answers "which event moved" rather than "something did".
  const byName = new Map();
  for (const row of rows(series)) {
    const name = String(row.x);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ x: row.t, y: row.y });
  }

  const keys = bucketsFor(unit);
  const names = [...byName.keys()].sort(
    (a, b) =>
      byName.get(b).reduce((x, r) => x + num(r.y), 0) -
      byName.get(a).reduce((x, r) => x + num(r.y), 0),
  );

  const stacks = trimLead(
    names.map((name, i) => ({
      name,
      color: SERIES[i % SERIES.length],
      data: align(byName.get(name), keys, unit),
    })),
  );

  return (
    chart("events", {
      series: stacks,
      unit,
      height: 320,
      log: false,
      label: t("a_events_fired", "Events"),
    }) +
    listTable(rows(totals), {
      type: "event",
      head: t("a_event", "Event"),
      metric: t("a_count", "Count"),
      more: "eventNames",
    })
  );
}

async function eventsActivity() {
  const view = state.tab.eventsView || "all";
  const page = state.page.events || 1;
  const res = await get("/api/websites/:id/events", {
    page,
    pageSize: PAGE_SIZE,
    search: state.search.events || undefined,
    eventType: view === "views" ? 1 : view === "events" ? 2 : undefined,
  });

  if (!res.ok) return failure(res);

  const list = ((res.data && res.data.data) || []).map((r) => {
    const kind = r.eventName ? t("a_triggered", "Event") : t("a_viewed", "View");
    const what = r.eventName || r.urlPath || "";
    const where = valueName(r.city ? "city" : "country", r.city || r.country, r);
    return {
      kind: {
        html: `<span class="bma-kind ${r.eventName ? "is-event" : "is-view"}"><i class="fa-solid fa-${
          r.eventName ? "bolt" : "eye"
        }" aria-hidden="true"></i>${escapeHTML(kind)}</span>`,
        v: kind,
      },
      what: {
        html: chip(r.eventName ? "event" : "path", what, r, what),
        v: what,
      },
      path: { html: escapeHTML(r.urlPath || ""), v: r.urlPath || "" },
      browser: { html: chip("browser", r.browser, r), v: valueName("browser", r.browser, r) },
      os: { html: chip("os", r.os, r), v: valueName("os", r.os, r) },
      device: { html: chip("device", r.device, r), v: valueName("device", r.device, r) },
      where: { html: chip(r.city ? "city" : "country", r.city || r.country, r, where), v: where },
      at: { html: escapeHTML(when(r.createdAt)), v: stamp(r.createdAt) },
    };
  });

  return (
    `<div class="bma-bar" data-k="eventsBar">${seg(
      "eventsView",
      [["all", t("a_all", "All")], ["views", t("a_views", "Views")], ["events", t("a_events", "Events")]],
      view,
    )}${search("events", state.search.events)}</div>` +
    dataTable(
      "eventsLog",
      [
        { key: "kind", label: t("a_type", "Type") },
        { key: "what", label: t("a_event", "Event"), wide: true, strong: true },
        { key: "path", label: t("a_f_path", "Path"), wide: true },
        { key: "browser", label: t("a_f_browser", "Browser") },
        { key: "os", label: t("a_f_os", "System") },
        { key: "device", label: t("a_f_device", "Device") },
        { key: "where", label: t("a_location", "Location") },
        { key: "at", label: t("a_when", "When"), num: true },
      ],
      list,
      { min: 940 },
    ) +
    pager("events", page, (res.data && res.data.count) || 0)
  );
}

async function eventProperties() {
  const res = await get("/api/websites/:id/event-data/properties");
  if (!res.ok) return failure(res);

  const all = rows(res);
  if (!all.length) return blank(t("a_nodata", "Nothing in this range"));

  const names = [...new Set(all.map((r) => r.eventName))].filter(Boolean).sort();
  const name = names.includes(state.tab.propEvent) ? state.tab.propEvent : names[0];
  const props = [...new Set(all.filter((r) => r.eventName === name).map((r) => r.propertyName))];
  const prop = props.includes(state.tab.propName) ? state.tab.propName : props[0];

  const values = prop
    ? await get("/api/websites/:id/event-data/values", { eventName: name, propertyName: prop })
    : null;

  return (
    `<div class="bma-bar" data-k="propsBar">
      ${seg("propEvent", names.map((n) => [n, n]), name)}
      ${props.length ? seg("propName", props.map((n) => [n, n]), prop) : ""}
    </div>` +
    (values && values.ok
      ? listTable(rows(values).map((r) => ({ x: r.value, y: r.total })), {
          head: prop,
          metric: t("a_count", "Count"),
          icon: false,
          more: "eventValues",
        })
      : blank(t("a_nodata", "Nothing in this range")))
  );
}

/* ─── sessions ────────────────────────────────────────────────────────────── */

async function viewSessions() {
  const tab = state.tab.sessions || "activity";
  const stats = await get("/api/websites/:id/sessions/stats");
  if (!stats.ok) return failure(stats);

  const s = stats.data || {};
  const value = (k) => full(s[k] && s[k].value);
  const bar = metricsBar([
    metric(t("a_visitors", "Visitors"), value("visitors")),
    metric(t("a_visits", "Visits"), value("visits")),
    metric(t("a_views", "Views"), value("pageviews")),
    metric(t("a_countries", "Countries"), value("countries")),
    metric(t("a_events_fired", "Events"), value("events")),
  ]);

  const head = tabsOf(
    "sessions",
    [["activity", t("a_activity", "Activity")], ["properties", t("a_properties", "Properties")]],
    tab,
  );

  const body = tab === "properties" ? await sessionProperties() : await sessionsActivity();
  return bar + panel("sessions", t("a_sessions", "Sessions"), head + body);
}

async function sessionsActivity() {
  const page = state.page.sessions || 1;
  const res = await get("/api/websites/:id/sessions", {
    page,
    pageSize: PAGE_SIZE,
    search: state.search.sessions || undefined,
  });

  if (!res.ok) return failure(res);

  const list = ((res.data && res.data.data) || []).map((r) => {
    const where = valueName(r.city ? "city" : "country", r.city || r.country, r);
    const id = String(r.id || "");
    return {
      id: {
        html: `<span class="bma-id" title="${escapeHTML(id)}">${escapeHTML(id.slice(0, 8))}</span>`,
        v: id,
      },
      visits: { html: escapeHTML(full(r.visits)), v: num(r.visits) },
      views: { html: escapeHTML(full(r.views)), v: num(r.views) },
      events: { html: escapeHTML(full(r.events)), v: num(r.events) },
      where: { html: chip(r.city ? "city" : "country", r.city || r.country, r, where), v: where },
      browser: { html: chip("browser", r.browser, r), v: valueName("browser", r.browser, r) },
      os: { html: chip("os", r.os, r), v: valueName("os", r.os, r) },
      device: { html: chip("device", r.device, r), v: valueName("device", r.device, r) },
      at: {
        html: escapeHTML(when(r.lastAt || r.createdAt)),
        v: stamp(r.lastAt || r.createdAt),
      },
    };
  });

  return (
    `<div class="bma-bar" data-k="sessionsBar">${search("sessions", state.search.sessions)}</div>` +
    dataTable(
      "sessionsLog",
      [
        { key: "id", label: t("a_session", "Session") },
        { key: "visits", label: t("a_visits", "Visits"), num: true },
        { key: "views", label: t("a_views", "Views"), num: true },
        { key: "events", label: t("a_events", "Events"), num: true },
        { key: "where", label: t("a_location", "Location"), wide: true },
        { key: "browser", label: t("a_f_browser", "Browser") },
        { key: "os", label: t("a_f_os", "System") },
        { key: "device", label: t("a_f_device", "Device") },
        { key: "at", label: t("a_last_seen", "Last seen"), num: true },
      ],
      list,
      { min: 900 },
    ) +
    pager("sessions", page, (res.data && res.data.count) || 0)
  );
}

async function sessionProperties() {
  const res = await get("/api/websites/:id/session-data/properties");
  if (!res.ok) return failure(res);

  const props = rows(res);
  if (!props.length) return blank(t("a_nodata", "Nothing in this range"));

  const names = props.map((r) => r.propertyName).filter(Boolean);
  const prop = names.includes(state.tab.sessProp) ? state.tab.sessProp : names[0];
  const values = await get("/api/websites/:id/session-data/values", { propertyName: prop });

  return (
    `<div class="bma-bar" data-k="sessPropBar">${seg("sessProp", names.map((n) => [n, n]), prop)}</div>` +
    (values.ok
      ? listTable(rows(values).map((r) => ({ x: r.value, y: r.total })), {
          head: prop,
          metric: t("a_count", "Count"),
          icon: false,
          more: "sessValues",
        })
      : failure(values))
  );
}

/* ─── performance ─────────────────────────────────────────────────────────── */

async function viewPerformance() {
  const unit = unitFor();
  const res = await report("performance", { unit, timezone: timezone(), metric: state.metric });
  if (!res.ok) return failure(res);

  const data = res.data || {};
  const summary = data.summary || {};
  const p = state.percentile;

  if (!num(summary.count)) {
    return blank(
      t(
        "a_perf_none",
        "No web vitals yet. The tracker collects them only when data-performance is set.",
      ),
    );
  }

  const cards = metricsBar(
    VITALS.map(([key, name, good, poor]) => {
      const v = num(summary[key] && summary[key][p]);
      return metric(name, vital(key, v), {
        tone: v <= good ? "good" : v <= poor ? "warn" : "bad",
        pick: key,
        on: key === state.metric,
        note: p,
      });
    }),
  );

  const keys = bucketsFor(unit);
  const source = data.chart || [];
  const series = trimLead(
    PERCENTILES.map((name, i) => ({
      name,
      type: "line",
      color: SERIES[[4, 0, 3][i]],
      data: align(source.map((r) => ({ x: r.t, y: r[name] })), keys, unit),
    })),
  );

  const format = (v) => vital(state.metric, v);
  const spec = VITALS.find(([k]) => k === state.metric) || VITALS[0];

  const listOf = (src, type) =>
    listTable(
      (src || [])
        .filter((r) => num(r[p]) > 0)
        .slice(0, 30)
        .map((r) => ({ x: r.name, y: num(r[p]) })),
      { type, head: t("a_name", "Name"), metric: spec[1] + " " + p, format, share: false },
    );

  const pagesTab = state.tab.perfPages || "path";
  const envTab = state.tab.perfEnv || "device";

  return (
    `<div class="bma-bar" data-k="perfbar">${seg(
      "percentile",
      PERCENTILES.map((x) => [x, x]),
      p,
    )}<span class="bm-hint" data-k="samples">${escapeHTML(
      t("a_samples", "Samples") + ": " + full(summary.count),
    )}</span></div>` +
    cards +
    panel(
      "vitals",
      VITAL_NAMES[state.metric] || spec[1],
      chart("vitals", { series, unit, height: 320, format, label: spec[1] }),
      { aside: chartControls("vitals") },
    ) +
    grid(
      "perf",
      panel(
        "perfPages",
        t("a_pages", "Pages"),
        tabsOf(
          "perfPages",
          [["path", t("a_f_path", "Path")], ["title", t("a_f_title", "Title")]],
          pagesTab,
        ) + listOf(pagesTab === "title" ? data.pageTitles : data.pages, "path"),
      ) +
        panel(
          "perfEnv",
          t("a_environment", "Environment"),
          tabsOf(
            "perfEnv",
            [["device", t("a_f_device", "Device")], ["browser", t("a_f_browser", "Browser")]],
            envTab,
          ) + listOf(envTab === "browser" ? data.browsers : data.devices, envTab),
        ),
    )
  );
}

/* ─── breakdown ───────────────────────────────────────────────────────────── */

async function viewBreakdown() {
  const res = await report("breakdown", { fields: state.fields });
  if (!res.ok) return failure(res);

  const list = Array.isArray(res.data) ? res.data : (res.data && res.data.data) || [];

  const picker = `<div class="bma-fields" data-k="fields" data-sig="${escapeHTML(
    state.fields.join(","),
  )}">${BREAKDOWN_FIELDS.map(
    ([f, key]) =>
      `<button type="button" data-field="${f}"${
        state.fields.includes(f) ? ' class="is-on"' : ""
      }>${escapeHTML(t(key, f))}</button>`,
  ).join("")}</div>`;

  const cols = state.fields
    .map((f) => ({
      key: "f:" + f,
      label: t((FIELDS.find(([x]) => x === f) || [])[1] || f, f),
      wide: true,
    }))
    .concat([
      { key: "visitors", label: t("a_visitors", "Visitors"), num: true, strong: true },
      { key: "visits", label: t("a_visits", "Visits"), num: true },
      { key: "views", label: t("a_views", "Views"), num: true },
      { key: "bounce", label: t("a_bounce", "Bounce rate"), num: true },
      { key: "time", label: t("a_duration", "Visit duration"), num: true },
    ]);

  const table = list.slice(0, 200).map((r) => {
    const bounce = num(r.visits)
      ? Math.round((Math.min(num(r.bounces), num(r.visits)) / num(r.visits)) * 100)
      : 0;
    const each = num(r.visits) ? num(r.totaltime) / num(r.visits) : 0;
    const row = {
      visitors: { html: escapeHTML(full(r.visitors)), v: num(r.visitors) },
      visits: { html: escapeHTML(full(r.visits)), v: num(r.visits) },
      views: { html: escapeHTML(full(r.views)), v: num(r.views) },
      bounce: { html: bounce + "%", v: bounce },
      time: { html: escapeHTML(duration(each)), v: each },
    };
    for (const f of state.fields) {
      const name = valueName(f, r[f], r);
      row["f:" + f] = { html: chip(f, r[f], r, name), v: name };
    }
    return row;
  });

  return panel(
    "breakdown",
    t("a_breakdown", "Breakdown"),
    picker +
      `<p class="bm-hint" data-k="breakNote">${escapeHTML(
        t("a_break_note", "Pick the dimensions to cross. At least one, at most four."),
      )}</p>` +
      dataTable("breakdown", cols, table, { min: 260 + cols.length * 110 }),
  );
}

/* ─── shell ───────────────────────────────────────────────────────────────── */

const RENDER = {
  overview: viewOverview,
  events: viewEvents,
  sessions: viewSessions,
  performance: viewPerformance,
  breakdown: viewBreakdown,
};

const skelPanel = (key, height) =>
  `<section class="bm-card bma-panel is-skeleton" data-k="${key}">
     <div class="bma-panel-head" data-k="${key}.head"><span class="bma-ghost w-30"></span></div>
     <div class="bma-panel-body" data-k="${key}.body"><span class="bma-ghost" style="height:${height}px"></span></div>
   </section>`;

/**
 * What the reader looks at while the first request of a view is in flight.
 *
 * It carries the REAL keys, so the answer does not replace it — each frame is
 * matched and filled in place. The page is therefore never blank, and never
 * jumps from one layout to another when the data lands.
 */
function skeleton(view) {
  const tiles = view === "events" ? 4 : 5;
  const metrics = `<div class="bma-metrics is-skeleton" data-k="metrics">${Array.from(
    { length: tiles },
    (_, i) => `<div class="bma-metric" data-k="m:s${i}"><span class="bma-ghost"></span></div>`,
  ).join("")}</div>`;

  if (view === "overview") {
    return (
      metrics +
      skelPanel("traffic", 300) +
      grid("panels", ["pages", "sources", "environment", "location"].map((k) => skelPanel(k, 220)).join("")) +
      skelPanel("compare", 220) +
      grid("geo", skelPanel("map", 260) + skelPanel("weekly", 260), " is-two-one")
    );
  }
  if (view === "performance") {
    return (
      `<div class="bma-bar" data-k="perfbar"><span class="bma-ghost w-30"></span></div>` +
      metrics +
      skelPanel("vitals", 300) +
      grid("perf", skelPanel("perfPages", 220) + skelPanel("perfEnv", 220))
    );
  }
  if (view === "breakdown") return skelPanel("breakdown", 320);
  return metrics + skelPanel(view, 320);
}

function shell() {
  section.innerHTML = `
    <h2 class="bm-section-title">
      <i class="fa-solid fa-chart-simple" aria-hidden="true"></i>${escapeHTML(
        t("a_title", "Analytics"),
      )}
    </h2>
    <p class="bm-lede">${escapeHTML(
      t("a_lede", "Read straight from Umami with an admin credential the Worker releases per session."),
    )}</p>
    <div class="bma-head">
      ${seg("view", VIEWS.map((v) => [v, t("a_" + v, v)]), state.view)}
      ${seg("days", RANGES.map(([d, , text]) => [d, text]), state.days)}
    </div>
    <div class="bma-body" data-a-body></div>`;
}

/**
 * Reconcile a rendered string against what is on screen, by key.
 *
 * A node whose key and markup both match is LEFT ALONE — not re-created, not
 * re-parsed, not re-animated. A node whose key matches but whose markup changed
 * is recursed into when it has keyed children of its own, so switching a tab
 * replaces that panel's body and leaves its frame, its title and every other
 * panel exactly where they were. Anything carrying a `data-sig` is compared on
 * that instead of on its markup, which is how a drawn chart survives a repaint
 * of the page around it.
 */
function reconcile(host, incoming, fresh) {
  const old = new Map();
  for (const el of host.children) {
    const k = el.getAttribute("data-k");
    if (k && !old.has(k)) old.set(k, el);
  }

  const final = [];
  for (const node of incoming) {
    const key = node.getAttribute("data-k");
    const prev = key ? old.get(key) : null;

    if (!prev || prev.tagName !== node.tagName) {
      node.classList.add("is-fresh");
      fresh.push(node);
      final.push(node);
      continue;
    }

    old.delete(key);

    const sig = node.getAttribute("data-sig");
    if (sig && prev.getAttribute("data-sig") === sig) {
      final.push(prev);
      continue;
    }

    if (prev.outerHTML === node.outerHTML) {
      final.push(prev);
      continue;
    }

    const nested = [...node.children].some((c) => c.hasAttribute("data-k"));
    if (nested && [...prev.children].some((c) => c.hasAttribute("data-k"))) {
      for (const attr of node.attributes) {
        if (prev.getAttribute(attr.name) !== attr.value) prev.setAttribute(attr.name, attr.value);
      }
      reconcile(prev, [...node.children], fresh);
      final.push(prev);
      continue;
    }

    node.classList.add("is-fresh");
    fresh.push(node);
    final.push(node);
  }

  final.forEach((node, i) => {
    const at = host.children[i];
    if (at !== node) host.insertBefore(node, at || null);
  });
  while (host.children.length > final.length) host.lastElementChild.remove();
}

function patch(host, html) {
  const next = document.createElement("div");
  next.innerHTML = html;
  const fresh = [];
  reconcile(host, [...next.children], fresh);
  // Off the class on the next frame, so the transition has a start state to run
  // from rather than resolving instantly against the same computed style.
  if (fresh.length) {
    requestAnimationFrame(() => fresh.forEach((n) => n.classList.remove("is-fresh")));
  }
}

/**
 * Everything a view's render reads, in one string.
 *
 * The clock is in it through the range's end, so the 24-hour view — whose buckets
 * move every minute — misses rather than serving an hour that has gone, while a
 * range of a day or more is stable until midnight.
 */
function renderKey() {
  return JSON.stringify([
    state.view,
    state.days,
    rangeOf(state.days).endAt,
    unitFor(),
    state.scale,
    state.metric,
    state.percentile,
    state.compareField,
    state.fields,
    state.tab,
    state.page,
    state.search,
    state.more,
    state.sort,
    !!geo.map,
  ]);
}

/** The chart specs this markup needs, so a cached view can still draw its plots. */
function snapshotCharts(html) {
  const out = new Map();
  const find = /data-chart="([^"]+)"/g;
  let hit;
  while ((hit = find.exec(html))) {
    const spec = charts.get(hit[1]);
    if (spec) out.set(hit[1], spec);
  }
  return out;
}

function remember(key, entry) {
  state.html.delete(key);
  state.html.set(key, entry);
  while (state.html.size > CACHE_MAX) state.html.delete(state.html.keys().next().value);
}

/** Session-scoped and in memory only: a reader's dashboard is not left on disk. */
function forget() {
  if (!state) return;
  state.cache.clear();
  state.html.clear();
}

/** The part of the page a control belongs to, or null when it moves all of it. */
function scopeOf(origin) {
  if (!origin || !origin.closest) return null;
  const box = origin.closest(".bma-panel") || origin.closest(".bma-bar, .bma-metrics");
  return box && box.getAttribute("data-k") && section.contains(box) ? box : null;
}

/**
 * Draw the wait where it is being waited for.
 *
 * Nothing is disabled and nothing is dimmed: the panel that asked carries a
 * hairline of its own until its answer lands, every other panel is untouched, and
 * every control — including the one just pressed — stays live throughout.
 */
function applyBusy(body) {
  body.classList.toggle("is-busy", bodyRuns > 0);
  body.querySelectorAll(".is-loading").forEach((node) => {
    if (!panelRuns.has(node.getAttribute("data-k"))) node.classList.remove("is-loading");
  });
  panelRuns.forEach((_, key) => {
    const box = body.querySelector(`[data-k="${key}"]`);
    if (box) box.classList.add("is-loading");
  });
}

function settle(body, html) {
  // A search box repaints its own view, so without this a reader loses the
  // caret on the first keystroke and types the rest of the word into nothing.
  const focused = document.activeElement;
  const keep =
    focused && focused.closest && focused.closest("[data-search]")
      ? { name: focused.getAttribute("data-search"), at: focused.selectionStart }
      : null;

  // Off before the diff and back on after it: a panel still carrying the class
  // would not match its own incoming markup, and would be rebuilt rather than
  // recognised. `applyBusy` puts it back on whatever is still waiting.
  body.querySelectorAll(".is-loading").forEach((node) => node.classList.remove("is-loading"));

  patch(body, html);
  applyBusy(body);
  paintCharts();
  wireScrollers();

  if (keep) {
    const input = body.querySelector(`[data-search="${keep.name}"]`);
    if (input && input !== document.activeElement) {
      input.focus();
      try {
        input.setSelectionRange(keep.at, keep.at);
      } catch {}
    }
  }

  try {
    window.dispatchEvent(new CustomEvent("redefine:content-resized"));
  } catch {}
}

/** @param {Element} [origin] the control that asked, if one did. */
async function paint(origin) {
  const body = section.querySelector("[data-a-body]");
  if (!body) return;

  const key = renderKey();
  const hit = state.html.get(key);
  const token = ++state.seq;

  // A view change has nothing on screen worth keeping, so its frames go up
  // immediately and the answer fills them in — unless the answer is already
  // here, in which case there is no moment to cover.
  if (body.dataset.view !== state.view) {
    body.dataset.view = state.view;
    charts = new Map();
    if (chartObserver) {
      chartObserver.disconnect();
      chartObserver = null;
    }
    if (!hit) patch(body, skeleton(state.view));
  }

  if (hit) {
    for (const [id, spec] of hit.specs) charts.set(id, spec);
    settle(body, hit.html);
    return;
  }

  const scope = scopeOf(origin);
  const scopeKey = scope && scope.getAttribute("data-k");
  if (scopeKey) panelRuns.set(scopeKey, (panelRuns.get(scopeKey) || 0) + 1);
  else bodyRuns += 1;
  applyBusy(body);

  let html;
  try {
    html = await RENDER[state.view]();
  } catch {
    html = failure({ status: 0 });
  } finally {
    if (scopeKey) {
      const left = (panelRuns.get(scopeKey) || 1) - 1;
      if (left > 0) panelRuns.set(scopeKey, left);
      else panelRuns.delete(scopeKey);
    } else bodyRuns = Math.max(0, bodyRuns - 1);
  }

  // A slower earlier request must not paint over a faster later one.
  if (token !== state.seq) {
    applyBusy(body);
    return;
  }

  remember(key, { html, specs: snapshotCharts(html) });
  settle(body, html);
}

/**
 * Mark the press NOW, not when the answer arrives.
 *
 * A picker that only lights up once its data lands reads as a control that
 * ignored the first press, which is what makes a reader press it again. The
 * box's signature is moved with it, so the repaint recognises the box and keeps
 * it rather than replacing what was just marked.
 */
function markOn(box, button, active) {
  box.querySelectorAll("button").forEach((b) => {
    const on = b === button;
    b.classList.toggle("is-on", on);
    if (!box.hasAttribute("data-tabs")) return;
    if (on) b.setAttribute("aria-selected", "true");
    else b.removeAttribute("aria-selected");
  });
  const sig = box.getAttribute("data-sig");
  if (sig) box.setAttribute("data-sig", sig.split("|")[0] + "|" + active);
}

function wire() {
  section.addEventListener("click", (event) => {
    const target = event.target;

    // Any tap that is not on a chart releases a pinned read-out.
    section.querySelectorAll("[data-chart]").forEach((host) => {
      if (!host.contains(target)) host.dispatchEvent(new CustomEvent("bma:release"));
    });

    const key = target.closest(".bma-key");
    if (key) {
      const host = key.closest("[data-chart]");
      const spec = host && charts.get(host.getAttribute("data-chart"));
      if (spec) {
        const off = hiddenOf(spec.id);
        const name = key.getAttribute("data-series");
        if (off.has(name)) off.delete(name);
        // The last visible series may not be switched off: an empty plot is not
        // a filter, it is a broken chart.
        else if (spec.series.length - off.size > 1) off.add(name);
        drawChart(host, spec);
      }
      return;
    }

    const sortTh = target.closest("[data-sort-key]");
    if (sortTh) {
      const name = sortTh.getAttribute("data-sort");
      const col = sortTh.getAttribute("data-sort-key");
      const current = state.sort[name];
      state.sort[name] =
        current && current.key === col
          ? { key: col, dir: current.dir === "asc" ? "desc" : "asc" }
          : { key: col, dir: sortTh.hasAttribute("data-num") ? "desc" : "asc" };
      paint(sortTh);
      return;
    }

    const segBtn = target.closest("[data-seg] [data-seg-id]");
    if (segBtn) {
      const box = segBtn.closest("[data-seg]");
      const group = box.getAttribute("data-seg");
      const value = segBtn.getAttribute("data-seg-id");
      // The view and the range move everything; the rest move one panel.
      let whole = false;

      if (group === "view") {
        state.view = value;
        whole = true;
      } else if (group === "days") {
        state.days = Number(value);
        // The range can move the unit out from under its own picker. The answers
        // are NOT dropped: they are keyed by the span they were asked for, so
        // coming back to a range already looked at costs nothing.
        if (!allowedUnits().includes(state.unit)) state.unit = null;
        whole = true;
      } else if (group === "unit") state.unit = value;
      else if (group.startsWith("scale:")) state.scale[group.slice(6)] = value;
      else if (group === "percentile") {
        state.percentile = value;
        whole = true;
      } else if (group === "compareField") state.compareField = value;
      else {
        state.tab[group] = value;
        if (group === "propEvent") state.tab.propName = null;
        if (group === "eventsView") state.page.events = 1;
      }

      markOn(box, segBtn, value);
      paint(whole ? null : segBtn);
      return;
    }

    const tab = target.closest("[data-tabs] [data-tab-id]");
    if (tab) {
      const box = tab.closest("[data-tabs]");
      const value = tab.getAttribute("data-tab-id");
      state.tab[box.getAttribute("data-tabs")] = value;
      markOn(box, tab, value);
      paint(tab);
      return;
    }

    const more = target.closest("[data-more]");
    if (more) {
      const name = more.getAttribute("data-more");
      state.more[name] = !state.more[name];
      paint(more);
      return;
    }

    const pick = target.closest("[data-pick]");
    if (pick) {
      state.metric = pick.getAttribute("data-pick");
      paint();
      return;
    }

    const field = target.closest("[data-field]");
    if (field) {
      const name = field.getAttribute("data-field");
      const next = state.fields.includes(name)
        ? state.fields.filter((f) => f !== name)
        : state.fields.concat(name).slice(-4);
      // Crossing nothing is not a breakdown; keep the last dimension standing.
      state.fields = next.length ? next : state.fields;
      state.sort.breakdown = null;
      paint(field);
      return;
    }

    const step = target.closest("[data-pager] [data-step]");
    if (step) {
      const name = step.closest("[data-pager]").getAttribute("data-pager");
      state.page[name] = Math.max(
        1,
        (state.page[name] || 1) + Number(step.getAttribute("data-step")),
      );
      paint(step);
    }
  });

  // A sortable header is a button in everything but tag name.
  section.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const hit = event.target.closest("[data-sort-key], [data-pick]");
    if (!hit) return;
    event.preventDefault();
    hit.click();
  });

  section.addEventListener("pointermove", wireMap);

  // A scroll event does not bubble, but it IS seen on the way down, so one
  // capturing listener serves every table without touching a single node — and
  // attributes written onto a scroller would make the next diff replace it.
  section.addEventListener(
    "scroll",
    (event) => {
      const box = event.target.closest && event.target.closest("[data-scrollbox]");
      if (box) edges(box);
    },
    true,
  );

  // Typed search, settled: one request when the typing stops, not one per key.
  let timer = null;
  section.addEventListener("input", (event) => {
    const input = event.target.closest("[data-search]");
    if (!input) return;
    const name = input.getAttribute("data-search");
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.search[name] = input.value.trim();
      state.page[name] = 1;
      paint(input);
    }, 350);
  });
}

/**
 * The world outlines and the subdivision names: 180 KB between them, wanted by
 * exactly one page of this site. Fetched beside the first render rather than
 * bundled into it.
 */
function loadGeo(host) {
  if (geo.asked) return;
  geo.asked = true;
  Promise.all([
    import("../data/worldMap.js").then((m) => (geo.map = m.default || m)),
    import("../data/regionNames.js").then((m) => (geo.region = m.regionName)),
  ])
    .catch(() => {})
    .then(() => {
      if (section === host) paint();
    });
}

/**
 * @param {Element} host       the `[data-part="analytics"]` section
 * @param {Element} consoleEl  the console root
 * @param {Function} translate the console's own `t`
 */
export function initManagementAnalytics(host, consoleEl, translate) {
  if (!host) return;

  section = host;
  t = translate || t;
  state = {
    view: "overview",
    days: 30,
    unit: null,
    scale: { ...SCALES },
    metric: "lcp",
    percentile: "p75",
    compareField: "path",
    fields: ["path"],
    tab: {},
    page: {},
    search: {},
    more: {},
    sort: {},
    hidden: {},
    cache: new Map(),
    html: new Map(),
    seq: 0,
  };
  charts = new Map();
  bodyRuns = 0;
  panelRuns = new Map();
  if (chartObserver) {
    chartObserver.disconnect();
    chartObserver = null;
  }
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }

  // The credential is asked for once, ahead of the first view, so several
  // parallel requests do not each race to mint it.
  adminToken();

  shell();
  wire();
  paint();
  loadGeo(host);
}

// The session's own answers, and they leave with the session: the page going
// away, or the credential behind them being given up.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", forget);
  window.addEventListener("blog:auth-change", () => {
    if (!window.blogAuth || !window.blogAuth.isAdmin) forget();
  });
}
