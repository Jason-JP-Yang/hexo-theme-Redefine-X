/**
 * Put this run's build log where Blog Management can read it, and nowhere else.
 *
 * The log names every file the build touched, which for a site with encrypted
 * articles is a list of things that are encrypted precisely so their names are
 * not public. So it is sealed — under a key of its own, not the console's, so
 * that the log section can be granted to somebody who is not given the console
 * whole.
 *
 * ── Why this is a step of its own ───────────────────────────────────────────
 *
 * Because the log worth reading is the one from the build that FAILED, and a
 * failed build produces no site to attach it to. This runs after the build
 * either way, writes into the published tree directly, and the workflow
 * restores the previous artifact first — so a failure publishes yesterday's
 * site with today's log, rather than publishing nothing.
 *
 * Only the most recent is kept. A log is read once, by somebody who has just
 * been told a build failed; a history of them would be a growing pile of
 * ciphertext in the deploy tree that nobody opens.
 *
 * Usage:
 *   node ci/seal-log.mjs --src <private-repo> --out <public-tree> --log <file> --status <ok|failed> --reason <text>
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { open, seal, fromB64url, master, pageId } from "./lib/vault.mjs";

// What the console will show. A build that spent four minutes transcoding
// images produces far more than anybody reads, and the end is the part that
// says what went wrong.
const TAIL_BYTES = 512 * 1024;

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[String(process.argv[i]).replace(/^--/, "")] = process.argv[i + 1];
}

const src = path.resolve(args.src || ".");
const out = path.resolve(args.out || "public");

function quit(why) {
  process.stderr.write(`::warning::the build log was not stored — ${why}\n`);
  process.exit(0);
}

let keyring;
try {
  const sealed = fs.readFileSync(path.join(src, ".vault", "keys.enc"), "utf8").trim();
  keyring = JSON.parse(open(master(), fromB64url(sealed)).toString("utf8"));
} catch {
  quit("the keyring did not open");
}

const entry = keyring[pageId("buildlog")];
if (!entry || !entry.key || !entry.slug) quit("the build log has no key yet — run a build at home first");

let prefix = "v";
try {
  const yaml = createRequire(path.join(src, "package.json"))("js-yaml");
  const config = yaml.load(fs.readFileSync(path.join(src, "_config.redefine-x.yml"), "utf8"));
  prefix = String(((config.backend || {}).encryption || {}).prefix || "/v").replace(/^\/+|\/+$/g, "");
} catch {
  /* the default is the theme's default */
}

let text = "";
try {
  const stat = fs.statSync(args.log);
  const fd = fs.openSync(args.log, "r");
  const length = Math.min(stat.size, TAIL_BYTES);
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, stat.size - length);
  fs.closeSync(fd);
  // The slice can land in the middle of a multi-byte character, and decoding
  // from a continuation byte paints a replacement character at the head of the
  // transcript — which reads as corruption. Walk forward to the first byte that
  // starts a code point before decoding.
  let start = 0;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  text = buf.subarray(start).toString("utf8");
  if (stat.size > length) text = `… ${stat.size - length} earlier bytes omitted …\n` + text;
} catch {
  text = "(no output was captured)";
}

// The build the published tree now carries: this run's when it succeeded, the
// restored previous one when it did not — either way, what this log ships with.
let build = "";
try {
  build = String(JSON.parse(fs.readFileSync(path.join(out, "version.json"), "utf8")).build || "");
} catch {
  /* deploy is off, or there was never a build */
}

const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
const record = {
  at: new Date().toISOString(),
  status: String(args.status || "ok"),
  reason: String(args.reason || ""),
  run: GITHUB_RUN_ID || "",
  url: GITHUB_RUN_ID ? `${GITHUB_SERVER_URL || "https://github.com"}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : "",
  build,
  text,
};

const dir = path.join(out, prefix, entry.slug);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "log.bin"), seal(fromB64url(entry.key), JSON.stringify(record)));

process.stdout.write(`sealed ${text.length} bytes of log into ${prefix}/${entry.slug}/log.bin\n`);
