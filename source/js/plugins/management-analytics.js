/**
 * The console's Analytics section — Umami's own dashboard, rebuilt in the
 * theme's vocabulary.
 *
 * Six views, and each one carries what Umami's corresponding page carries:
 *
 *   Overview     five headline metrics against the previous period, the
 *                views/visitors chart, and the four tabbed metric panels
 *                (Pages, Sources, Environment, Location) plus the weekly grid.
 *   Events       four metrics, the event series, the ranked event list, the
 *                paged activity log, and the event-property explorer.
 *   Sessions     five metrics, the paged session table, and the session-property
 *                explorer.
 *   Performance  a percentile picker, the five web vitals as selectable cards,
 *                the p50/p75/p95 chart, and the pages/environment tables.
 *   Compare      the metrics bar and the chart against the previous period, and
 *                the side-by-side dimension tables.
 *   Breakdown    any combination of dimensions, crossed, with the full set of
 *                per-row metrics.
 *
 * The browser talks to Umami DIRECTLY with the bearer the Worker released;
 * nothing here passes through the Worker after the ticket.
 *
 * The chart is drawn at MEASURED PIXEL SIZE rather than in a stretched viewBox.
 * That is what makes an axis possible: a stretched box cannot carry a tick, a
 * gridline or a label without deforming them, which is the whole reason the
 * first version had none.
 */

import { escapeHTML } from "./notifications-inbox.js";
import { adminQuery, adminReport, adminToken, timezone } from "../tools/analytics.js";

const VIEWS = ["overview", "events", "sessions", "performance", "compare", "breakdown"];

// [days, chart unit, short label]. The unit is not free: Umami replaces any unit
// finer than the span allows (lib/date.getMinimumUnit), so these mirror it — a
// year can only be asked for by month.
const RANGES = [
  [1, "hour", "24h"],
  [7, "day", "7d"],
  [30, "day", "30d"],
  [90, "day", "90d"],
  [180, "day", "6m"],
  [365, "month", "1y"],
];

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
  ["lcp", "LCP", 2500, 4000, "ms"],
  ["inp", "INP", 200, 500, "ms"],
  ["cls", "CLS", 0.1, 0.25, ""],
  ["fcp", "FCP", 1800, 3000, "ms"],
  ["ttfb", "TTFB", 800, 1800, "ms"],
];

const VITAL_NAMES = {
  lcp: "Largest Contentful Paint",
  inp: "Interaction to Next Paint",
  cls: "Cumulative Layout Shift",
  fcp: "First Contentful Paint",
  ttfb: "Time to First Byte",
};

const PERCENTILES = ["p50", "p75", "p95"];

// Everything Umami's breakdown and compare pickers offer that a website (rather
// than a link or a pixel) can answer.
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
// SHORTER list than the metrics one: entry, exit, screen and channel are not
// groupable, and sending them is a 400 rather than an empty table.
const BREAKDOWN_FIELDS = [
  ["path", "a_f_path"],
  ["title", "a_f_title"],
  ["query", "a_f_query"],
  ["referrer", "a_f_referrer"],
  ["hostname", "a_f_hostname"],
  ["browser", "a_f_browser"],
  ["os", "a_f_os"],
  ["device", "a_f_device"],
  ["language", "a_f_language"],
  ["country", "a_f_country"],
  ["region", "a_f_region"],
  ["city", "a_f_city"],
  ["tag", "a_f_tag"],
];

const PAGE_SIZE = 10;

let section = null;
let t = (k, f) => f;
let state = null;
let charts = new Map();
let chartObserver = null;

/* ─── formatting ──────────────────────────────────────────────────────────── */

const num = (v) => Number(v || 0);

function compact(v) {
  const n = num(v);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(n));
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

const pct = (part, whole) => (num(whole) ? Math.round((num(part) / num(whole)) * 100) : 0);

/** The signed change between two numbers as a percentage of the older one. */
function delta(now, before) {
  const a = num(now);
  const b = num(before);
  if (!b) return a ? null : 0;
  return Math.round(((a - b) / b) * 100);
}

/** A two-letter country code as its flag, with no asset and no lookup table. */
function flag(code) {
  const c = String(code || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  return String.fromCodePoint(...[...c].map((ch) => 127397 + ch.charCodeAt(0)));
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

/** A bucket timestamp, labelled the way its unit deserves. */
function bucketLabel(x, unit) {
  const s = String(x);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}))?/.exec(s);
  if (!m) return s;
  if (unit === "hour") return m[4] + ":00";
  if (unit === "month") return m[1].slice(2) + "/" + m[2];
  return m[2] + "/" + m[3];
}

function rangeOf(days) {
  // A rolling 24 hours ends NOW; everything longer is whole days and ends
  // tonight, which is what makes "the previous period" the same length.
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

const unitFor = () => (RANGES.find(([d]) => d === state.days) || [0, "day"])[1];

/* ─── fetching ────────────────────────────────────────────────────────────── */

/**
 * One read, memoised for the life of the current range.
 *
 * The cache is on the REQUEST, not on the rendered HTML: switching a tab inside
 * a view re-renders it, and every series it already had is then free.
 */
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
  const body = {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    ...parameters,
  };
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
  return blank(
    t("a_offline", "Umami did not answer.") + (status ? ` (${status})` : ""),
  );
}

/* ─── small builders ──────────────────────────────────────────────────────── */

const blank = (m) => `<p class="bm-blank">${escapeHTML(m)}</p>`;
const spinner = () => `<div class="bma-wait"><i class="fa-solid fa-circle-notch fa-spin"></i></div>`;

function seg(group, items, active) {
  return `<div class="bm-seg bma-seg" data-seg="${group}" role="group">${items
    .map(
      ([id, label]) =>
        `<button type="button" data-seg-id="${escapeHTML(String(id))}"${
          String(id) === String(active) ? ' class="is-on"' : ""
        }>${escapeHTML(label)}</button>`,
    )
    .join("")}</div>`;
}

/**
 * One headline metric. The change is the previous period's, and the arrow is
 * the only coloured thing on the tile — a whole number turning red at five tiles
 * side by side reads as an alarm rather than as a comparison.
 */
function metric(label, value, options = {}) {
  const change = options.change;
  const has = change !== null && change !== undefined;
  const good = options.inverse ? change < 0 : change > 0;
  const tone = !has || change === 0 ? "" : good ? " is-up" : " is-down";

  return `
    <div class="bma-metric${options.tone ? " tone-" + options.tone : ""}${
      options.on ? " is-on" : ""
    }"${options.pick ? ` data-pick="${escapeHTML(options.pick)}" tabindex="0" role="button"` : ""}>
      <div class="bma-metric-label">${escapeHTML(label)}</div>
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
    <section class="bm-card bma-panel${options.wide ? " is-wide" : ""}">
      <div class="bma-panel-head">
        <h3 class="bm-sub-title">${escapeHTML(title)}</h3>
        ${options.aside || ""}
      </div>
      ${inner}
    </section>`;
}

/**
 * A ranked list — name, bar, count, share — which is the one shape every
 * dimension in Umami is shown in.
 */
function listTable(items, options = {}) {
  const list = (items || []).slice(0, options.limit || 10);
  if (!list.length) return blank(t("a_nodata", "Nothing in this range"));

  const max = list.reduce((m, r) => Math.max(m, num(r.y)), 0) || 1;
  const sum = options.total || list.reduce((s, r) => s + num(r.y), 0) || 1;
  const format = options.format || full;

  const body = list
    .map((r) => {
      const raw = r.x == null || r.x === "" ? t("a_direct", "Direct / none") : String(r.x);
      const icon = options.icon ? options.icon(r) : "";
      return `
        <li class="bma-row" style="--bma-bar:${((num(r.y) / max) * 100).toFixed(2)}%">
          <span class="bma-row-name" title="${escapeHTML(raw)}">${icon}${escapeHTML(raw)}</span>
          <span class="bma-row-value">${escapeHTML(format(r.y))}</span>
          ${
            options.share === false
              ? ""
              : `<span class="bma-row-share">${pct(r.y, sum)}%</span>`
          }
        </li>`;
    })
    .join("");

  return `
    <div class="bma-list">
      <div class="bma-list-head">
        <span>${escapeHTML(options.label || t("a_name", "Name"))}</span>
        <span>${escapeHTML(options.metric || t("a_visitors", "Visitors"))}</span>
        ${options.share === false ? "" : "<span></span>"}
      </div>
      <ol class="bma-rows">${body}</ol>
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

/** Paging that says where it is, which a bare pair of arrows does not. */
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

function tabsOf(group, items, active) {
  return `<div class="bma-tabs" data-tabs="${group}" role="tablist">${items
    .map(
      ([id, label]) =>
        `<button type="button" role="tab" data-tab-id="${id}"${
          id === active ? ' class="is-on" aria-selected="true"' : ""
        }>${escapeHTML(label)}</button>`,
    )
    .join("")}</div>`;
}

/* ─── the chart ───────────────────────────────────────────────────────────── */

/**
 * A chart placeholder. The drawing waits for layout, because the whole point of
 * this chart is that it is drawn at its real pixel size: an axis, a gridline and
 * a tick can only be honest in a box that is not being stretched.
 */
function chart(spec) {
  const id = "c" + state.seq + "-" + charts.size;
  charts.set(id, spec);
  return `<div class="bma-chart" data-chart="${id}" style="--bma-chart-h:${
    spec.height || 260
  }px"><div class="bma-chart-tip" data-chart-tip></div></div>`;
}

function niceCeil(value) {
  if (value <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const f = value / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * exp;
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

  const points = series[0].data.length;
  const height = spec.height || 260;
  const padT = 14;
  const padB = 26;
  const padR = 10;

  const peak = series.reduce(
    (m, s) => s.data.reduce((n, d) => Math.max(n, num(d.y)), m),
    0,
  );
  const top = niceCeil(peak || 1);
  const ticks = 4;
  const label = spec.format || compact;
  const padL = Math.max(34, label(top).length * 8 + 12);

  const plotW = Math.max(10, width - padL - padR);
  const plotH = Math.max(10, height - padT - padB);
  const x = (i) => padL + (points > 1 ? (i / points) * plotW : 0);
  const y = (v) => padT + plotH - (num(v) / top) * plotH;

  const parts = [];

  for (let i = 0; i <= ticks; i++) {
    const value = (top / ticks) * i;
    const py = padT + plotH - (plotH / ticks) * i;
    parts.push(
      `<line class="bma-gridline" x1="${padL}" y1="${py}" x2="${padL + plotW}" y2="${py}"/>`,
      `<text class="bma-axis-y" x="${padL - 8}" y="${py + 4}">${escapeHTML(label(value))}</text>`,
    );
  }

  // At most one label per 64px, so the axis never overprints itself.
  const every = Math.max(1, Math.ceil(points / Math.max(2, Math.floor(plotW / 64))));
  for (let i = 0; i < points; i++) {
    if (i % every && i !== points - 1) continue;
    const px = x(i) + plotW / points / 2;
    if (px > padL + plotW - 6) continue;
    parts.push(
      `<text class="bma-axis-x" x="${px.toFixed(1)}" y="${height - 8}">${escapeHTML(
        bucketLabel(series[0].data[i].x, spec.unit),
      )}</text>`,
    );
  }

  const band = plotW / Math.max(1, points);
  const bars = series.filter((s) => s.type !== "line");
  const lines = series.filter((s) => s.type === "line");
  const slot = (band * 0.72) / Math.max(1, bars.length);

  bars.forEach((s, si) => {
    s.data.forEach((d, i) => {
      const h = Math.max(num(d.y) > 0 ? 1.5 : 0, plotH - (y(d.y) - padT));
      if (!h) return;
      const px = x(i) + band * 0.14 + si * slot;
      parts.push(
        `<rect class="bma-col" fill="${s.color}" x="${px.toFixed(2)}" y="${(
          padT +
          plotH -
          h
        ).toFixed(2)}" width="${slot.toFixed(2)}" height="${h.toFixed(2)}" rx="${Math.min(
          2,
          slot / 3,
        ).toFixed(2)}"/>`,
      );
    });
  });

  lines.forEach((s) => {
    const path = s.data
      .map((d, i) => (i ? "L" : "M") + (x(i) + band / 2).toFixed(2) + " " + y(d.y).toFixed(2))
      .join(" ");
    parts.push(`<path class="bma-line" stroke="${s.color}" d="${path}"/>`);
  });

  parts.push(
    `<line class="bma-axis" x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${
      padT + plotH
    }"/>`,
    `<rect class="bma-hover" data-hover x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/>`,
    `<rect class="bma-cursor" data-cursor x="0" y="${padT}" width="${band.toFixed(
      2,
    )}" height="${plotH}" hidden/>`,
  );

  const svg =
    `<svg class="bma-chart-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `role="img" aria-label="${escapeHTML(spec.label || "")}">${parts.join("")}</svg>`;

  const legend = series.length
    ? `<div class="bma-legend">${series
        .map(
          (s) =>
            `<span><i style="background:${s.color}"></i>${escapeHTML(s.name)}</span>`,
        )
        .join("")}</div>`
    : "";

  host.dataset.w = String(width);
  host.innerHTML = legend + svg + '<div class="bma-chart-tip" data-chart-tip></div>';

  wireChartHover(host, { series, padL, plotW, points, band, format: label, unit: spec.unit });
}

function wireChartHover(host, ctx) {
  const svg = host.querySelector("svg");
  const cursor = host.querySelector("[data-cursor]");
  const tip = host.querySelector("[data-chart-tip]");
  if (!svg || !cursor || !tip || !ctx.points) return;

  const move = (event) => {
    const box = svg.getBoundingClientRect();
    const scale = box.width / svg.viewBox.baseVal.width || 1;
    const local = (event.clientX - box.left) / scale;
    const i = Math.floor((local - ctx.padL) / ctx.band);
    if (i < 0 || i >= ctx.points) return leave();

    cursor.setAttribute("x", (ctx.padL + i * ctx.band).toFixed(2));
    cursor.removeAttribute("hidden");

    tip.innerHTML =
      `<b>${escapeHTML(bucketLabel(ctx.series[0].data[i].x, ctx.unit))}</b>` +
      ctx.series
        .map(
          (s) =>
            `<span><i style="background:${s.color}"></i>${escapeHTML(s.name)}<em>${escapeHTML(
              ctx.format(s.data[i] ? s.data[i].y : 0),
            )}</em></span>`,
        )
        .join("");
    tip.classList.add("is-on");

    const hostBox = host.getBoundingClientRect();
    const px = (ctx.padL + (i + 0.5) * ctx.band) * scale;
    tip.style.left =
      Math.min(Math.max(px, tip.offsetWidth / 2 + 4), hostBox.width - tip.offsetWidth / 2 - 4) +
      "px";
  };

  const leave = () => {
    cursor.setAttribute("hidden", "");
    tip.classList.remove("is-on");
  };

  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerleave", leave);
}

/** Draw every placeholder the last render left, and keep them at the right size. */
function paintCharts() {
  const hosts = section.querySelectorAll("[data-chart]");
  if (!hosts.length) return;

  // Redraw on a real width change only: the draw replaces the host's contents,
  // and a redraw that reacted to its own output would never settle.
  chartObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
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

const COLORS = {
  primary: "var(--bma-c1)",
  second: "var(--bma-c2)",
  third: "var(--bma-c3)",
  ghost: "var(--bma-ghost)",
};

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
  const series = [
    {
      name: t("a_views", "Views"),
      data: d.pageviews || [],
      color: COLORS.primary,
    },
    {
      name: t("a_visitors", "Visitors"),
      data: d.sessions || [],
      color: COLORS.second,
    },
  ];
  if (compareMode && d.compare) {
    // The previous period is drawn on the CURRENT period's x values, or the two
    // runs would be two charts sharing an axis they do not agree on.
    const align = (from, onto) =>
      (from || []).map((r, i) => ({ x: ((onto || [])[i] || r).x, y: r.y }));
    series.push(
      {
        name: t("a_prev_views", "Views (previous)"),
        data: align(d.compare.pageviews, d.pageviews),
        color: COLORS.ghost,
        type: "line",
      },
      {
        name: t("a_prev_visitors", "Visitors (previous)"),
        data: align(d.compare.sessions, d.sessions),
        color: COLORS.third,
        type: "line",
      },
    );
  }

  const plot = panel(
    t("a_traffic_over_time", "Traffic"),
    chart({ series, unit, height: 280, label: t("a_views", "Views") }),
    { wide: true },
  );

  if (compareMode) return bar + plot + (await compareTables());

  return bar + plot + (await overviewPanels());
}

async function overviewPanels() {
  const picks = PANELS.map(([group, tabs]) => {
    const type = state.tab[group] || tabs[0][0];
    return [group, tabs, type];
  });

  const results = await Promise.all(
    picks.map(([, , type]) => get("/api/websites/:id/metrics", { type, limit: 10 })),
  );

  const weekly = await get("/api/websites/:id/sessions/weekly", { timezone: timezone() });

  const cards = picks
    .map(([group, tabs, type], i) => {
      const res = results[i];
      const label = t("a_" + group, group);
      const body = res.ok
        ? listTable(rows(res), {
            label: t((tabs.find(([f]) => f === type) || [])[1] || type, type),
            icon: group === "location" && type === "country" ? countryIcon : null,
          })
        : failure(res);
      return panel(
        label,
        tabsOf(group, tabs.map(([f, key]) => [f, t(key, f)]), type) + body,
      );
    })
    .join("");

  return `<div class="bma-grid">${cards}</div>${panel(
    t("a_weekly", "Weekly traffic"),
    weeklyGrid(weekly.ok ? weekly.data : null),
    { wide: true },
  )}`;
}

const countryIcon = (r) => {
  const f = flag(r.x);
  return f ? `<em class="bma-flag">${f}</em>` : "";
};

/** Hours down, days across — Umami's own traffic grid. */
function weeklyGrid(data) {
  if (!Array.isArray(data) || data.length !== 7) {
    return blank(t("a_nodata", "Nothing in this range"));
  }

  let peak = 0;
  data.forEach((day) => day.forEach((v) => (peak = Math.max(peak, num(v)))));
  const days = t("a_weekdays", "Sun,Mon,Tue,Wed,Thu,Fri,Sat").split(",");

  const head = `<div class="bma-week-head"><span></span>${days
    .map((d) => `<span>${escapeHTML(d)}</span>`)
    .join("")}</div>`;

  const body = Array.from({ length: 24 }, (_, hour) => {
    const cells = data
      .map((day) => {
        const v = num(day[hour]);
        const level = !v ? 0 : Math.max(1, Math.min(5, Math.ceil((v / (peak || 1)) * 5)));
        return `<i class="l${level}" title="${escapeHTML(full(v))}"></i>`;
      })
      .join("");
    const label = hour % 3 === 0 ? (hour === 0 ? "12a" : hour < 12 ? hour + "a" : (hour === 12 ? "12p" : hour - 12 + "p")) : "";
    return `<div class="bma-week-row"><span>${label}</span>${cells}</div>`;
  }).join("");

  return `<div class="bma-week">${head}${body}</div>`;
}

/* ─── events ──────────────────────────────────────────────────────────────── */

async function viewEvents() {
  const tab = state.tab.events || "chart";
  const head =
    tabsOf("events", [
      ["chart", t("a_chart", "Chart")],
      ["activity", t("a_activity", "Activity")],
      ["properties", t("a_properties", "Properties")],
    ], tab);

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

  let body;
  if (tab === "activity") body = await eventsActivity();
  else if (tab === "properties") body = await eventProperties();
  else body = await eventsChart();

  return bar + panel(t("a_events", "Events"), head + body, { wide: true });
}

async function eventsChart() {
  const unit = unitFor();
  const [series, totals] = await Promise.all([
    get("/api/websites/:id/events/series", { unit, timezone: timezone(), limit: 10 }),
    get("/api/websites/:id/metrics", { type: "event", limit: 50 }),
  ]);

  if (!series.ok) return failure(series);

  // One row per (name, bucket). The chart carries the total; the list beside it
  // carries the split, which is the pair Umami shows too.
  const buckets = new Map();
  for (const row of rows(series)) {
    const key = String(row.t);
    buckets.set(key, (buckets.get(key) || 0) + num(row.y));
  }
  const data = Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([x, y]) => ({ x, y }));

  return (
    chart({
      series: [{ name: t("a_events_fired", "Events"), data, color: COLORS.primary }],
      unit,
      height: 240,
    }) +
    listTable(rows(totals), {
      label: t("a_event", "Event"),
      metric: t("a_count", "Count"),
      limit: 50,
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
        <td>
          <span class="bma-kind ${r.eventName ? "is-event" : "is-view"}">
            <i class="fa-solid fa-${r.eventName ? "bolt" : "eye"}" aria-hidden="true"></i>
            ${escapeHTML(r.eventName ? t("a_triggered", "Event") : t("a_viewed", "View"))}
          </span>
        </td>
        <td class="bma-strong" title="${escapeHTML(r.eventName || r.urlPath || "")}">${escapeHTML(
          r.eventName || r.urlPath || "",
        )}</td>
        <td>${escapeHTML([r.city, r.country].filter(Boolean).join(", "))}</td>
        <td>${escapeHTML(r.browser || "")}</td>
        <td>${escapeHTML(r.device || "")}</td>
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
      `<th>${escapeHTML(t("a_type", "Type"))}</th><th>${escapeHTML(
        t("a_event", "Event"),
      )}</th><th>${escapeHTML(t("a_location", "Location"))}</th><th>${escapeHTML(
        t("a_f_browser", "Browser"),
      )}</th><th>${escapeHTML(t("a_f_device", "Device"))}</th><th class="bma-num">${escapeHTML(
        t("a_when", "When"),
      )}</th>`,
      body,
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

  const picker = `<div class="bma-bar">
    ${seg("propEvent", names.map((n) => [n, n]), name)}
    ${props.length ? seg("propName", props.map((n) => [n, n]), prop) : ""}
  </div>`;

  const body =
    values && values.ok
      ? listTable(
          rows(values).map((r) => ({ x: r.value, y: r.total })),
          { label: prop, metric: t("a_count", "Count"), limit: 20 },
        )
      : blank(t("a_nodata", "Nothing in this range"));

  return picker + body;
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
  return bar + panel(t("a_sessions", "Sessions"), head + body, { wide: true });
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
      const where = [r.city, r.country && (flag(r.country) + " " + r.country)]
        .filter(Boolean)
        .join(", ");
      return `
      <tr>
        <td class="bma-id" title="${escapeHTML(r.id || "")}">${escapeHTML(
          String(r.id || "").slice(0, 8),
        )}</td>
        <td class="bma-num">${escapeHTML(full(r.visits))}</td>
        <td class="bma-num">${escapeHTML(full(r.views))}</td>
        <td class="bma-num">${escapeHTML(full(r.events))}</td>
        <td title="${escapeHTML(where)}">${escapeHTML(where)}</td>
        <td>${escapeHTML(r.browser || "")}</td>
        <td>${escapeHTML(r.os || "")}</td>
        <td>${escapeHTML(r.device || "")}</td>
        <td class="bma-num">${escapeHTML(when(r.lastAt || r.createdAt))}</td>
      </tr>`;
    })
    .join("");

  return (
    `<div class="bma-bar">${search("sessions", state.search.sessions)}</div>` +
    table(
      `<th>${escapeHTML(t("a_session", "Session"))}</th><th class="bma-num">${escapeHTML(
        t("a_visits", "Visits"),
      )}</th><th class="bma-num">${escapeHTML(
        t("a_views", "Views"),
      )}</th><th class="bma-num">${escapeHTML(
        t("a_events", "Events"),
      )}</th><th>${escapeHTML(t("a_location", "Location"))}</th><th>${escapeHTML(
        t("a_f_browser", "Browser"),
      )}</th><th>${escapeHTML(t("a_f_os", "OS"))}</th><th>${escapeHTML(
        t("a_f_device", "Device"),
      )}</th><th class="bma-num">${escapeHTML(t("a_last_seen", "Last seen"))}</th>`,
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
      ? listTable(
          rows(values).map((r) => ({ x: r.value, y: r.total })),
          { label: prop, metric: t("a_count", "Count"), limit: 20 },
        )
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
    VITALS.map(([key, label, good, poor]) => {
      const v = num(summary[key] && summary[key][p]);
      return metric(label, vital(key, v), {
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
    color: [COLORS.third, COLORS.primary, COLORS.second][i],
    data: (data.chart || []).map((r) => ({ x: r.t, y: num(r[name]) })),
  }));

  const format = (v) => vital(state.metric, v);
  const spec = VITALS.find(([k]) => k === state.metric) || VITALS[0];

  const listOf = (source) =>
    listTable(
      (source || [])
        .filter((r) => num(r[p]) > 0)
        .slice(0, 20)
        .map((r) => ({ x: r.name, y: num(r[p]) })),
      { label: t("a_name", "Name"), metric: spec[1] + " " + p, format, share: false },
    );

  const pagesTab = state.tab.perfPages || "path";
  const envTab = state.tab.perfEnv || "device";

  return (
    `<div class="bma-bar">${seg(
      "percentile",
      PERCENTILES.map((x) => [x, x]),
      p,
    )}<span class="bm-hint">${escapeHTML(
      t("a_samples", "Samples") + ": " + full(summary.count),
    )}</span></div>` +
    cards +
    panel(
      VITAL_NAMES[state.metric] || spec[1],
      chart({ series, unit, height: 280, format }),
      { wide: true },
    ) +
    `<div class="bma-grid">${panel(
      t("a_pages", "Pages"),
      tabsOf("perfPages", [
        ["path", t("a_f_path", "Path")],
        ["title", t("a_f_title", "Title")],
      ], pagesTab) + listOf(pagesTab === "title" ? data.pageTitles : data.pages),
    )}${panel(
      t("a_environment", "Environment"),
      tabsOf("perfEnv", [
        ["device", t("a_f_device", "Device")],
        ["browser", t("a_f_browser", "Browser")],
      ], envTab) + listOf(envTab === "browser" ? data.browsers : data.devices),
    )}</div>`
  );
}

/* ─── compare ─────────────────────────────────────────────────────────────── */

const viewCompare = () => viewOverview(true);

async function compareTables() {
  const type = state.compareField;
  const { start, end } = rangeOf(state.days);
  const span = end.getTime() - start.getTime();

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
  const withChange = rows(now).map((r) => ({ ...r, prev: prev.get(String(r.x)) }));

  const body = withChange.length
    ? withChange
        .map((r) => {
          const change = delta(r.y, r.prev);
          const name = r.x == null || r.x === "" ? t("a_direct", "Direct / none") : String(r.x);
          return `
          <tr>
            <td title="${escapeHTML(name)}">${escapeHTML(name)}</td>
            <td class="bma-num">${escapeHTML(full(r.prev || 0))}</td>
            <td class="bma-num bma-strong">${escapeHTML(full(r.y))}</td>
            <td class="bma-num"><span class="bma-delta${
              change === null || change === 0 ? "" : change > 0 ? " is-up" : " is-down"
            }">${change === null ? "—" : (change > 0 ? "+" : "") + change + "%"}</span></td>
          </tr>`;
        })
        .join("")
    : "";

  return panel(
    t("a_compare", "Compare"),
    `<div class="bma-bar">${seg(
      "compareField",
      FIELDS.map(([f, key]) => [f, t(key, f)]),
      type,
    )}</div>` +
      table(
        `<th>${escapeHTML(t("a_name", "Name"))}</th><th class="bma-num">${escapeHTML(
          t("a_previous", "Previous"),
        )}</th><th class="bma-num">${escapeHTML(
          t("a_current", "Current"),
        )}</th><th class="bma-num">${escapeHTML(t("a_change", "Change"))}</th>`,
        body,
      ),
    { wide: true },
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
      .map((f) => `<th>${escapeHTML(t((FIELDS.find(([x]) => x === f) || [])[1] || f, f))}</th>`)
      .join("") +
    `<th class="bma-num">${escapeHTML(t("a_visitors", "Visitors"))}</th>` +
    `<th class="bma-num">${escapeHTML(t("a_visits", "Visits"))}</th>` +
    `<th class="bma-num">${escapeHTML(t("a_views", "Views"))}</th>` +
    `<th class="bma-num">${escapeHTML(t("a_bounce", "Bounce rate"))}</th>` +
    `<th class="bma-num">${escapeHTML(t("a_duration", "Visit duration"))}</th>`;

  const body = list
    .slice(0, 100)
    .map((r) => {
      const cells = state.fields
        .map((f) => {
          const v = r[f] == null || r[f] === "" ? t("a_direct", "Direct / none") : String(r[f]);
          return `<td title="${escapeHTML(v)}">${escapeHTML(v)}</td>`;
        })
        .join("");
      const bounce = num(r.visits) ? Math.round((Math.min(num(r.bounces), num(r.visits)) / num(r.visits)) * 100) : 0;
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
    { wide: true },
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
      ${seg("days", RANGES.map(([d, , label]) => [d, label]), state.days)}
    </div>
    <div class="bma-body" data-a-body>${spinner()}</div>`;
}

async function paint() {
  const body = section.querySelector("[data-a-body]");
  if (!body) return;

  // Every chart of the outgoing view is gone the moment the body is replaced,
  // so its observer has to go with it or it watches detached nodes for the life
  // of the page.
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
  const box = section.querySelector(`[data-seg="${group}"]`);
  if (!box) return;
  box.querySelectorAll("button").forEach((b) => b.classList.remove("is-on"));
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
        // The range moves every series, so nothing cached survives it.
        state.cache.clear();
        markOn(group, segBtn);
      } else if (group === "percentile") state.percentile = value;
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
      state.page[name] = Math.max(1, (state.page[name] || 1) + Number(step.getAttribute("data-step")));
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
 * @param {Element} consoleEl  the console root, for delegated lookups
 * @param {Function} translate the console's own `t`
 */
export function initManagementAnalytics(host, consoleEl, translate) {
  if (!host) return;

  section = host;
  t = translate || t;
  state = {
    view: "overview",
    days: 30,
    metric: "lcp",
    percentile: "p75",
    compareField: "path",
    fields: ["path"],
    tab: {},
    page: {},
    search: {},
    cache: new Map(),
    seq: 0,
  };

  // The credential is asked for once, ahead of the first view, so six parallel
  // requests do not each race to mint it.
  adminToken();

  shell();
  wire();
  paint();
}
