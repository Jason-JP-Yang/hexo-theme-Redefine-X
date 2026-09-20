/**
 * Sign a locally built artifact so the runner will publish it.
 *
 * A push to the public repository's main branch is rejected and force-reset
 * unless the runner can account for it. There are exactly two accounts it
 * takes: a commit it made itself, and a commit signed here.
 *
 * "The owner pushed it" is deliberately NOT one of them. The token an editing
 * session holds belongs to the same account, so an identity check would pass
 * for the one thing it exists to stop.
 *
 * What is signed is the TREE, not the message: it is the bytes being published
 * that need vouching for, and a tree hash is stable across an amend or a
 * rebase, so a commit that is reworded does not have to be re-signed.
 *
 * Usage, from the site root after `npm run build`:
 *   npm run sign
 * It stages the artifact and prints the trailer to put on the commit.
 *
 * git runs in the artifact directory rather than in the current one, worked out
 * from this file's own location: the thing being signed is the tree the RUNNER
 * will publish, and running it a directory too high would sign the source.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mac } from "./lib/vault.mjs";

const artifact = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Read .env the way the build does, so this needs no environment of its own.
if (!process.env.VAULT_MASTER) {
  for (const dir of [process.cwd(), artifact, path.join(artifact, "..")]) {
    try {
      const line = fs
        .readFileSync(path.join(dir, ".env"), "utf8")
        .split(/\r?\n/)
        .find((l) => /^\s*VAULT_MASTER\s*=/.test(l));
      if (line) {
        process.env.VAULT_MASTER = line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
        break;
      }
    } catch {
      /* keep looking */
    }
  }
}

const git = (...args) => execFileSync("git", args, { cwd: artifact, encoding: "utf8" }).trim();

git("add", "-A");
const tree = git("write-tree");
process.stdout.write(`Deploy-Signature: ${mac("rdfx-deploy", tree)}\n`);
