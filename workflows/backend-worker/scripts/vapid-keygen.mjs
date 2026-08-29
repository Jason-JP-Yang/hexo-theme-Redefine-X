/**
 * Generate a VAPID key pair for Web Push.
 *
 *   node scripts/vapid-keygen.mjs      (or: npm run vapid:keygen)
 *
 * Uses Node's Web Crypto so it produces exactly the encoding src/webpush.js
 * expects — and needs no dependencies, which is the point: the `web-push`
 * package cannot run on Workers, so the Worker implements RFC 8291/8292 itself
 * and this script is the matching key generator.
 *
 * Output:
 *   public  — base64url, 65-byte uncompressed P-256 point. NOT a secret. Goes in
 *             wrangler.toml [vars] VAPID_PUBLIC_KEY *and* in the theme config as
 *             notifications.vapid_public_key. The two must match.
 *   private — base64url, 32-byte scalar. Secret. `wrangler secret put
 *             VAPID_PRIVATE_KEY` (and .dev.vars for local runs).
 */

import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;

function bytesToB64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);

const publicKey = bytesToB64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
const jwk = await subtle.exportKey("jwk", pair.privateKey);

console.log("");
console.log("VAPID key pair (P-256)");
console.log("──────────────────────────────────────────────────────────────");
console.log("Public  (wrangler.toml [vars] + theme config):");
console.log("  " + publicKey);
console.log("");
console.log("Private (wrangler secret put VAPID_PRIVATE_KEY):");
console.log("  " + jwk.d);
console.log("");
console.log("Rotating these invalidates every existing subscription — readers");
console.log("would have to follow again. Keep the pair stable once deployed.");
console.log("");
