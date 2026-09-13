/**
 * The site's one door to Umami.
 *
 * Two credentials, and the difference between them is the whole security model:
 *
 *   PUBLIC   a share token, minted by GET /api/share/{slug}. Read-only by
 *            construction and scoped in Umami to the Overview section alone, so
 *            it can answer "how many views on each day" and nothing else. It is
 *            cached in localStorage because it is already public — the slug that
 *            mints it ships in the page.
 *
 *   ADMIN    a full Umami bearer, held as a Cloudflare secret and released by the
 *            Worker only to a verified admin session. It lives in a MODULE
 *            VARIABLE and nowhere else: not localStorage, not sessionStorage, so
 *            closing the tab or signing out destroys it with the page. Swup
 *            navigations keep it, a reload does not, which is the trade we want.
 *
 * Both paths talk to Umami DIRECTLY. The Worker hands out the credential and
 * then steps out of the way — the same shape as the editor's repository ticket,
 * and for the same reason: a proxy would put every dashboard query through a
 * 10ms CPU budget it has no business spending.
 */

const SHARE_KEY = "umami-share";
const PULSE_KEY = "umami-pulse";
const PULSE_TTL = 30 * 60e3;

/**
 * Umami refuses a `unit` finer than the span allows: lib/date.getMinimumUnit
 * returns `month` as soon as the range covers more than seven CALENDAR months,
 * and lib/request.getRequestDateRange then silently replaces the requested
 * `day` with it. A year asked for in one request therefore comes back as twelve
 * monthly totals — which is what a calendar cannot be drawn from. So a long span
 * is asked for in pieces short enough to keep daily buckets.
 */
const MAX_DAY_SPAN = 180;

let adminCache = null; // { token, host, websiteId } — memory only, never stored
let adminPromise = null;

/* ─── config ──────────────────────────────────────────────────────────────── */

export function analyticsConfig() {
  const a = (window.theme && window.theme.analytics) || {};
  return {
    enable: a.enable === true,
    host: String(a.host || "").replace(/\/+$/, ""),
    websiteId: a.website_id || "",
    share: a.share || "",
    pulse: a.pulse !== false,
    events: a.events !== false,
  };
}

export function analyticsReady() {
  const c = analyticsConfig();
  return c.enable && !!c.host && !!c.websiteId;
}

/** The reader's own calendar, so "today" is their today and not UTC's. */
export function timezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function store(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function keep(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {}
}

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((item) => q.append(k, String(item)));
    else q.set(k, String(v));
  }
  const s = q.toString();
  return s ? "?" + s : "";
}

/* ─── the public credential ───────────────────────────────────────────────── */

async function shareToken(force) {
  const { host, share } = analyticsConfig();
  if (!host || !share) return null;

  if (!force) {
    const raw = store(SHARE_KEY);
    if (raw) {
      try {
        const saved = JSON.parse(raw);
        if (saved && saved.slug === share && saved.token) return saved;
      } catch {}
    }
  }

  let data;
  try {
    const res = await fetch(host + "/api/share/" + encodeURIComponent(share));
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  if (!data || !data.token) return null;

  const saved = { slug: share, token: data.token, websiteId: data.websiteId };
  keep(SHARE_KEY, JSON.stringify(saved));
  return saved;
}

/**
 * One read through the public share token.
 *
 * A share token carries no expiry in self-hosted Umami, but it IS invalidated by
 * rotating the share — so a 401 re-mints once rather than leaving the card dead
 * until someone clears their storage.
 */
export async function publicQuery(path, params, retry = true) {
  const { host } = analyticsConfig();
  const share = await shareToken(!retry);
  if (!host || !share) return null;

  const url =
    host + path.replace(":id", share.websiteId || analyticsConfig().websiteId) + query(params);

  let res;
  try {
    res = await fetch(url, {
      headers: {
        "x-umami-share-token": share.token,
        "x-umami-share-context": "1",
      },
    });
  } catch {
    return null;
  }

  if (res.status === 401 && retry) {
    keep(SHARE_KEY, null);
    return publicQuery(path, params, false);
  }
  if (!res.ok) return null;

  try {
    return await res.json();
  } catch {
    return null;
  }
}

/* ─── the admin credential ────────────────────────────────────────────────── */

function workerBase() {
  const backend = (window.theme && window.theme.backend) || {};
  return window.blogAuth
    ? window.blogAuth.resolveApiBase()
    : String(backend.api_url || "").replace(/\/+$/, "");
}

/** Forget the Umami bearer. Called on sign-out and when the page goes away. */
export function dropAdminToken() {
  adminCache = null;
  adminPromise = null;
}

export async function adminToken(force) {
  if (!force && adminCache) return adminCache;
  if (adminPromise) return adminPromise;

  adminPromise = (async () => {
    const base = workerBase();
    if (!base || !window.blogAuth) return null;

    let session;
    try {
      session = await window.blogAuth.getSessionToken();
    } catch {
      return null;
    }
    if (!session) return null;

    let data;
    try {
      const res = await fetch(base + "/api/admin/analytics/ticket", {
        headers: { Authorization: "Bearer " + session },
      });
      if (!res.ok) return null;
      data = await res.json();
    } catch {
      return null;
    }
    if (!data || !data.token) return null;

    adminCache = {
      token: data.token,
      host: String(data.host || analyticsConfig().host).replace(/\/+$/, ""),
      websiteId: data.websiteId || analyticsConfig().websiteId,
    };
    return adminCache;
  })();

  const out = await adminPromise;
  adminPromise = null;
  return out;
}

/**
 * One read as the admin. `path` may contain `:id`, replaced by the website id
 * the Worker named, so callers never hard-code it.
 */
export async function adminQuery(path, params, options = {}, retry = true) {
  const cred = await adminToken();
  if (!cred) return { ok: false, status: 401, data: null };

  const init = {
    method: options.method || "GET",
    headers: { Authorization: "Bearer " + cred.token },
  };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let res;
  try {
    res = await fetch(cred.host + path.replace(":id", cred.websiteId) + query(params), init);
  } catch {
    return { ok: false, status: 0, data: null };
  }

  // The Umami bearer is permanent, so a 401 means the secret was rotated rather
  // than that it aged out. Re-ticket once; a second 401 is a real answer.
  if (res.status === 401 && retry) {
    dropAdminToken();
    return adminQuery(path, params, options, false);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { ok: res.ok, status: res.status, data };
}

/**
 * One report. These endpoints take the website id and the whole parameter set in
 * the BODY, so the credential has to be in hand before the request can be built.
 */
export async function adminReport(type, parameters, filters) {
  const cred = await adminToken();
  if (!cred) return { ok: false, status: 401, data: null };

  return adminQuery("/api/reports/" + type, null, {
    method: "POST",
    body: {
      websiteId: cred.websiteId,
      type,
      filters: filters || {},
      parameters,
    },
  });
}

/* ─── the activity series ─────────────────────────────────────────────────── */

function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Umami returns a timestamp string; only the calendar day of it matters here. */
function rowKey(x) {
  if (typeof x === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(x);
    if (m) return m[1];
  }
  const d = new Date(x);
  return isNaN(d) ? null : dayKey(d);
}

/** One window of daily buckets, short enough that Umami keeps the unit. */
async function dayChunk(from, to) {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);

  return publicQuery("/api/websites/:id/pageviews", {
    startAt: start.getTime(),
    endAt: end.getTime(),
    unit: "day",
    timezone: timezone(),
  });
}

/**
 * Daily view counts for the last `days` days, oldest first, gaps filled with 0.
 *
 * Umami groups by day and omits the empty ones, so the filling is not a nicety:
 * a calendar drawn straight from the response would silently close up its quiet
 * weeks and every date after the first gap would be wrong.
 */
export async function dailyViews(days) {
  const span = Math.max(1, Math.min(400, days | 0));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const cached = readPulseCache(span, dayKey(today));
  if (cached) return cached;

  const start = new Date(today);
  start.setDate(start.getDate() - (span - 1));

  const windows = [];
  for (let offset = 0; offset < span; offset += MAX_DAY_SPAN) {
    const from = new Date(start);
    from.setDate(from.getDate() + offset);
    const to = new Date(start);
    to.setDate(to.getDate() + Math.min(offset + MAX_DAY_SPAN - 1, span - 1));
    windows.push([from, to]);
  }

  const responses = await Promise.all(windows.map(([from, to]) => dayChunk(from, to)));
  if (!responses.some((r) => r && Array.isArray(r.pageviews))) return null;

  const counts = new Map();
  for (const data of responses) {
    if (!data || !Array.isArray(data.pageviews)) continue;
    for (const row of data.pageviews) {
      const key = rowKey(row.x);
      if (key) counts.set(key, (counts.get(key) || 0) + Number(row.y || 0));
    }
  }

  const series = [];
  const cursor = new Date(start);
  for (let i = 0; i < span; i++) {
    const key = dayKey(cursor);
    series.push({ date: key, value: counts.get(key) || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  writePulseCache(span, dayKey(today), series);
  return series;
}

function readPulseCache(span, today) {
  const raw = store(PULSE_KEY);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    if (!saved || saved.today !== today) return null;
    if (Date.now() - saved.at > PULSE_TTL) return null;
    if (!Array.isArray(saved.series) || saved.series.length < span) return null;
    // A longer cached run answers a shorter question for free: the series ends
    // on today either way, so the tail is the shorter series exactly.
    return saved.series.slice(saved.series.length - span);
  } catch {
    return null;
  }
}

function writePulseCache(span, today, series) {
  const raw = store(PULSE_KEY);
  try {
    const saved = raw ? JSON.parse(raw) : null;
    // Never trade a long run for a short one: the long one answers both.
    if (
      saved &&
      saved.today === today &&
      Date.now() - saved.at <= PULSE_TTL &&
      Array.isArray(saved.series) &&
      saved.series.length >= series.length
    ) {
      return;
    }
  } catch {}
  keep(PULSE_KEY, JSON.stringify({ span, today, at: Date.now(), series }));
}

/* ─── lifetime ────────────────────────────────────────────────────────────── */

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", dropAdminToken);
  window.addEventListener("blog:auth-change", () => {
    if (!window.blogAuth || !window.blogAuth.isAdmin) dropAdminToken();
  });
}

export default {
  analyticsConfig,
  analyticsReady,
  timezone,
  publicQuery,
  adminToken,
  adminQuery,
  adminReport,
  dropAdminToken,
  dailyViews,
};
