/**
 * Redefine-X Backend Worker
 *
 * A headless Cloudflare Worker (Hono + D1) backing the Redefine-X theme. It has
 * NO front-end of its own — it serves four JSON/proxy concerns:
 *   1. Instant Notes API   — D1-backed notes (public read; admin CRUD).
 *   2. Auth                — verifies a giscus-derived GitHub token and mints a
 *                            short-lived HMAC session. Every verified user gets
 *                            one; only allowlisted ids get isAdmin.
 *   3. Giscus CORS proxy   — forwards giscus.app API calls (comments + masonry
 *                            likes) with the blog's CORS headers.
 *   4. Notifications       — follow/push subscriptions, the in-site inbox, the
 *                            GitHub webhook that ingests changelog.json, and the
 *                            cron that drains the push queue.
 * Admin writes are authorized ONLY by an isAdmin HMAC session; follower routes
 * take any valid session.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { fetchGitHubUser, isAdminUser, signSession, verifySession } from "./auth.js";
import {
  ingestEntries,
  drainOutbox,
  pruneOutbox,
  getSetting,
  setSetting,
  isDryRun,
} from "./notify.js";
import { verifySignature, fetchChangelog, isRelevantPush } from "./hooks.js";
import { sendWebPush, checkVapidKeys } from "./webpush.js";

const app = new Hono();

// Session TTL for the minted session token (2 hours).
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// How many inbox rows one request returns.
const INBOX_LIMIT = 30;

// ─── CORS ──────────────────────────────────────────────────
/**
 * Reduce an origin or an allowlist entry to a bare hostname.
 *
 * ALLOWED_ORIGIN matches on the DOMAIN only — scheme and port are ignored — so
 * "blog.example.com" covers https, http and every port. Entries written the long
 * way ("https://blog.example.com:8443") still work; the extra parts are simply
 * stripped, so an old-style list keeps behaving.
 */
function hostOf(value) {
  let s = String(value || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.split("/")[0]; // path
  if (s.startsWith("[")) {
    const close = s.indexOf("]"); // IPv6 literal, port lives after the bracket
    return close === -1 ? s : s.slice(1, close);
  }
  return s.replace(/:[^:]*$/, ""); // port (numeric or "*")
}

/**
 * One allowlist entry → a hostname matcher.
 *
 * `*` stands for ONE label and never crosses a dot, so "*.example.com" cannot be
 * widened by "evil.example.com.attacker.net" or by a deeper host somebody else
 * controls. "192.168.*.*" works the same way, an octet being a label.
 *
 * The token `local` (or `localhost`) matches any private address: loopback,
 * mDNS `.local`, and the RFC 1918 LAN ranges. That is the set a developer can
 * reach and the public internet cannot.
 */
function hostMatcher(entry) {
  const pattern = hostOf(entry);
  if (!pattern) return () => false;
  if (pattern === "local" || pattern === "localhost") return isPrivateHost;
  if (!pattern.includes("*")) return (host) => host === pattern;

  const source =
    "^" +
    pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^.]+") +
    "$";
  const re = new RegExp(source);
  return (host) => re.test(host);
}

/** Any address only reachable from a private network — see tools/auth.js. */
function isPrivateHost(host) {
  const h = String(host || "").toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  if (/(^|\.)localhost$/.test(h) || /\.local$/.test(h)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  const m = /^172\.(\d+)\.\d+\.\d+$/.exec(h);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

function isLocalhostOrigin(origin) {
  return !!origin && isPrivateHost(hostOf(origin));
}

let matcherCache = null;
let matcherCacheKey = null;

function allowedMatchers(allowed) {
  if (matcherCacheKey === allowed) return matcherCache;
  matcherCacheKey = allowed;
  matcherCache = allowed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(hostMatcher);
  return matcherCache;
}

/**
 * Decide the Access-Control-Allow-Origin for a request.
 *
 * ALLOWED_ORIGIN is AUTHORITATIVE — there is no built-in exception for
 * localhost. (There used to be one, applied before the list was even read, which
 * made the setting quietly mean less than it said.) It is deliberately NOT
 * declared in wrangler.toml, so it can be edited in the Cloudflare dashboard and
 * take effect without a redeploy; if it is unset entirely, the Worker falls back
 * to the SITE_URL domain rather than to `*`.
 *
 * Matching is on the domain only. That means http and https are treated alike —
 * a deliberate trade for a config that is easy to edit under pressure, and a
 * non-issue for a site that redirects http to https anyway.
 *
 * Worth being clear about what this does and does not buy: CORS is enforced by
 * the browser and governs which web origins may READ a response. It is not
 * authentication — any non-browser client can send whatever Origin header it
 * likes, and curl ignores the answer entirely. Every privileged route here is
 * protected by the Bearer session token, not by this list. What the list is for
 * is least privilege and honesty: it should mean exactly what it says.
 */
function resolveOrigin(origin, env) {
  const configured = env.ALLOWED_ORIGIN;
  // Unset is not a licence to allow everything: fall back to the site's own
  // domain, which is the one origin that must always work.
  const allowed = configured == null || configured === "" ? hostOf(env.SITE_URL) : configured;
  if (allowed === "*") return "*";
  if (!origin) return null;
  const host = hostOf(origin);
  if (!host) return null;
  return allowedMatchers(allowed).some((match) => match(host)) ? origin : null;
}

// Standard CORS for the JSON API endpoints. The giscus proxy routes set their
// OWN CORS headers (they return forwarded giscus.app responses), so they are
// intentionally NOT covered by this middleware.
const apiCors = cors({
  origin: (origin, c) => resolveOrigin(origin, c.env),
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
});
app.use("/api/notes", apiCors);
app.use("/api/auth/*", apiCors);
app.use("/api/admin/*", apiCors);
app.use("/api/push/*", apiCors);
app.use("/api/me/*", apiCors);
// The webhook is deliberately NOT in this list: it is called server-to-server by
// GitHub, authenticated by HMAC, and must not be reachable from a browser.

// ─── GISCUS CORS PROXY (merged from giscus-cors-proxy) ──────
// giscus.app only allows CORS from its own origin, so the front-end can't call
// it directly. We forward a small allowlist of API paths and add the blog's
// CORS headers ourselves (mirrors the former standalone giscus-cors-proxy).
const GISCUS_ORIGIN = "https://giscus.app";

function pickProxyOrigin(c) {
  const allowed = c.env.ALLOWED_ORIGIN || "*";
  if (allowed === "*") return "*";
  const matched = resolveOrigin(c.req.header("Origin") || "", c.env);
  return matched || allowed.split(",")[0].trim();
}

async function proxyToGiscus(c) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": pickProxyOrigin(c),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };

  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(c.req.url);
  const target = GISCUS_ORIGIN + url.pathname + url.search;

  const headers = new Headers();
  for (const key of ["content-type", "accept"]) {
    const val = c.req.header(key);
    if (val) headers.set(key, val);
  }
  const auth = c.req.header("authorization");
  if (auth) headers.set("Authorization", auth);

  const init = { method: c.req.method, headers };
  if (c.req.method === "POST") init.body = await c.req.text();

  let res;
  try {
    res = await fetch(target, init);
  } catch {
    return new Response(JSON.stringify({ error: "Proxy fetch failed" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Forward giscus's body + content-type with OUR CORS headers (do not copy
  // giscus.app's own CORS headers — they'd be scoped to giscus.app).
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: {
      ...corsHeaders,
      "Content-Type": res.headers.get("content-type") || "application/json",
    },
  });
}

app.options("/api/discussions", proxyToGiscus);
app.options("/api/discussions/categories", proxyToGiscus);
app.options("/api/oauth/token", proxyToGiscus);
app.get("/api/discussions", proxyToGiscus);
app.get("/api/discussions/categories", proxyToGiscus);
app.post("/api/oauth/token", proxyToGiscus);

// ─── PUBLIC API: GET recent notes (48h, max 5) ─────────────
app.get("/api/notes", async (c) => {
  const db = c.env.DB;
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { results } = await db
    .prepare(
      `SELECT id, text, emoji, color, created_at
       FROM notes
       WHERE created_at >= ?1
       ORDER BY created_at DESC
       LIMIT 5`
    )
    .bind(cutoff)
    .all();

  return c.json(results || []);
});

// ─── Auth middleware for admin routes ───────────────────────
// Authorized solely by an HMAC session token minted by /api/auth/login (a
// GitHub-OAuth-verified admin) — verified locally, no GitHub round-trip.
/**
 * Refuse admin writes issued from a localhost page unless this deployment says
 * otherwise (`ALLOW_LOCALHOST_ADMIN = "true"`, which `.dev.vars` sets locally).
 *
 * This is the guard that matters, and the hazard it addresses is not an attacker
 * — it is the author. A dev build pointed at the production Worker looks
 * identical to the real site, and one careless click there posts a test note to
 * the live banner or broadcasts a test notification to real followers. There is
 * no undo for a push that has already been delivered.
 *
 * Production therefore refuses the combination outright; the local Worker
 * permits it, so full-stack local development is unaffected. Deliberately
 * administering production from a local page is still possible — it just has to
 * be a decision (flip the var, deploy) rather than an accident.
 */
function requireLocalAdmin(c) {
  if (String(c.env.ALLOW_LOCALHOST_ADMIN || "") === "true") return null;
  if (!isLocalhostOrigin(c.req.header("Origin"))) return null;
  return c.json(
    {
      error: "Admin writes from a localhost origin are disabled on this deployment",
      hint: "Run the Worker locally (wrangler dev), or set ALLOW_LOCALHOST_ADMIN=true to allow it deliberately.",
    },
    403
  );
}

const authMiddleware = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const token = authHeader.slice(7);

  const session = await verifySession(token, c.env.SESSION_SECRET);
  if (session && session.isAdmin) {
    const blocked = requireLocalAdmin(c);
    if (blocked) return blocked;
    c.set("admin", session);
    await next();
    return;
  }

  return c.json({ error: "Invalid credentials" }, 403);
};

// ─── Auth middleware for follower routes ────────────────────
// Same signed session, weaker requirement: any verified GitHub user, admin or
// not. Guards /api/me/* and /api/push/* — a reader managing their OWN inbox,
// devices and topic preferences, never anyone else's. Every handler below scopes
// its queries by this id, so a valid token grants access to that identity only.
const userMiddleware = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const session = await verifySession(authHeader.slice(7), c.env.SESSION_SECRET);
  if (!session || !session.id) {
    return c.json({ error: "Invalid credentials" }, 403);
  }
  c.set("user", session);
  await next();
};

// ─── AUTH API: GitHub-OAuth login / admin check ─────────────
// The browser obtains a GitHub user token from giscus (window.blogAuth) and
// posts it here. We verify it against GitHub, check the admin allowlist, and
// mint a short-lived signed session token.
//
// EVERY verified user gets a token, not just admins: following the blog is a
// per-reader action, so an ordinary reader needs a credential to register a push
// device and read their own inbox. What the allowlist decides is the `isAdmin`
// claim inside it, which is the only thing /api/admin/* accepts.
app.post("/api/auth/login", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad request" }, 400);
  }
  const githubToken = body && body.githubToken;
  if (!githubToken) return c.json({ error: "Missing token" }, 400);

  const user = await fetchGitHubUser(githubToken);
  if (!user) return c.json({ error: "GitHub verification failed" }, 401);

  const isAdmin = isAdminUser(user, c.env.ADMIN_LOGINS);

  let token = null;
  let exp = null;
  if (c.env.SESSION_SECRET) {
    exp = Date.now() + SESSION_TTL_MS;
    token = await signSession(
      { id: user.id, login: user.login, isAdmin, exp },
      c.env.SESSION_SECRET
    );
  }

  return c.json({
    id: user.id,
    login: user.login,
    avatar: user.avatar_url,
    isAdmin,
    token,
    exp,
  });
});

// ─── ADMIN API: List ALL notes (not just 48h) ──────────────
app.get("/api/admin/notes", authMiddleware, async (c) => {
  const db = c.env.DB;
  const { results } = await db
    .prepare(
      `SELECT id, text, emoji, color, created_at, updated_at
       FROM notes
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .all();
  return c.json(results || []);
});

// ─── ADMIN API: Create note ────────────────────────────────
// Creating a note also announces it, on the `notes` topic. Only creation does —
// editing a note is a correction, not news, and re-alerting for a typo fix is
// how a notification channel teaches people to mute it.
app.post("/api/admin/notes", authMiddleware, async (c) => {
  const body = await c.req.json();
  const { text, emoji, color } = body;
  if (!text || text.length === 0) {
    return c.json({ error: "Text is required" }, 400);
  }
  if (text.length > 200) {
    return c.json({ error: "Text too long (max 200 chars)" }, 400);
  }
  const db = c.env.DB;
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO notes (text, emoji, color, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`
    )
    .bind(text, emoji || "", color || "default", now)
    .run();

  const id = result.meta.last_row_id;

  // `notify: false` in the request opts one note out; NOTIFY_ON_NOTE = "false"
  // turns the whole behaviour off for the deployment.
  const wanted = body.notify !== false && String(c.env.NOTIFY_ON_NOTE || "true") !== "false";
  let notification = null;

  if (wanted) {
    const admin = c.get("admin");
    notification = await ingestEntries(
      db,
      c.env,
      [
        {
          id: `note:${id}`,
          type: "note",
          topic: "notes",
          title: c.env.NOTE_TITLE || "New note",
          body: `${emoji ? emoji + " " : ""}${text}`,
          url: c.env.SITE_URL || "/",
          // All notes share one tag, so an unread note in the OS tray is
          // REPLACED by the next one rather than stacking. Notes are ephemeral
          // (the public API only returns the last 48h) and a pile of them is
          // noise by the time anyone looks.
          tag: "notes",
          audience: { kind: "topic", exclude: excludeSelf(c, admin) },
        },
      ],
      { source: "note" }
    );
  }

  return c.json({ ok: true, id, notification }, 201);
});

// ─── ADMIN API: Update note ────────────────────────────────
app.put("/api/admin/notes/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const { text, emoji, color } = await c.req.json();
  if (!text || text.length === 0) {
    return c.json({ error: "Text is required" }, 400);
  }
  if (text.length > 200) {
    return c.json({ error: "Text too long (max 200 chars)" }, 400);
  }
  const db = c.env.DB;
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE notes SET text = ?1, emoji = ?2, color = ?3, updated_at = ?4 WHERE id = ?5`
    )
    .bind(text, emoji || "", color || "default", now, id)
    .run();

  return c.json({ ok: true });
});

// ─── ADMIN API: Delete note ────────────────────────────────
app.delete("/api/admin/notes/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  await db.prepare(`DELETE FROM notes WHERE id = ?1`).bind(id).run();
  return c.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════════════════════════

/**
 * Who to leave out of an audience because they are the one who caused it.
 *
 * Being told about your own action is noise, and worse, it is indistinguishable
 * from the feature misfiring — you cannot tell "the push worked" from "the push
 * went to everyone including me by mistake". So the actor is excluded by
 * default. NOTIFY_SELF = "true" (set in .dev.vars) puts them back in, which is
 * exactly what local testing needs: with one follower in the database, excluding
 * yourself means nothing observable ever happens.
 */
function excludeSelf(c, actor) {
  if (!actor || !actor.id) return [];
  if (String(c.env.NOTIFY_SELF || "") === "true") return [];
  return [actor.id];
}

/**
 * Create or refresh the follower row for the signed-in user.
 * Following is implied by any of the follow actions — there is no separate
 * "follow" button to get out of sync with the subscription state.
 */
async function upsertFollower(db, session, topics) {
  await db
    .prepare(
      `INSERT INTO followers (github_id, login, avatar, topics)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(github_id) DO UPDATE SET
         login  = excluded.login,
         topics = COALESCE(?5, followers.topics)`
    )
    .bind(
      session.id,
      session.login || "",
      "",
      topics == null ? "" : String(topics),
      topics == null ? null : String(topics)
    )
    .run();
}

// ─── PUBLIC: the VAPID application server key ───────────────
// Public by definition — every subscribing browser is given this key. Exposed as
// an endpoint so the front-end can work even if the theme config has not been
// filled in yet.
app.get("/api/push/vapid-key", (c) => {
  return c.json({ key: c.env.VAPID_PUBLIC_KEY || null });
});

// ─── USER: register a push device ───────────────────────────
app.post("/api/push/subscribe", userMiddleware, async (c) => {
  const session = c.get("user");
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad request" }, 400);
  }

  // Accept both the flat shape and the raw PushSubscription#toJSON shape.
  const endpoint = body.endpoint;
  const p256dh = body.p256dh || (body.keys && body.keys.p256dh);
  const auth = body.auth || (body.keys && body.keys.auth);
  if (!endpoint || !p256dh || !auth) {
    return c.json({ error: "Missing subscription fields" }, 400);
  }

  const db = c.env.DB;
  await upsertFollower(db, session, body.topics);

  // The endpoint is the identity of a subscription. Re-subscribing the same
  // browser (a key rotation, a reinstall) rewrites the keys and clears the
  // failure count rather than adding a second row that will never work.
  await db
    .prepare(
      `INSERT INTO push_devices (github_id, endpoint, p256dh, auth, ua)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(endpoint) DO UPDATE SET
         github_id  = excluded.github_id,
         p256dh     = excluded.p256dh,
         auth       = excluded.auth,
         ua         = excluded.ua,
         fail_count = 0`
    )
    .bind(
      session.id,
      String(endpoint),
      String(p256dh),
      String(auth),
      String(c.req.header("User-Agent") || "").slice(0, 180)
    )
    .run();

  return c.json({ ok: true, following: true });
});

// ─── USER: unregister a push device ─────────────────────────
// Removes the device only. The follower row and the inbox survive, so the reader
// keeps their history and can re-subscribe without losing it. Leaving entirely
// is PUT /api/me/preferences { follow: false }.
app.delete("/api/push/subscribe", userMiddleware, async (c) => {
  const session = c.get("user");
  let body = {};
  try {
    body = await c.req.json();
  } catch {}

  const db = c.env.DB;
  if (body && body.endpoint) {
    await db
      .prepare(`DELETE FROM push_devices WHERE endpoint = ?1 AND github_id = ?2`)
      .bind(String(body.endpoint), session.id)
      .run();
  } else {
    await db.prepare(`DELETE FROM push_devices WHERE github_id = ?1`).bind(session.id).run();
  }
  return c.json({ ok: true });
});

// ─── USER: the in-site inbox ────────────────────────────────
app.get("/api/me/notifications", userMiddleware, async (c) => {
  const session = c.get("user");
  const db = c.env.DB;

  const { results } = await db
    .prepare(
      `SELECT n.id, n.type, n.topic, n.title, n.body, n.url, n.image,
              n.published_at, d.read_at
         FROM deliveries d
         JOIN notifications n ON n.id = d.notification_id
        WHERE d.github_id = ?1
        ORDER BY n.published_at DESC
        LIMIT ?2`
    )
    .bind(session.id, INBOX_LIMIT)
    .all();

  const unread = await db
    .prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE github_id = ?1 AND read_at IS NULL`)
    .bind(session.id)
    .first();

  const device = await db
    .prepare(`SELECT COUNT(*) AS n FROM push_devices WHERE github_id = ?1`)
    .bind(session.id)
    .first();

  return c.json({
    items: results || [],
    unread: unread ? unread.n : 0,
    devices: device ? device.n : 0,
  });
});

// ─── USER: mark read ────────────────────────────────────────
// No body marks everything read; `{ ids: [...] }` marks just those.
app.post("/api/me/notifications/read", userMiddleware, async (c) => {
  const session = c.get("user");
  let body = {};
  try {
    body = await c.req.json();
  } catch {}

  const db = c.env.DB;
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  if (body && Array.isArray(body.ids) && body.ids.length > 0) {
    const ids = body.ids.slice(0, 100).map(String);
    const placeholders = ids.map((_, i) => `?${i + 3}`).join(", ");
    await db
      .prepare(
        `UPDATE deliveries SET read_at = ?1
          WHERE github_id = ?2 AND read_at IS NULL AND notification_id IN (${placeholders})`
      )
      .bind(stamp, session.id, ...ids)
      .run();
  } else {
    await db
      .prepare(`UPDATE deliveries SET read_at = ?1 WHERE github_id = ?2 AND read_at IS NULL`)
      .bind(stamp, session.id)
      .run();
  }

  return c.json({ ok: true });
});

// ─── USER: topic preferences ────────────────────────────────
app.get("/api/me/preferences", userMiddleware, async (c) => {
  const session = c.get("user");
  const row = await c.env.DB
    .prepare(`SELECT topics, muted_until, created_at FROM followers WHERE github_id = ?1`)
    .bind(session.id)
    .first();

  const devices = await c.env.DB
    .prepare(`SELECT id, ua, created_at, last_ok_at FROM push_devices WHERE github_id = ?1`)
    .bind(session.id)
    .all();

  return c.json({
    following: !!row,
    topics: row ? row.topics : "",
    muted_until: row ? row.muted_until : null,
    since: row ? row.created_at : null,
    devices: devices.results || [],
  });
});

// ─── USER: edit preferences / leave ─────────────────────────
// `{ follow: false }` is a full erasure: devices, inbox and the follower row.
// That is the whole of what we hold about a reader, which is what makes
// unfollowing a real deletion rather than a flag.
app.put("/api/me/preferences", userMiddleware, async (c) => {
  const session = c.get("user");
  let body = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad request" }, 400);
  }
  const db = c.env.DB;

  if (body.follow === false) {
    await db.batch([
      db.prepare(`DELETE FROM push_devices WHERE github_id = ?1`).bind(session.id),
      db.prepare(`DELETE FROM deliveries WHERE github_id = ?1`).bind(session.id),
      db.prepare(`DELETE FROM followers WHERE github_id = ?1`).bind(session.id),
    ]);
    return c.json({ ok: true, following: false });
  }

  await upsertFollower(db, session, body.topics == null ? "" : body.topics);

  if (body.muted_until !== undefined) {
    await db
      .prepare(`UPDATE followers SET muted_until = ?1 WHERE github_id = ?2`)
      .bind(body.muted_until ? String(body.muted_until) : null, session.id)
      .run();
  }

  return c.json({ ok: true, following: true });
});

// ─── ADMIN: broadcast one notification by hand ──────────────
app.post("/api/admin/notifications", authMiddleware, async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad request" }, 400);
  }

  const entries = Array.isArray(body.entries) ? body.entries : [body];
  const result = await ingestEntries(c.env.DB, c.env, entries, { source: "admin" });

  if (result.ingested.length === 0) {
    return c.json({ error: "No new entries (missing id/title/url, or already sent)", ...result }, 400);
  }
  return c.json({ ok: true, ...result }, 201);
});

// ─── ADMIN: notification history + delivery stats ───────────
app.get("/api/admin/notifications", authMiddleware, async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT n.id, n.type, n.topic, n.title, n.url, n.source, n.published_at,
              (SELECT COUNT(*) FROM deliveries d WHERE d.notification_id = n.id)                        AS recipients,
              (SELECT COUNT(*) FROM deliveries d WHERE d.notification_id = n.id AND d.read_at IS NOT NULL) AS read,
              (SELECT COUNT(*) FROM outbox o WHERE o.notification_id = n.id AND o.state = 'sent')       AS pushed,
              (SELECT COUNT(*) FROM outbox o WHERE o.notification_id = n.id AND o.state = 'pending')    AS pending,
              (SELECT COUNT(*) FROM outbox o WHERE o.notification_id = n.id AND o.state = 'dead')       AS failed
         FROM notifications n
        ORDER BY n.published_at DESC
        LIMIT 50`
    )
    .all();

  const followers = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM followers`).first();
  const devices = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM push_devices`).first();

  return c.json({
    items: results || [],
    followers: followers ? followers.n : 0,
    devices: devices ? devices.n : 0,
    dryRun: await isDryRun(c.env.DB, c.env),
  });
});

// ─── ADMIN: resend an existing notification ─────────────────
// The deliberate override of the dedupe rule. Ingest refuses to resend because
// nearly every repeat is accidental; this route exists so the rare intentional
// one does not require touching the database by hand.
app.post("/api/admin/notifications/:id/resend", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;

  const notification = await db
    .prepare(`SELECT id FROM notifications WHERE id = ?1`)
    .bind(id)
    .first();
  if (!notification) return c.json({ error: "Unknown notification" }, 404);

  // Re-queue every device belonging to someone already in this notification's
  // inbox — the audience is fixed at ingest, so a resend cannot widen it.
  const { results: devices } = await db
    .prepare(
      `SELECT p.id FROM push_devices p
        WHERE p.github_id IN (SELECT github_id FROM deliveries WHERE notification_id = ?1)`
    )
    .bind(id)
    .all();

  if (!devices || devices.length === 0) return c.json({ ok: true, queued: 0 });

  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await db.batch(
    devices.map((d) =>
      db
        .prepare(
          `INSERT INTO outbox (notification_id, device_id, not_before, state, attempts)
           VALUES (?1, ?2, ?3, 'pending', 0)
           ON CONFLICT(notification_id, device_id) DO UPDATE SET
             state = 'pending', attempts = 0, not_before = ?3, last_error = NULL`
        )
        .bind(id, d.id, stamp)
    )
  );

  return c.json({ ok: true, queued: devices.length });
});

// ─── ADMIN: drain the queue now ─────────────────────────────
// The cron does this every minute; this is the same call for a human who does
// not want to wait for the next tick while testing.
app.post("/api/admin/notify/drain", authMiddleware, async (c) => {
  const stats = await drainOutbox(c.env.DB, c.env);
  return c.json({ ok: true, ...stats });
});

// ─── ADMIN: pipeline state ──────────────────────────────────
// `{ dry_run: false }` is the switch that takes the system live after a
// bootstrap run has been checked.
app.put("/api/admin/notify/settings", authMiddleware, async (c) => {
  let body = {};
  try {
    body = await c.req.json();
  } catch {}

  if (body.dry_run !== undefined) {
    await setSetting(c.env.DB, "dry_run", body.dry_run ? "true" : "false");
  }
  return c.json({
    ok: true,
    dry_run: await getSetting(c.env.DB, "dry_run"),
    bootstrap_at: await getSetting(c.env.DB, "bootstrap_at"),
    last_push_sha: await getSetting(c.env.DB, "last_push_sha"),
  });
});

// ─── ADMIN: ingest a changelog by hand ──────────────────────
// The webhook path cannot be exercised from localhost — GitHub has no route to
// it — so this is the same ingest, triggered by an admin instead of by a push.
// Reads `url` from the body, else SITE_URL/changelog.json.
app.post("/api/admin/notify/ingest", authMiddleware, async (c) => {
  let body = {};
  try {
    body = await c.req.json();
  } catch {}

  const url =
    body.url ||
    (c.env.SITE_URL ? `${String(c.env.SITE_URL).replace(/\/+$/, "")}/changelog.json` : null);
  if (!url) return c.json({ error: "No url given and SITE_URL is unset" }, 400);

  let entries;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "redefine-x-backend-worker" } });
    if (!res.ok) return c.json({ error: `Fetch failed: ${res.status}`, url }, 502);
    const data = await res.json();
    entries = data && data.entries;
    if (!Array.isArray(entries)) return c.json({ error: "No entries array", url }, 422);
  } catch (e) {
    return c.json({ error: String(e && e.message ? e.message : e), url }, 502);
  }

  const result = await ingestEntries(c.env.DB, c.env, entries, { source: "manual" });
  return c.json({ ok: true, url, ...result });
});

// ─── ADMIN: why is nothing arriving? ────────────────────────
// One request that answers the question the whole pipeline makes hard: a push
// that never shows up looks identical whether the keys are wrong, the queue is
// empty, the audience excluded you, or the cron never ran. This checks each of
// those and names the ones that are actually blocking delivery.
app.get("/api/admin/notify/diagnose", authMiddleware, async (c) => {
  const admin = c.get("admin");
  const db = c.env.DB;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const one = async (sql, ...bind) => {
    try {
      const row = await db.prepare(sql).bind(...bind).first();
      return row ? Object.values(row)[0] : null;
    } catch (e) {
      return `error: ${e && e.message ? e.message : e}`;
    }
  };

  const vapid = await checkVapidKeys(c.env);

  const followers = await one(`SELECT COUNT(*) FROM followers`);
  const devices = await one(`SELECT COUNT(*) FROM push_devices`);
  const myDevices = await one(
    `SELECT COUNT(*) FROM push_devices WHERE github_id = ?1`,
    admin.id
  );
  const iFollow = await one(`SELECT COUNT(*) FROM followers WHERE github_id = ?1`, admin.id);
  const myTopics = await one(`SELECT topics FROM followers WHERE github_id = ?1`, admin.id);

  const pendingDue = await one(
    `SELECT COUNT(*) FROM outbox WHERE state = 'pending' AND not_before <= ?1`,
    now
  );
  const pendingLater = await one(
    `SELECT COUNT(*) FROM outbox WHERE state = 'pending' AND not_before > ?1`,
    now
  );
  const nextDue = await one(
    `SELECT MIN(not_before) FROM outbox WHERE state = 'pending' AND not_before > ?1`,
    now
  );
  const sent = await one(`SELECT COUNT(*) FROM outbox WHERE state = 'sent'`);
  const dead = await one(`SELECT COUNT(*) FROM outbox WHERE state = 'dead'`);
  const lastError = await one(
    `SELECT last_error FROM outbox WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1`
  );
  const notifications = await one(`SELECT COUNT(*) FROM notifications`);

  const dryRun = await isDryRun(db, c.env);
  const bootstrapAt = await getSetting(db, "bootstrap_at");

  // Everything that would stop a push from reaching THIS admin, in the order it
  // would bite. Empty means the pipeline is clear and the problem is elsewhere
  // (browser permission, or the notification simply not created yet).
  const blockers = [];
  if (!vapid.ok) blockers.push(`VAPID keys: ${vapid.pair} (public ${vapid.publicKey}, private ${vapid.privateKey})`);
  if (!c.env.SESSION_SECRET) blockers.push("SESSION_SECRET is unset — nobody can authenticate");
  if (dryRun) blockers.push("dry run is ON — notifications are recorded but never queued or sent");
  if (!iFollow) blockers.push("you are not a follower in THIS database — click Follow on the site that talks to this Worker");
  if (!myDevices) blockers.push("you have no push device registered here — the browser never subscribed, or subscribed against the other Worker");
  if (String(c.env.NOTIFY_SELF || "") !== "true") {
    blockers.push(
      "NOTIFY_SELF is false — you are excluded from notifications YOU trigger (posting a note, broadcasting). Others still receive them; set NOTIFY_SELF=true to include yourself while testing."
    );
  }
  if (pendingDue > 0) {
    blockers.push(
      `${pendingDue} push(es) are queued and due but unsent — nothing drained them. wrangler dev does NOT fire cron: call POST /api/admin/notify/drain.`
    );
  }
  if (pendingDue === 0 && pendingLater > 0) {
    blockers.push(
      `${pendingLater} push(es) are queued but not due until ${nextDue} (NOTIFY_GRACE_SEC=${c.env.NOTIFY_GRACE_SEC ?? "120"}). Set NOTIFY_GRACE_SEC=0 locally.`
    );
  }

  return c.json({
    worker: {
      site_url: c.env.SITE_URL || null,
      allowed_origin: c.env.ALLOWED_ORIGIN || "*",
      request_origin: c.req.header("Origin") || null,
      allow_localhost_admin: String(c.env.ALLOW_LOCALHOST_ADMIN || "false"),
      notify_self: String(c.env.NOTIFY_SELF || "false"),
      notify_on_note: String(c.env.NOTIFY_ON_NOTE || "true"),
      notify_grace_sec: String(c.env.NOTIFY_GRACE_SEC ?? "120"),
      dry_run: dryRun,
      bootstrap_at: bootstrapAt,
    },
    vapid,
    you: {
      github_id: admin.id,
      login: admin.login,
      following: !!iFollow,
      topics: myTopics === null ? null : myTopics === "" ? "(all)" : myTopics,
      devices: myDevices,
    },
    totals: { followers, devices, notifications, sent, dead, pendingDue, pendingLater },
    last_error: lastError,
    blockers,
    verdict: blockers.length ? "delivery is blocked — see blockers" : "pipeline looks clear",
  });
});

// ─── ADMIN: send a test push to your own devices ────────────
// Bypasses ingest entirely, so it proves the VAPID keys and the aes128gcm
// encryption in isolation before any of the pipeline depends on them.
app.post("/api/admin/notify/test", authMiddleware, async (c) => {
  const admin = c.get("admin");
  const { results: devices } = await c.env.DB
    .prepare(`SELECT endpoint, p256dh, auth FROM push_devices WHERE github_id = ?1`)
    .bind(admin.id)
    .all();

  if (!devices || devices.length === 0) {
    return c.json(
      {
        error: "No push devices registered for this account in THIS database",
        hint: "Follow the blog from a page pointed at this Worker. A device registered against the other Worker does not exist here.",
      },
      404
    );
  }

  const out = [];
  for (const d of devices) {
    let res;
    try {
      res = await sendWebPush(
        d,
        {
          id: "test",
          title: "Test notification",
          body: "If you can read this, Web Push is working.",
          url: c.env.SITE_URL || "/",
          tag: "test",
        },
        c.env
      );
    } catch (e) {
      // A configuration fault, not a delivery failure. Report it as such rather
      // than letting it surface as an opaque 500.
      return c.json(
        {
          error: "Push configuration is broken",
          detail: String(e && e.message ? e.message : e),
          hint: "GET /api/admin/notify/diagnose checks the VAPID pair.",
        },
        500
      );
    }
    out.push({ endpoint: d.endpoint.slice(0, 60) + "…", ...res });
  }
  return c.json({ ok: out.every((r) => r.ok), results: out });
});

// ─── WEBHOOK: GitHub push on the deploy repo ────────────────
// The only route the backend acts on without a human. Authenticated by HMAC over
// the raw body; the changelog is then read at the pushed SHA so what we ingest
// is exactly what that push produced.
app.post("/api/hooks/github", async (c) => {
  const raw = await c.req.text();

  const ok = await verifySignature(
    raw,
    c.req.header("X-Hub-Signature-256"),
    c.env.GITHUB_WEBHOOK_SECRET
  );
  if (!ok) return c.json({ error: "Bad signature" }, 401);

  const event = c.req.header("X-GitHub-Event");
  if (event === "ping") return c.json({ ok: true, pong: true });
  if (event !== "push") return c.json({ ok: true, ignored: event });

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: "Bad payload" }, 400);
  }
  if (!isRelevantPush(payload, c.env)) {
    return c.json({ ok: true, ignored: "ref" });
  }

  const repo =
    (payload.repository && payload.repository.full_name) || c.env.DEPLOY_REPO || "";
  const sha = payload.after;

  const changelog = await fetchChangelog(repo, sha, c.env);
  if (!changelog) return c.json({ error: "changelog.json not reachable" }, 502);

  const db = c.env.DB;

  // Bootstrap guard. The first push a fresh database ever sees is recorded as
  // already-delivered, because the changelog on that push describes the whole
  // back catalogue and nobody asked to be told about all of it at once.
  const bootstrapped = await getSetting(db, "bootstrap_at");
  if (!bootstrapped) {
    await setSetting(db, "dry_run", "true");
  }

  const result = await ingestEntries(db, c.env, changelog.data.entries, {
    source: "changelog",
  });

  if (!bootstrapped) {
    await setSetting(db, "bootstrap_at", new Date().toISOString());
    await setSetting(db, "dry_run", "false");
  }
  await setSetting(db, "last_push_sha", sha);

  return c.json({
    ok: true,
    source: changelog.url,
    bootstrap: !bootstrapped,
    ...result,
  });
});

// ─── Health root (no front-end; just a liveness probe) ─────
app.get("/", (c) => {
  return c.json({ service: "redefine-x backend worker", ok: true });
});

/**
 * Cron entry point — the sending half of the pipeline.
 *
 * Ingest queues; this drains. Keeping them apart is what bounds a fan-out: no
 * single request ever has to make N subrequests, however many followers there
 * are. Runs every minute (see [triggers] in wrangler.toml).
 */
async function scheduled(event, env, ctx) {
  const stats = await drainOutbox(env.DB, env);
  // Prune on the hour rather than every tick — it is maintenance, not delivery,
  // and it competes with sending for the same invocation budget.
  if (new Date().getUTCMinutes() === 0) {
    await pruneOutbox(env.DB);
  }
  console.log("[notify] drain", JSON.stringify(stats));
}

export default { fetch: app.fetch, scheduled };
