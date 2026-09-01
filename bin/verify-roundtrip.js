#!/usr/bin/env node
"use strict";

/**
 * The editor's correctness gate.
 *
 *   npm run verify:roundtrip
 *
 * Asserts the one law the whole document model rests on:
 *
 *   docToMarkdown(markdownToDoc(s)) === s
 *
 * for every post and draft in the repository. If it holds, opening a post in the
 * editor and saving it without typing produces a zero-line diff — which is what
 * makes every OTHER diff readable, and what makes an unrecognised construct a
 * fidelity problem in the canvas rather than data loss in the file.
 *
 * It also reports how many blocks fell through to `raw`. That number is the
 * parser's coverage, and it is a quality metric rather than a failure: a `raw`
 * block round-trips perfectly, it just cannot be edited visually.
 *
 * Run from the SITE root.
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const DIRS = [path.join(ROOT, "source", "_posts"), path.join(ROOT, "source", "_drafts")];
const MODULE = path.join(__dirname, "..", "source", "js", "plugins", "editor", "markdown.js");

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(full));
    else if (/\.md$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/** The first line at which two strings differ, with a little context. */
function firstDifference(a, b) {
  const left = a.split("\n");
  const right = b.split("\n");
  const max = Math.max(left.length, right.length);

  for (let i = 0; i < max; i++) {
    if (left[i] === right[i]) continue;
    return {
      line: i + 1,
      expected: left[i] === undefined ? "(end of file)" : left[i],
      actual: right[i] === undefined ? "(end of file)" : right[i],
    };
  }
  return null;
}

(async function main() {
  const md = await import("file://" + MODULE.replace(/\\/g, "/"));

  const files = DIRS.flatMap(walk);
  if (!files.length) {
    console.log("[roundtrip] no posts to check.");
    process.exit(0);
  }

  let failed = 0;
  let rawBlocks = 0;
  let totalBlocks = 0;
  const rawKinds = new Map();

  for (const file of files) {
    // The parser normalises CRLF, so the comparison is against the normalised
    // source. A repository that stores CRLF would otherwise fail every file for
    // a reason that has nothing to do with the parser.
    const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");

    let doc;
    try {
      doc = md.markdownToDoc(source);
    } catch (err) {
      console.error(`  FAIL  ${rel}\n        parser threw: ${err.message}`);
      failed++;
      continue;
    }

    totalBlocks += doc.blocks.length;
    for (const block of doc.blocks) {
      if (block.type !== "raw") continue;
      rawBlocks++;
      const head = (block.src || "").trim().split("\n")[0].slice(0, 48) || "(blank)";
      rawKinds.set(head, (rawKinds.get(head) || 0) + 1);
    }

    const back = md.docToMarkdown(doc);
    if (back === source) continue;

    failed++;
    const diff = firstDifference(source, back);
    console.error(`  FAIL  ${rel}`);
    if (diff) {
      console.error(`        line ${diff.line}`);
      console.error(`          in:  ${JSON.stringify(diff.expected)}`);
      console.error(`          out: ${JSON.stringify(diff.actual)}`);
    } else {
      console.error(`        lengths differ: ${source.length} in, ${back.length} out`);
    }
  }

  const coverage = totalBlocks ? (100 * (1 - rawBlocks / totalBlocks)).toFixed(1) : "100.0";
  console.log(
    `[roundtrip] ${files.length - failed}/${files.length} file(s) round-trip exactly · ` +
      `${totalBlocks} block(s), ${rawBlocks} raw (${coverage}% modelled)`
  );

  if (rawKinds.size) {
    console.log("[roundtrip] constructs that fell through to `raw`:");
    for (const [head, count] of Array.from(rawKinds).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`    ${String(count).padStart(3)}x  ${head}`);
    }
  }

  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("[roundtrip] " + (err && err.stack ? err.stack : err));
  process.exit(1);
});
