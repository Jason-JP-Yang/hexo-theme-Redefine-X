#!/usr/bin/env node
"use strict";

/**
 * `.vault/keys.json` ⇄ `.vault/keys.enc`.
 *
 *   npm run vault:open    in CI, after checkout
 *
 * Sealing is NOT a command any more — `hexo generate` does it, so the sealed
 * copy can never be a build behind the keys it protects. `seal` is kept here
 * for the case where you need it without a build.
 *
 * The keyring holds every post key in the clear, so only the sealed copy is
 * committed — one commit then carries a key and its ciphertext together.
 * Run from the SITE root.
 */

const fs = require("fs");
const path = require("path");
const secrets = require("../scripts/lib/secrets");
const vc = require("../scripts/lib/vault-crypto");
const store = require("../scripts/lib/vault-store");

const ENC_FILE = path.join(secrets.ROOT, ".vault", "keys.enc");
const mode = (process.argv[2] || "").toLowerCase();
const force = process.argv.includes("--force");

function fail(message) {
  console.error("[vault] " + message);
  process.exit(1);
}

function master() {
  const raw = secrets.env("VAULT_MASTER");
  if (!raw) fail("VAULT_MASTER is not set (.env locally, a secret in CI).");
  const key = vc.fromB64url(raw);
  if (key.length !== vc.KEY_BYTES) {
    fail(`VAULT_MASTER must decode to ${vc.KEY_BYTES} bytes, got ${key.length}.`);
  }
  return key;
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
    fail(".vault/keys.enc does not open under this VAULT_MASTER.");
  }
}

if (mode === "seal") {
  const result = store.seal();
  if (!result) fail("no .vault/keys.json to seal.");
  console.log(
    result.changed
      ? `[vault] sealed ${result.count} key(s) into .vault/keys.enc`
      : "[vault] keys.enc is already current."
  );
  process.exit(0);
}

if (mode === "open") {
  const key = master();
  const sealed = readEnc(key);
  if (!sealed) fail("no .vault/keys.enc to open.");

  const local = secrets.readKeyring();
  if (local && !force) {
    // A key only present locally has never been sealed; overwriting it would
    // strand whatever it encrypted.
    const stranded = Object.keys(local).filter((id) => !(id in sealed));
    if (stranded.length) {
      fail(
        `.vault/keys.json holds ${stranded.length} key(s) that .vault/keys.enc does not:\n` +
          stranded.map((id) => `    ${id}  ${(local[id] || {}).title || ""}`).join("\n") +
          `\n  Run a local build to seal them, or pass --force to discard them.`
      );
    }
  }

  secrets.writeKeyring(sealed);
  console.log(`[vault] opened ${Object.keys(sealed).length} key(s) into .vault/keys.json`);
  process.exit(0);
}

console.error("usage: vault-keyring.js <seal|open> [--force]");
process.exit(1);
