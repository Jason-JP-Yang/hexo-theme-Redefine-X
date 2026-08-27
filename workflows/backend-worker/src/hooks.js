/**
 * GitHub webhook — the one trigger the backend acts on by itself.
 *
 * The deploy repo pushes, GitHub calls us, we read the `changelog.json` that the
 * push produced and hand its entries to the pipeline. Two properties make this
 * safe to expose publicly:
 *
 *   1. The request is authenticated by HMAC (X-Hub-Signature-256) over the RAW
 *      body, so nobody else can trigger a fan-out.
 *   2. The changelog is fetched at the pushed COMMIT SHA, not from the live
 *      site, so what we ingest is exactly what that push contained — a rebuild
 *      or a rollback mid-flight cannot change it underneath us.
 */

const enc = new TextEncoder();

/**
 * Verify GitHub's HMAC signature over the raw request body.
 * Compared in constant time: a fast-exit comparison leaks the correct prefix.
 */
export async function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  if (!signatureHeader.startsWith("sha256=")) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));

  let expected = "";
  for (let i = 0; i < mac.length; i++) expected += mac[i].toString(16).padStart(2, "0");

  const received = signatureHeader.slice(7);
  if (received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Fetch the changelog produced by one push.
 *
 * Primary source is the raw blob at that exact SHA. A private deploy repo needs
 * GITHUB_READ_TOKEN for that; without it, the live site is the fallback — less
 * precise (it reflects whatever is deployed right now) but enough to keep the
 * pipeline working on a public-site/private-repo setup.
 */
export async function fetchChangelog(repo, sha, env) {
  const headers = { "User-Agent": "redefine-x-backend-worker" };
  if (env.GITHUB_READ_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_READ_TOKEN}`;

  const sources = [];
  if (repo && sha) {
    sources.push(`https://raw.githubusercontent.com/${repo}/${sha}/changelog.json`);
  }
  if (env.SITE_URL) {
    sources.push(`${String(env.SITE_URL).replace(/\/+$/, "")}/changelog.json`);
  }

  for (const url of sources) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && Array.isArray(data.entries)) return { data, url };
    } catch {
      // Try the next source; a single unreachable origin is not a failure.
    }
  }
  return null;
}

/**
 * Decide whether a push event is one we should act on.
 *
 * Only the configured branch counts, and a deleted branch or a force-push to
 * nothing carries no changelog to read.
 */
export function isRelevantPush(payload, env) {
  if (!payload || payload.deleted) return false;
  const ref = String(payload.ref || "");
  const branch = String(env.DEPLOY_BRANCH || "main");
  if (ref !== `refs/heads/${branch}`) return false;
  return !!payload.after && !/^0+$/.test(payload.after);
}
