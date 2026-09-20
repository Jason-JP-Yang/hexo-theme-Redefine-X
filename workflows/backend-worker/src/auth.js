/**
 * Auth helpers for the blog backend Worker.
 *
 * Identity is rooted in the giscus GitHub OAuth login (the same sign-in that
 * powers comments and masonry likes). The browser obtains a GitHub user token
 * from giscus and sends it to POST /api/auth/login. This module:
 *
 *   1. fetchGitHubUser()  — verifies the token by asking GitHub "who am I?".
 *   2. signSession()      — mints a short-lived HMAC-signed session token for
 *                           EVERY verified user, carrying `isAdmin` and `collab`
 *                           in the payload, so that each later request is
 *                           authorized LOCALLY (no extra GitHub call per
 *                           request). Admin routes additionally require isAdmin;
 *                           follower routes (/api/me/*, /api/push/*) take any
 *                           valid token.
 *   3. verifySession()    — validates that HMAC token + its expiry.
 *
 * The session token is a compact JWT-ish string: base64url(payload).base64url(sig)
 * Uses Web Crypto (available in Workers) — no external dependencies. The
 * base64url helpers are exported because Web Push needs the same encoding for
 * its keys.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// The session key is imported on EVERY authenticated request, and the secret
// behind it changes only when the deployment does. Caching the imported
// CryptoKey at module scope takes one Web Crypto call out of the hot path
// without changing what is signed or verified. Isolate-local, so nothing here
// needs invalidating beyond the secret changing under it.
let hmacKeyCache = null; // { secret, key }

async function importKey(secret) {
  if (hmacKeyCache && hmacKeyCache.secret === secret) return hmacKeyCache.key;

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  hmacKeyCache = { secret, key };
  return key;
}

/**
 * Sign a payload object into a compact `payload.signature` token.
 * @param {object} payload  e.g. { id, login, isAdmin, exp }
 * @param {string} secret   SESSION_SECRET
 */
export async function signSession(payload, secret) {
  const key = await importKey(secret);
  const head = bytesToB64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(head));
  return `${head}.${bytesToB64url(new Uint8Array(sig))}`;
}

/**
 * Verify a session token; returns the payload if valid & unexpired, else null.
 * @param {string} token
 * @param {string} secret  SESSION_SECRET
 */
export async function verifySession(token, secret) {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const head = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!head || !sigB64) return null;
  try {
    const key = await importKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlToBytes(sigB64),
      enc.encode(head)
    );
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64urlToBytes(head)));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Verify a GitHub user token and return the user identity.
 * Works with the giscus-app user token (a standard GitHub user-to-server token):
 * GET /user returns the authenticated user regardless of which app issued it.
 * @param {string} token  GitHub OAuth user token (e.g. gho_…)
 * @returns {Promise<{id:number, login:string, name:string, avatar_url:string}|null>}
 */
export async function fetchGitHubUser(token) {
  if (!token) return null;
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "blog-instant-notes-worker",
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) return null;
    const u = await res.json();
    if (!u || !u.login) return null;
    return { id: u.id, login: u.login, name: u.name || "", avatar_url: u.avatar_url };
  } catch {
    return null;
  }
}

/** A comma-separated allowlist as a list of tokens. */
export function allowList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Is this identity named by that allowlist, by numeric id or by login? */
function listed(user, raw) {
  if (!user) return false;
  const allowed = allowList(raw);
  return allowed.includes(String(user.id)) || allowed.includes(user.login);
}

/**
 * Decide whether a GitHub identity is an admin.
 * ADMIN_LOGINS is a comma-separated list of GitHub numeric ids (preferred,
 * immutable) and/or login names.
 */
export function isAdminUser(user, adminLoginsRaw) {
  return listed(user, adminLoginsRaw);
}

/**
 * Decide whether a GitHub identity is a collaborator.
 *
 * COLLABORATORS has the same shape and the same meaning as ADMIN_LOGINS, and a
 * collaborator carries the SAME `isAdmin` claim — the two roles differ in
 * exactly one place, moderation, where a collaborator may not act on an admin
 * or on themselves. Everything else an admin can reach, a collaborator can.
 *
 * The roster of names, emails and avatars is site configuration
 * (`backend.collaborators`), not Worker configuration: it is what the build
 * renders and what the editor signs a commit with. Only the ids live here,
 * because authorization is the only question this Worker answers.
 */
export function isCollaborator(user, collaboratorsRaw) {
  return listed(user, collaboratorsRaw);
}
