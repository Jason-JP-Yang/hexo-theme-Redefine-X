"use strict";

/**
 * Which of the site's own pictures anything refers to.
 *
 * Answered from the SOURCES, before anything renders: every text file under
 * source/ (posts, drafts, pages, _data, scripts, styles), the site's and the
 * theme's config — on disk and as the objects Hexo holds in memory — the
 * scaffolds, and the whole theme (layouts, scripts, styles, languages).
 * Rendered HTML would be the wrong witness: routes render after the transcoder
 * has had to decide, and an encrypted post's pictures never reach a public
 * page at all.
 *
 * The matching is generous on purpose, because the two mistakes are not alike:
 * calling an unused picture used publishes a file nobody links to, while calling
 * a used one unused breaks a page. A reference is found by SUFFIX —
 * `/images/a.png`, `images/a.png`, `https://site/images/a.png`, `../images/a.png`
 * all end in the picture's path — case-insensitively, with percent-escapes and
 * HTML entities decoded, `.jpg`/`.jpeg` interchangeable, a transcoded `.avif`
 * standing for its source, an album photograph named relative to
 * source/masonry/, and a bare file name counting when the file naming it sits
 * in the same folder.
 */

const fs = require("fs");
const path = require("path");

const TEXT = /\.(md|markdown|html?|ejs|njk|swig|pug|ya?ml|json|js|mjs|cjs|ts|jsx|tsx|vue|css|styl|scss|sass|less|txt|xml|svg|webmanifest|toml)$/i;
const REF = /\.(png|jpe?g|gif|webp|avif|svg|bmp)(?![a-z0-9])/gi;
const BITMAP = /\.(png|jpe?g|gif|webp|bmp)$/i;
const WORD = /[a-z0-9_.-]/;
// Long enough for a full URL to a deep album path, short enough to stay cheap.
const WINDOW = 320;
const SKIP = new Set(["node_modules", ".git", ".deploy_git", "build"]);
// The editor's move journal names pictures it has already moved; that is not a use.
const JOURNAL = "_data/image-moves.json";

function decodeEscapes(s) {
  return s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch (e) {
      return run;
    }
  });
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const norm = (s) => s.replace(/\\/g, "/").toLowerCase();

/** Every name a reference to `rel` could end in. */
function spellings(rel) {
  const out = new Set();
  const base = norm(rel);
  const forms = [base];
  if (/\.jpe?g$/.test(base)) forms.push(base.replace(/\.jpe?g$/, (e) => (e === ".jpg" ? ".jpeg" : ".jpg")));
  if (BITMAP.test(base)) forms.push(base.replace(/\.[^./]+$/, ".avif"));
  for (const form of forms) {
    out.add(form);
    if (form.startsWith("masonry/")) out.add(form.slice("masonry/".length));
  }
  return out;
}

function walk(dir, out) {
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of list) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(full, out);
    } else if (TEXT.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * @param {object} o
 *   sourceDir, baseDir, themeDir   where to look
 *   candidates                     picture paths relative to source/
 *   memory                         extra text to search (the in-memory config)
 * @returns {Set<string>} the candidates something refers to
 */
function findUsed(o) {
  const global = new Map();
  const local = new Map();
  const add = (map, key, rel) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(rel);
  };

  for (const rel of o.candidates) {
    for (const s of spellings(rel)) add(global, s, rel);
    const dir = norm(path.posix.dirname(rel));
    if (!local.has(dir)) local.set(dir, new Map());
    for (const s of spellings(path.posix.basename(rel))) add(local.get(dir), s, rel);
  }

  const used = new Set();

  const scan = (text, dir) => {
    const near = dir == null ? null : local.get(dir);
    REF.lastIndex = 0;
    let m;
    while ((m = REF.exec(text))) {
      const end = m.index + m[0].length;
      const raw = norm(text.slice(Math.max(0, end - WINDOW), end));
      const decoded = norm(decodeEntities(decodeEscapes(raw)));
      for (const w of decoded === raw ? [raw] : [raw, decoded]) {
        for (let p = 0; p < w.length; p++) {
          // A path or a name starts after a separator, never mid-word.
          if (p && WORD.test(w[p - 1])) continue;
          const tail = w.slice(p);
          const hit = global.get(tail) || (near && near.get(tail));
          if (hit) for (const rel of hit) used.add(rel);
        }
      }
    }
  };

  const read = (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (e) {
      return "";
    }
  };

  const sourceDir = path.resolve(o.sourceDir);
  for (const file of walk(sourceDir, [])) {
    const rel = path.relative(sourceDir, file).replace(/\\/g, "/");
    if (rel === JOURNAL) continue;
    scan(read(file), norm(path.posix.dirname(rel)));
  }

  if (o.baseDir) {
    let top = [];
    try {
      top = fs.readdirSync(o.baseDir).filter((name) => /^_config.*\.ya?ml$/i.test(name));
    } catch (e) {
      /* no base dir to read */
    }
    for (const name of top) scan(read(path.join(o.baseDir, name)), null);
    for (const file of walk(path.join(o.baseDir, "scaffolds"), [])) scan(read(file), null);
  }

  if (o.themeDir) for (const file of walk(o.themeDir, [])) scan(read(file), null);

  for (const text of o.memory || []) scan(String(text || ""), null);

  return used;
}

module.exports = { findUsed };
