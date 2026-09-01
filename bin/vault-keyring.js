#!/usr/bin/env node
"use strict";

/**
 * `.vault/keys.json` ⇄ `.vault/keys.enc`.
 *
 *   npm run vault:seal    keys.json -> keys.enc   (before committing)
 *   npm run vault:open    keys.enc  -> keys.json  (in CI, after checkout)
 *
 * The keyring holds every post key in the clear, so it cannot be committed as
 * it stands — but a build machine that cannot read it cannot build an encrypted
 * post at all, and `vault.js` fails closed rather than publishing one. Sealing
 * it under VAULT_MASTER, which the builder must already hold, puts the keyring
 * in the private repository next to the content it belongs to: one commit
 * carries both, so a key and its ciphertext can never travel separately.
 *
 * Run from the SITE root.
 */

const fs = require("fs");
const path = require("path");
const secrets = require("../scripts/lib/secrets");
const vc = require("../scripts/lib/vault-crypto");

const ENC_FILE = path.join(secrets.ROOT, ".vault", "keys.enc");
const mode = (process.argv[2] || "").toLowerCase();
const force = process.argv.includes("--force");

function fail(message) {
  console.error("[vault] " + message);
  process.exit(1);
}

function master() {
  const raw = secrets.env("VAULT_MASTER");
  if (!raw) {
    fail(
      "VAULT_MASTER is not set. Put it in .env locally, or in the runner's secrets."
    );
  }
  const key = vc.fromB64url(raw);
  if (key.length !== vc.KEY_BYTES) {
    fail(`VAULT_MASTER must decode to ${vc.KEY_BYTES} bytes, got ${key.length}.`);
  }
  return key;
}

/** Sorted, so two machines sealing the same keyring produce the same JSON. */
function canonical(map) {
  const out = {};
  for (const id of Object.keys(map).sort()) out[id] = map[id];
  return JSON.stringify(out, null, 2) + "\n";
}

function readEnc(key) {
  let sealed;
  try {
    sealed = fs.readFileSync(ENC_FILE, "utf8").trim();
  } catch (e) {
    return null;
  }
  try {
    return JSON.parse(vc.open(key, vc.fromB64url(sealed)).toString("utf8"));
  } catch (e) {
    fail(
      ".vault/keys.enc does not open under this VAULT_MASTER. Either the secret is " +
        "wrong, or the file was sealed under a key that has since been rotated."
    );
  }
}

if (mode === "seal") {
  const key = master();
  const keys = secrets.readKeyring();
  if (!keys) fail("no .vault/keys.json to seal.");

  const text = canonical(keys);
  const current = readEnc(key);

  // The nonce is fresh on every seal, so re-sealing unchanged content would
  // rewrite the file and show up as a change in every commit.
  if (current && canonical(current) === text) {
    console.log("[vault] keys.enc is already current.");
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(ENC_FILE), { recursive: true });
  fs.writeFileSync(ENC_FILE, vc.b64url(vc.seal(key, text)) + "\n", "utf8");
  console.log(`[vault] sealed ${Object.keys(keys).length} key(s) into .vault/keys.enc`);
  process.exit(0);
}

if (mode === "open") {
  const key = master();
  const sealed = readEnc(key);
  if (!sealed) fail("no .vault/keys.enc to open.");

  const local = secrets.readKeyring();
  if (local && !force) {
    // A key that exists only locally has never reached the sealed copy, and
    // overwriting it would strand whatever it encrypted with no way back.
    const stranded = Object.keys(local).filter((id) => !(id in sealed));
    if (stranded.length) {
      fail(
        `.vault/keys.json holds ${stranded.length} key(s) that .vault/keys.enc does not:\n` +
          stranded.map((id) => `    ${id}  ${(local[id] || {}).title || ""}`).join("\n") +
          `\n  Run \`npm run vault:seal\` first, or pass --force to discard them.`
      );
    }
  }

  secrets.writeKeyring(sealed);
  console.log(`[vault] opened ${Object.keys(sealed).length} key(s) into .vault/keys.json`);
  process.exit(0);
}

console.error("usage: vault-keyring.js <seal|open> [--force]");
process.exit(1);
