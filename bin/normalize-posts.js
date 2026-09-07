#!/usr/bin/env node
"use strict";

/**
 * Bring `source/_posts` to the spelling the editor and the renderer agree on.
 *
 * Everything here is safe against `hexo-renderer-marked` with `breaks: true`,
 * which is this site's setting — a single newline inside a paragraph is a `<br>`
 * there, so the changes below are visible only where they are meant to be.
 *
 *   1. CRLF -> LF. The editor's parser normalises line endings on the way in
 *      and emits LF on the way out, so a CRLF file is rewritten whole by the
 *      first save — one edited word, a diff touching every line.
 *   2. Trailing whitespace goes. Two trailing spaces are markdown's hard break,
 *      which `breaks: true` already gives every newline, so they say nothing.
 *   3. A single newline between two finished sentences becomes a blank line, and
 *      a lone image gets a blank line on both sides. Written as `<br>`, an image
 *      is stuck inside the paragraph above it: the editor cannot show it as a
 *      figure, and the page cannot either.
 *
 * What it will NOT touch, because guessing there costs content:
 *   - anything the parser does not call a paragraph — code fences, math, tags,
 *     tables, lists, quotes, raw HTML;
 *   - indented lines, which markdown reads as a code block;
 *   - a break between two fragments, where one side does not end a sentence.
 *     Labelled lines and verse stay exactly as written;
 *   - error books, whose `Q:` / `A:` / `=` lines are a line-oriented syntax of
 *     their own where a blank line means something.
 *
 * Usage:  node bin/normalize-posts.js [--write] [--dir <path>]
 *         Reports without `--write`.
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const dirArg = args.indexOf("--dir");
const POSTS = path.resolve(dirArg >= 0 ? args[dirArg + 1] : path.join(process.cwd(), "source/_posts"));

// A finished sentence: CJK and Latin terminals, allowing a closing bracket or
// quote after them.
const ENDS_SENTENCE = /[.!?。！？…]["'”’」』）)\]]*$/;
const LONE_IMAGE = /^!\[[^\]]*\]\([^)]*\)$/;
const INDENTED = /^(?: {4}|\t)/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const MATH = /^\s*\$\$\s*$/;
const TAG = /^\s*\{%/;
const BLOCK_START = /^\s*(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|<[a-zA-Z!/]|\|)/;

function frontMatterEnd(lines) {
  if (lines[0] !== "---") return 0;
  for (let i = 1; i < lines.length; i++) if (lines[i] === "---") return i + 1;
  return 0;
}

/** Is a blank line wanted between these two? */
function shouldSplit(above, below) {
  if (INDENTED.test(above) || INDENTED.test(below)) return false;
  if (BLOCK_START.test(above) || BLOCK_START.test(below)) return false;
  if (ERROR_BOOK.test(above) || ERROR_BOOK.test(below)) return false;
  if (LONE_IMAGE.test(below.trim()) || LONE_IMAGE.test(above.trim())) return true;
  return ENDS_SENTENCE.test(above.trim());
}

// `Q:` / `A:` / `X:` / `= C` / `! A` — a line-oriented syntax where the parser
// carries state from one line to the next, so a blank line is a statement.
const ERROR_BOOK = /^\s*(?:[A-Z]:|[=!]\s)/;

function normalize(source) {
  const text = source.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
  const lines = text.split("\n");
  const start = frontMatterEnd(lines);
  const out = lines.slice(0, start);

  // Line endings and trailing space still get fixed; nothing is re-flowed.
  const book = /^errorbook:\s*true/m.test(lines.slice(0, start).join("\n")) || /\{%\s*error-?book\b/.test(text);
  if (book) return text.replace(/\n*$/, "\n");

  let inFence = false;
  let inMath = false;
  let inTag = false;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);

    if (FENCE.test(line)) inFence = !inFence;
    else if (MATH.test(line)) inMath = !inMath;
    else if (TAG.test(line)) inTag = !/^\s*\{%\s*end/.test(line) && !/^\s*\{%\s*(btn|button)\b/i.test(line);

    if (inFence || inMath || inTag) continue;

    const next = lines[i + 1];
    if (next === undefined || !line.trim() || !next.trim()) continue;
    if (FENCE.test(next) || MATH.test(next) || TAG.test(next)) continue;
    if (shouldSplit(line, next)) out.push("");
  }

  return out.join("\n").replace(/\n*$/, "\n");
}

const files = fs
  .readdirSync(POSTS)
  .filter((f) => f.toLowerCase().endsWith(".md"))
  .sort();

let changed = 0;
for (const name of files) {
  const file = path.join(POSTS, name);
  const before = fs.readFileSync(file, "utf8");
  const after = normalize(before);
  if (before === after) continue;

  changed++;
  const crlf = /\r\n/.test(before) ? " crlf" : "";
  const added = after.split("\n").length - before.replace(/\r\n/g, "\n").split("\n").length;
  console.log(`${WRITE ? "wrote" : "would change"}  ${name}${crlf}  (+${added} blank line(s))`);
  if (WRITE) fs.writeFileSync(file, after, "utf8");
}

console.log(`\n${changed} of ${files.length} file(s)${WRITE ? " rewritten" : " would change"}.`);
