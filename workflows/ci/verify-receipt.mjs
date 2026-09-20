/**
 * Is this save allowed to happen at all?
 *
 * Runs before the private repository has been cloned, before any dependency has
 * been installed, and before a single byte of the payload has been decrypted.
 * Everything it needs is the commit message, the sealed payload, one public key
 * and VAULT_MASTER.
 *
 * ── What is actually checked ────────────────────────────────────────────────
 *
 *   1. The receipt carries an Ed25519 signature made by the Worker. This is the
 *      whole of the authorisation: a commit's author line is a string the
 *      committer types, and nothing here reads it.
 *   2. The receipt has not expired. A receipt lifted out of a public commit is
 *      worthless within the half hour, and a replay of one inside its window
 *      can only ever re-apply the same payload, because —
 *   3. — the sha256 of the sealed payload is what the receipt names. A payload
 *      swapped for another under a valid receipt fails here.
 *   4. The one-time key opens under VAULT_MASTER. A payload sealed with a key
 *      this deployment did not issue cannot be opened, so it cannot be applied.
 *
 * What it does NOT check is which files the payload touches. That is apply.mjs,
 * because it needs the private repository in hand to know which albums changed.
 *
 * Usage:  node ci/verify-receipt.mjs <payload-file> <message-file>
 * Writes a one-line JSON verdict to stdout and the outputs GitHub Actions needs
 * to $GITHUB_OUTPUT.
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { trailer, verifyEd25519, unwrapSubmission } from "./lib/vault.mjs";

// How long a receipt is worth anything, plus a minute of clock drift between
// the Worker and this runner. Must not be shorter than the Worker's own TTL.
const MAX_AGE_S = 30 * 60 + 60;

function out(obj) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    const lines = Object.entries(obj)
      .map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, " ")}`)
      .join("\n");
    fs.appendFileSync(file, lines + "\n");
  }
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function refuse(why) {
  out({ ok: "false", why });
  process.exit(1);
}

const [, , payloadFile, messageFile] = process.argv;
if (!payloadFile || !messageFile) refuse("verify-receipt needs a payload and a message");

const message = fs.readFileSync(messageFile, "utf8");
const body = trailer(message, "Editor-Receipt");
const signature = trailer(message, "Editor-Signature");
const wrapped = trailer(message, "Editor-Key");

if (!body || !signature || !wrapped) refuse("the commit carries no editor receipt");

const pubkey = process.env.RDFX_EDITOR_PUBKEY || "";
if (!pubkey) refuse("RDFX_EDITOR_PUBKEY is not set — no receipt can be checked");
if (!verifyEd25519(pubkey, body, signature)) refuse("the receipt's signature does not verify");

let receipt;
try {
  receipt = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
} catch {
  refuse("the receipt is not readable");
}
if (receipt.v !== 1) refuse(`unknown receipt version ${receipt.v}`);

const age = Math.floor(Date.now() / 1000) - Number(receipt.ts || 0);
if (!Number.isFinite(age) || age < -120) refuse("the receipt is dated in the future");
if (age > MAX_AGE_S) refuse(`the receipt expired ${age - MAX_AGE_S}s ago`);

const sealed = fs.readFileSync(payloadFile);
const digest = crypto.createHash("sha256").update(sealed).digest("hex");
if (digest !== String(receipt.hash)) refuse("the payload is not the one the receipt was issued for");

// Unwrapped and then thrown away. The key is never an output and never a file:
// a workflow output is echoed into a run log that anybody can read on a public
// repository, and an artifact is downloadable by anybody too. The build job
// unwraps it again from the same trailer, which costs one HKDF and keeps the
// only copy inside the process that uses it.
let key;
try {
  key = unwrapSubmission(wrapped);
} catch {
  refuse("the submission key was not issued by this deployment");
}
if (key.length !== 32) refuse("the submission key is malformed");

out({
  ok: "true",
  sub: String(receipt.sub || ""),
  login: String(receipt.login || ""),
  admin: receipt.admin ? "true" : "false",
  ids: (receipt.ids || []).join(","),
  nonce: String(receipt.nonce || ""),
});
