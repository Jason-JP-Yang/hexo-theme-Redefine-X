#!/usr/bin/env node
/**
 * An Ed25519 pair for the editor's submission receipts.
 *
 * The private half is a Worker secret and signs the receipt a save carries. The
 * public half is published — in the theme config and in the public repository —
 * so that the person whose name is on a commit can prove it was theirs to
 * anybody, with no access to the Worker and no shared secret.
 *
 * Both are printed as raw 32-byte values in base64url, which is what
 * src/collab.js and the runner's verifier both expect: an Ed25519 key has one
 * length, so the DER wrappers around it are fixed prefixes rather than
 * something either side has to parse.
 */

import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);

console.log("EDITOR_SIGNING_KEY (secret — wrangler secret put EDITOR_SIGNING_KEY)");
console.log("  " + seed.toString("base64url"));
console.log();
console.log("EDITOR_PUBLIC_KEY (not a secret — wrangler.toml [vars], the theme config,");
console.log("                   and RDFX_EDITOR_PUBKEY in the public repository)");
console.log("  " + pub.toString("base64url"));
