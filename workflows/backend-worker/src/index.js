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
 *
 * ─── configuration ──────────────────────────────────────────
 * Seven values, no more, and nothing here reads anything else off `env`:
 *
 *   ADMIN_LOGINS          who gets the isAdmin claim
 *   ALLOWED_ORIGIN        the CORS allowlist (kept in the dashboard, so it can
 *                         be edited without a redeploy)
 *   SITE_URL              the site this backend belongs to — the ONE place a URL
 *                         comes from, for the changelog fallback, a note's click
 *                         target, and the VAPID `sub` claim
 *   VAPID_PUBLIC_KEY      shipped to every subscribing browser; not a secret
 *   VAPID_PRIVATE_KEY     secret
 *   SESSION_SECRET        secret — signs the session tokens
 *   GITHUB_WEBHOOK_SECRET secret — authenticates the deployment webhook
 *
 * Everything that used to be a feature flag is now simply how the Worker
 * behaves. A flag whose only correct value is "on" is not configuration, it is
 * a second code path that nobody exercises.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { fetchGitHubUser, isAdminUser, signSession, verifySession } from "./auth.js";
import { ingestEntries, drainOutbox, pruneOutbox, INLINE_BATCH } from "./notify.js";
import { verifySignature, fetchChangelog, isLiveDeployment } from "./hooks.js";
import { sendWebPush, checkVapidKeys } from "./webpush.js";

const app = new Hono();

// Session TTL for the minted session token (2 hours).
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// How many inbox rows one request returns.
const INBOX_LIMIT = 30;

// Title shown for a note notification; the note's own text becomes the body.
const NOTE_TITLE = "New note";

// All notes share one tray tag, so an unread note in the OS tray is REPLACED by
// the next one rather than stacking. Notes are ephemeral (the public API only
// returns the last 48h) and a pile of them is noise by the time anyone looks.
const NOTE_TAG = "notes";

/**
 * Run work after the response has gone out.
 *
 * Sending is the slow half of every write path here, and none of it changes what
 * the caller is told — the durable rows are already committed by the time this
 * is reached. GitHub in particular gives a webhook ten seconds before it calls
 * the delivery failed, which is not a budget worth spending on push traffic.
 */
function background(c, promise) {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    // No execution context (direct invocation in a test): let it run detached.
  }
}

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
 * Decide the Access-Control-Allow-Origin for a request. Null means "no origin is
 * permitted to read this response".
 *
 * ALLOWED_ORIGIN is AUTHORITATIVE — there is no built-in exception for
 * localhost. It is deliberately NOT declared in wrangler.toml, so it can be
 * edited in the Cloudflare dashboard and take effect without a redeploy. Unset,
 * it falls back to the SITE_URL domain; with BOTH unset the answer is nobody.
 * A misconfiguration must fail closed — an empty allowlist that meant `*` would
 * be a wildcard nobody chose, produced by the very mistake it should catch.
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
  const allowed =
    configured == null || configured === "" ? hostOf(env.SITE_URL) : configured;
  if (!allowed) return null;
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

async function proxyToGiscus(c) {
  // The SAME resolver the JSON API uses. These routes used to fall back to `*`
  // when ALLOWED_ORIGIN was unset while the API fell back to SITE_URL, which
  // meant one blanked dashboard field opened the proxy to the whole web.
  const origin = resolveOrigin(c.req.header("Origin") || "", c.env);
  const corsHeaders = {
    // No match: answer with the site's own origin, which the browser will reject
    // for anyone else. Never echo back an origin we did not allow.
    "Access-Control-Allow-Origin": origin || hostOf(c.env.SITE_URL) || "null",
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
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { results } = await c.env.DB.prepare(
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

// ─── Auth middleware ────────────────────────────────────────
// Both middlewares verify the SAME HMAC session token locally — no GitHub
// round-trip per request. They differ only in what they require of the payload.
const authMiddleware = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const session = await verifySession(authHeader.slice(7), c.env.SESSION_SECRET);
  if (!session || !session.isAdmin) return c.json({ error: "Invalid credentials" }, 403);

  c.set("admin", session);
  await next();
};

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
  if (!session || !session.id) return c.json({ error: "Invalid credentials" }, 403);

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
  const { results } = await c.env.DB.prepare(
    `SELECT id, text, emoji, color, created_at, updated_at
       FROM notes
      ORDER BY created_at DESC
      LIMIT 50`
  ).all();
  return c.json(results || []);
});

// ─── ADMIN API: Create note ────────────────────────────────
// Creating a note also announces it, on the `notes` topic. Only creation does —
// editing a note is a correction, not news, and re-alerting for a typo fix is
// how a notification channel teaches people to mute it. `notify: false` in the
// request opts one note out.
app.post("/api/admin/notes", authMiddleware, async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad request" }, 400);
  }
  const { text, emoji, color } = body;
  if (!text || text.length === 0) return c.json({ error: "Text is required" }, 400);
  if (text.length > 200) return c.json({ error: "Text too long (max 200 chars)" }, 400);

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
  let notification = null;

  if (body.notify !== false) {
    notification = await ingestEntries(
      db,
      c.env,
      [
        {
          id: `note:${id}`,
          type: "note",
          topic: "notes",
          title: NOTE_TITLE,
          body: `${emoji ? emoji + " " : ""}${text}`,
          url: c.env.SITE_URL || "/",
          tag: NOTE_TAG,
        },
      ],
      { source: "note" }
    );
    background(c, drainOutbox(db, c.env, INLINE_BATCH));
  }

  return c.json({ ok: true, id, notification }, 201);
});

// ─── ADMIN API: Update note ────────────────────────────────
app.put("/api/admin/notes/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const { text, emoji, color } = await c.req.json();
  if (!text || text.length === 0) return c.json({ error: "Text is required" }, 400);
  if (text.length > 200) return c.json({ error: "Text too long (max 200 chars)" }, 400);

  await c.env.DB.prepare(
    `UPDATE notes SET text = ?1, emoji = ?2, color = ?3, updated_at = ?4 WHERE id = ?5`
  )
    .bind(text, emoji || "", color || "default", new Date().toISOString(), id)
    .run();

  return c.json({ ok: true });
});

// ─── ADMIN API: Delete note ────────────────────────────────
app.delete("/api/admin/notes/:id", authMiddleware, async (c) => {
  await c.env.DB.prepare(`DELETE FROM notes WHERE id = ?1`).bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════════════════════════

/**
 * Create or refresh the follower row for the signed-in user.
 * Following is implied by any of the follow actions — there is no separate
 * "follow" button to get out of sync with the subscription state.
 */
function upsertFollower(db, session, topics) {
  return db
    .prepare(
      `INSERT INTO followers (github_id, login, avatar, topics)
       VALUES (?1, ?2, '', ?3)
       ON CONFLICT(github_id) DO UPDATE SET
         login  = excluded.login,
         topics = COALESCE(?4, followers.topics)`
    )
    .bind(
      session.id,
      session.login || "",
      topics == null ? "" : String(topics),
      topics == null ? null : String(topics)
    );
}

// ─── PUBLIC: the VAPID application server key ───────────────
// Public by definition — every subscribing browser is given this key. Exposed as
// an endpoint so the front-end can work even if the theme config has not been
// filled in yet.
app.get("/api/push/vapid-key", (c) => c.json({ key: c.env.VAPID_PUBLIC_KEY || null }));

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
  // Following and subscribing are one action, so they are one round trip. The
  // endpoint is the identity of a subscription: re-subscribing the same browser
  // (a key rotation, a reinstall) rewrites the keys and clears the failure count
  // rather than adding a second row that will never work.
  await db.batch([
    upsertFollower(db, session, body.topics),
    db
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
      ),
  ]);

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
// Returns everything the notification panel paints in ONE round trip: the items,
// the badge count, the device count and the follow state. The panel used to ask
// for the last two separately, which cost a second HTTP request and three more
// queries to render exactly the same view.
app.get("/api/me/notifications", userMiddleware, async (c) => {
  const session = c.get("user");
  const db = c.env.DB;

  const [items, counts, follower] = await db.batch([
    db
      .prepare(
        `SELECT n.id, n.type, n.topic, n.title, n.body, n.url, n.image,
                n.published_at, d.read_at
           FROM deliveries d
           JOIN notifications n ON n.id = d.notification_id
          WHERE d.github_id = ?1
          ORDER BY n.published_at DESC
          LIMIT ?2`
      )
      .bind(session.id, INBOX_LIMIT),
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM deliveries
                  WHERE github_id = ?1 AND read_at IS NULL) AS unread,
                (SELECT COUNT(*) FROM push_devices WHERE github_id = ?1) AS devices`
      )
      .bind(session.id),
    db
      .prepare(`SELECT topics, muted_until FROM followers WHERE github_id = ?1`)
      .bind(session.id),
  ]);

  const totals = (counts.results && counts.results[0]) || { unread: 0, devices: 0 };
  const row = follower.results && follower.results[0];

  return c.json({
    items: items.results || [],
    unread: totals.unread || 0,
    devices: totals.devices || 0,
    following: !!row,
    topics: row ? row.topics : "",
    muted_until: row ? row.muted_until : null,
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
    // Bounded by D1's 100-parameter ceiling, two of which are already spoken for.
    const ids = body.ids.slice(0, 90).map(String);
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
  const db = c.env.DB;

  const [follower, devices] = await db.batch([
    db
      .prepare(`SELECT topics, muted_until, created_at FROM followers WHERE github_id = ?1`)
      .bind(session.id),
    db
      .prepare(
        `SELECT id, ua, created_at, last_ok_at FROM push_devices WHERE github_id = ?1`
      )
      .bind(session.id),
  ]);

  const row = follower.results && follower.results[0];
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

  const statements = [upsertFollower(db, session, body.topics == null ? "" : body.topics)];
  if (body.muted_until !== undefined) {
    statements.push(
      db
        .prepare(`UPDATE followers SET muted_until = ?1 WHERE github_id = ?2`)
        .bind(body.muted_until ? String(body.muted_until) : null, session.id)
    );
  }
  await db.batch(statements);

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
    return c.json(
      { error: "No new entries (missing id/title/url, or already sent)", ...result },
      400
    );
  }

  background(c, drainOutbox(c.env.DB, c.env, INLINE_BATCH));
  return c.json({ ok: true, ...result }, 201);
});

// ─── ADMIN: notification history + delivery stats ───────────
// The counts come from two pre-aggregated joins rather than five correlated
// subqueries per row: the old shape re-scanned `deliveries` and `outbox` 250
// times to render 50 lines.
app.get("/api/admin/notifications", authMiddleware, async (c) => {
  const db = c.env.DB;

  const [history, totals] = await db.batch([
    db.prepare(
      `WITH recent AS (
         SELECT id, type, topic, title, url, source, published_at
           FROM notifications
          ORDER BY published_at DESC
          LIMIT 50
       )
       SELECT r.id, r.type, r.topic, r.title, r.url, r.source, r.published_at,
              COALESCE(d.recipients, 0) AS recipients,
              COALESCE(d.seen, 0)       AS read,
              COALESCE(o.sent, 0)       AS pushed,
              COALESCE(o.pending, 0)    AS pending,
              COALESCE(o.dead, 0)       AS failed
         FROM recent r
         LEFT JOIN (
              SELECT notification_id,
                     COUNT(*)                        AS recipients,
                     SUM(read_at IS NOT NULL)        AS seen
                FROM deliveries
               WHERE notification_id IN (SELECT id FROM recent)
               GROUP BY notification_id
         ) d ON d.notification_id = r.id
         LEFT JOIN (
              SELECT notification_id,
                     SUM(state = 'sent')    AS sent,
                     SUM(state = 'pending') AS pending,
                     SUM(state = 'dead')    AS dead
                FROM outbox
               WHERE notification_id IN (SELECT id FROM recent)
               GROUP BY notification_id
         ) o ON o.notification_id = r.id
        ORDER BY r.published_at DESC`
    ),
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM followers)    AS followers,
              (SELECT COUNT(*) FROM push_devices) AS devices`
    ),
  ]);

  const counts = (totals.results && totals.results[0]) || { followers: 0, devices: 0 };
  return c.json({
    items: history.results || [],
    followers: counts.followers || 0,
    devices: counts.devices || 0,
  });
});

// ─── ADMIN: resend an existing notification ─────────────────
// The deliberate override of the dedupe rule. Ingest refuses to resend because
// nearly every repeat is accidental; this route exists so the rare intentional
// one does not require touching the database by hand.
app.post("/api/admin/notifications/:id/resend", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;

  // Re-queue every device belonging to someone already in this notification's
  // inbox — the audience is fixed at ingest, so a resend cannot widen it. The
  // whole thing is one round trip: the existence check rides along with the
  // requeue so that "unknown id" and "nobody left to send to" stay
  // distinguishable, which a bare row count could not do.
  const [known, requeued] = await db.batch([
    db.prepare(`SELECT 1 AS found FROM notifications WHERE id = ?1`).bind(id),
    db
      .prepare(
        `INSERT INTO outbox (notification_id, device_id, not_before, state, attempts)
         SELECT ?1, p.id, ?2, 'pending', 0
           FROM push_devices p
          WHERE p.github_id IN (SELECT github_id FROM deliveries WHERE notification_id = ?1)
         ON CONFLICT(notification_id, device_id) DO UPDATE SET
           state = 'pending', attempts = 0, not_before = ?2, last_error = NULL`
      )
      .bind(id, new Date().toISOString().replace(/\.\d{3}Z$/, "Z")),
  ]);

  if (!known.results || known.results.length === 0) {
    return c.json({ error: "Unknown notification" }, 404);
  }

  const queued = (requeued.meta && requeued.meta.changes) || 0;
  if (queued > 0) background(c, drainOutbox(db, c.env, INLINE_BATCH));

  return c.json({ ok: true, queued });
});

// ─── ADMIN: drain the queue now ─────────────────────────────
// The cron does this every five minutes; this is the same call for a human who
// does not want to wait for the next tick while testing.
app.post("/api/admin/notify/drain", authMiddleware, async (c) => {
  const stats = await drainOutbox(c.env.DB, c.env);
  return c.json({ ok: true, ...stats });
});

// ─── ADMIN: ingest a changelog by hand ──────────────────────
// The webhook path cannot be exercised from localhost — GitHub has no route to
// it — so this is the same ingest, triggered by an admin instead of by a
// deployment. Reads `url` from the body, else SITE_URL/changelog.json.
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
  background(c, drainOutbox(c.env.DB, c.env, INLINE_BATCH));
  return c.json({ ok: true, url, ...result });
});

// ─── ADMIN: why is nothing arriving? ────────────────────────
// One request that answers the question the whole pipeline makes hard: a push
// that never shows up looks identical whether the keys are wrong, the queue is
// empty, or nothing has drained it. This checks each of those in a single round
// trip and names the ones that are actually blocking delivery.
app.get("/api/admin/notify/diagnose", authMiddleware, async (c) => {
  const admin = c.get("admin");
  const db = c.env.DB;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const vapid = await checkVapidKeys(c.env);

  const [overview, mine, queue, lastError] = await db.batch([
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM followers)     AS followers,
              (SELECT COUNT(*) FROM push_devices)  AS devices,
              (SELECT COUNT(*) FROM notifications) AS notifications`
    ),
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM push_devices WHERE github_id = ?1) AS devices,
                (SELECT COUNT(*) FROM followers    WHERE github_id = ?1) AS following,
                (SELECT topics    FROM followers   WHERE github_id = ?1) AS topics`
      )
      .bind(admin.id),
    db
      .prepare(
        `SELECT SUM(state = 'pending' AND not_before <= ?1) AS due,
                SUM(state = 'pending' AND not_before >  ?1) AS later,
                SUM(state = 'sent')                         AS sent,
                SUM(state = 'dead')                         AS dead
           FROM outbox`
      )
      .bind(now),
    db.prepare(
      `SELECT last_error FROM outbox
        WHERE last_error IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`
    ),
  ]);

  const totals = (overview.results && overview.results[0]) || {};
  const you = (mine.results && mine.results[0]) || {};
  const pending = (queue.results && queue.results[0]) || {};

  // Everything that would stop a push from reaching THIS admin, in the order it
  // would bite. Empty means the pipeline is clear and the problem is elsewhere
  // (browser permission, or the notification simply not created yet).
  const blockers = [];
  if (!vapid.ok) {
    blockers.push(
      `VAPID keys: ${vapid.pair} (public ${vapid.publicKey}, private ${vapid.privateKey})`
    );
  }
  if (!c.env.SESSION_SECRET) blockers.push("SESSION_SECRET is unset — nobody can authenticate");
  if (!c.env.SITE_URL) blockers.push("SITE_URL is unset — notifications have nowhere to link");
  if (!you.following) {
    blockers.push(
      "you are not a follower in THIS database — click Follow on the site that talks to this Worker"
    );
  }
  if (!you.devices) {
    blockers.push(
      "you have no push device registered here — the browser never subscribed, or subscribed against the other Worker"
    );
  }
  if (pending.due > 0) {
    blockers.push(
      `${pending.due} push(es) are queued and due but unsent — nothing drained them. wrangler dev does NOT fire cron: call POST /api/admin/notify/drain.`
    );
  }

  return c.json({
    worker: {
      site_url: c.env.SITE_URL || null,
      allowed_origin: c.env.ALLOWED_ORIGIN || null,
      request_origin: c.req.header("Origin") || null,
    },
    vapid,
    you: {
      github_id: admin.id,
      login: admin.login,
      following: !!you.following,
      topics: you.topics == null ? null : you.topics === "" ? "(all)" : you.topics,
      devices: you.devices || 0,
    },
    totals: {
      followers: totals.followers || 0,
      devices: totals.devices || 0,
      notifications: totals.notifications || 0,
      sent: pending.sent || 0,
      dead: pending.dead || 0,
      pendingDue: pending.due || 0,
      pendingLater: pending.later || 0,
    },
    last_error: (lastError.results && lastError.results[0] && lastError.results[0].last_error) || null,
    blockers,
    verdict: blockers.length ? "delivery is blocked — see blockers" : "pipeline looks clear",
  });
});

// ─── ADMIN: send a test push to your own devices ────────────
// Bypasses ingest entirely, so it proves the VAPID keys and the aes128gcm
// encryption in isolation before any of the pipeline depends on them.
app.post("/api/admin/notify/test", authMiddleware, async (c) => {
  const admin = c.get("admin");
  const { results: devices } = await c.env.DB.prepare(
    `SELECT endpoint, p256dh, auth FROM push_devices WHERE github_id = ?1`
  )
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

// ─── WEBHOOK: the deploy repo finished deploying ────────────
// The only route the backend acts on without a human. Authenticated by HMAC over
// the raw body; the changelog is then read at the deployed SHA so what we ingest
// is exactly what that deployment published.
//
// GitHub abandons a webhook delivery after ten seconds, so the response goes out
// as soon as the durable writes land and the pushes follow in the background.
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
  if (event !== "deployment_status") return c.json({ ok: true, ignored: event });

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: "Bad payload" }, 400);
  }
  if (!isLiveDeployment(payload)) {
    return c.json({
      ok: true,
      ignored: payload.deployment_status ? payload.deployment_status.state : "malformed",
    });
  }

  const repo = (payload.repository && payload.repository.full_name) || "";
  const sha = payload.deployment.sha;

  const changelog = await fetchChangelog(repo, sha, c.env);
  if (!changelog) return c.json({ error: "changelog.json not reachable" }, 502);

  const result = await ingestEntries(c.env.DB, c.env, changelog.data.entries, {
    source: "changelog",
  });

  background(c, drainOutbox(c.env.DB, c.env, INLINE_BATCH));
  return c.json({ ok: true, source: changelog.url, sha, ...result });
});

// ─── Health root (no front-end; just a liveness probe) ─────
app.get("/", (c) => c.json({ service: "redefine-x backend worker", ok: true }));

/**
 * Cron entry point — the sending half of the pipeline.
 *
 * Ingest already drains the first batch itself, so this is not the fast path; it
 * is what carries a fan-out larger than one invocation can send, and what
 * retries a push service that was down when the notification was created. Every
 * five minutes (see [triggers] in wrangler.toml) — often enough that a backlog
 * clears in minutes, rare enough that an idle queue costs 288 indexed SELECTs a
 * day instead of 1,440.
 */
async function scheduled(event, env, ctx) {
  const stats = await drainOutbox(env.DB, env);

  // Pruning is maintenance, not delivery, and it competes with sending for the
  // same invocation budget. Once a day, at a quiet hour, is plenty.
  const now = new Date();
  if (now.getUTCHours() === 3 && now.getUTCMinutes() < 5) {
    ctx.waitUntil(pruneOutbox(env.DB));
  }

  console.log("[notify] drain", JSON.stringify(stats));
}

export default { fetch: app.fetch, scheduled };
