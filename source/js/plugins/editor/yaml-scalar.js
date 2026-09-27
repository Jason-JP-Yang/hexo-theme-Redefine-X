/**
 * One YAML value, for the editor's two YAML line editors: a post's front matter
 * (markdown.js) and masonry.yml (masonry-yaml.js).
 *
 * Both edit the TEXT one line per key, which only holds while every value the
 * editor writes IS one line. The Description and Excerpt boxes are textareas,
 * and a value with a line break used to be written raw: its next line landed at
 * column 0, the next keystroke rewrote only the key's own line, and what was
 * left behind — a lone `"` in the save that failed — made the file unparseable.
 * So a value is written plain only when YAML reads those exact characters back,
 * and double-quoted otherwise with every line break and control character
 * escaped, which is always a single line.
 */

// U+2028 and U+2029 end a line in YAML as in JavaScript, so a regex literal may
// not hold them; they and U+00A0 (`\_`) are built from their code points.
const [LS, PS, NBSP] = [0x2028, 0x2029, 0xa0].map((c) => String.fromCharCode(c));
const CONTROL = new RegExp("[\\x00-\\x1f\\x7f\\x85" + LS + PS + "]");
const ESCAPED = new RegExp('[\\\\"\\x00-\\x1f\\x7f\\x85' + LS + PS + "]", "g");
const OUT = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\0": "\\0",
  "\x85": "\\N",
  [LS]: "\\L",
  [PS]: "\\P",
};
const IN = {
  n: "\n",
  r: "\r",
  t: "\t",
  0: "\0",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  f: "\f",
  v: "\v",
  N: "\x85",
  L: LS,
  P: PS,
  _: NBSP,
};

/**
 * Plain unless YAML would read something else: an indicator in front, `: ` or
 * a closing `:` (a mapping), ` #` (a comment that eats the rest), edge space,
 * or anything that is not a printable character on this line.
 */
export function writeScalar(value) {
  const s = String(value == null ? "" : value);
  if (!s) return "";
  const plain =
    !CONTROL.test(s) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) &&
    !/:(\s|$)/.test(s) &&
    !/\s#/.test(s) &&
    !/^\s|\s$/.test(s);
  if (plain) return s;
  return (
    '"' +
    s.replace(ESCAPED, (ch) => OUT[ch] || "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0")) +
    '"'
  );
}

/** The value one line holds, quotes and escapes undone. */
export function readScalar(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (s.length > 1 && s[0] === '"' && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (m, c) => {
      if (c.length === 1) return c in IN ? IN[c] : c;
      const code = parseInt(c.slice(1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : m;
    });
  }
  if (s.length > 1 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

// Anything shaped like a mapping key, quoted or not — deliberately broad, so a
// row is only ever called stray when no structure could possibly own it.
const KEY = /^[ \t]*(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"][^#]*?)[ \t]*:(?:[ \t]|\r?\n?$)/;
const ITEM = /^[ \t]*[-?:](?:[ \t]|\r?\n?$)/;
const DASH = /^[ \t]*-(?:[ \t]|\r?\n?$)/;
const COMMENT = /^[ \t]*#/;

const indentOf = (row) => String(row).match(/^[ \t]*/)[0].length;
const isBlank = (row) => !String(row).trim();

/**
 * A row no YAML structure at `width` could own: not blank, not a comment, not a
 * key, not a list entry, and not indented under a key. Only an old multi-line
 * write leaves such a row behind.
 */
export function isStray(row, width) {
  return !isBlank(row) && indentOf(row) <= width && !COMMENT.test(row) && !KEY.test(row) && !ITEM.test(row);
}

/** The quote a key's value opens on this row and does not close, or "". */
function opens(row) {
  if (!KEY.test(row)) return "";
  const value = String(row).replace(/^[^:]*:/, "").trim();
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
  return quote && !closes(value.slice(1), quote) ? quote : "";
}

/**
 * The rows with every stray one taken out — leaving the rest of a quote that a
 * key's row opened, which is its value however it is indented. On a file that
 * parses this removes nothing, so it keeps the round-trip law; it is what lets
 * a document an older version broke be opened and saved whole.
 */
export function sweepStray(rows, width) {
  const out = [];
  let quote = "";
  for (const row of rows) {
    if (quote) {
      out.push(row);
      if (closes(row, quote)) quote = "";
      continue;
    }
    if (isStray(row, width)) continue;
    out.push(row);
    quote = opens(row);
  }
  return out;
}

/** Does `text` close a scalar opened with `quote`? */
function closes(text, quote) {
  for (let i = 0; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") i += 1;
    else if (text[i] === quote) {
      if (quote === "'" && text[i + 1] === "'") i += 1;
      else return true;
    }
  }
  return false;
}

/**
 * Where the value of the key on row `at` ends: the first row that is not its.
 *
 * Its own rows are those indented deeper (a block scalar, a nested list or map)
 * and list entries at its own indent — and also what an older, broken write
 * left behind: the rest of a quote opened on the key's row, and stray rows
 * directly under it. Taking those with the key is what lets rewriting a value
 * repair the file the old version of it broke. A blank row always ends it.
 */
export function valueEnd(rows, at, width) {
  let quote = opens(rows[at]);

  let end = at + 1;
  while (end < rows.length) {
    const row = rows[end];
    if (isBlank(row)) break;
    if (quote) {
      if (closes(row, quote)) quote = "";
      end += 1;
      continue;
    }
    const indent = indentOf(row);
    if (indent > width || (indent === width && DASH.test(row)) || isStray(row, width)) {
      end += 1;
      continue;
    }
    break;
  }
  return end;
}
