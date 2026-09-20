/**
 * The runner's half of the vault primitives.
 *
 * Deliberately standalone and dependency-free. These scripts run in the PUBLIC
 * repository's checkout, before the private repository has been cloned and
 * before any `npm ci` has happened — which is exactly the point: nothing that
 * decides whether a push is legitimate may depend on code that push could have
 * reached.
 *
 * Every primitive here has a counterpart in scripts/lib/vault-crypto.js (the
 * build), src/vault.js (the Worker) and source/js/tools/vaultCrypto.js (the
 * browser). All four must agree byte for byte.
 */

import crypto from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function fromB64url(str) {
  return Buffer.from(String(str), "base64url");
}

/** iv ‖ ciphertext ‖ tag. */
export function seal(key, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

export function open(key, sealed) {
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const body = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function hkdf(ikm, info) {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(info, "utf8"), 32));
}

export function master() {
  const raw = fromB64url(process.env.VAULT_MASTER || "");
  if (raw.length !== 32) throw new Error("VAULT_MASTER must decode to 32 bytes");
  return raw;
}

/** The one-time key a save was sealed with, as the Worker wrapped it. */
export function unwrapSubmission(wrapped) {
  return open(hkdf(master(), "rdfx-submit"), fromB64url(wrapped));
}

/** sha256(source path), first 16 hex — the same identity every side computes. */
export function postId(sourcePath) {
  const rel = String(sourcePath || "")
    .replace(/^\/+/, "")
    .replace(/^source\//, "");
  return crypto.createHash("sha256").update(rel, "utf8").digest("hex").slice(0, 16);
}

export function pageId(name) {
  return crypto.createHash("sha256").update("page|" + String(name), "utf8").digest("hex").slice(0, 16);
}

export function albumId(pageTitle) {
  return crypto.createHash("sha256").update("masonry|" + String(pageTitle), "utf8").digest("hex").slice(0, 16);
}

export function albumDraftId(pageTitle) {
  return crypto
    .createHash("sha256")
    .update("masonry|draft|" + String(pageTitle), "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Check a detached Ed25519 signature against the published key.
 *
 * An Ed25519 public key has exactly one length, so the SPKI wrapper around it
 * is a fixed prefix rather than something to parse — which is what lets the key
 * travel as 32 base64url bytes in a config file and in a repository variable.
 */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyEd25519(publicKeyB64url, message, signatureB64url) {
  const raw = fromB64url(publicKeyB64url);
  if (raw.length !== 32) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(message, "utf8"), key, fromB64url(signatureB64url));
  } catch {
    return false;
  }
}

/** HMAC over an arbitrary string under an HKDF subkey of the master. */
export function mac(info, message) {
  return "sha256=" + crypto.createHmac("sha256", hkdf(master(), info)).update(String(message), "utf8").digest("hex");
}

/** Constant time, because a fast exit leaks the correct prefix. */
export function sameMac(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** One commit-message trailer, the last well-formed one wins. */
export function trailer(message, name) {
  const re = new RegExp(`^${name}:[ \\t]*(.+)$`, "gim");
  let found = "";
  let m;
  while ((m = re.exec(String(message || "")))) found = m[1].trim();
  return found;
}
