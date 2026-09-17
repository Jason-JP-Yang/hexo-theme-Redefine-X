/**
 * The site's one door to Umami — and it opens for an ADMIN ONLY.
 *
 * The credential is a full Umami bearer, held as a Cloudflare secret and released
 * by the Worker to a verified admin session. It lives in a MODULE VARIABLE and
 * nowhere else: not localStorage, not sessionStorage, so closing the tab or
 * signing out destroys it with the page. Swup navigations keep it, a reload does
 * not, which is the trade we want.
 *
 * The browser then talks to Umami DIRECTLY. The Worker hands out the credential
 * and steps out of the way — the same shape as the editor's repository ticket,
 * and for the same reason: a proxy would put every dashboard query through a 10ms
 * CPU budget it has no business spending.
 *
 * NOTHING PUBLIC READS UMAMI ANY MORE. The home page's activity card used to mint
 * a share token here and ask for two years of daily buckets in every reader's
 * browser, which made the analytics instance re-aggregate a year that had not
 * changed since the last visitor asked. Those days are finished numbers, so the
 * BUILD reads them once and the page carries them —
 * themes/redefine-x/scripts/lib/analytics-archive.js. What is left in this file
 * serves the admin console, which is one reader asking about today.
 */

let adminCache = null; // { token, host, websiteId } — memory only, never stored
let adminPromise = null;

/* ─── config ──────────────────────────────────────────────────────────────── */

export function analyticsConfig() {
  const a = (window.theme && window.theme.backend && window.theme.backend.analytics) || {};
  return {
    enable: a.enable === true,
    host: String(a.host || "").replace(/\/+$/, ""),
    websiteId: a.website_id || "",
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
  adminToken,
  adminQuery,
  adminReport,
  dropAdminToken,
};
