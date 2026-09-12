/**
 * A GitHub App installation token, in place of a standing PAT.
 *
 * The editor commits from the browser, so whatever authorises those commits is
 * handed to a browser. A fine-grained PAT handed over that way is a credential
 * with no expiry, usable from anywhere, that outlives the session it was issued
 * for and leaves no trace of having been used — revoking the session does not
 * revoke it, and a copy in a HAR file or a borrowed machine keeps working.
 *
 * An installation token is the same capability with three differences that
 * matter: it lasts ONE HOUR, it is narrowed per request to one repository and
 * one set of permissions, and it is minted from a private key that never leaves
 * this Worker.
 *
 * ── Cost, on a 10 ms budget ─────────────────────────────────
 *
 * One RS256 signature and one subrequest, at most once per isolate per
 * fifty-five minutes. Both the imported key and the token itself are held at
 * MODULE SCOPE, which is the cheapest cache there is: no D1 row, no KV read, and
 * nothing in the shared edge cache, where a credential stored under a routable
 * key could be fetched back out. A cold isolate mints once; every ticket after
 * that is a date comparison.
 *
 * Signing is native (BoringSSL), so the JS in the path is three small base64url
 * encodes over a few hundred bytes.
 */

import { bytesToB64url } from "./auth.js";

// GitHub rejects an app JWT whose `exp` is more than ten minutes out. Nine.
const JWT_TTL = 540;
// Re-minted this long before it lapses, so a session opened in a token's last
// minute is not handed one that dies mid-commit.
const EARLY_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

let signingKey = null;
let cached = null; // { token, expires } — `expires` is GitHub's own ISO stamp

function segment(value) {
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** PEM (PKCS#8) → CryptoKey, once per isolate. */
async function importKey(pem) {
  if (signingKey) return signingKey;
  const body = String(pem || "").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
  signingKey = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return signingKey;
}

async function appJWT(env) {
  const now = Math.floor(Date.now() / 1000);
  const head = segment({ alg: "RS256", typ: "JWT" });
  // Backdated thirty seconds, for clock skew between here and GitHub.
  const body = segment({ iat: now - 30, exp: now + JWT_TTL, iss: String(env.GITHUB_APP_ID) });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importKey(env.GITHUB_APP_PRIVATE_KEY),
    new TextEncoder().encode(`${head}.${body}`)
  );
  return `${head}.${body}.${bytesToB64url(new Uint8Array(signature))}`;
}

export function appConfigured(env) {
  return !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID);
}

/**
 * The token the browser is given, or null when the App is not configured or
 * GitHub refuses — in which case the caller falls back to whatever standing
 * token it has, because refusing to let the author write is worse than handing
 * over the credential that was already being handed over.
 *
 * @param {object} env
 * @param {string} repo  repository NAME (not owner/name) to narrow the token to
 * @returns {Promise<{token: string, expires: string}|null>}
 */
export async function installationToken(env, repo) {
  if (!appConfigured(env)) return null;
  if (cached && Date.parse(cached.expires) - Date.now() > EARLY_MS) return cached;

  const api = String(env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");

  let res;
  try {
    res = await fetch(`${api}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await appJWT(env)}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "backend-blog",
      },
      // Narrowed to exactly what the editor does. A token can never exceed the
      // installation's own grant, so naming these can only ever subtract — and
      // `Workflows` is absent here as it is absent there, which is what makes
      // GitHub itself refuse any write under `.github/workflows/`.
      body: JSON.stringify({
        repositories: repo ? [repo] : undefined,
        permissions: { contents: "write", metadata: "read", actions: "read" },
      }),
    });
  } catch (err) {
    return null;
  }
  if (!res.ok) return null;

  const body = await res.json().catch(() => null);
  if (!body || !body.token) return null;

  cached = {
    token: body.token,
    expires: body.expires_at || new Date(Date.now() + HOUR_MS).toISOString(),
  };
  return cached;
}
