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
 *                            producer half of the Queues-based push pipeline.
 *                            The consumer half is the `queue` export at the
 *                            bottom of this file; see src/notify.js.
 * Admin writes are authorized ONLY by an isAdmin HMAC session; follower routes
 * take any valid session.
 *
 * ─── configuration ──────────────────────────────────────────
 * Eight values, no more, and nothing here reads anything else off `env`:
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
 *   VAULT_MASTER          secret — unwraps the per-post keys in `vault_posts`.
 *                         Must be byte-identical to the build machine's .env.
 *
 * Everything that used to be a feature flag is now simply how the Worker
 * behaves. A flag whose only correct value is "on" is not configuration, it is
 * a second code path that nobody exercises.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { fetchGitHubUser, isAdminUser, signSession, verifySession } from "./auth.js";
import {
  ingestEntries,
  fanOut,
  consumeBatch,
  pruneInboxes,
  deleteNotification,
  BODY_MAX,
} from "./notify.js";
import { verifySignature, fetchChangelog, isLiveDeployment } from "./hooks.js";
import { grantedPosts, listPosts, registerPost, deletePost, setAudience } from "./vault.js";
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

// What a subscribing browser is allowed to call itself. An allowlist rather than
// a length cap because this string is rendered as an icon name by the panel, and
// the set it can choose from is closed.
const DEVICE_CLASSES = new Set(["laptop", "desktop", "mobile", "tablet"]);

// Enough of an endpoint for a browser to recognise its OWN subscription in the
// device list, and not enough to be one. Push endpoints are bearer URLs — whoever
// holds one can send to it — so the full string never leaves the database.
const ENDPOINT_TAIL = 18;

// Rows per page on the management screens. Followers carry their devices in a
// second statement bound by D1's 100-parameter ceiling, so this is also the
// widest IN () list either query builds.
const ADMIN_PAGE = 20;

// What `?type=` on the notification history may filter by. A closed set, because
// the value is interpolated into nothing but a bound parameter and an unknown
// one should read as "no filter" rather than as an empty result.
const NOTIFICATION_TYPES = new Set(["announcement", "post", "note"]);

// The three moderation states. Anything else is rejected outright rather than
// stored — an unknown state would silently mean "not moderated" everywhere.
const MODERATION_STATES = new Set(["", "muted", "banned"]);

// Topics that can carry a global blocklist. The same three the reader sees as
// delivery switches.
const BLOCKLIST_TOPICS = new Set(["posts", "notes", "announcements"]);

// Identities one lookup may resolve. Bounded by D1's 100-parameter ceiling, and
// by MAX_EXPLICIT_USERS in notify.js — an audience larger than the fan-out can
// actually bind would validate and then silently under-deliver.
const ADMIN_LOOKUP_MAX = 80;

// A `background()` helper used to live here, deferring push sending past the
// response with waitUntil. Nothing needs it any more: handing a fan-out to the
// queue is three D1 round trips and one sendBatch, with no crypto and no calls
// to push services in the request path at all. The slow half now happens in a
// different invocation entirely, which is the point of the queue.

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
app.use("/api/vault/*", apiCors);
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
    // `name` rides along so that upserting a follower — which happens on routes
    // that never see GitHub — can store the display name without a second call.
    token = await signSession(
      { id: user.id, login: user.login, name: user.name || "", isAdmin, exp },
      c.env.SESSION_SECRET
    );
  }

  return c.json({
    id: user.id,
    login: user.login,
    name: user.name || "",
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
 *
 * The INSERT ... SELECT form exists for the WHERE: a banned identity must not be
 * able to re-create its own follower row, and doing that check inside the
 * statement costs nothing, where a preceding SELECT would cost a round trip on
 * every subscribe.
 */
function upsertFollower(db, session, topics) {
  return db
    .prepare(
      `INSERT INTO followers (github_id, login, name, avatar, topics)
       SELECT ?1, ?2, ?3, '', ?4
        WHERE NOT EXISTS (SELECT 1 FROM moderation
                           WHERE github_id = ?1 AND state = 'banned')
       ON CONFLICT(github_id) DO UPDATE SET
         login  = excluded.login,
         name   = excluded.name,
         topics = COALESCE(?5, followers.topics)`
    )
    .bind(
      session.id,
      session.login || "",
      session.name || "",
      topics == null ? "" : String(topics),
      topics == null ? null : String(topics)
    );
}

/** SQL fragment: true when this identity is not banned. `?N` takes the id. */
const notBanned = (p) =>
  `NOT EXISTS (SELECT 1 FROM moderation WHERE github_id = ?${p} AND state = 'banned')`;

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
  // (a key rotation, a reinstall) rewrites the keys rather than adding a second
  // row that will never work.
  const [follower] = await db.batch([
    upsertFollower(db, session, body.topics),
    db
      .prepare(
        `INSERT INTO push_devices (github_id, endpoint, p256dh, auth, ua, device)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE ${notBanned(1)}
         ON CONFLICT(endpoint) DO UPDATE SET
           github_id = excluded.github_id,
           p256dh    = excluded.p256dh,
           auth      = excluded.auth,
           ua        = excluded.ua,
           -- A re-subscribe from a client too old to send this must not erase
           -- what an earlier one already worked out.
           device    = COALESCE(NULLIF(excluded.device, ''), push_devices.device)`
      )
      .bind(
        session.id,
        String(endpoint),
        String(p256dh),
        String(auth),
        String(c.req.header("User-Agent") || "").slice(0, 180),
        DEVICE_CLASSES.has(String(body.device)) ? String(body.device) : ""
      ),
  ]);

  // Nothing written means the guard inside the statement refused it, which is
  // the one reason it can refuse. Reported rather than swallowed so the panel
  // does not sit claiming to have subscribed a browser that received nothing.
  const wrote = (follower && follower.meta && follower.meta.changes) || 0;
  if (!wrote) return c.json({ error: "banned" }, 403);

  return c.json({ ok: true, following: true });
});

// ─── USER: unregister a push device ─────────────────────────
// Removes the device only. The follower row and the inbox survive, so the reader
// keeps their history and can re-subscribe without losing it. Leaving entirely
// is PUT /api/me/preferences { follow: false }.
//
// Three ways to name what to remove, all scoped to the caller's own id:
//   { endpoint } — this browser, which is the only one that knows its endpoint;
//   { id }       — a row from the reader's device list, revoked from elsewhere;
//   neither      — every device on the account.
app.delete("/api/push/subscribe", userMiddleware, async (c) => {
  const session = c.get("user");
  let body = {};
  try {
    body = await c.req.json();
  } catch {}

  const db = c.env.DB;
  // `state <> 'banned'` is the backend half of the hidden delete button. Without
  // it, a reader could revoke the banned row and simply re-subscribe the same
  // browser into a clean one — the ban would be a front-end suggestion.
  const keepBanned = `state <> 'banned' AND ${notBanned(2)}`;

  if (body && body.endpoint) {
    await db
      .prepare(`DELETE FROM push_devices WHERE endpoint = ?1 AND github_id = ?2 AND ${keepBanned}`)
      .bind(String(body.endpoint), session.id)
      .run();
  } else if (body && body.id != null) {
    // `github_id` in the WHERE is what makes a row id safe to accept from a
    // browser: the id space is global and guessable, so the scope is what stops
    // one reader revoking another's device.
    await db
      .prepare(`DELETE FROM push_devices WHERE id = ?1 AND github_id = ?2 AND ${keepBanned}`)
      .bind(Number(body.id) || 0, session.id)
      .run();
  } else {
    await db
      .prepare(`DELETE FROM push_devices WHERE github_id = ?1 AND state <> 'banned' AND ${notBanned(1)}`)
      .bind(session.id)
      .run();
  }
  return c.json({ ok: true });
});

// ─── USER: the in-site inbox ────────────────────────────────
// Returns everything BOTH pages of the notification panel paint, in ONE round
// trip: the items, the badge count, the follow state, the topic selection, and
// the reader's registered devices. The panel used to ask for those separately,
// which cost a second HTTP request and three more queries to render the same
// view — and the device list is very nearly free here, because the count it
// replaces already had to walk the same index.
app.get("/api/me/notifications", userMiddleware, async (c) => {
  const session = c.get("user");
  const db = c.env.DB;

  // All three read the reader's own row by primary key. The inbox arrives as
  // two JSON arrays on it, so the items cost one row plus one keyed lookup per
  // notification — where a (notification × follower) table cost an index walk
  // and a second row for every item on every panel open.
  const [items, meta, devices, moderated] = await db.batch([
    db
      .prepare(
        `SELECT n.id, n.type, n.topic, n.title, n.body, n.url, n.image,
                strftime('%Y-%m-%dT%H:%M:%SZ', j.value->>1, 'unixepoch') AS published_at,
                NULL AS read_at
           FROM followers f, json_each(f.unread) j
           JOIN notifications n ON n.id = j.value->>0
          WHERE f.github_id = ?1
          UNION ALL
         SELECT n.id, n.type, n.topic, n.title, n.body, n.url, n.image,
                strftime('%Y-%m-%dT%H:%M:%SZ', j.value->>1, 'unixepoch') AS published_at,
                strftime('%Y-%m-%dT%H:%M:%SZ', j.value->>2, 'unixepoch') AS read_at
           FROM followers f, json_each(f.seen) j
           JOIN notifications n ON n.id = j.value->>0
          WHERE f.github_id = ?1
          ORDER BY published_at DESC
          LIMIT ?2`
      )
      .bind(session.id, INBOX_LIMIT),
    // The badge is a scalar off the same row — no json_each, no counting.
    db
      .prepare(
        `SELECT json_array_length(f.unread) AS unread, f.topics, f.muted_until
           FROM followers f
          WHERE f.github_id = ?1`
      )
      .bind(session.id),
    // Browser and OS are parsed from `ua` in the panel rather than here: the
    // strings are long, the rules change often, and a Worker invocation has ten
    // milliseconds to spend on things only it can do. A muted device is reported
    // as ordinary — that is what makes muting silent.
    db
      .prepare(
        `SELECT id, ua, device, created_at,
                CASE WHEN state = 'banned' THEN 1 ELSE 0 END AS banned,
                substr(endpoint, -${ENDPOINT_TAIL}) AS tail
           FROM push_devices
          WHERE github_id = ?1
          ORDER BY created_at DESC`
      )
      .bind(session.id),
    // Keyed at a table that only holds moderated identities, so it costs one row
    // and usually none. Asked separately from the follower row because a banned
    // reader who has unfollowed HAS no follower row, and must still be told.
    // This route stays readable to them precisely so the panel can say so; every
    // write route refuses.
    db
      .prepare(`SELECT state FROM moderation WHERE github_id = ?1`)
      .bind(session.id),
  ]);

  const row = meta.results && meta.results[0];
  const flag = moderated.results && moderated.results[0];

  return c.json({
    items: items.results || [],
    unread: row ? row.unread || 0 : 0,
    devices: devices.results || [],
    following: !!row,
    banned: !!flag && flag.state === "banned",
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
  const stamp = Math.floor(Date.now() / 1000);

  // Reading moves an entry from one array to the other and stamps it with the
  // moment it was read — which is what the 14-day retention counts from. Both
  // shapes below are ONE statement writing ONE row: the whole operation costs
  // the reader's own row, whether they marked one item or thirty.
  if (body && Array.isArray(body.ids) && body.ids.length > 0) {
    // Bounded by D1's 100-parameter ceiling, two of which are already spoken for.
    const ids = body.ids.slice(0, 90).map(String);
    const list = ids.map((_, i) => `?${i + 3}`).join(", ");
    await db
      .prepare(
        `UPDATE followers
            SET unread = (SELECT COALESCE(json_group_array(json(j.value)), '[]')
                            FROM json_each(followers.unread) j
                           WHERE j.value->>0 NOT IN (${list})),
                seen   = (SELECT json_group_array(json(v)) FROM (
                            SELECT j.value AS v FROM json_each(followers.seen) j
                            UNION ALL
                            SELECT json_array(j.value->>0, j.value->>1, ?2)
                              FROM json_each(followers.unread) j
                             WHERE j.value->>0 IN (${list})))
          WHERE github_id = ?1 AND ${notBanned(1)}`
      )
      .bind(session.id, stamp, ...ids)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE followers
            SET seen   = (SELECT json_group_array(json(v)) FROM (
                            SELECT j.value AS v FROM json_each(followers.seen) j
                            UNION ALL
                            SELECT json_array(j.value->>0, j.value->>1, ?2)
                              FROM json_each(followers.unread) j)),
                unread = '[]'
          WHERE github_id = ?1 AND unread <> '[]' AND ${notBanned(1)}`
      )
      .bind(session.id, stamp)
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
        `SELECT id, ua, device, created_at, substr(endpoint, -${ENDPOINT_TAIL}) AS tail
           FROM push_devices WHERE github_id = ?1`
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
    // Two statements now, not three: the inbox lives on the follower row, so
    // deleting the reader deletes their history with them. Banned subscriptions
    // are the one thing left behind — see the DELETE route above for why — and
    // a banned identity cannot leave at all, because leaving would clear the
    // follower row the ban is enforced through on the way back in.
    await db.batch([
      db
        .prepare(
          `DELETE FROM push_devices WHERE github_id = ?1 AND state <> 'banned' AND ${notBanned(1)}`
        )
        .bind(session.id),
      db
        .prepare(`DELETE FROM followers WHERE github_id = ?1 AND ${notBanned(1)}`)
        .bind(session.id),
    ]);
    return c.json({ ok: true, following: false });
  }

  const statements = [upsertFollower(db, session, body.topics == null ? "" : body.topics)];
  if (body.muted_until !== undefined) {
    // Stored as a unix epoch. Accept either a number or a date string, so a
    // caller sending an ISO timestamp is not silently muted until 1970.
    let until = null;
    if (body.muted_until) {
      const raw = body.muted_until;
      const parsed = typeof raw === "number" ? raw : Math.floor(Date.parse(String(raw)) / 1000);
      if (Number.isFinite(parsed)) until = parsed;
    }
    statements.push(
      db
        .prepare(`UPDATE followers SET muted_until = ?1 WHERE github_id = ?2 AND ${notBanned(2)}`)
        .bind(until, session.id)
    );
  }
  await db.batch(statements);

  return c.json({ ok: true, following: true });
});

// ─── ADMIN: broadcast one notification by hand ──────────────
// The audience is resolved to real identities BEFORE ingest, purely so the
// receipt can say which ids matched. Delivery does not depend on it: an id that
// matches nobody is reported and then ignored, never a reason to refuse the
// whole send.
app.post("/api/admin/notifications", authMiddleware, async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad request" }, 400);
  }

  const entries = Array.isArray(body.entries) ? body.entries : [body];
  const named = [];
  for (const entry of entries) {
    const users = entry && entry.audience && entry.audience.users;
    if (Array.isArray(users)) named.push(...users);
  }

  const audience = named.length ? await resolveIdentities(c.env.DB, named) : null;
  const result = await ingestEntries(c.env.DB, c.env, entries, { source: "admin" });

  if (result.ingested.length === 0) {
    return c.json(
      { error: "No new entries (missing id/title/url, or already sent)", ...result },
      400
    );
  }

  return c.json({ ok: true, ...result, audience }, 201);
});

// ─── ADMIN: notification history + delivery stats ───────────
// A plain indexed read, paged. The recipient and device counts were written by
// the fan-out that produced them, so this no longer aggregates over join tables
// — which is the whole reason those tables could be deleted.
app.get("/api/admin/notifications", authMiddleware, async (c) => {
  const db = c.env.DB;
  const type = String(c.req.query("type") || "");
  const offset = Math.max(0, Number(c.req.query("cursor")) || 0);
  const wanted = NOTIFICATION_TYPES.has(type) ? type : "";

  // One extra row is fetched, never returned: its existence is the whole answer
  // to "is there a next page", and it costs less than a COUNT(*).
  const [history, totals] = await db.batch([
    db
      .prepare(
        `SELECT id, type, topic, title, body, url, image, tag, source, silent,
                audience_json, recipients, devices,
                strftime('%Y-%m-%dT%H:%M:%SZ', created_at, 'unixepoch') AS published_at
           FROM notifications
          WHERE ?1 = '' OR type = ?1
          ORDER BY created_at DESC
          LIMIT ?2 OFFSET ?3`
      )
      .bind(wanted, ADMIN_PAGE + 1, offset),
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM followers)    AS followers,
              (SELECT COUNT(*) FROM push_devices) AS devices`
    ),
  ]);

  const rows = history.results || [];
  const more = rows.length > ADMIN_PAGE;
  const counts = (totals.results && totals.results[0]) || { followers: 0, devices: 0 };

  return c.json({
    items: more ? rows.slice(0, ADMIN_PAGE) : rows,
    cursor: more ? offset + ADMIN_PAGE : null,
    followers: counts.followers || 0,
    devices: counts.devices || 0,
  });
});

// ─── ADMIN: edit one notification ───────────────────────────
// Corrects what the inbox shows from here on. It does NOT re-announce: the copy
// already in an OS notification tray cannot be recalled, and a second buzz for a
// fixed typo is how a channel teaches people to mute it.
app.put("/api/admin/notifications/:id", authMiddleware, async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad request" }, 400);
  }

  const title = String(body.title || "").trim();
  if (!title) return c.json({ error: "Title is required" }, 400);

  const result = await c.env.DB.prepare(
    `UPDATE notifications SET title = ?2, body = ?3, url = COALESCE(NULLIF(?4, ''), url)
      WHERE id = ?1`
  )
    .bind(
      c.req.param("id"),
      title.slice(0, 120),
      String(body.body || "").slice(0, BODY_MAX),
      String(body.url || "").trim()
    )
    .run();

  if (!(result.meta && result.meta.changes)) return c.json({ error: "Unknown notification" }, 404);
  return c.json({ ok: true });
});

// ─── ADMIN: delete one notification ─────────────────────────
app.delete("/api/admin/notifications/:id", authMiddleware, async (c) => {
  const stats = await deleteNotification(c.env.DB, c.req.param("id"));
  if (!stats.removed) return c.json({ error: "Unknown notification" }, 404);
  return c.json({ ok: true, ...stats });
});

// ════════════════════════════════════════════════════════════
// ADMIN — moderation
// ════════════════════════════════════════════════════════════

/** ADMIN_LOGINS as a list of bindable tokens (numeric ids and/or login names). */
function adminTokens(env) {
  return String(env.ADMIN_LOGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A SQL fragment that is FALSE for any admin identity, with its parameters.
 *
 * Written as SQL rather than as a JS check because the JS version would need a
 * round trip to learn the target's login first. This way "an admin cannot be
 * muted or banned" is a property of the statement itself.
 *
 * @param {string} idCol     column holding the numeric GitHub id
 * @param {string} loginExpr expression yielding the login for that row
 * @param {number} from      first free parameter number
 */
function notAdmin(env, idCol, loginExpr, from) {
  const tokens = adminTokens(env);
  if (tokens.length === 0) return { clause: "1", params: [] };
  const list = tokens.map((_, i) => `?${from + i}`).join(", ");
  return {
    clause: `CAST(${idCol} AS TEXT) NOT IN (${list}) AND ${loginExpr} NOT IN (${list})`,
    params: tokens,
  };
}

/**
 * Resolve typed GitHub ids or logins against identities this blog knows about.
 *
 * Followers first; moderation rows second, so an identity that was blocked and
 * has since unfollowed still resolves to a name instead of turning back into a
 * bare number. Nothing is asked of GitHub: an account this blog has never seen
 * cannot receive a notification either way, so "unknown here" is the answer that
 * matters, and it costs no subrequest and no rate limit.
 */
async function resolveIdentities(db, raw) {
  const wanted = [...new Set((raw || []).map((v) => String(v).trim()).filter(Boolean))].slice(
    0,
    ADMIN_LOOKUP_MAX
  );
  if (wanted.length === 0) return { matched: [], unknown: [] };

  const keys = wanted.map((v) => v.toLowerCase());
  const list = keys.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT github_id AS id, login, name, 1 AS follower FROM followers
        WHERE CAST(github_id AS TEXT) IN (${list}) OR lower(login) IN (${list})
        UNION ALL
       SELECT github_id AS id, login, '' AS name, 0 AS follower FROM moderation
        WHERE (CAST(github_id AS TEXT) IN (${list}) OR lower(login) IN (${list}))
          AND github_id NOT IN (SELECT github_id FROM followers)`
    )
    .bind(...keys)
    .all();

  const matched = results || [];
  const found = new Set();
  for (const row of matched) {
    found.add(String(row.id));
    found.add(String(row.login).toLowerCase());
  }

  return { matched, unknown: wanted.filter((v) => !found.has(v.toLowerCase())) };
}

// ─── ADMIN: name the ids typed into an audience field ───────
app.post("/api/admin/lookup", authMiddleware, async (c) => {
  let body = {};
  try {
    body = await c.req.json();
  } catch {}
  return c.json(await resolveIdentities(c.env.DB, body.ids));
});

// ─── ADMIN: followers, their devices, and the blocklists ────
// The first page carries everything the management screen paints once — orphan
// devices, the three blocklists, the totals — and later pages carry only more
// followers, because that is the only part that grows.
app.get("/api/admin/followers", authMiddleware, async (c) => {
  const db = c.env.DB;
  const offset = Math.max(0, Number(c.req.query("cursor")) || 0);
  const first = offset === 0;

  const statements = [
    // Devices arrive as a JSON array from a correlated subquery over
    // idx_devices_owner, which keeps the whole page to ONE statement — the
    // alternative is a second round trip that cannot start until this one has
    // returned the ids to look up.
    db
      .prepare(
        `SELECT f.github_id AS id, f.login, f.name, f.created_at,
                json_array_length(f.unread) AS unread,
                COALESCE(m.state, '')   AS state,
                COALESCE(m.blocked, '') AS blocked,
                (SELECT json_group_array(json_array(
                          d.id, d.ua, d.device, d.state, d.created_at,
                          substr(d.endpoint, -${ENDPOINT_TAIL})))
                   FROM push_devices d WHERE d.github_id = f.github_id) AS devices
           FROM followers f
           LEFT JOIN moderation m ON m.github_id = f.github_id
          ORDER BY f.created_at DESC
          LIMIT ?1 OFFSET ?2`
      )
      .bind(ADMIN_PAGE + 1, offset),
  ];

  if (first) {
    statements.push(
      // Subscriptions whose owner has gone. Only banned ones can be here — the
      // daily sweep removes the rest — so this list is short by construction.
      db.prepare(
        `SELECT d.id, d.github_id, d.ua, d.device, d.state, d.created_at,
                substr(d.endpoint, -${ENDPOINT_TAIL}) AS tail
           FROM push_devices d
          WHERE NOT EXISTS (SELECT 1 FROM followers f WHERE f.github_id = d.github_id)
          ORDER BY d.created_at DESC`
      ),
      db.prepare(`SELECT github_id AS id, login, blocked FROM moderation WHERE blocked <> ''`),
      db.prepare(
        `SELECT (SELECT COUNT(*) FROM followers)    AS followers,
                (SELECT COUNT(*) FROM push_devices) AS devices`
      )
    );
  }

  const [page, orphanRows, blockRows, totalRow] = await db.batch(statements);

  const rows = page.results || [];
  const more = rows.length > ADMIN_PAGE;
  const items = (more ? rows.slice(0, ADMIN_PAGE) : rows).map((row) => ({
    id: row.id,
    login: row.login,
    name: row.name || "",
    created_at: row.created_at,
    unread: row.unread || 0,
    state: row.state || "",
    blocked: row.blocked || "",
    is_admin: isAdminUser({ id: row.id, login: row.login }, c.env.ADMIN_LOGINS),
    devices: unpackDevices(row.devices),
  }));

  const body = { items, cursor: more ? offset + ADMIN_PAGE : null };

  if (first) {
    const blocklists = { posts: [], notes: [], announcements: [] };
    for (const row of blockRows.results || []) {
      for (const topic of String(row.blocked).split(",")) {
        if (blocklists[topic]) blocklists[topic].push({ id: row.id, login: row.login });
      }
    }
    const totals = (totalRow.results && totalRow.results[0]) || {};
    body.orphans = orphanRows.results || [];
    body.blocklists = blocklists;
    body.totals = { followers: totals.followers || 0, devices: totals.devices || 0 };
  }

  return c.json(body);
});

/** json_group_array of positional device tuples → the object shape the UI reads. */
function unpackDevices(json) {
  if (!json) return [];
  let rows;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  return (rows || []).map(([id, ua, device, state, created_at, tail]) => ({
    id,
    ua,
    device,
    state,
    created_at,
    tail,
  }));
}

// ─── ADMIN: mute / ban one follower or one device ───────────
// `{ github_id, state }` moderates an identity, `{ device_id, state }` a single
// subscription. Three states, mutually exclusive: '' | 'muted' | 'banned'.
app.put("/api/admin/moderation", authMiddleware, async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad request" }, 400);
  }

  const state = String(body.state == null ? "" : body.state);
  if (!MODERATION_STATES.has(state)) return c.json({ error: "Unknown state" }, 400);

  const db = c.env.DB;

  if (body.device_id != null) {
    const guard = notAdmin(
      c.env,
      "github_id",
      "COALESCE((SELECT login FROM followers WHERE github_id = push_devices.github_id), '')",
      3
    );
    const result = await db
      .prepare(`UPDATE push_devices SET state = ?2 WHERE id = ?1 AND ${guard.clause}`)
      .bind(Number(body.device_id) || 0, state, ...guard.params)
      .run();
    if (!(result.meta && result.meta.changes)) {
      return c.json({ error: "Unknown device, or it belongs to an admin" }, 404);
    }
    return c.json({ ok: true, device_id: Number(body.device_id), state });
  }

  const id = Number(body.github_id) || 0;
  if (!id) return c.json({ error: "github_id or device_id is required" }, 400);

  // The login is taken from the follower row when there is one, and only falls
  // back to what the client sent — which the admin guard must not trust alone.
  const login = `COALESCE((SELECT login FROM followers WHERE github_id = ?1), ?3, '')`;
  const guard = notAdmin(c.env, "?1", login, 4);

  // Nothing cascades onto push_devices: a moderated identity is already dropped
  // by the fan-out's own probe, and its devices hang off that same join. Writing
  // a state onto each of them would be a row per device to change no outcome.
  const [written] = await db.batch([
    db
      .prepare(
        `INSERT INTO moderation (github_id, login, state)
         SELECT ?1, ${login}, ?2 WHERE ${guard.clause}
         ON CONFLICT(github_id) DO UPDATE SET
           state      = excluded.state,
           login      = COALESCE(NULLIF(excluded.login, ''), moderation.login),
           updated_at = unixepoch()`
      )
      .bind(id, state, String(body.login || ""), ...guard.params),
    // A cleared row holds nothing. Dropping it keeps the table to the identities
    // that are actually moderated, which is what makes the fan-out's probe cheap.
    db
      .prepare(`DELETE FROM moderation WHERE github_id = ?1 AND state = '' AND blocked = ''`)
      .bind(id),
  ]);

  if (!(written.meta && written.meta.changes)) {
    return c.json({ error: "That identity is an admin" }, 403);
  }
  return c.json({ ok: true, github_id: id, state });
});

// ─── ADMIN: the three global blocklists ─────────────────────
// One topic per call, sent as the WHOLE intended list. Saving a diff instead
// would make two admins editing the same list silently merge their mistakes.
app.put("/api/admin/blocklists", authMiddleware, async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad request" }, 400);
  }

  const topic = String(body.topic || "");
  if (!BLOCKLIST_TOPICS.has(topic)) return c.json({ error: "Unknown topic" }, 400);

  const db = c.env.DB;
  const [resolved, current] = await Promise.all([
    resolveIdentities(db, body.users),
    db
      .prepare(
        `SELECT github_id AS id, login, blocked FROM moderation
          WHERE instr(',' || blocked || ',', ',' || ?1 || ',') > 0`
      )
      .bind(topic)
      .all(),
  ]);

  const admins = adminTokens(c.env);
  const wanted = new Map();
  for (const row of resolved.matched) {
    if (isAdminUser({ id: row.id, login: row.login }, c.env.ADMIN_LOGINS)) continue;
    wanted.set(row.id, row.login);
  }

  const statements = [];
  const held = new Set();

  // Rows that already carry this topic: keep it, or take it away.
  for (const row of current.results || []) {
    held.add(row.id);
    if (wanted.has(row.id)) continue;
    const kept = String(row.blocked)
      .split(",")
      .filter((t) => t && t !== topic)
      .join(",");
    statements.push(
      db
        .prepare(`UPDATE moderation SET blocked = ?2, updated_at = unixepoch() WHERE github_id = ?1`)
        .bind(row.id, kept)
    );
    statements.push(
      db
        .prepare(`DELETE FROM moderation WHERE github_id = ?1 AND state = '' AND blocked = ''`)
        .bind(row.id)
    );
  }

  // Rows that need it added. The topic list is computed in SQL from whatever the
  // row already holds, so adding `notes` cannot drop a `posts` set by another
  // call between the read above and this write.
  for (const [id, login] of wanted) {
    if (held.has(id)) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO moderation (github_id, login, blocked)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(github_id) DO UPDATE SET
             blocked    = CASE WHEN instr(',' || moderation.blocked || ',', ',' || ?3 || ',') > 0
                               THEN moderation.blocked
                               WHEN moderation.blocked = '' THEN ?3
                               ELSE moderation.blocked || ',' || ?3 END,
             login      = COALESCE(NULLIF(excluded.login, ''), moderation.login),
             updated_at = unixepoch()`
        )
        .bind(id, login || "", topic)
    );
  }

  if (statements.length > 0) await db.batch(statements);

  return c.json({
    ok: true,
    topic,
    users: [...wanted].map(([id, login]) => ({ id, login })),
    unknown: resolved.unknown,
  });
});

// ─── ADMIN: resend an existing notification ─────────────────
// The deliberate override of the dedupe rule. Ingest refuses to resend because
// nearly every repeat is accidental; this route exists so the rare intentional
// one does not require touching the database by hand.
app.post("/api/admin/notifications/:id/resend", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;

  const { results } = await db
    .prepare(`SELECT * FROM notifications WHERE id = ?1`)
    .bind(id)
    .all();
  if (!results || results.length === 0) {
    return c.json({ error: "Unknown notification" }, 404);
  }

  // The stored `audience_json` is what makes this a resend rather than a new
  // broadcast: the audience is recomputed from the same rule the original used,
  // so a reader who has since muted or unsubscribed is correctly left out, and
  // one who joined afterwards is not retro-fitted into an old announcement's
  // reach beyond what that rule already covered.
  const stats = await fanOut(db, c.env, results[0]);
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

  const [overview, mine] = await db.batch([
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM followers)     AS followers,
              (SELECT COUNT(*) FROM push_devices)  AS devices,
              (SELECT COUNT(*) FROM notifications) AS notifications,
              (SELECT COALESCE(SUM(devices), 0) FROM notifications) AS queued`
    ),
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM push_devices WHERE github_id = ?1) AS devices,
                json_array_length(unread) AS unread, topics
           FROM followers WHERE github_id = ?1`
      )
      .bind(admin.id),
  ]);

  const totals = (overview.results && overview.results[0]) || {};
  const you = (mine.results && mine.results[0]) || {};

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
  const following = !!(mine.results && mine.results.length > 0);
  if (!following) {
    blockers.push(
      "you are not a follower in THIS database — click Follow on the site that talks to this Worker"
    );
  }
  if (!you.devices) {
    blockers.push(
      "you have no push device registered here — the browser never subscribed, or subscribed against the other Worker"
    );
  }
  if (!c.env.NOTIFY_QUEUE) {
    blockers.push(
      "NOTIFY_QUEUE is not bound — nothing can be enqueued. Check [[queues.producers]] in wrangler.toml."
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
      following,
      topics: you.topics == null ? null : you.topics === "" ? "(all)" : you.topics,
      devices: you.devices || 0,
      unread: you.unread || 0,
    },
    totals: {
      followers: totals.followers || 0,
      devices: totals.devices || 0,
      notifications: totals.notifications || 0,
      pushesQueued: totals.queued || 0,
    },
    // Delivery state no longer lives in D1 — Queues owns it. What happened to a
    // given push is in the Worker's own logs, one `[notify] push` line per
    // message with its sent/failed/dropped counts.
    delivery: "see Workers Logs — filter for [notify]",
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

// ─── VAULT: keys for the encrypted posts this reader may open ─
//
// The whole reader-facing surface of the vault: ONE request, and for a reader
// with no grants ONE primary-key row. The response is the post ids, their
// obfuscated path segments and their unwrapped keys — never any content, which
// the browser fetches from the CDN and decrypts itself.
//
// `no-store` because the body is key material: a shared cache holding it would
// hand the next reader on that hop everything this one may read.
app.post("/api/vault/keys", userMiddleware, async (c) => {
  if (!c.env.VAULT_MASTER) return c.json({ error: "Vault not configured" }, 503);

  const session = c.get("user");
  const posts = await grantedPosts(c.env.DB, c.env, session);

  c.header("Cache-Control", "no-store");
  return c.json({ posts, admin: !!session.isAdmin });
});

// ─── ADMIN: encrypted post registry ─────────────────────────
app.get("/api/admin/vault", authMiddleware, async (c) => {
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const { posts, more } = await listPosts(c.env.DB, ADMIN_PAGE, offset);
  return c.json({ posts, more, offset });
});

// Activation. The build prints one JSON line per post and it is pasted here;
// re-pasting the same line is an update, so a repeated paste cannot duplicate.
app.post("/api/admin/vault", authMiddleware, async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad request" }, 400);
  }

  const id = String(body?.id || "").trim();
  const slug = String(body?.slug || "").trim();
  const wrapped = String(body?.wrapped || "").trim();
  if (!/^[0-9a-f]{16}$/.test(id)) return c.json({ error: "Bad id" }, 400);
  if (!/^[0-9a-z]{4,32}$/.test(slug)) return c.json({ error: "Bad slug" }, 400);
  if (!/^[A-Za-z0-9_-]{40,}$/.test(wrapped)) return c.json({ error: "Bad key" }, 400);

  await registerPost(c.env.DB, { id, slug, wrapped });
  return c.json({ ok: true, id, slug });
});

app.delete("/api/admin/vault/:id", authMiddleware, async (c) => {
  const removed = await deletePost(c.env.DB, c.req.param("id"));
  return c.json({ ok: removed });
});

// The complete new audience for one post, not a delta: the panel always sends
// the whole chip list, and only the identities that actually changed are written.
app.put("/api/admin/vault/:id/audience", authMiddleware, async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad request" }, 400);
  }
  const ids = Array.isArray(body?.audience) ? body.audience : [];
  if (ids.length > ADMIN_LOOKUP_MAX) return c.json({ error: "Too many" }, 400);

  const written = await setAudience(c.env.DB, c.req.param("id"), ids);
  return c.json({ ok: true, written });
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

  return c.json({ ok: true, source: changelog.url, sha, ...result });
});

// ─── Health root (no front-end; just a liveness probe) ─────
app.get("/", (c) => c.json({ service: "redefine-x backend worker", ok: true }));

/**
 * Cron entry point — retention only, once a day.
 *
 * It used to run every five minutes because it owned the second half of
 * SENDING: a fan-out too large for one invocation, and the retry for a push
 * service that was down. Queues owns both of those now, and owns them better —
 * it starts within seconds instead of on the next tick, and it scales out
 * instead of draining a fixed batch — so what is left here is housekeeping, and
 * housekeeping has no reason to wake up 288 times a day to find nothing to do.
 */
async function scheduled(event, env, ctx) {
  const stats = await pruneInboxes(env.DB);
  console.log("[notify] prune", JSON.stringify(stats));
}

/**
 * Queue consumer entry point — the sending half of the pipeline.
 *
 * One message per invocation (`max_batch_size = 1`), 25 pushes per message. See
 * the header of notify.js for why those two numbers are what they are.
 */
async function queue(batch, env, ctx) {
  await consumeBatch(batch, env);
}

export default { fetch: app.fetch, scheduled, queue };
