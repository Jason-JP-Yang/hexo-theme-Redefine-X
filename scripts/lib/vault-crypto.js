"use strict";

/**
 * Vault crypto — the Node half. The Worker (src/vault.js) and the browser
 * (source/js/plugins/vault.js) implement the SAME primitives against Web Crypto;
 * all three must agree byte for byte or nothing decrypts.
 *
 * ── The key hierarchy ───────────────────────────────────────────────────────
 *
 *   VAULT_MASTER            32 random bytes. .env here, a Worker secret there.
 *                           NEVER in D1, never in a config file, never shipped.
 *        │
 *        │  AES-256-GCM wrap
 *        ▼
 *   wrapped(postKey)        what D1 stores. A database dump yields nothing.
 *
 *   postKey                 32 random bytes, ONE per post, generated once and
 *                           then stable forever (.vault/keys.json is the local
 *                           authority; D1 holds the wrapped copy).
 *        │
 *        ├── AES-256-GCM ─────────────► the post body and its card blob
 *        │
 *        └── HKDF-SHA256(info=asset|H) ► one key per image, so no image key can
 *                                        be reused across posts
 *
 * ── Why the nonce is NOT stored ─────────────────────────────────────────────
 *
 * postKey is deliberately stable across builds, which makes the nonce the only
 * thing standing between two builds of an edited post and catastrophic GCM
 * nonce reuse: encrypting two different plaintexts under one (key, nonce) leaks
 * their XOR and hands over the GHASH authentication key, after which any
 * ciphertext can be forged. So a fresh random nonce is drawn on EVERY build and
 * travels in front of the ciphertext, where it is public and harmless.
 */

const crypto = require("crypto");

const IV_BYTES = 12;
const KEY_BYTES = 32;
const SLUG_CHARS = 10;

// No I, L, O, U — a slug gets read aloud and typed by hand often enough that
// the pairs that look alike are worth giving up.
const SLUG_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function fromB64url(str) {
  return Buffer.from(String(str), "base64url");
}

function randomKey() {
  return crypto.randomBytes(KEY_BYTES);
}

/** A short, unguessable path segment. 50 bits — collision is not a concern at
 *  blog scale, and the secrecy of the content never rests on it. */
function randomSlug() {
  const bytes = crypto.randomBytes(SLUG_CHARS);
  let out = "";
  for (let i = 0; i < SLUG_CHARS; i++) {
    out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return out;
}

/** Stable across a retitle, a redate and a move between categories. */
function postId(sourcePath) {
  return crypto
    .createHash("sha256")
    .update(String(sourcePath), "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** A masonry album has no source file, so its identity is the page it would
 *  have been published at. Renaming that page mints a new key. */
function albumId(pageTitle) {
  return crypto
    .createHash("sha256")
    .update("masonry|" + String(pageTitle), "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** iv || ciphertext || tag, base64url. The shape every blob in this system has. */
function seal(key, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

function open(key, sealed) {
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - 16);
  const body = buf.subarray(IV_BYTES, buf.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** What D1 stores for a post. */
function wrapKey(master, postKey) {
  return b64url(seal(master, postKey));
}

function unwrapKey(master, wrapped) {
  return open(master, fromB64url(wrapped));
}

function hkdf(ikm, info) {
  return Buffer.from(
    crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(info, "utf8"), KEY_BYTES)
  );
}

/** One key per (post, image). */
function assetKey(postKey, assetHash) {
  return hkdf(postKey, "rdfx-asset|" + assetHash);
}

/** Content-addressed: the same bytes get the same name in every post that uses
 *  them, which is what lets one reference in the markup resolve anywhere. */
function assetHash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/**
 * The PUBLISHED name of one sealed image — the post key mixed in.
 *
 * The blob used to be named by the content hash alone. Two encrypted items that
 * share an image (every masonry album on this site shares one avatar) therefore
 * claimed ONE path while sealing it under two different asset keys, so whichever
 * was written last silently replaced the other and the readers of the first got
 * a blob that would not open — a broken image with no error anywhere.
 *
 * A reader derives this from the post key it already holds, so nothing extra is
 * published and nothing has to be looked up.
 */
function assetPath(postKey, hash) {
  return crypto
    .createHash("sha256")
    .update("rdfx-asset-path|" + b64url(postKey) + "|" + hash, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * A bento variant is addressed and encrypted by the SET of post keys it renders.
 * The browser holds those keys, so it derives both without asking the Worker and
 * without any published index — which is what keeps the number of encrypted
 * posts unguessable to everyone else.
 */
function variantMaterial(page, postKeys) {
  const sorted = postKeys.map((k) => b64url(k)).sort();
  return "rdfx-grid|" + String(page) + "|" + sorted.join(",");
}

function variantPath(page, postKeys) {
  return crypto
    .createHash("sha256")
    .update(variantMaterial(page, postKeys), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function variantKey(page, postKeys) {
  return hkdf(Buffer.from(variantMaterial(page, postKeys), "utf8"), "rdfx-grid-key");
}

/**
 * How a tag or a category is named in the taxonomy gate's URL fragment. Mirrors
 * `taxHash` in source/js/tools/vaultCrypto.js — the browser has to arrive at the
 * same digest from the name it decrypts.
 */
function taxHash(kind, name) {
  return crypto
    .createHash("sha256")
    .update("rdfx-tax|" + kind + "|" + name, "utf8")
    .digest("hex")
    .slice(0, 16);
}

module.exports = {
  IV_BYTES,
  KEY_BYTES,
  b64url,
  fromB64url,
  randomKey,
  randomSlug,
  postId,
  albumId,
  seal,
  open,
  wrapKey,
  unwrapKey,
  hkdf,
  assetKey,
  assetHash,
  assetPath,
  variantPath,
  variantKey,
  taxHash,
};
