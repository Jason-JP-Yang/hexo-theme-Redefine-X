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
import fs from "node:fs";
import path from "node:path";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const PART = /^payload\.(\d+)\.bin$/;

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

/* ─── an editor save ───────────────────────────────────────────────────────── */

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/**
 * A save's sealed parts, in order, from its checkout of the queue commit.
 *
 * Version 1 was one `payload.bin`; version 2 is `payload.000.bin`,
 * `payload.001.bin`, … because GitHub's blob endpoint refuses one request past
 * about 42 MB. `where` is the checkout, or `<checkout>/payload.bin` as the
 * workflow has always passed it — a save in parts has no such file.
 */
export function readParts(where) {
  let dir = where;
  try {
    const stat = fs.statSync(where);
    if (stat.isFile()) return { legacy: true, parts: [fs.readFileSync(where)] };
  } catch {
    dir = path.dirname(where);
  }
  const found = fs
    .readdirSync(dir)
    .map((name) => [name, PART.exec(name)])
    .filter(([, m]) => m)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]));
  if (!found.length) throw new Error("the save carries no payload");
  found.forEach(([, m], i) => {
    if (Number(m[1]) !== i) throw new Error("the save is missing a part");
  });
  return { legacy: false, parts: found.map(([name]) => fs.readFileSync(path.join(dir, name))) };
}

/**
 * What the receipt names: v1's sha256, or for parts the sha256 of every part's
 * sha256, one per line, in order — the editor's `saveDigest`, byte for byte.
 */
export function saveDigest({ legacy, parts }) {
  if (legacy) return sha256(parts[0]);
  return sha256(Buffer.from(parts.map(sha256).join("\n"), "utf8"));
}

/**
 * The save, opened: `{ v, message, files: [{ op, path, owner, bytes }] }`.
 *
 * v1 is JSON with every file as base64. v2 is a 4-byte big-endian header
 * length, the header JSON (each file with its `size`), then the files' bytes
 * back to back in header order — nothing in it may be left over or missing.
 */
export function openSave(key, { legacy, parts }) {
  const plain = Buffer.concat(parts.map((part) => open(key, part)));

  if (legacy) {
    const body = JSON.parse(plain.toString("utf8"));
    return {
      v: body.v,
      message: body.message,
      files: (Array.isArray(body.files) ? body.files : []).map((f) => ({
        op: f.op,
        path: f.path,
        owner: f.owner,
        bytes: f.op === "delete" ? null : Buffer.from(String(f.data || ""), "base64"),
      })),
    };
  }

  if (plain.length < 4) throw new Error("the save is truncated");
  const length = plain.readUInt32BE(0);
  if (4 + length > plain.length) throw new Error("the save is truncated");
  const header = JSON.parse(plain.subarray(4, 4 + length).toString("utf8"));

  let at = 4 + length;
  const files = [];
  for (const f of Array.isArray(header.files) ? header.files : []) {
    if (f.op === "delete") {
      files.push({ op: f.op, path: f.path, owner: f.owner, bytes: null });
      continue;
    }
    const size = Number(f.size);
    if (!Number.isInteger(size) || size < 0 || at + size > plain.length) throw new Error("the save is truncated");
    files.push({ op: f.op, path: f.path, owner: f.owner, bytes: plain.subarray(at, at + size) });
    at += size;
  }
  if (at !== plain.length) throw new Error("the save carries bytes its header does not name");
  return { v: header.v, message: header.message, files };
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

/** One commit-message trailer, the last well-formed one wins. */
export function trailer(message, name) {
  const re = new RegExp(`^${name}:[ \\t]*(.+)$`, "gim");
  let found = "";
  let m;
  while ((m = re.exec(String(message || "")))) found = m[1].trim();
  return found;
}
