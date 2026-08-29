/**
 * Web Push — payload encryption and VAPID authentication.
 *
 * Two RFCs, no dependencies. Everything here runs on Web Crypto, which is what
 * lets the Worker send a push without pulling in the `web-push` package (which
 * assumes Node's crypto and does not run on Workers).
 *
 *   • RFC 8291 — Message Encryption for Web Push. Derives a content key from an
 *     ECDH exchange between an ephemeral server key and the subscription's
 *     public key, then encrypts one `aes128gcm` record (RFC 8188).
 *   • RFC 8292 — VAPID. Signs a short-lived ES256 JWT identifying this server to
 *     the push service.
 *
 * The one asymmetry worth knowing: the ECDH key pair is generated fresh for
 * EVERY message (RFC 8291 requires it, and it is what makes the encryption
 * forward-secret), while the VAPID key pair is long-lived and configured out of
 * band. That asymmetry is also where the CPU budget goes, so the long-lived half
 * is cached at module scope — see `vapidHeader`.
 */

import { bytesToB64url, b64urlToBytes } from "./auth.js";

const enc = new TextEncoder();

// A push service must accept at least 4096 bytes of payload; the record size is
// declared in the body header and bounds the single record we send.
const RECORD_SIZE = 4096;
// Ciphertext expands by the GCM tag (16) plus the padding delimiter (1), so the
// plaintext ceiling is the record size minus that overhead. We stay well under.
const MAX_PLAINTEXT = 3000;
// VAPID tokens are short-lived by design; 12h is the maximum most services allow.
const VAPID_TTL_SEC = 12 * 60 * 60;
// Re-sign a cached token this long before it actually expires, so a message is
// never sent with a header that lapses in flight.
const VAPID_REFRESH_SEC = 5 * 60;

// ─── module-scope caches ─────────────────────────────────────
// A fan-out signs the SAME VAPID token over and over: the JWT's audience is the
// push endpoint's ORIGIN, and every subscriber's endpoint resolves to one of
// three of them (Google, Mozilla, Apple). Signing per message therefore paid for
// an ECDSA key import and an ECDSA signature per DEVICE to produce at most three
// distinct strings. Both are cached here instead, which takes the per-message
// cost of VAPID to zero for all but the first device on each push service.
//
// Isolate-local and non-authoritative: losing the cache costs one signature, so
// nothing here needs invalidating beyond the key changing under it.
let vapidKeyCache = null; // { publicKey, privateKey, key }
const vapidJwtCache = new Map(); // audience origin -> { header, expiresAt }

// ─── byte helpers ────────────────────────────────────────────
function concat(...chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function uint32BE(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

// ─── HKDF (RFC 5869), the two-step form the push RFCs spell out ──
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

/** HKDF-Extract then a single-block HKDF-Expand, truncated to `length`. */
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

// ─── RFC 8291 — encrypt one aes128gcm record ─────────────────
/**
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} uaPublic  subscription p256dh, uncompressed point (65 bytes)
 * @param {Uint8Array} authSecret subscription auth, 16 bytes
 * @returns {Promise<Uint8Array>} the complete request body
 */
async function encryptPayload(plaintext, uaPublic, authSecret) {
  if (plaintext.length > MAX_PLAINTEXT) {
    throw new Error(`Push payload too large (${plaintext.length} > ${MAX_PLAINTEXT})`);
  }

  // Ephemeral server key pair — new for every message.
  const asKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", asKeyPair.publicKey)
  );

  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey },
      asKeyPair.privateKey,
      256
    )
  );

  // The IKM is bound to BOTH public keys, which is what stops a captured
  // ciphertext from being replayed against a different subscription.
  const keyInfo = concat(
    enc.encode("WebPush: info"),
    new Uint8Array([0]),
    uaPublic,
    asPublic
  );
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(
    salt,
    ikm,
    concat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])),
    16
  );
  const nonce = await hkdf(
    salt,
    ikm,
    concat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0])),
    12
  );

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  // 0x02 is the padding delimiter for the LAST record. We only ever send one.
  const padded = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      aesKey,
      padded
    )
  );

  // RFC 8188 §2.1 header: salt | record size | keyid length | keyid
  return concat(
    salt,
    uint32BE(RECORD_SIZE),
    new Uint8Array([asPublic.length]),
    asPublic,
    ciphertext
  );
}

// ─── RFC 8292 — VAPID ────────────────────────────────────────
/**
 * Import the VAPID signing key. The private key is the raw 32-byte P-256 scalar
 * (what `web-push generateVAPIDKeys` prints), so the public key supplies the
 * x/y coordinates the JWK import needs.
 */
async function importVapidKey(privateKeyB64, publicKeyB64) {
  if (
    vapidKeyCache &&
    vapidKeyCache.privateKey === privateKeyB64 &&
    vapidKeyCache.publicKey === publicKeyB64
  ) {
    return vapidKeyCache.key;
  }

  const d = b64urlToBytes(privateKeyB64);
  const pub = b64urlToBytes(publicKeyB64);
  if (d.length !== 32) {
    throw new Error(`VAPID_PRIVATE_KEY must be a 32-byte P-256 scalar (got ${d.length})`);
  }
  if (pub.length !== 65 || pub[0] !== 4) {
    throw new Error("VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: bytesToB64url(d),
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  vapidKeyCache = { privateKey: privateKeyB64, publicKey: publicKeyB64, key };
  return key;
}

/**
 * The RFC 8292 `sub` claim: who to contact about this server.
 *
 * SITE_URL is the natural answer and the only variable that carries it, but the
 * spec allows only `https:` and `mailto:` — and SITE_URL is deliberately set to
 * `http://localhost:4000` during local development, which push services reject
 * outright. Falling back to the audience keeps a local run sending real pushes
 * instead of collecting 400s that look like a broken key pair.
 */
function vapidSubject(env, audience) {
  const site = String(env.SITE_URL || "");
  return /^(https:\/\/|mailto:)/i.test(site) ? site : audience;
}

/**
 * Build the `Authorization: vapid t=…, k=…` header value for one audience.
 *
 * The audience is the ORIGIN of the push endpoint, never the full URL — which is
 * what makes the result cacheable: a hundred subscribers share three origins, so
 * a hundred-device fan-out needs three signatures, not a hundred.
 *
 * `sub` identifies this server to the push service per RFC 8292. The site's own
 * URL satisfies it (a `mailto:` is equally valid), so it comes from SITE_URL
 * rather than from a second variable that could drift away from it.
 */
async function vapidHeader(endpoint, env) {
  const audience = new URL(endpoint).origin;
  const subject = vapidSubject(env, audience);
  const cacheKey = `${audience}|${env.VAPID_PUBLIC_KEY}|${subject}`;
  const now = Math.floor(Date.now() / 1000);

  const cached = vapidJwtCache.get(cacheKey);
  if (cached && cached.expiresAt - VAPID_REFRESH_SEC > now) return cached.header;

  const key = await importVapidKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);
  const exp = now + VAPID_TTL_SEC;

  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64url(
    enc.encode(JSON.stringify({ aud: audience, exp, sub: subject }))
  );
  const signingInput = `${header}.${payload}`;

  // Web Crypto returns the raw r||s pair, which is exactly the JWS encoding —
  // no DER unwrapping needed.
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      enc.encode(signingInput)
    )
  );

  const value = `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
  vapidJwtCache.set(cacheKey, { header: value, expiresAt: exp });
  return value;
}

// ─── public API ──────────────────────────────────────────────
/**
 * Send one push message.
 *
 * Never throws for a delivery failure — the caller classifies the status code
 * and decides whether to retry, back off, or drop the device. It only rejects
 * when the CONFIGURATION is wrong (bad keys), which is not a per-device
 * condition and must surface loudly.
 *
 * @param {{endpoint:string, p256dh:string, auth:string}} device
 * @param {object|null} payload  JSON-serialised into the encrypted record
 * @param {object} env
 * @param {{ttl?:number, urgency?:string}} [opts]
 * @returns {Promise<{ok:boolean, status:number, error?:string}>}
 */
export async function sendWebPush(device, payload, env, opts = {}) {
  const headers = {
    TTL: String(opts.ttl == null ? 86400 : opts.ttl),
    Authorization: await vapidHeader(device.endpoint, env),
  };
  if (opts.urgency) headers.Urgency = opts.urgency;

  let body = null;
  if (payload != null) {
    body = await encryptPayload(
      enc.encode(JSON.stringify(payload)),
      b64urlToBytes(device.p256dh),
      b64urlToBytes(device.auth)
    );
    headers["Content-Encoding"] = "aes128gcm";
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Length"] = String(body.length);
  }

  try {
    const res = await fetch(device.endpoint, { method: "POST", headers, body });
    if (res.ok) return { ok: true, status: res.status };
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {}
    return { ok: false, status: res.status, error: detail };
  } catch (e) {
    // A network failure is indistinguishable from a transient outage, so report
    // it as a retryable 0 rather than inventing an HTTP status.
    return { ok: false, status: 0, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * Check the configured VAPID pair without sending anything.
 *
 * Both halves can be individually well-formed and still not belong together —
 * the commonest way to end up with silence, because the push service rejects
 * every message with a 401 that nothing surfaces. A sign/verify round trip is
 * the only way to prove they match: the private key is imported from `d` plus
 * the public `x`/`y`, so a mismatched pair produces a signature that its own
 * public key cannot verify.
 *
 * @returns {Promise<{ok:boolean, publicKey:string, privateKey:string, pair:string}>}
 */
export async function checkVapidKeys(env) {
  const out = { ok: false, publicKey: "missing", privateKey: "missing", pair: "unchecked" };

  if (!env.VAPID_PUBLIC_KEY) return out;
  if (!env.VAPID_PRIVATE_KEY) {
    out.publicKey = "present";
    return out;
  }

  try {
    const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY);
    out.publicKey =
      pub.length === 65 && pub[0] === 4 ? "valid" : `invalid (${pub.length} bytes, needs 65)`;
    const d = b64urlToBytes(env.VAPID_PRIVATE_KEY);
    out.privateKey = d.length === 32 ? "valid" : `invalid (${d.length} bytes, needs 32)`;
    if (out.publicKey !== "valid" || out.privateKey !== "valid") return out;

    const priv = await importVapidKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      priv,
      enc.encode("vapid-selftest")
    );
    const verifier = await crypto.subtle.importKey(
      "raw",
      pub,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const matched = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifier,
      sig,
      enc.encode("vapid-selftest")
    );
    out.pair = matched ? "matched" : "MISMATCHED — the two halves are from different key pairs";
    out.ok = matched;
  } catch (e) {
    out.pair = `error: ${e && e.message ? e.message : e}`;
  }
  return out;
}
