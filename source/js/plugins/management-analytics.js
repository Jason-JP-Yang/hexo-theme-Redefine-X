/**
 * The console's Analytics section.
 *
 * Six views — Overview, Events, Sessions, Performance, Compare, Breakdown — the
 * same six Umami's own share page offers, read with the Umami bearer the Worker
 * releases to a verified admin. The browser talks to Umami directly; nothing
 * here passes through the Worker after the ticket.
 *
 * Everything is drawn with the console's existing vocabulary: `.bm-seg` for the
 * tab bar and the range picker, `.bm-card` for a panel, `morph()` for the swap.
 * The only new furniture is the chart, and it is inline SVG rather than a
 * library — three chart shapes at this size do not justify shipping one, and a
 * library's canvas would need its own colour bridge into the theme's tokens.
 *
 * A view is fetched the first time it is opened and then kept. Switching back to
 * a tab is free, and changing the range is what drops the cache.
 */

import { escapeHTML } from "./notifications-inbox.js";
import { adminQuery, adminToken, timezone } from "../tools/analytics.js";

const VIEWS = ["overview", "events", "sessions", "performance", "compare", "breakdown"];

// Days, and the bucket a chart of that many days should use.
const RANGES = [
  [7, "day"],
  [30, "day"],
  [90, "day"],
  [365, "month"],
];

const METRIC_TABLES = [
  ["url", "a_pages", "Pages"],
  ["referrer", "a_referrers", "Referrers"],
  ["browser", "a_browsers", "Browsers"],
  ["os", "a_os", "Systems"],
  ["device", "a_devices", "Devices"],
  ["country", "a_countries", "Countries"],
];

// Google's Core Web Vitals thresholds. The colour on a performance tile is a
// judgement, not decoration, so it comes from the published bands rather than
// from where this site happens to sit today.
const VITALS = {
  lcp: { label: "LCP", good: 2500, poor: 4000, unit: "ms" },
  inp: { label: "INP", good: 200, poor: 500, unit: "ms" },
  cls: { label: "CLS", good: 0.1, poor: 0.25, unit: "" },
  fcp: { label: "FCP", good: 1800, poor: 3000, unit: "ms" },
  ttfb: { label: "TTFB", good: 800, poor: 1800, unit: "ms" },
};

const BREAKDOWN_FIELDS = ["path", "referrer", "browser", "os", "device", "country"];

let root = null;
let t = (k, f) => f;
let state = null;

/* ─── helpers ─────────────────────────────────────────────────────────────── */

const num = (v) => Number(v || 0);

function compact(v) {
  const n = num(v);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(n));
}

function duration(seconds) {
  const s = Math.max(0, Math.round(num(seconds)));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

function ms(value, unit) {
  const n = num(value);
  if (unit === "") return n.toFixed(2);
  return n >= 1000 ? (n / 1000).toFixed(2) + "s" : Math.round(n) + "ms";
}

function percent(value) {
  return Math.round(num(value) * 100) + "%";
}

/** The change between two numbers, as a signed percentage of the older one. */
function delta(now, before) {
  const a = num(now);
  const b = num(before);
  if (!b) return a ? null : 0;
  return Math.round(((a - b) / b) * 100);
}

function dayKey(date) {
  return (
    date.getFullYear() +
    "-" +
    String(date.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(date.getDate()).padStart(2, "0")
  );
}

function range() {
  const days = state.days;
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  return { startAt: start.getTime(), endAt: end.getTime(), start, end };
}

function unitFor() {
  const found = RANGES.find(([d]) => d === state.days);
  return found ? found[1] : "day";
}

function shortDate(x) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(x));
  if (m) return m[2] + "/" + m[3];
  const d = new Date(x);
  return isNaN(d) ? String(x) : dayKey(d).slice(5).replace("-", "/");
}

/* ─── chart ───────────────────────────────────────────────────────────────── */

/**
 * A bar series, as inline SVG on a 0..100 × 0..100 grid stretched by the box.
 *
 * `preserveAspectRatio="none"` is what lets one viewBox serve every width; bar
 * widths are therefore in viewBox units and the rounded corners are dropped,
 * because a radius would stretch with the box and read as a different shape at
 * each breakpoint.
 */
function barChart(series, options = {}) {
  const rows = series || [];
  if (!rows.length) return blank(t("a_nodata", "Nothing in this range"));

  const max = rows.reduce((m, r) => Math.max(m, num(r.y)), 0) || 1;
  const step = 100 / rows.length;
  const width = Math.max(step * 0.55, Math.min(step * 0.82, step - 0.25));

  const bars = rows
    .map((r, i) => {
      const h = (num(r.y) / max) * 100;
      const x = i * step + (step - width) / 2;
      return (
        `<rect class="bm-bar" x="${x.toFixed(3)}" y="${(100 - h).toFixed(3)}"` +
        ` width="${width.toFixed(3)}" height="${Math.max(h, 0.4).toFixed(3)}"` +
        `><title>${escapeHTML(shortDate(r.x))} · ${compact(r.y)}</title></rect>`
      );
    })
    .join("");

  // Compared series behind, in the same geometry, so the two read as one chart.
  const ghost = (options.compare || [])
    .map((r, i) => {
      const h = (num(r.y) / max) * 100;
      const x = i * step + (step - width) / 2;
      return (
        `<rect class="bm-bar is-ghost" x="${x.toFixed(3)}" y="${(100 - h).toFixed(3)}"` +
        ` width="${width.toFixed(3)}" height="${Math.max(h, 0.4).toFixed(3)}"></rect>`
      );
    })
    .join("");

  const first = rows[0] ? shortDate(rows[0].x) : "";
  const last = rows.length ? shortDate(rows[rows.length - 1].x) : "";

  return `
    <div class="bm-chart">
      <div class="bm-chart-peak">${compact(max)}</div>
      <svg class="bm-chart-svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
           aria-label="${escapeHTML(options.label || "")}">${ghost}${bars}</svg>
      <div class="bm-chart-axis"><span>${escapeHTML(first)}</span><span>${escapeHTML(last)}</span></div>
    </div>`;
}

function blank(message) {
  return `<p class="bm-blank">${escapeHTML(message)}</p>`;
}

function spinner() {
  return `<div class="bm-a-wait"><i class="fa-solid fa-circle-notch fa-spin"></i></div>`;
}

/* ─── tiles and tables ────────────────────────────────────────────────────── */

function tile(label, value, options = {}) {
  const change = options.change;
  const tone =
    change === null || change === undefined
      ? ""
      : (options.inverse ? change < 0 : change > 0)
        ? " is-up"
        : change === 0
          ? ""
          : " is-down";
  const arrow =
    change === null || change === undefined
      ? ""
      : `<span class="bm-tile-change${tone}">${change > 0 ? "+" : ""}${change}%</span>`;

  return `
    <div class="bm-tile${options.tone ? " tone-" + options.tone : ""}">
      <div class="bm-tile-label">${escapeHTML(label)}</div>
      <div class="bm-tile-value">${escapeHTML(String(value))}</div>
      ${arrow}
    </div>`;
}

/**
 * A ranked list with the bar drawn INTO the row rather than beside it, so the
 * proportion is readable without spending a column on it.
 */
function rankTable(title, rows, options = {}) {
  const items = (rows || []).slice(0, options.limit || 8);
  if (!items.length) {
    return `<div class="bm-card bm-a-panel">
      <div class="bm-sub-title">${escapeHTML(title)}</div>${blank(t("a_nodata", "Nothing in this range"))}
    </div>`;
  }

  const max = items.reduce((m, r) => Math.max(m, num(r.y)), 0) || 1;
  const body = items
    .map((r) => {
      const name = String(r.x == null || r.x === "" ? t("a_direct", "Direct / none") : r.x);
      const share = (num(r.y) / max) * 100;
      return `
        <li class="bm-rank-row" style="--bm-rank:${share.toFixed(2)}%">
          <span class="bm-rank-name" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
          <span class="bm-rank-value">${escapeHTML(compact(r.y))}</span>
        </li>`;
    })
    .join("");

  return `
    <div class="bm-card bm-a-panel">
      <div class="bm-sub-title">${escapeHTML(title)}</div>
      <ul class="bm-rank">${body}</ul>
    </div>`;
}

/* ─── fetching ────────────────────────────────────────────────────────────── */

function get(path, params) {
  const { startAt, endAt } = range();
  return adminQuery(path, { startAt, endAt, ...params });
}

/**
 * The report endpoints take the website id in the BODY, not the path, so the
 * credential has to be in hand before the request can be built.
 */
async function report(type, parameters) {
  const cred = await adminToken();
  if (!cred) return { ok: false, status: 401, data: null };

  const { start, end } = range();
  return adminQuery("/api/reports/" + type, null, {
    method: "POST",
    body: {
      websiteId: cred.websiteId,
      filters: {},
      type,
      parameters: {
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        ...parameters,
      },
    },
  });
}

/* ─── the views ───────────────────────────────────────────────────────────── */

async function viewOverview() {
  const [stats, chart, ...metrics] = await Promise.all([
    get("/api/websites/:id/stats"),
    get("/api/websites/:id/pageviews", { unit: unitFor(), timezone: timezone() }),
    ...METRIC_TABLES.map(([type]) =>
      get("/api/websites/:id/metrics", { type, limit: 8 }),
    ),
  ]);

  if (!stats.ok) return failure(stats.status);

  const s = stats.data || {};
  const views = num(s.pageviews);
  const visits = num(s.visits);
  const bounceRate = visits ? num(s.bounces) / visits : 0;
  const perVisit = visits ? num(s.totaltime) / visits : 0;

  const tiles = [
    tile(t("a_visitors", "Visitors"), compact(s.visitors)),
    tile(t("a_visits", "Visits"), compact(s.visits)),
    tile(t("a_views", "Views"), compact(views)),
    tile(t("a_bounce", "Bounce rate"), percent(bounceRate)),
    tile(t("a_duration", "Visit duration"), duration(perVisit)),
  ].join("");

  const tables = METRIC_TABLES.map(([, key, fallback], i) =>
    rankTable(t(key, fallback), (metrics[i] && metrics[i].data) || []),
  ).join("");

  return `
    <div class="bm-tiles">${tiles}</div>
    ${barChart((chart.data && chart.data.pageviews) || [], { label: t("a_views", "Views") })}
    <div class="bm-a-grid">${tables}</div>`;
}

async function viewEvents() {
  const [totals, series] = await Promise.all([
    get("/api/websites/:id/metrics", { type: "event", limit: 15 }),
    get("/api/websites/:id/events/series", {
      unit: unitFor(),
      timezone: timezone(),
      limit: 8,
    }),
  ]);

  if (!totals.ok) return failure(totals.status);

  const rows = totals.data || [];
  const fired = rows.reduce((sum, r) => sum + num(r.y), 0);

  // The series arrives as one row per (name, bucket); collapsing it to a total
  // per bucket is the only shape a single chart can carry.
  const byBucket = new Map();
  for (const row of (series.data || [])) {
    const key = String(row.t);
    byBucket.set(key, (byBucket.get(key) || 0) + num(row.y));
  }
  const chart = Array.from(byBucket.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([x, y]) => ({ x, y }));

  return `
    <div class="bm-tiles">
      ${tile(t("a_events_fired", "Events"), compact(fired))}
      ${tile(t("a_event_types", "Types"), String(rows.length))}
    </div>
    ${barChart(chart, { label: t("a_events_fired", "Events") })}
    <div class="bm-a-grid">
      ${rankTable(t("a_by_name", "By name"), rows, { limit: 15 })}
    </div>`;
}

async function viewSessions() {
  const [stats, list] = await Promise.all([
    get("/api/websites/:id/sessions/stats"),
    get("/api/websites/:id/sessions", { page: 1, pageSize: 20 }),
  ]);

  if (!list.ok) return failure(list.status);

  const s = stats.data || {};
  const rows = (list.data && list.data.data) || [];

  const body = rows
    .map((r) => {
      const where = [r.city, r.country].filter(Boolean).join(", ");
      const what = [r.browser, r.os, r.device].filter(Boolean).join(" · ");
      const when = r.lastAt ? new Date(r.lastAt) : null;
      return `
        <li class="bm-session">
          <span class="bm-session-where" title="${escapeHTML(where)}">${escapeHTML(where || t("a_unknown", "Unknown"))}</span>
          <span class="bm-session-what" title="${escapeHTML(what)}">${escapeHTML(what)}</span>
          <span class="bm-session-num">${escapeHTML(compact(r.views))}</span>
          <span class="bm-session-when">${when && !isNaN(when) ? escapeHTML(when.toLocaleDateString()) : ""}</span>
        </li>`;
    })
    .join("");

  return `
    <div class="bm-tiles">
      ${tile(t("a_visitors", "Visitors"), compact(s.visitors))}
      ${tile(t("a_visits", "Visits"), compact(s.visits))}
      ${tile(t("a_views", "Views"), compact(s.pageviews))}
      ${tile(t("a_countries", "Countries"), compact(s.countries))}
      ${tile(t("a_events_fired", "Events"), compact(s.events))}
    </div>
    <div class="bm-card bm-a-panel">
      <div class="bm-sub-title">${escapeHTML(t("a_recent", "Recent sessions"))}
        <span class="bm-count">${escapeHTML(compact((list.data && list.data.count) || rows.length))}</span>
      </div>
      ${rows.length ? `<ul class="bm-sessions">${body}</ul>` : blank(t("a_nodata", "Nothing in this range"))}
    </div>`;
}

async function viewPerformance() {
  const res = await report("performance", {
    unit: unitFor(),
    timezone: timezone(),
    metric: state.metric,
  });

  if (!res.ok) return failure(res.status);

  const data = res.data || {};
  const summary = data.summary || {};

  const anyData = Object.keys(VITALS).some((k) => num(summary[k] && summary[k].p75) > 0);
  if (!anyData) {
    return blank(
      t(
        "a_perf_none",
        "No web vitals yet. The tracker collects them only when data-performance is set.",
      ),
    );
  }

  const tiles = Object.entries(VITALS)
    .map(([key, spec]) => {
      const p75 = num(summary[key] && summary[key].p75);
      const tone = p75 <= spec.good ? "good" : p75 <= spec.poor ? "warn" : "bad";
      return tile(spec.label + " p75", ms(p75, spec.unit), { tone });
    })
    .join("");

  const picker = Object.entries(VITALS)
    .map(
      ([key, spec]) =>
        `<button type="button" data-metric="${key}"${key === state.metric ? ' class="is-on"' : ""}>${spec.label}</button>`,
    )
    .join("");

  const spec = VITALS[state.metric] || VITALS.lcp;
  const chart = (data.chart || []).map((r) => ({ x: r.t, y: r.p75 }));

  return `
    <div class="bm-tiles">${tiles}</div>
    <div class="bm-a-bar">
      <div class="bm-seg bm-a-metric" role="group">${picker}</div>
      <span class="bm-hint">${escapeHTML(spec.label)} · p75</span>
    </div>
    ${barChart(chart, { label: spec.label })}
    <div class="bm-a-grid">
      ${rankTable(t("a_pages", "Pages"), (data.pages || []).map((r) => ({ x: r.x, y: r.p75 })))}
      ${rankTable(t("a_browsers", "Browsers"), (data.browsers || []).map((r) => ({ x: r.x, y: r.p75 })))}
    </div>`;
}

async function viewCompare() {
  const [stats, chart] = await Promise.all([
    get("/api/websites/:id/stats"),
    get("/api/websites/:id/pageviews", {
      unit: unitFor(),
      timezone: timezone(),
      compare: "prev",
    }),
  ]);

  if (!stats.ok) return failure(stats.status);

  const s = stats.data || {};
  const p = s.comparison || {};

  const rate = (b, v) => (num(v) ? num(b) / num(v) : 0);
  const each = (v) => (num(v.visits) ? num(v.totaltime) / num(v.visits) : 0);

  const tiles = [
    tile(t("a_visitors", "Visitors"), compact(s.visitors), {
      change: delta(s.visitors, p.visitors),
    }),
    tile(t("a_visits", "Visits"), compact(s.visits), { change: delta(s.visits, p.visits) }),
    tile(t("a_views", "Views"), compact(s.pageviews), {
      change: delta(s.pageviews, p.pageviews),
    }),
    tile(t("a_bounce", "Bounce rate"), percent(rate(s.bounces, s.visits)), {
      change: delta(rate(s.bounces, s.visits), rate(p.bounces, p.visits)),
      // A bounce rate going DOWN is the good direction, so the tone flips.
      inverse: true,
    }),
    tile(t("a_duration", "Visit duration"), duration(each(s)), {
      change: delta(each(s), each(p)),
    }),
  ].join("");

  const now = (chart.data && chart.data.pageviews) || [];
  const before = (chart.data && chart.data.compare && chart.data.compare.pageviews) || [];

  return `
    <div class="bm-tiles">${tiles}</div>
    ${barChart(now, { compare: before, label: t("a_views", "Views") })}
    <p class="bm-hint">${escapeHTML(t("a_compare_note", "Against the previous period of the same length."))}</p>`;
}

async function viewBreakdown() {
  const res = await report("breakdown", { fields: state.fields });

  if (!res.ok) return failure(res.status);

  const rows = Array.isArray(res.data) ? res.data : res.data && res.data.data;
  const picker = BREAKDOWN_FIELDS.map(
    (f) =>
      `<button type="button" data-field="${f}"${state.fields.includes(f) ? ' class="is-on"' : ""}>${escapeHTML(t("a_f_" + f, f))}</button>`,
  ).join("");

  const head = state.fields
    .map((f) => `<th>${escapeHTML(t("a_f_" + f, f))}</th>`)
    .join("");

  const body = (rows || [])
    .slice(0, 40)
    .map((r) => {
      const cells = state.fields
        .map((f) => {
          const v = r[f];
          const shown = v == null || v === "" ? t("a_direct", "Direct / none") : String(v);
          return `<td title="${escapeHTML(shown)}">${escapeHTML(shown)}</td>`;
        })
        .join("");
      return `<tr>${cells}<td class="bm-td-num">${escapeHTML(compact(r.visitors ?? r.y ?? r.count))}</td></tr>`;
    })
    .join("");

  return `
    <div class="bm-a-bar">
      <div class="bm-seg bm-a-fields" role="group">${picker}</div>
      <span class="bm-hint">${escapeHTML(t("a_break_note", "Pick up to three dimensions to cross."))}</span>
    </div>
    ${
      body
        ? `<div class="bm-card bm-a-panel bm-a-scroll">
             <table class="bm-table">
               <thead><tr>${head}<th class="bm-td-num">${escapeHTML(t("a_visitors", "Visitors"))}</th></tr></thead>
               <tbody>${body}</tbody>
             </table>
           </div>`
        : blank(t("a_nodata", "Nothing in this range"))
    }`;
}

function failure(status) {
  if (status === 401 || status === 403) {
    return blank(t("a_denied", "The analytics credential was refused."));
  }
  return blank(t("a_offline", "Umami did not answer."));
}

const RENDER = {
  overview: viewOverview,
  events: viewEvents,
  sessions: viewSessions,
  performance: viewPerformance,
  compare: viewCompare,
  breakdown: viewBreakdown,
};

/* ─── shell ───────────────────────────────────────────────────────────────── */

function shell(section) {
  const tabs = VIEWS.map(
    (v) =>
      `<button type="button" data-view="${v}"${v === state.view ? ' class="is-on"' : ""}>${escapeHTML(
        t("a_" + v, v),
      )}</button>`,
  ).join("");

  const ranges = RANGES.map(
    ([days]) =>
      `<button type="button" data-days="${days}"${days === state.days ? ' class="is-on"' : ""}>${
        days >= 365 ? "1y" : days + "d"
      }</button>`,
  ).join("");

  section.innerHTML = `
    <h2 class="bm-section-title">
      <i class="fa-solid fa-chart-simple" aria-hidden="true"></i>${escapeHTML(t("a_title", "Analytics"))}
    </h2>
    <p class="bm-lede">${escapeHTML(
      t("a_lede", "Read straight from Umami with an admin credential the Worker releases per session."),
    )}</p>
    <div class="bm-a-head">
      <div class="bm-seg bm-a-views" role="group">${tabs}</div>
      <div class="bm-seg bm-a-range" role="group">${ranges}</div>
    </div>
    <div class="bm-a-body" data-a-body>${spinner()}</div>`;
}

async function paint(force) {
  const body = root.querySelector("[data-a-body]");
  if (!body) return;

  const key = state.view + ":" + state.days + ":" + state.metric + ":" + state.fields.join(",");
  if (!force && state.cache.has(key)) {
    body.innerHTML = state.cache.get(key);
    return;
  }

  body.innerHTML = spinner();
  const token = ++state.seq;

  let html;
  try {
    html = await RENDER[state.view]();
  } catch {
    html = failure(0);
  }

  // A slower earlier request must not paint over a faster later one.
  if (token !== state.seq) return;

  state.cache.set(key, html);
  body.innerHTML = html;
}

function wire(section) {
  section.addEventListener("click", (e) => {
    const view = e.target.closest("[data-view]");
    if (view) {
      state.view = view.getAttribute("data-view");
      setOn(section, ".bm-a-views", view);
      paint();
      return;
    }

    const days = e.target.closest("[data-days]");
    if (days) {
      state.days = Number(days.getAttribute("data-days"));
      // The range moves every series, so nothing cached survives it.
      state.cache.clear();
      setOn(section, ".bm-a-range", days);
      paint();
      return;
    }

    const metric = e.target.closest("[data-metric]");
    if (metric) {
      state.metric = metric.getAttribute("data-metric");
      setOn(section, ".bm-a-metric", metric);
      paint();
      return;
    }

    const field = e.target.closest("[data-field]");
    if (field) {
      const name = field.getAttribute("data-field");
      const next = state.fields.includes(name)
        ? state.fields.filter((f) => f !== name)
        : state.fields.concat(name).slice(-3);
      // Crossing nothing is not a breakdown; keep the last dimension standing.
      state.fields = next.length ? next : state.fields;
      paint();
    }
  });
}

function setOn(section, group, button) {
  const box = section.querySelector(group);
  if (!box) return;
  box.querySelectorAll("button").forEach((b) => b.classList.remove("is-on"));
  button.classList.add("is-on");
}

/**
 * @param {Element} section    the `[data-part="analytics"]` host
 * @param {Element} consoleEl  the console root, for delegated lookups
 * @param {Function} translate the console's own `t`
 */
export function initManagementAnalytics(section, consoleEl, translate) {
  if (!section) return;

  root = consoleEl || section;
  t = translate || t;
  state = {
    view: "overview",
    days: 30,
    metric: "lcp",
    fields: ["path"],
    cache: new Map(),
    seq: 0,
  };

  shell(section);
  wire(section);
  paint();
}
