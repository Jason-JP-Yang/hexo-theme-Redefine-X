/**
 * GitHub webhook — the one trigger the backend acts on by itself.
 *
 * The event is `deployment_status`, not `push`. That distinction is the whole
 * design: a push means the deploy repo has new commits, which is NOT the moment
 * the site is readable. A successful deployment IS. Announcing on `push` meant
 * every notification had to be held back behind a fixed grace period, guessing
 * at how long the static host would take; announcing on `deployment_status`
 * removes the guess, and with it the reason to defer sending at all.
 *
 * Three properties make the endpoint safe to expose publicly:
 *
 *   1. The request is authenticated by HMAC (X-Hub-Signature-256) over the RAW
 *      body, so nobody else can trigger a fan-out. The secret is configured on
 *      exactly one repository, which is also why the Worker does not need to be
 *      told which repository to expect — only that one can produce a valid
 *      signature.
 *   2. Only a SUCCESSFUL deployment to a PRODUCTION environment is acted on;
 *      preview builds and failed deploys are acknowledged and dropped.
 *   3. The changelog is fetched at the deployed COMMIT SHA, not from the live
 *      site, so what we ingest is exactly what that deployment contained — a
 *      rebuild or a rollback mid-flight cannot change it underneath us.
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
 * Is this deployment the live site rather than a preview?
 *
 * `production_environment` is the field that ought to answer this, but hosts
 * disagree about it — Vercel names the environment "Production" and still
 * reports `production_environment: false`. So the flag is accepted when set and
 * the environment NAME is matched when it is not, which covers Vercel,
 * Cloudflare Pages and GitHub Pages without naming any of them a special case.
 */
function isProductionEnvironment(payload) {
  const deployment = payload.deployment || {};
  const status = payload.deployment_status || {};
  if (deployment.production_environment === true) return true;

  const name = String(status.environment || deployment.environment || "").toLowerCase();
  return name === "production" || name === "prod" || name === "github-pages";
}

/**
 * Decide whether a deployment_status event is one we should act on.
 *
 * `success` is the only state that means the site is serving the new build;
 * `pending`, `in_progress`, `failure` and `error` all carry a SHA that either is
 * not live yet or never will be.
 */
export function isLiveDeployment(payload) {
  if (!payload || !payload.deployment || !payload.deployment_status) return false;
  if (String(payload.deployment_status.state) !== "success") return false;
  if (!isProductionEnvironment(payload)) return false;
  return !!payload.deployment.sha;
}

/**
 * Fetch the changelog produced by one deployment.
 *
 * Primary source is the raw blob at that exact SHA; the live site is the
 * fallback for when the deploy repo cannot be read that way. Both are public
 * reads — the deploy repo is the one holding the RENDERED site, so nothing here
 * needs a credential.
 *
 * The file is the contract: `{ entries: [...] }`, each entry carrying its own
 * stable `id`. Whether it lists only what this deployment added or the whole
 * back catalogue is the generator's business, not ours — ingest dedupes by id
 * either way.
 */
export async function fetchChangelog(repo, sha, env) {
  const headers = { "User-Agent": "redefine-x-backend-worker" };

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
