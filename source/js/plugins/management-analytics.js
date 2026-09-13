/**
 * The console's Analytics section — Umami's own dashboard, rebuilt in the
 * theme's vocabulary, panel for panel.
 *
 *   Overview     five headline metrics against the previous period; the stacked
 *                visitors/views chart with a unit and a scale picker; Pages,
 *                Sources, Environment and Location as tabbed ranked tables; and
 *                the world map beside the weekly traffic grid.
 *   Events       four metrics, the event series stacked by name, the ranked
 *                event list, the paged activity log, the property explorer.
 *   Sessions     five metrics, the paged session table, the property explorer.
 *   Performance  a percentile picker, the five web vitals as selectable cards,
 *                the p50/p75/p95 chart, the pages and environment tables.
 *   Compare      the metrics bar and the chart against the previous period, and
 *                the dimension table with per-row change.
 *   Breakdown    any combination of dimensions, crossed, with every metric.
 *
 * The browser talks to Umami DIRECTLY with the bearer the Worker released.
 *
 * The chart is drawn at MEASURED PIXEL SIZE rather than in a stretched viewBox.
 * That is what makes an axis possible: a stretched box cannot carry a tick, a
 * gridline or a label without deforming them.
 */

import { escapeHTML } from "./notifications-inbox.js";
import { adminQuery, adminReport, adminToken, timezone } from "../tools/analytics.js";

const VIEWS = ["overview", "events", "sessions", "performance", "compare", "breakdown"];

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

// Twelve hues, the first of which is the site accent so the lead series stays on
// brand and the other eleven stay apart from it and from each other. Resolved in
// the stylesheet, where each can be tuned per colour scheme.
const SERIES = Array.from({ length: 12 }, (_, i) => `var(--bma-p${i + 1})`);

let section = null;
let t = (k, f) => f;
let state = null;
let charts = new Map();
let chartObserver = null;
let worldMap = null;

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

function bucketLabel(x, unit) {
  const s = String(x);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}))?/.exec(s);
  if (!m) return s;
  if (unit === "hour") return String(+m[4]) + ":00";
  if (unit === "month") return m[1].slice(2) + "/" + m[2];
  return m[2] + "/" + m[3];
}

function rangeOf(days) {
  const end = new Date();
  const start = new Date(end);
  if (days <= 1) {
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
 * Which units Umami will actually honour for the current span. It clamps
 * anything finer than the range allows (lib/date.getAllowedUnits), so offering
 * `hour` over a year would be offering a button that silently does nothing.
 */
function allowedUnits() {
  const d = state.days;
  const min = d <= 30 ? "hour" : d <= 180 ? "day" : "month";
  return UNITS.slice(UNITS.indexOf(min));
}

function unitFor() {
  const allowed = allowedUnits();
  if (state.unit && allowed.includes(state.unit)) return state.unit;
  const fallback = (RANGES.find(([d]) => d === state.days) || [0, "day"])[1];
  return allowed.includes(fallback) ? fallback : allowed[0];
}

/* ─── names and icons ─────────────────────────────────────────────────────── */

const display = {};

/** Intl carries every region and language name already; a table would be dead weight. */
function named(kind, code) {
  const value = String(code || "").trim();
  if (!value) return "";
  try {
    if (!display[kind]) {
      display[kind] = new Intl.DisplayNames(
        [document.documentElement.lang || "en"],
        { type: kind },
      );
    }
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
  unknown: "fa-solid fa-circle-question",
};

const pick = (table, value) => {
  const v = String(value || "").toLowerCase();
  for (const [re, cls] of table) if (re.test(v)) return cls;
  return null;
};

/**
 * The mark that goes in front of a row's name.
 *
 * A referrer gets its real favicon; everything else gets a Font Awesome glyph,
 * because a name alone in a list of ten is a paragraph and an icon makes it a
 * table you can scan.
 */
function rowIcon(type, value) {
  const v = String(value == null ? "" : value);

  if (type === "country") {
    const f = flag(v);
    return f ? `<span class="bma-ico bma-flag">${f}</span>` : dot("fa-solid fa-globe");
  }
  if (type === "browser") return dot(pick(BROWSER_ICONS, v) || "fa-solid fa-window-maximize");
  if (type === "os") return dot(pick(OS_ICONS, v) || "fa-solid fa-desktop");
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
  if (type === "path" || type === "fullPath" || type === "entry" || type === "exit") {
    return dot("fa-regular fa-file-lines");
  }
  if (type === "language") return dot("fa-solid fa-language");
  if (type === "region" || type === "city") return dot("fa-solid fa-location-dot");
  if (type === "event") return dot("fa-solid fa-bolt");
  return "";
}

const dot = (cls) => `<span class="bma-ico"><i class="${cls}" aria-hidden="true"></i></span>`;

/** The readable form of a raw dimension value. */
function label(type, value) {
  const v = value == null || value === "" ? "" : String(value);
  if (!v) return t("a_direct", "Direct / none");
  if (type === "country") return named("region", v) || v;
  if (type === "language") return named("language", v.split("-")[0]) || v;
  if (type === "channel") return t("a_ch_" + v.toLowerCase(), v);
  return v;
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
const spinner = () => `<div class="bma-wait"><i class="fa-solid fa-circle-notch fa-spin"></i></div>`;

function seg(group, items, active, extra = "") {
  return `<div class="bm-seg bma-seg${extra}" data-seg="${group}" role="group">${items
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
    }"${options.pick ? ` data-pick="${escapeHTML(options.pick)}" tabindex="0" role="button"` : ""}>
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

const metricsBar = (tiles) => `<div class="bma-metrics">${tiles.join("")}</div>`;

function panel(title, inner, options = {}) {
  return `
    <section class="bm-card bma-panel${options.span ? " span-" + options.span : ""}">
      ${
        title || options.aside
          ? `<div class="bma-panel-head">
              <h3 class="bm-sub-title">${escapeHTML(title || "")}</h3>
              ${options.aside || ""}
            </div>`
          : ""
      }
      ${inner}
    </section>`;
}

function tabsOf(group, items, active) {
  return `<div class="bma-tabs" data-tabs="${group}" role="tablist">${items
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
      const name = options.label ? options.label(r) : label(type, r.x);
      const icon = options.icon === false ? "" : rowIcon(type, r.x);
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

  return `
    <div class="bma-list">
      <div class="bma-list-head">
        <span>${escapeHTML(options.head || t("a_name", "Name"))}</span>
        <span>${escapeHTML(options.metric || t("a_visitors", "Visitors"))}</span>
        ${options.share === false ? "" : "<span></span>"}
      </div>
      <ol class="bma-rows">${body}</ol>
      ${more}
    </div>`;
}

function table(head, body, options = {}) {
  if (!body) return blank(t("a_nodata", "Nothing in this range"));
  return `
    <div class="bma-scroll">
      <table class="bma-table${options.fixed ? " is-fixed" : ""}">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function pager(name, page, count) {
  const pages = Math.max(1, Math.ceil(num(count) / PAGE_SIZE));
  if (pages <= 1 && page <= 1) return "";
  return `
    <div class="bma-pager" data-pager="${name}">
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

function search(name, value) {
  return `<label class="bma-search">
    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
    <input type="search" data-search="${name}" value="${escapeHTML(value || "")}"
           placeholder="${escapeHTML(t("a_search", "Search"))}" />
  </label>`;
}

/** The unit and scale pickers a chart panel carries in its head. */
function chartControls(options = {}) {
  const units = allowedUnits().map((u) => [u, t("a_u_" + u, u)]);
  return (
    `<div class="bma-controls">` +
    (options.unit === false || units.length < 2 ? "" : seg("unit", units, unitFor())) +
    seg("scale", [["linear", t("a_linear", "Linear")], ["log", t("a_log", "Log")]], state.scale) +
    `</div>`
  );
}

/* ─── the chart ───────────────────────────────────────────────────────────── */

function chart(spec) {
  const id = "c" + state.seq + "-" + charts.size;
  charts.set(id, spec);
  return `<div class="bma-chart" data-chart="${id}" style="--bma-chart-h:${
    spec.height || 300
  }px"><div class="bma-chart-tip" data-chart-tip></div></div>`;
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

function drawChart(host, spec) {
  const width = host.clientWidth;
  if (!width) return;

  const series = (spec.series || []).filter((s) => s.data && s.data.length);
  if (!series.length) {
    host.dataset.w = String(width);
    host.innerHTML = blank(t("a_nodata", "Nothing in this range"));
    return;
  }

  const log = state.scale === "log" && spec.log !== false;
  const points = series.reduce((m, s) => Math.max(m, s.data.length), 0);
  const height = spec.height || 300;
  const padT = 12;
  const padB = 42;
  const padR = 12;
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
  const labelSource = series[0].data;
  for (let i = 0; i < points; i++) {
    if (i % every || !labelSource[i]) continue;
    const px = padL + (i + 0.5) * band;
    parts.push(
      `<text class="bma-axis-x" x="${px.toFixed(1)}" y="${height - padB + 18}">${escapeHTML(
        bucketLabel(labelSource[i].x, spec.unit),
      )}</text>`,
    );
  }

  // Wide bars with a hairline between them, which is what makes a month of data
  // read as a run rather than as a picket fence.
  const bw = Math.max(1, band * (band > 6 ? 0.82 : 0.94));
  const bx = (i) => padL + i * band + (band - bw) / 2;

  for (let i = 0; i < points; i++) {
    let below = 0;
    for (const s of bars) {
      const value = num(s.data[i] && s.data[i].y);
      if (value <= 0) continue;
      const yTop = y(below + value);
      const yBottom = y(below);
      below += value;
      const h = Math.max(1, yBottom - yTop);
      parts.push(
        `<rect class="bma-col" fill="${s.color}" x="${bx(i).toFixed(2)}" y="${yTop.toFixed(
          2,
        )}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}"/>`,
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
    `<rect class="bma-cursor" data-cursor x="0" y="${padT}" width="${band.toFixed(
      2,
    )}" height="${plotH}" hidden/>`,
  );

  const svg =
    `<svg class="bma-chart-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `role="img" aria-label="${escapeHTML(spec.label || "")}">${parts.join("")}</svg>`;

  const legend = `<div class="bma-legend">${series
    .map(
      (s) =>
        `<span><i class="${s.type === "line" ? "is-line" : ""}" style="background:${
          s.color
        }"></i>${escapeHTML(s.name)}</span>`,
    )
    .join("")}</div>`;

  host.dataset.w = String(width);
  host.innerHTML = svg + legend + '<div class="bma-chart-tip" data-chart-tip></div>';

  wireChartHover(host, { series, padL, band, points, format, unit: spec.unit });
}

function wireChartHover(host, ctx) {
  const svg = host.querySelector("svg");
  const cursor = host.querySelector("[data-cursor]");
  const tip = host.querySelector("[data-chart-tip]");
  if (!svg || !cursor || !tip || !ctx.points) return;

  const leave = () => {
    cursor.setAttribute("hidden", "");
    tip.classList.remove("is-on");
  };

  svg.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect();
    const scale = box.width / (svg.viewBox.baseVal.width || box.width) || 1;
    const i = Math.floor(((event.clientX - box.left) / scale - ctx.padL) / ctx.band);
    if (i < 0 || i >= ctx.points) return leave();

    cursor.setAttribute("x", (ctx.padL + i * ctx.band).toFixed(2));
    cursor.removeAttribute("hidden");

    const head = ctx.series.find((s) => s.data[i]);
    tip.innerHTML =
      `<b>${escapeHTML(bucketLabel(head ? head.data[i].x : "", ctx.unit))}</b>` +
      ctx.series
        .map(
          (s) =>
            `<span><i style="background:${s.color}"></i>${escapeHTML(s.name)}<em>${escapeHTML(
              ctx.format(s.data[i] ? s.data[i].y : 0),
            )}</em></span>`,
        )
        .join("");
    tip.classList.add("is-on");

    const px = (ctx.padL + (i + 0.5) * ctx.band) * scale;
    tip.style.left =
      Math.min(Math.max(px, tip.offsetWidth / 2 + 4), box.width - tip.offsetWidth / 2 - 4) + "px";
  });

  svg.addEventListener("pointerleave", leave);
}

function paintCharts() {
  const hosts = section.querySelectorAll("[data-chart]");
  if (!hosts.length) return;

  // Redraw on a real width change only: the draw replaces the host's contents,
  // and a redraw that reacted to its own output would never settle.
  chartObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          for (const entry of entries) {
            const host = entry.target;
            const spec = charts.get(host.getAttribute("data-chart"));
            if (spec && host.clientWidth && host.dataset.w !== String(host.clientWidth)) {
              drawChart(host, spec);
            }
          }
        });

  hosts.forEach((host) => {
    const spec = charts.get(host.getAttribute("data-chart"));
    if (!spec) return;
    drawChart(host, spec);
    if (chartObserver) chartObserver.observe(host);
  });
}

/* ─── overview ────────────────────────────────────────────────────────────── */

async function viewOverview(compareMode) {
  const unit = unitFor();
  const [stats, chartRes] = await Promise.all([
    get("/api/websites/:id/stats", compareMode ? { compare: "prev" } : null),
    get("/api/websites/:id/pageviews", {
      unit,
      timezone: timezone(),
      ...(compareMode ? { compare: "prev" } : null),
    }),
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

  const d = chartRes.data || {};
  const views = d.pageviews || [];
  const sessions = d.sessions || [];

  // Visitors at the bottom, the rest of the views above: the bar's full height
  // is the views, and the split says how much of it was repeat reading. Two
  // separate bars per bucket would say neither.
  const series = [
    { name: t("a_visitors", "Visitors"), data: sessions, color: SERIES[0] },
    {
      name: t("a_views", "Views"),
      data: views.map((r, i) => ({
        x: r.x,
        y: Math.max(0, num(r.y) - num(sessions[i] && sessions[i].y)),
      })),
      color: SERIES[6],
    },
  ];

  if (compareMode && d.compare) {
    const align = (from, onto) =>
      (from || []).map((r, i) => ({ x: ((onto || [])[i] || r).x, y: r.y }));
    series.push(
      {
        name: t("a_prev_views", "Views (previous)"),
        data: align(d.compare.pageviews, views),
        color: SERIES[4],
        type: "line",
      },
      {
        name: t("a_prev_visitors", "Visitors (previous)"),
        data: align(d.compare.sessions, sessions),
        color: SERIES[3],
        type: "line",
      },
    );
  }

  const plot = panel(
    t("a_traffic_over_time", "Traffic"),
    chart({ series, unit, height: 320, label: t("a_views", "Views") }),
    { aside: chartControls() },
  );

  if (compareMode) return bar + plot + (await compareTables());
  return bar + plot + (await overviewPanels());
}

async function overviewPanels() {
  const picks = PANELS.map(([group, tabs]) => [group, tabs, state.tab[group] || tabs[0][0]]);

  const [results, weekly, map] = await Promise.all([
    Promise.all(picks.map(([, , type]) => get("/api/websites/:id/metrics", { type, limit: 30 }))),
    get("/api/websites/:id/sessions/weekly", { timezone: timezone() }),
    get("/api/websites/:id/metrics", { type: "country", limit: 250 }),
  ]);

  const cards = picks
    .map(([group, tabs, type], i) => {
      const res = results[i];
      const head = tabs.find(([f]) => f === type);
      const body = res.ok
        ? listTable(rows(res), {
            type,
            head: t(head ? head[1] : type, type),
            more: group,
          })
        : failure(res);
      return panel(
        t("a_" + group, group),
        tabsOf(group, tabs.map(([f, key]) => [f, t(key, f)]), type) + body,
      );
    })
    .join("");

  return (
    `<div class="bma-grid">${cards}</div>` +
    `<div class="bma-grid is-two-one">` +
    panel(t("a_map", "Visitors by country"), worldMapPanel(rows(map)), { span: 2 }) +
    panel(t("a_weekly", "Weekly traffic"), weeklyGrid(weekly.ok ? weekly.data : null), {
      aside: seg(
        "scale",
        [["linear", t("a_linear", "Linear")], ["log", t("a_log", "Log")]],
        state.scale,
        " is-mini",
      ),
    }) +
    `</div>`
  );
}

/* ─── world map ───────────────────────────────────────────────────────────── */

/**
 * The choropleth. Six steps rather than a continuous ramp: a country's exact
 * share is what the list beside it is for, and a continuous fill on 174 shapes
 * reads as noise at this size.
 */
function worldMapPanel(list) {
  if (!worldMap) return `<div class="bma-map is-waiting">${spinner()}</div>`;

  const total = list.reduce((s, r) => s + num(r.y), 0);
  const byCode = new Map(list.map((r) => [String(r.x || "").toUpperCase(), num(r.y)]));
  const peak = list.reduce((m, r) => Math.max(m, num(r.y)), 0) || 1;

  const shapes = Object.entries(worldMap.PATHS)
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

  return `
    <div class="bma-map" data-map>
      <svg viewBox="${worldMap.VIEWBOX}" preserveAspectRatio="xMidYMid meet"
           role="img" aria-label="${escapeHTML(t("a_map", "Visitors by country"))}">${shapes}</svg>
      <div class="bma-map-tip" data-map-tip></div>
    </div>`;
}

function wireMap() {
  const host = section.querySelector("[data-map]");
  const tip = host && host.querySelector("[data-map-tip]");
  if (!host || !tip) return;

  host.addEventListener("pointermove", (event) => {
    const land = event.target.closest(".bma-land");
    if (!land) {
      tip.classList.remove("is-on");
      return;
    }
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
  });

  host.addEventListener("pointerleave", () => tip.classList.remove("is-on"));
}

/* ─── weekly traffic ──────────────────────────────────────────────────────── */

/**
 * Days across, hours down, each cell a dot whose size and opacity carry the
 * count — Umami's own grid, and the reason it is dots rather than squares is
 * that a quiet hour should read as nearly nothing rather than as a pale tile.
 */
function weeklyGrid(data) {
  if (!Array.isArray(data) || data.length !== 7) {
    return blank(t("a_nodata", "Nothing in this range"));
  }

  let peak = 0;
  data.forEach((day) => day.forEach((v) => (peak = Math.max(peak, num(v)))));

  const log = state.scale === "log";
  const ratio = (v) => {
    const n = num(v);
    if (!n || !peak) return 0;
    return log ? Math.log1p(n) / Math.log1p(peak) : n / peak;
  };

  const days = t("a_weekdays", "Sun,Mon,Tue,Wed,Thu,Fri,Sat").split(",");
  const hour = (h) =>
    h === 0 ? "12am" : h < 12 ? h + "am" : h === 12 ? "12pm" : h - 12 + "pm";

  const head = `<div class="bma-week-row is-head"><span></span>${days
    .map((d) => `<span>${escapeHTML(d)}</span>`)
    .join("")}</div>`;

  const body = Array.from({ length: 24 }, (_, h) => {
    const cells = data
      .map((day) => {
        const v = num(day[h]);
        const r = ratio(v);
        return `<i style="--bma-dot:${r.toFixed(3)}" title="${escapeHTML(full(v))}"></i>`;
      })
      .join("");
    return `<div class="bma-week-row"><span>${hour(h)}</span>${cells}</div>`;
  }).join("");

  return `<div class="bma-week">${head}${body}</div>`;
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

  const head = tabsOf("events", [
    ["chart", t("a_chart", "Chart")],
    ["activity", t("a_activity", "Activity")],
    ["properties", t("a_properties", "Properties")],
  ], tab);

  let body;
  let aside = "";
  if (tab === "activity") body = await eventsActivity();
  else if (tab === "properties") body = await eventProperties();
  else {
    body = await eventsChart();
    aside = chartControls();
  }

  return bar + panel(t("a_events", "Events"), head + body, { aside });
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
  const buckets = [];
  const seen = new Set();
  const byName = new Map();
  for (const row of rows(series)) {
    const key = String(row.t);
    if (!seen.has(key)) {
      seen.add(key);
      buckets.push(key);
    }
    const name = String(row.x);
    if (!byName.has(name)) byName.set(name, new Map());
    byName.get(name).set(key, num(row.y));
  }
  buckets.sort();

  const names = [...byName.keys()].sort(
    (a, b) =>
      [...byName.get(b).values()].reduce((x, v) => x + v, 0) -
      [...byName.get(a).values()].reduce((x, v) => x + v, 0),
  );

  const stacks = names.map((name, i) => ({
    name,
    color: SERIES[i % SERIES.length],
    data: buckets.map((b) => ({ x: b, y: byName.get(name).get(b) || 0 })),
  }));

  return (
    chart({ series: stacks, unit, height: 300, label: t("a_events_fired", "Events") }) +
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

  const list = (res.data && res.data.data) || [];
  const body = list
    .map(
      (r) => `
      <tr>
        <td><span class="bma-kind ${r.eventName ? "is-event" : "is-view"}">
          <i class="fa-solid fa-${r.eventName ? "bolt" : "eye"}" aria-hidden="true"></i>
          ${escapeHTML(r.eventName ? t("a_triggered", "Event") : t("a_viewed", "View"))}
        </span></td>
        <td class="bma-strong" title="${escapeHTML(r.eventName || r.urlPath || "")}">${escapeHTML(
          r.eventName || r.urlPath || "",
        )}</td>
        <td>${cell("country", r.country, [r.city, label("country", r.country)].filter(Boolean).join(", "))}</td>
        <td>${cell("browser", r.browser)}</td>
        <td>${cell("device", r.device)}</td>
        <td class="bma-num">${escapeHTML(when(r.createdAt))}</td>
      </tr>`,
    )
    .join("");

  return (
    `<div class="bma-bar">${seg("eventsView", [
      ["all", t("a_all", "All")],
      ["views", t("a_views", "Views")],
      ["events", t("a_events", "Events")],
    ], view)}${search("events", state.search.events)}</div>` +
    table(
      th(t("a_type", "Type")) +
        th(t("a_event", "Event")) +
        th(t("a_location", "Location")) +
        th(t("a_f_browser", "Browser")) +
        th(t("a_f_device", "Device")) +
        th(t("a_when", "When"), true),
      body,
    ) +
    pager("events", page, (res.data && res.data.count) || 0)
  );
}

const th = (text, right) =>
  `<th${right ? ' class="bma-num"' : ""}>${escapeHTML(text)}</th>`;

/** A table cell that carries the same icon its ranked list would. */
function cell(type, value, text) {
  const shown = text !== undefined ? text : label(type, value);
  if (!value) return escapeHTML(shown || "");
  return `<span class="bma-cell" title="${escapeHTML(shown)}">${rowIcon(type, value)}<span>${escapeHTML(
    shown,
  )}</span></span>`;
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
    `<div class="bma-bar">
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

  const head = tabsOf("sessions", [
    ["activity", t("a_activity", "Activity")],
    ["properties", t("a_properties", "Properties")],
  ], tab);

  const body = tab === "properties" ? await sessionProperties() : await sessionsActivity();
  return bar + panel(t("a_sessions", "Sessions"), head + body);
}

async function sessionsActivity() {
  const page = state.page.sessions || 1;
  const res = await get("/api/websites/:id/sessions", {
    page,
    pageSize: PAGE_SIZE,
    search: state.search.sessions || undefined,
  });

  if (!res.ok) return failure(res);

  const list = (res.data && res.data.data) || [];
  const body = list
    .map((r) => {
      const where = [r.city, label("country", r.country)].filter(Boolean).join(", ");
      return `
      <tr>
        <td class="bma-id" title="${escapeHTML(r.id || "")}">${escapeHTML(
          String(r.id || "").slice(0, 8),
        )}</td>
        <td class="bma-num">${escapeHTML(full(r.visits))}</td>
        <td class="bma-num">${escapeHTML(full(r.views))}</td>
        <td class="bma-num">${escapeHTML(full(r.events))}</td>
        <td>${cell("country", r.country, where)}</td>
        <td>${cell("browser", r.browser)}</td>
        <td>${cell("os", r.os)}</td>
        <td>${cell("device", r.device)}</td>
        <td class="bma-num">${escapeHTML(when(r.lastAt || r.createdAt))}</td>
      </tr>`;
    })
    .join("");

  return (
    `<div class="bma-bar">${search("sessions", state.search.sessions)}</div>` +
    table(
      th(t("a_session", "Session")) +
        th(t("a_visits", "Visits"), true) +
        th(t("a_views", "Views"), true) +
        th(t("a_events", "Events"), true) +
        th(t("a_location", "Location")) +
        th(t("a_f_browser", "Browser")) +
        th(t("a_f_os", "OS")) +
        th(t("a_f_device", "Device")) +
        th(t("a_last_seen", "Last seen"), true),
      body,
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
    `<div class="bma-bar">${seg("sessProp", names.map((n) => [n, n]), prop)}</div>` +
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
  const res = await report("performance", {
    unit,
    timezone: timezone(),
    metric: state.metric,
  });

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

  const series = PERCENTILES.map((name, i) => ({
    name,
    type: "line",
    color: SERIES[[0, 4, 1][i]],
    data: (data.chart || []).map((r) => ({ x: r.t, y: num(r[name]) })),
  }));

  const format = (v) => vital(state.metric, v);
  const spec = VITALS.find(([k]) => k === state.metric) || VITALS[0];

  const listOf = (source, type) =>
    listTable(
      (source || [])
        .filter((r) => num(r[p]) > 0)
        .slice(0, 20)
        .map((r) => ({ x: r.name, y: num(r[p]) })),
      {
        type,
        head: t("a_name", "Name"),
        metric: spec[1] + " " + p,
        format,
        share: false,
      },
    );

  const pagesTab = state.tab.perfPages || "path";
  const envTab = state.tab.perfEnv || "device";

  return (
    `<div class="bma-bar">${seg("percentile", PERCENTILES.map((x) => [x, x]), p)}
      <span class="bm-hint">${escapeHTML(
        t("a_samples", "Samples") + ": " + full(summary.count),
      )}</span></div>` +
    cards +
    panel(VITAL_NAMES[state.metric] || spec[1], chart({ series, unit, height: 300, format }), {
      aside: chartControls(),
    }) +
    `<div class="bma-grid">${panel(
      t("a_pages", "Pages"),
      tabsOf("perfPages", [
        ["path", t("a_f_path", "Path")],
        ["title", t("a_f_title", "Title")],
      ], pagesTab) + listOf(pagesTab === "title" ? data.pageTitles : data.pages, "path"),
    )}${panel(
      t("a_environment", "Environment"),
      tabsOf("perfEnv", [
        ["device", t("a_f_device", "Device")],
        ["browser", t("a_f_browser", "Browser")],
      ], envTab) + listOf(envTab === "browser" ? data.browsers : data.devices, envTab),
    )}</div>`
  );
}

/* ─── compare ─────────────────────────────────────────────────────────────── */

const viewCompare = () => viewOverview(true);

async function compareTables() {
  const type = state.compareField;
  const { start, startAt, endAt } = rangeOf(state.days);
  const span = endAt - startAt;

  const [now, before] = await Promise.all([
    get("/api/websites/:id/metrics", { type, limit: 20 }),
    adminQuery("/api/websites/:id/metrics", {
      type,
      limit: 20,
      startAt: start.getTime() - span,
      endAt: start.getTime(),
    }),
  ]);

  const prev = new Map(rows(before).map((r) => [String(r.x), num(r.y)]));
  const list = rows(now).map((r) => ({ ...r, prev: prev.get(String(r.x)) }));

  const body = list
    .map((r) => {
      const change = delta(r.y, r.prev);
      return `
      <tr>
        <td>${cell(type, r.x)}</td>
        <td class="bma-num">${escapeHTML(full(r.prev || 0))}</td>
        <td class="bma-num bma-strong">${escapeHTML(full(r.y))}</td>
        <td class="bma-num"><span class="bma-delta${
          change === null || change === 0 ? "" : change > 0 ? " is-up" : " is-down"
        }">${change === null ? "—" : (change > 0 ? "+" : "") + change + "%"}</span></td>
      </tr>`;
    })
    .join("");

  return panel(
    t("a_compare", "Compare"),
    `<div class="bma-bar">${seg(
      "compareField",
      FIELDS.map(([f, key]) => [f, t(key, f)]),
      type,
    )}</div>` +
      table(
        th(t("a_name", "Name")) +
          th(t("a_previous", "Previous"), true) +
          th(t("a_current", "Current"), true) +
          th(t("a_change", "Change"), true),
        body,
      ),
  );
}

/* ─── breakdown ───────────────────────────────────────────────────────────── */

async function viewBreakdown() {
  const res = await report("breakdown", { fields: state.fields });
  if (!res.ok) return failure(res);

  const list = Array.isArray(res.data) ? res.data : (res.data && res.data.data) || [];

  const picker = `<div class="bma-fields">${BREAKDOWN_FIELDS.map(
    ([f, key]) =>
      `<button type="button" data-field="${f}"${
        state.fields.includes(f) ? ' class="is-on"' : ""
      }>${escapeHTML(t(key, f))}</button>`,
  ).join("")}</div>`;

  const head =
    state.fields
      .map((f) => th(t((FIELDS.find(([x]) => x === f) || [])[1] || f, f)))
      .join("") +
    th(t("a_visitors", "Visitors"), true) +
    th(t("a_visits", "Visits"), true) +
    th(t("a_views", "Views"), true) +
    th(t("a_bounce", "Bounce rate"), true) +
    th(t("a_duration", "Visit duration"), true);

  const body = list
    .slice(0, 100)
    .map((r) => {
      const cells = state.fields.map((f) => `<td>${cell(f, r[f])}</td>`).join("");
      const bounce = num(r.visits)
        ? Math.round((Math.min(num(r.bounces), num(r.visits)) / num(r.visits)) * 100)
        : 0;
      return `<tr>${cells}
        <td class="bma-num bma-strong">${escapeHTML(full(r.visitors))}</td>
        <td class="bma-num">${escapeHTML(full(r.visits))}</td>
        <td class="bma-num">${escapeHTML(full(r.views))}</td>
        <td class="bma-num">${bounce}%</td>
        <td class="bma-num">${escapeHTML(
          duration(num(r.visits) ? num(r.totaltime) / num(r.visits) : 0),
        )}</td>
      </tr>`;
    })
    .join("");

  return panel(
    t("a_breakdown", "Breakdown"),
    picker +
      `<p class="bm-hint">${escapeHTML(
        t("a_break_note", "Pick the dimensions to cross. At least one, at most four."),
      )}</p>` +
      table(head, body, { fixed: true }),
  );
}

/* ─── shell ───────────────────────────────────────────────────────────────── */

const RENDER = {
  overview: () => viewOverview(false),
  events: viewEvents,
  sessions: viewSessions,
  performance: viewPerformance,
  compare: viewCompare,
  breakdown: viewBreakdown,
};

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
    <div class="bma-body" data-a-body>${spinner()}</div>`;
}

async function paint() {
  const body = section.querySelector("[data-a-body]");
  if (!body) return;

  // Every chart of the outgoing view goes with the body, so its observer has to
  // go too or it watches detached nodes for the life of the page.
  if (chartObserver) {
    chartObserver.disconnect();
    chartObserver = null;
  }

  body.innerHTML = spinner();
  const token = ++state.seq;
  charts = new Map();

  let html;
  try {
    html = await RENDER[state.view]();
  } catch {
    html = failure({ status: 0 });
  }

  // A slower earlier request must not paint over a faster later one.
  if (token !== state.seq) return;

  // A search box repaints its own view, so without this a reader loses the
  // caret on the first keystroke and types the rest of the word into nothing.
  const focused = document.activeElement;
  const keep =
    focused && focused.closest && focused.closest("[data-search]")
      ? { name: focused.getAttribute("data-search"), at: focused.selectionStart }
      : null;

  body.innerHTML = html;
  paintCharts();
  wireMap();

  if (keep) {
    const input = body.querySelector(`[data-search="${keep.name}"]`);
    if (input) {
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

/** The head pickers live outside the body, so their state is not repainted. */
function markOn(group, button) {
  section.querySelectorAll(`[data-seg="${group}"]`).forEach((box) => {
    box.querySelectorAll("button").forEach((b) => b.classList.remove("is-on"));
  });
  button.classList.add("is-on");
}

function wire() {
  section.addEventListener("click", (event) => {
    const target = event.target;

    const segBtn = target.closest("[data-seg] [data-seg-id]");
    if (segBtn) {
      const group = segBtn.closest("[data-seg]").getAttribute("data-seg");
      const value = segBtn.getAttribute("data-seg-id");
      if (group === "view") {
        state.view = value;
        markOn(group, segBtn);
      } else if (group === "days") {
        state.days = Number(value);
        // The range moves every series, and it can move the unit out from under
        // the picker as well.
        state.cache.clear();
        if (!allowedUnits().includes(state.unit)) state.unit = null;
        markOn(group, segBtn);
      } else if (group === "unit") state.unit = value;
      else if (group === "scale") state.scale = value;
      else if (group === "percentile") state.percentile = value;
      else if (group === "compareField") state.compareField = value;
      else {
        state.tab[group] = value;
        if (group === "propEvent") state.tab.propName = null;
        if (group === "eventsView") state.page.events = 1;
      }
      paint();
      return;
    }

    const tab = target.closest("[data-tabs] [data-tab-id]");
    if (tab) {
      state.tab[tab.closest("[data-tabs]").getAttribute("data-tabs")] =
        tab.getAttribute("data-tab-id");
      paint();
      return;
    }

    const more = target.closest("[data-more]");
    if (more) {
      const key = more.getAttribute("data-more");
      state.more[key] = !state.more[key];
      paint();
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
      paint();
      return;
    }

    const step = target.closest("[data-pager] [data-step]");
    if (step) {
      const name = step.closest("[data-pager]").getAttribute("data-pager");
      state.page[name] = Math.max(
        1,
        (state.page[name] || 1) + Number(step.getAttribute("data-step")),
      );
      paint();
    }
  });

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
      paint();
    }, 350);
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
    scale: "linear",
    metric: "lcp",
    percentile: "p75",
    compareField: "path",
    fields: ["path"],
    tab: {},
    page: {},
    search: {},
    more: {},
    cache: new Map(),
    seq: 0,
  };

  // The credential is asked for once, ahead of the first view, so several
  // parallel requests do not each race to mint it.
  adminToken();

  shell();
  wire();
  paint();

  // 115 KB of country outlines, wanted by exactly one panel of one admin page.
  // Fetched beside the first render rather than bundled into it.
  if (!worldMap) {
    import("../data/worldMap.js")
      .then((mod) => {
        worldMap = mod.default || mod;
        if (section === host && state.view === "overview") paint();
      })
      .catch(() => {});
  }
}
