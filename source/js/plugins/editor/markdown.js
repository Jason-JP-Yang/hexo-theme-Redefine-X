/**
 * Markdown ⇄ blocks.
 *
 * ── The round-trip law ──────────────────────────────────────────────────────
 *
 *   blocksToMarkdown(markdownToBlocks(s)) === s      for every s
 *
 * It holds by CONSTRUCTION rather than by the serializer being a careful
 * inverse of the parser: every block keeps the exact source slice it came from
 * (`src`) and the exact whitespace that followed it (`after`), and a block is
 * re-emitted from its fields only once something has actually edited it. A
 * document you open and close is therefore byte-identical, whatever the parser
 * did or did not understand about it, and a document you edit differs only in
 * the blocks you touched — which is also what makes the git diff readable.
 *
 * The escape hatch is the `raw` block: anything the parser does not recognise
 * becomes one, shows its source, and is never rewritten. So parser coverage is
 * a quality metric, never a correctness risk.
 *
 * ── Inline ──────────────────────────────────────────────────────────────────
 *
 * Paragraph-ish blocks are edited as rendered rich text, so the inline layer is
 * a genuine pair: `inlineToHTML` for the canvas, `htmlToInline` for reading the
 * contenteditable back. Everything it does not model — an HTML tag, an odd
 * construct — survives as literal text through both directions.
 */

const BLOCK_ID = { n: 0 };

export function nextId() {
  BLOCK_ID.n += 1;
  return "b" + BLOCK_ID.n;
}

/* ─── front matter ─────────────────────────────────────────────────────────── */

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Split a post into its front matter and its body.
 *
 * The front matter is kept as TEXT. Re-emitting parsed YAML would reorder keys,
 * requote strings and drop the comments `scaffolds/post.md` ships with — a
 * diff on every save that touched nothing anyone wrote.
 */
export function splitFrontMatter(source) {
  const text = String(source == null ? "" : source);
  const match = text.match(FRONT_MATTER);
  if (!match) return { front: "", body: text, raw: "" };
  return { front: match[1], body: text.slice(match[0].length), raw: match[0] };
}

/** A flat `key: value` view of the front matter, for the inspector. */
export function parseFrontMatter(front) {
  const out = {};
  const lines = String(front || "").split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    // A key with nothing after the colon owns the indented block below it,
    // which for this scaffold is always a YAML list.
    if (!value) {
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s?/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*-\s?/, "").trim());
        j++;
      }
      if (items.length) {
        out[key] = items;
        i = j - 1;
        continue;
      }
      out[key] = "";
      continue;
    }

    if (/^\[.*\]$/.test(value)) {
      out[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
      continue;
    }
    out[key] = unquote(value);
  }
  return out;
}

function unquote(value) {
  const s = String(value).trim();
  if (s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

function quoteIfNeeded(value) {
  const s = String(value == null ? "" : value);
  if (!s) return "";
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) || /:\s/.test(s) || /^\s|\s$/.test(s)) {
    return '"' + s.replace(/"/g, '\\"') + '"';
  }
  return s;
}

/**
 * Keys Hexo's Post schema declares as String, where a bare `key:` is fatal.
 *
 * warehouse runs `validate` on insert but not `cast`, so an explicitly null
 * value never reaches the schema default: `excerpt:` with nothing after it
 * parses as null and the whole build dies with "`null` is not a string!" before
 * a single page renders. Every other key here is untyped and may be left bare,
 * which is why this is a list and not a blanket rule.
 */
const STRING_KEYS = new Set(["title", "excerpt", "layout", "content", "more", "raw", "id"]);

/** Empty, spelled so Hexo can read it: `""` for the typed keys, bare for the rest. */
function emptyFor(key) {
  return STRING_KEYS.has(key) ? '""' : "";
}

/**
 * Write one key back into the front-matter TEXT, leaving every other line —
 * comments, key order, blank lines — exactly as it was. A key that is not there
 * is appended; a key set to `null` is removed.
 */
export function setFrontMatterKey(front, key, value) {
  const lines = String(front || "").split(/\r?\n/);
  const isList = Array.isArray(value);
  const head = new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:");

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i])) {
      start = i;
      break;
    }
  }

  // The line itself plus any indented list that belongs to it.
  let end = start;
  if (start >= 0) {
    end = start + 1;
    while (end < lines.length && /^\s*-\s?/.test(lines[end])) end++;
  }

  if (value === null || value === undefined) {
    if (start < 0) return lines.join("\n");
    lines.splice(start, end - start);
    return lines.join("\n");
  }

  const written = isList ? "" : quoteIfNeeded(value);
  const replacement = isList
    ? [key + ":"].concat(value.filter(Boolean).map((item) => "  - " + quoteIfNeeded(item)))
    : [key + ": " + (written || emptyFor(key))];

  if (start < 0) lines.push.apply(lines, replacement);
  else lines.splice(start, end - start, ...replacement);

  return lines.join("\n");
}

/* ─── block parsing ────────────────────────────────────────────────────────── */

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const UL_ITEM = /^(\s*)([-*+])\s+(.*)$/;
const OL_ITEM = /^(\s*)(\d+)([.)])\s+(.*)$/;
const IMAGE_ONLY = /^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+["']([^"']*)["'])?\s*\)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const INDENTED_CODE = /^(?: {4}|\t)\s*\S/;
const MATH_OPEN = /^\s*\$\$\s*$/;
const TAG_OPEN = /^\s*\{%\s*([A-Za-z][\w-]*)([^%]*?)%\}\s*$/;
const TAG_INLINE = /^\s*\{%\s*([A-Za-z][\w-]*)([^%]*?)%\}\s*$/;

// Which tag names open a block that must be closed by `{% endX %}`. Mirrors the
// `ends: true` registrations in scripts/modules/.
const PAIRED_TAGS = new Set([
  "note", "notes", "subnote",
  "notel", "notelarge", "notel-large", "notes-large", "subwarning",
  "box", "folding",
  "tabs", "subtabs", "subsubtabs",
  "errorbook", "error-book", "ebook",
  "exifimage",
]);

const VOID_TAGS = new Set(["btn", "button"]);

function block(type, fields) {
  return Object.assign({ id: nextId(), type, src: "", after: "\n\n", dirty: false }, fields);
}

/**
 * Source → blocks.
 *
 * Line-oriented and single-pass. Every branch consumes a whole construct and
 * records the line range it consumed; the separators between blocks are worked
 * out afterwards from those ranges.
 *
 * ── The separator ───────────────────────────────────────────────────────────
 *
 * Kept as the literal text between two blocks, not as a count of newlines. A
 * "blank" line is blank to the parser when it holds only whitespace, and two
 * posts here have lines of spaces and one of an ideographic space — counting
 * newlines would quietly delete them, which is a rewrite of a file nobody asked
 * to rewrite. Reconstructed as the newline that ends the previous block, the
 * intervening lines verbatim, and the newline that starts the next.
 */
export function parseBlocks(body) {
  const text = String(body == null ? "" : body).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const blocks = [];

  // Blank lines before the first block belong to no block. Almost every post
  // has one — the newline after the front matter's closing `---`.
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const lead = i ? lines.slice(0, i).join("\n") + "\n" : "";

  const push = (b, from, to) => {
    b.src = lines.slice(from, to).join("\n");
    b.from = from;
    b.to = to;
    blocks.push(b);
  };

  while (i < lines.length) {
    const line = lines[i];

    // A blank run is a separator, not a block. It is measured in the pass below.
    if (!line.trim()) {
      while (i < lines.length && !lines[i].trim()) i++;
      continue;
    }

    // ── fenced code, mermaid, and anything else a fence can hold ──────────
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[2];
      const lang = (fence[3] || "").trim();
      let j = i + 1;
      while (j < lines.length && !new RegExp("^\\s*" + marker[0] + "{" + marker.length + ",}\\s*$").test(lines[j])) j++;
      const code = lines.slice(i + 1, j).join("\n");
      const type = lang.toLowerCase() === "mermaid" ? "mermaid" : "code";
      push(block(type, { lang, code, fence: marker }), i, Math.min(j + 1, lines.length));
      i = Math.min(j + 1, lines.length);
      continue;
    }

    // ── display math ──────────────────────────────────────────────────────
    if (MATH_OPEN.test(line)) {
      let j = i + 1;
      while (j < lines.length && !MATH_OPEN.test(lines[j])) j++;
      push(block("math", { tex: lines.slice(i + 1, j).join("\n") }), i, Math.min(j + 1, lines.length));
      i = Math.min(j + 1, lines.length);
      continue;
    }

    // ── a paired custom tag ───────────────────────────────────────────────
    const open = line.match(TAG_OPEN);
    if (open && PAIRED_TAGS.has(open[1].toLowerCase())) {
      const name = open[1];
      const close = new RegExp("^\\s*\\{%\\s*end" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*%\\}\\s*$", "i");
      let j = i + 1;
      let depth = 1;
      const nested = new RegExp("^\\s*\\{%\\s*" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
      while (j < lines.length) {
        if (nested.test(lines[j])) depth++;
        else if (close.test(lines[j]) && --depth === 0) break;
        j++;
      }
      push(
        block("component", {
          name: name.toLowerCase(),
          args: open[2].trim(),
          body: lines.slice(i + 1, j).join("\n"),
        }),
        i,
        Math.min(j + 1, lines.length)
      );
      i = Math.min(j + 1, lines.length);
      continue;
    }

    // ── a void custom tag on its own line ─────────────────────────────────
    const solo = line.match(TAG_INLINE);
    if (solo && VOID_TAGS.has(solo[1].toLowerCase())) {
      push(block("component", { name: solo[1].toLowerCase(), args: solo[2].trim(), body: null }), i, i + 1);
      i += 1;
      continue;
    }

    // ── table ─────────────────────────────────────────────────────────────
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes("|")) j++;
      const table = parseTable(lines.slice(i, j));
      if (table) {
        push(block("table", table), i, j);
        i = j;
        continue;
      }
    }

    // ── heading ───────────────────────────────────────────────────────────
    const heading = line.match(HEADING);
    if (heading) {
      push(block("heading", { level: heading[1].length, text: heading[2].trim() }), i, i + 1);
      i += 1;
      continue;
    }

    // ── horizontal rule ───────────────────────────────────────────────────
    if (HR.test(line)) {
      push(block("hr", {}), i, i + 1);
      i += 1;
      continue;
    }

    // ── blockquote ────────────────────────────────────────────────────────
    if (QUOTE.test(line)) {
      let j = i;
      while (j < lines.length && lines[j].trim() && QUOTE.test(lines[j])) j++;
      push(
        block("quote", { text: lines.slice(i, j).map((l) => l.replace(QUOTE, "")).join("\n") }),
        i,
        j
      );
      i = j;
      continue;
    }

    // ── list ──────────────────────────────────────────────────────────────
    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      let j = i;
      const items = [];
      const ordered = OL_ITEM.test(line);
      let marker = ordered ? (line.match(OL_ITEM)[3] || ".") : (line.match(UL_ITEM)[2] || "-");

      while (j < lines.length && lines[j].trim()) {
        const ul = lines[j].match(UL_ITEM);
        const ol = lines[j].match(OL_ITEM);
        if (ol && ordered) items.push({ indent: ol[1].length, text: ol[4] });
        else if (ul && !ordered) items.push({ indent: ul[1].length, text: ul[3] });
        else if (items.length && /^\s+\S/.test(lines[j])) {
          // A continuation line belongs to the item above it.
          items[items.length - 1].text += "\n" + lines[j];
        } else break;
        j++;
      }
      if (items.length) {
        push(block("list", { ordered, marker, items }), i, j);
        i = j;
        continue;
      }
    }

    // ── a lone image is a figure, not a paragraph ─────────────────────────
    if (IMAGE_ONLY.test(line.trim())) {
      const m = line.trim().match(IMAGE_ONLY);
      // `url`, not `src`: every block carries `src` as the exact source text it
      // was parsed from, and `push` below writes it. An image that stored its
      // address there had it overwritten with its own markdown line, so the
      // canvas asked the server for `/![](/images/x.jpeg)` and a save re-emitted
      // that inside a second set of brackets.
      push(block("image", { alt: m[1], url: m[2], title: m[3] || "" }), i, i + 1);
      i += 1;
      continue;
    }

    // ── an HTML block ─────────────────────────────────────────────────────
    if (/^\s*<[a-zA-Z!/]/.test(line)) {
      let j = i;
      while (j < lines.length && lines[j].trim()) j++;
      push(block("raw", { text: lines.slice(i, j).join("\n") }), i, j);
      i = j;
      continue;
    }

    // ── an indented code block ────────────────────────────────────────────
    // Last, so a list's own indented continuation lines are already gone. Kept
    // as `raw` because that mounts a textarea: read as a paragraph the leading
    // spaces are whitespace the browser collapses, and the first edit to the
    // block deletes the indentation that made it code.
    if (INDENTED_CODE.test(line)) {
      let j = i;
      while (j < lines.length && (INDENTED_CODE.test(lines[j]) || !lines[j].trim())) j++;
      while (j > i && !lines[j - 1].trim()) j--;
      push(block("raw", { text: lines.slice(i, j).join("\n") }), i, j);
      i = j;
      continue;
    }

    // ── paragraph ─────────────────────────────────────────────────────────
    let j = i;
    while (
      j < lines.length &&
      lines[j].trim() &&
      !HEADING.test(lines[j]) &&
      !HR.test(lines[j]) &&
      !QUOTE.test(lines[j]) &&
      !FENCE.test(lines[j]) &&
      !MATH_OPEN.test(lines[j]) &&
      !TAG_OPEN.test(lines[j]) &&
      !(j > i && (UL_ITEM.test(lines[j]) || OL_ITEM.test(lines[j])))
    ) {
      j++;
    }
    push(block("paragraph", { text: lines.slice(i, j).join("\n") }), i, Math.max(j, i + 1));
    i = Math.max(j, i + 1);
  }

  for (let n = 0; n < blocks.length; n++) {
    const to = blocks[n].to;
    const last = n + 1 === blocks.length;
    const next = last ? lines.length : blocks[n + 1].from;

    blocks[n].after = last
      ? to < lines.length
        ? "\n" + lines.slice(to).join("\n")
        : ""
      : "\n" + lines.slice(to, next).join("\n") + (next > to ? "\n" : "");

    delete blocks[n].from;
    delete blocks[n].to;
  }

  blocks.lead = lead;
  return blocks;
}

function parseTable(rows) {
  const cells = (row) => {
    let line = row.trim();
    if (line.startsWith("|")) line = line.slice(1);
    if (line.endsWith("|")) line = line.slice(0, -1);
    return line.split("|").map((c) => c.trim());
  };

  const header = cells(rows[0]);
  const divider = cells(rows[1]);
  if (divider.length !== header.length) return null;

  const align = divider.map((d) => {
    const left = d.startsWith(":");
    const right = d.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });

  const body = rows.slice(2).map((row) => {
    const values = cells(row);
    while (values.length < header.length) values.push("");
    return values.slice(0, header.length);
  });

  return { header, align, rows: body };
}

/* ─── block serialisation ──────────────────────────────────────────────────── */

/** One block back to markdown. Only ever called for a block that was edited. */
export function emitBlock(b) {
  switch (b.type) {
    case "heading":
      return "#".repeat(b.level) + " " + b.text;
    case "paragraph":
      return b.text;
    case "quote":
      return b.text.split("\n").map((line) => "> " + line).join("\n");
    case "hr":
      return "---";
    case "code":
      return (b.fence || "```") + (b.lang || "") + "\n" + b.code + "\n" + (b.fence || "```");
    case "mermaid":
      return "```mermaid\n" + b.code + "\n```";
    case "math":
      return "$$\n" + b.tex + "\n$$";
    case "image":
      return "![" + b.alt + "](" + b.url + (b.title ? ' "' + b.title + '"' : "") + ")";
    case "list":
      return b.items
        .map((item, index) =>
          " ".repeat(item.indent || 0) +
          (b.ordered ? index + 1 + (b.marker || ".") : b.marker || "-") +
          " " +
          item.text
        )
        .join("\n");
    case "table":
      return emitTable(b);
    case "component":
      return emitComponent(b);
    default:
      return b.text || "";
  }
}

function emitTable(b) {
  const widths = b.header.map((cell, i) =>
    Math.max(
      3,
      String(cell).length,
      ...b.rows.map((row) => String(row[i] == null ? "" : row[i]).length)
    )
  );
  const pad = (value, i) => String(value == null ? "" : value).padEnd(widths[i]);

  const divider = b.align.map((a, i) => {
    const width = widths[i];
    if (a === "center") return ":" + "-".repeat(Math.max(1, width - 2)) + ":";
    if (a === "right") return "-".repeat(Math.max(1, width - 1)) + ":";
    if (a === "left") return ":" + "-".repeat(Math.max(1, width - 1));
    return "-".repeat(width);
  });

  const line = (cells) => "| " + cells.join(" | ") + " |";
  return [
    line(b.header.map(pad)),
    line(divider),
    ...b.rows.map((row) => line(row.map(pad))),
  ].join("\n");
}

function emitComponent(b) {
  const args = b.args ? " " + b.args : "";
  if (b.body === null || b.body === undefined) return `{% ${b.name}${args} %}`;
  return `{% ${b.name}${args} %}\n${b.body}\n{% end${b.name} %}`;
}

/** Blocks back to a document body. */
export function blocksToBody(blocks, lead) {
  const head = lead == null ? blocks.lead || "" : lead;
  return (
    head +
    blocks
      .map((b) => (b.dirty ? emitBlock(b) : b.src) + (b.after == null ? "\n\n" : b.after))
      .join("")
  );
}

export function markdownToDoc(source) {
  const { front, body, raw } = splitFrontMatter(source);
  const blocks = parseBlocks(body);
  return { front, frontRaw: raw, frontDirty: false, lead: blocks.lead, blocks };
}

export function docToMarkdown(doc) {
  const front = doc.frontDirty ? "---\n" + doc.front + "\n---\n" : doc.frontRaw;
  return front + blocksToBody(doc.blocks, doc.lead);
}

/* ─── inline ───────────────────────────────────────────────────────────────── */

export function escapeHTML(value) {
  return String(value == null ? "" : value).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

/** tools/components.js, when the page has loaded it. The one emitter. */
function components() {
  return (typeof window !== "undefined" && window.RedefineComponents) || null;
}

/**
 * A highlight is `{% box colour %}…{% endbox %}`, and equally
 * `{$ box colour $}…{$ endbox $}` — scripts/filters/box-syntax.js rewrites the
 * second into the first before Hexo sees it. The shorthand exists so a box can
 * sit against a `$` math delimiter without the two fighting, which is also why
 * this rule has to run BEFORE the math one: `{$ box green $}` is otherwise read
 * as an equation called " box green ".
 *
 * Whichever spelling the author used is remembered on the node and re-emitted,
 * so opening a post does not rewrite the other one.
 */
const BOX_RE = /\{([%$])\s*box(?:\s+([^%$}]*?))?\s*\1\}([\s\S]*?)\{\1\s*endbox\s*\1\}/;

function boxHTML(m) {
  const api = components();
  const colour = api ? api.boxColor(m[2]) : String(m[2] || "default").trim() || "default";
  const inner = inlineToHTML(m[3]);
  const data = ` data-md="box" data-box-syntax="${m[1]}"`;

  if (!api) return `<span class="post-box post-box-${escapeHTML(colour)}"${data}>${inner}</span>`;

  // Through the shared emitter, so the box on the canvas is the box the build
  // makes. The placeholder survives its escaping untouched.
  const MARK = " box ";
  return api
    .box([colour], MARK)
    .replace(MARK, inner)
    .replace(/^<(span|div)\s/, `<$1${data} `);
}

/** `{% btn class::text::url::icon %}` — one node, edited through the toolbar. */
const BTN_RE = /\{%\s*(?:btn|button)\s+([^%]*?)\s*%\}/;

function btnHTML(m) {
  const api = components();
  const data = ` data-md="btn" data-md-src="${escapeHTML(m[0])}"`;
  if (!api) return `<span class="button"${data}>${escapeHTML(m[1])}</span>`;
  return api
    .btn(m[1].trim().split(/\s+/))
    .replace(/^\s*<a\s/, `<a${data} `);
}

// Ordered by precedence. `box` and `btn` are first because their delimiters
// contain characters later rules claim; `code` and `math` come next because
// their contents are literal — an asterisk inside a code span is an asterisk.
const INLINE_RULES = [
  { name: "box", re: BOX_RE, html: boxHTML },
  { name: "btn", re: BTN_RE, html: btnHTML },
  { name: "code", re: /`([^`\n]+)`/, html: (m) => `<code data-md="code">${escapeHTML(m[1])}</code>` },
  // Not `$$`: that is display math, and it is a block of its own. Without the
  // guards this rule ate the inner half of one and left a stray delimiter at
  // each end.
  {
    name: "math",
    re: /(?<!\$)\$(?!\$)([^$\n]+)\$(?!\$)/,
    html: (m) =>
      `<span class="mathjax-inline ed-math" data-md="math" data-tex="${escapeHTML(m[1])}">` +
      `<span class="ed-math-src">${escapeHTML(m[1])}</span></span>`,
  },
  { name: "image", re: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/, html: (m) => `<img data-md="image" src="${escapeHTML(m[2])}" alt="${escapeHTML(m[1])}"${m[3] ? ` title="${escapeHTML(m[3])}"` : ""}>` },
  { name: "link", re: /\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/, html: (m) => `<a data-md="link" href="${escapeHTML(m[2])}"${m[3] ? ` title="${escapeHTML(m[3])}"` : ""}>${inlineToHTML(m[1])}</a>` },
  { name: "strong", re: /\*\*([^*]+)\*\*/, html: (m) => `<strong data-md="strong">${inlineToHTML(m[1])}</strong>` },
  { name: "strike", re: /~~([^~]+)~~/, html: (m) => `<del data-md="strike">${inlineToHTML(m[1])}</del>` },
  { name: "em", re: /(?:\*([^*\n]+)\*|_([^_\n]+)_)/, html: (m) => `<em data-md="em">${inlineToHTML(m[1] || m[2])}</em>` },
];

// Inline HTML the author may write by hand. Passed through verbatim in both
// directions — this is how `<mark>` works without inventing syntax the build
// does not understand.
const INLINE_HTML = /^<(\/?)(mark|kbd|sup|sub|small|abbr|u|br|span|code|strong|em|del|b|i)\b([^>]*)>/i;

/** Inline markdown → HTML for the canvas. */
export function inlineToHTML(text) {
  const source = String(text == null ? "" : text);
  let out = "";
  let i = 0;

  while (i < source.length) {
    const rest = source.slice(i);

    if (rest[0] === "\\" && rest.length > 1) {
      out += escapeHTML(rest[1]);
      i += 2;
      continue;
    }

    if (rest[0] === "<") {
      const tag = rest.match(INLINE_HTML);
      if (tag) {
        out += tag[0];
        i += tag[0].length;
        continue;
      }
    }

    let best = null;
    for (const rule of INLINE_RULES) {
      const match = rest.match(rule.re);
      if (match && (best === null || match.index < best.match.index)) best = { rule, match };
      if (best && best.match.index === 0) break;
    }

    if (!best) {
      out += escapeHTML(rest);
      break;
    }

    out += escapeHTML(rest.slice(0, best.match.index));
    out += best.rule.html(best.match);
    i += best.match.index + best.match[0].length;
  }

  return out.replace(/\n/g, "<br>");
}

const MD_ESCAPE = /([\\`*_[\]~])/g;

/** The colour a box node is wearing, when the attribute has been lost. */
export function boxColourOf(el) {
  const found = String(el.className || "").match(/post-box-([a-z]+)/);
  return found ? found[1] : "default";
}

/** The contenteditable's DOM → inline markdown. The inverse of the above. */
export function htmlToInline(node) {
  let out = "";

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      // Zero-width spaces are the editor's own: they are the caret's landing
      // place either side of a mark (see anchorMarks in inline.js) and are
      // never part of what the author wrote.
      out += child.nodeValue.replace(/​/g, "").replace(MD_ESCAPE, "\\$1");
      continue;
    }
    if (child.nodeType !== 1) continue;

    const tag = child.tagName.toLowerCase();
    const kind = child.getAttribute("data-md");

    // A node the editor rendered from markdown it cannot read back — a button,
    // a box, anything inserted into a component's body — carries its own source
    // and is emitted as that source, unchanged.
    const source = child.getAttribute("data-md-src");
    if (source != null) {
      out += source;
      continue;
    }

    if (tag === "br") {
      out += "\n";
    } else if (kind === "box") {
      // Back in the spelling it arrived in. `%` is the tag, `$` the shorthand;
      // anything new the editor makes is written as the shorthand, which is the
      // form that survives sitting next to a `$` delimiter.
      const d = child.getAttribute("data-box-syntax") === "%" ? "%" : "$";
      const colour = child.getAttribute("data-box-color") || boxColourOf(child);
      out += `{${d} box ${colour} ${d}}${htmlToInline(child)}{${d} endbox ${d}}`;
    } else if (tag === "code" || kind === "code") {
      out += "`" + child.textContent + "`";
    } else if (kind === "math") {
      out += "$" + (child.getAttribute("data-tex") || child.textContent) + "$";
    } else if (tag === "img") {
      const title = child.getAttribute("title");
      out += `![${child.getAttribute("alt") || ""}](${child.getAttribute("src") || ""}${title ? ` "${title}"` : ""})`;
    } else if (tag === "a") {
      const title = child.getAttribute("title");
      out += `[${htmlToInline(child)}](${child.getAttribute("href") || ""}${title ? ` "${title}"` : ""})`;
    } else if (tag === "strong" || tag === "b") {
      out += "**" + htmlToInline(child) + "**";
    } else if (tag === "em" || tag === "i") {
      out += "*" + htmlToInline(child) + "*";
    } else if (tag === "del" || tag === "s") {
      out += "~~" + htmlToInline(child) + "~~";
    } else if (INLINE_HTML.test("<" + tag + ">")) {
      // Hand-written inline HTML goes back out as itself, attributes and all.
      const attrs = Array.from(child.attributes || [])
        .filter((a) => a.name !== "data-md")
        .map((a) => ` ${a.name}="${a.value}"`)
        .join("");
      out += `<${tag}${attrs}>${htmlToInline(child)}</${tag}>`;
    } else {
      out += htmlToInline(child);
    }
  }

  return out;
}
