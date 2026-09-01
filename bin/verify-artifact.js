#!/usr/bin/env node
"use strict";

/**
 * Does this build reproduce the artifact that is already published?
 *
 *   npm run verify:artifact -- <reference-dir> <candidate-dir> [--ignore <prefix>]...
 *
 * Byte equality is the standard everywhere EXCEPT the encrypted tree, where it
 * is not merely unmet but impossible: a post key is stable across builds, so the
 * GCM nonce has to be redrawn on every one — reusing a (key, nonce) pair leaks
 * the XOR of the two plaintexts and hands over the authentication key. Every
 * `.bin` under the vault prefix therefore differs by design, and what is checked
 * instead is the path set and the exact byte LENGTH of each blob, which is
 * `12 + plaintext + 16` and so pins the plaintext length of every one.
 *
 * Exit 0 only when nothing is missing, nothing is unexpected, every sealed blob
 * is the same size, and every other file is identical.
 */

const fs = require("fs");
const path = require("path");
const siteConfig = require("../scripts/lib/site-config");

const args = process.argv.slice(2);
const ignores = [];
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--ignore") ignores.push(String(args[++i] || "").replace(/^\/+|\/+$/g, ""));
  else positional.push(args[i]);
}

if (positional.length < 2) {
  console.error("usage: verify-artifact.js <reference-dir> <candidate-dir> [--ignore <prefix>]...");
  process.exit(1);
}

const [referenceDir, candidateDir] = positional.map((p) => path.resolve(p));
const vaultPrefix = String(siteConfig.load().theme?.backend?.vault_prefix || "/v").replace(/^\/+|\/+$/g, "");

const TEXT_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".xml", ".txt", ".svg", ".map", ".yml", ".webmanifest"]);
const WINDOW = 60;

function walk(root, dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else out.add(path.relative(root, full).replace(/\\/g, "/"));
  }
  return out;
}

const ignored = (rel) => ignores.some((p) => rel === p || rel.startsWith(p + "/"));

/** Sealed by the vault: fresh nonce every build, so only the length is stable. */
const volatile = (rel) => rel.startsWith(vaultPrefix + "/") && rel.endsWith(".bin");

function excerpt(a, b) {
  const limit = Math.min(a.length, b.length);
  let at = limit;
  for (let i = 0; i < limit; i++) {
    if (a[i] !== b[i]) {
      at = i;
      break;
    }
  }
  const from = Math.max(0, at - WINDOW);
  const show = (buf) =>
    JSON.stringify(buf.subarray(from, Math.min(buf.length, at + WINDOW)).toString("utf8")).slice(1, -1);
  return { at, reference: show(a), candidate: show(b) };
}

const reference = walk(referenceDir, referenceDir, new Set());
const candidate = walk(candidateDir, candidateDir, new Set());

const missing = [];
const extra = [];
const sized = [];
const differing = [];
let sealed = 0;
let matched = 0;
let skipped = 0;

for (const rel of reference) {
  if (ignored(rel)) {
    skipped++;
    continue;
  }
  if (!candidate.has(rel)) {
    missing.push(rel);
    continue;
  }

  const a = fs.readFileSync(path.join(referenceDir, rel));
  const b = fs.readFileSync(path.join(candidateDir, rel));

  if (volatile(rel)) {
    if (a.length === b.length) sealed++;
    else sized.push({ rel, reference: a.length, candidate: b.length });
    continue;
  }

  if (a.equals(b)) {
    matched++;
    continue;
  }
  differing.push({
    rel,
    reference: a.length,
    candidate: b.length,
    text: TEXT_EXT.has(path.extname(rel).toLowerCase()),
    detail: excerpt(a, b),
  });
}

for (const rel of candidate) {
  if (ignored(rel)) continue;
  if (!reference.has(rel)) extra.push(rel);
}

function section(title, rows, render) {
  if (!rows.length) return;
  console.log(`\n── ${title} (${rows.length}) ${"─".repeat(Math.max(0, 56 - title.length))}`);
  for (const row of rows.slice(0, 40)) console.log(render(row));
  if (rows.length > 40) console.log(`   … and ${rows.length - 40} more`);
}

console.log(`reference  ${referenceDir}  (${reference.size} files)`);
console.log(`candidate  ${candidateDir}  (${candidate.size} files)`);
console.log(`vault prefix "${vaultPrefix}/" — sealed blobs compared by length only`);

section("MISSING — published but not rebuilt", missing, (r) => `   ${r}`);
section("EXTRA — rebuilt but not published", extra, (r) => `   ${r}`);
section("SIZE — sealed blob changed length", sized, (r) => `   ${r.rel}\n      ${r.reference} -> ${r.candidate} bytes`);
section("DIFF — content changed", differing, (r) => {
  const head = `   ${r.rel}  (${r.reference} -> ${r.candidate} bytes, first difference at byte ${r.detail.at})`;
  if (!r.text) return head;
  return `${head}\n      published: …${r.detail.reference}…\n      rebuilt  : …${r.detail.candidate}…`;
});

const failures = missing.length + extra.length + sized.length + differing.length;

console.log(
  `\n${matched} identical, ${sealed} sealed blob(s) matched by length` +
    (skipped ? `, ${skipped} ignored` : "")
);

if (!failures) {
  console.log("\nPASS — the rebuild reproduces the published artifact.");
  process.exit(0);
}

console.log(
  `\nFAIL — ${failures} difference(s): ${missing.length} missing, ${extra.length} extra, ` +
    `${sized.length} resized, ${differing.length} changed.`
);
process.exit(1);
