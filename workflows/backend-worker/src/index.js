/**
 * Redefine-X Backend Worker
 *
 * A headless Cloudflare Worker (Hono + D1) backing the Redefine-X theme. It has
 * NO front-end of its own — it serves three JSON/proxy concerns:
 *   1. Instant Notes API   — D1-backed notes (public read; admin CRUD).
 *   2. Auth                — verifies a giscus-derived GitHub token and mints a
 *                            short-lived HMAC session for the admin allowlist.
 *   3. Giscus CORS proxy   — forwards giscus.app API calls (comments + masonry
 *                            likes) with the blog's CORS headers.
 * Admin writes are authorized ONLY by the GitHub-OAuth HMAC session.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { fetchGitHubUser, isAdminUser, signSession, verifySession } from "./auth.js";

const app = new Hono();

// Session TTL for the minted admin token (2 hours).
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// ─── CORS ──────────────────────────────────────────────────
function resolveOrigin(origin, env) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  if (allowed === "*") return "*";
  // Always allow localhost for local development
  if (origin && /^https?:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  if (origin && /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return origin;
  // Support comma-separated allowed origins
  const origins = allowed.split(",").map((s) => s.trim());
  return origins.includes(origin) ? origin : null;
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
const authMiddleware = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const token = authHeader.slice(7);

  const session = await verifySession(token, c.env.SESSION_SECRET);
  if (session && session.isAdmin) {
    c.set("admin", session);
    await next();
    return;
  }

  return c.json({ error: "Invalid credentials" }, 403);
};

// ─── AUTH API: GitHub-OAuth login / admin check ─────────────
// The browser obtains a GitHub user token from giscus (window.blogAuth) and
// posts it here. We verify it against GitHub, check the admin allowlist, and —
// for admins — mint a short-lived signed session token used for admin writes.
// Non-admins get { isAdmin:false } (comments + likes still work via giscus).
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
  if (isAdmin && c.env.SESSION_SECRET) {
    exp = Date.now() + SESSION_TTL_MS;
    token = await signSession(
      { id: user.id, login: user.login, isAdmin: true, exp },
      c.env.SESSION_SECRET
    );
  }

  return c.json({ login: user.login, avatar: user.avatar_url, isAdmin, token, exp });
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
app.post("/api/admin/notes", authMiddleware, async (c) => {
  const { text, emoji, color } = await c.req.json();
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

  return c.json({ ok: true, id: result.meta.last_row_id }, 201);
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

// ─── Health root (no front-end; just a liveness probe) ─────
app.get("/", (c) => {
  return c.json({ service: "redefine-x backend worker", ok: true });
});

export default app;
