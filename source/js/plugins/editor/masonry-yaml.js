/**
 * `source/_data/masonry.yml`, as a document that can be edited without being
 * rewritten.
 *
 * ── The round-trip law, again ───────────────────────────────────────────────
 *
 * `emit(parse(s)) === s` for any file, byte for byte. It holds by construction
 * rather than by the serialiser being a careful inverse: every node keeps the
 * exact text it was parsed from and is only ever changed by a line edit made on
 * that text. A key this file has never heard of, a comment, a trailing space
 * after `list:` — all of it survives a save untouched, because none of it is
 * ever re-emitted from a model.
 *
 * That matters more here than it does for a post. masonry.yml is ONE file
 * holding every album on the site, and it opens with forty lines of hand-written
 * template comments; a YAML round trip through js-yaml would return a correct
 * document with all of that gone and every album reformatted.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 *
 *   head        everything before the first top-level `- ` entry
 *   nodes[]     the top-level sequence, in order:
 *                 raw       an entry this file does not model (`- title:` …)
 *                 category  `links_category` + `list:` + its albums
 *   category.items[]   one album
 *   item.images[]      one photograph
 *
 * ── Dashes, and why every node is stored dashless ───────────────────────────
 *
 * A sequence entry writes its first key on the dash line (`  - name: x`) and the
 * rest one indent in (`    page-title: y`), so the same key is at two different
 * columns depending on whether it happens to be first. Every node therefore
 * stores its text with the dash run replaced by spaces of the SAME WIDTH, which
 * puts every key of that node at one column and makes the line editor below
 * uniform. `lead` is the dash run that goes back on at emit time.
 *
 * ── Tails ───────────────────────────────────────────────────────────────────
 *
 * The blank lines after a node belong to it, not to the one that follows —
 * otherwise deleting the last album of a category eats the blank line that
 * separated the categories. They are split off as `tail` and handed to the
 * previous sibling when a node is removed.
 */

/* ─── lines ────────────────────────────────────────────────────────────────── */

/** Lines WITH their terminators, so joining them is the identity. */
function rowsOf(text) {
  const out = [];
  const re = /\r?\n/g;
  let at = 0;
  let m;
  while ((m = re.exec(String(text)))) {
    out.push(String(text).slice(at, m.index + m[0].length));
    at = m.index + m[0].length;
  }
  if (at < String(text).length) out.push(String(text).slice(at));
  return out;
}

function indentOf(row) {
  const m = String(row).match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

function isBlank(row) {
  return !String(row).trim();
}

/** Trailing blank lines, split off the end of a block. */
function splitTail(rows) {
  let cut = rows.length;
  while (cut > 0 && isBlank(rows[cut - 1])) cut -= 1;
  return { body: rows.slice(0, cut).join(""), tail: rows.slice(cut).join("") };
}

/* ─── values ───────────────────────────────────────────────────────────────── */

function unquote(value) {
  const s = String(value == null ? "" : value).trim();
  if (s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

/**
 * The same rule markdown.js applies to front matter: quote only what YAML would
 * otherwise read as something else. Album names and paths hold spaces, slashes
 * and Chinese, none of which needs quoting — and quoting them would rewrite
 * every line of a file that was fine.
 */
export function quoteYaml(value) {
  const s = String(value == null ? "" : value);
  if (!s) return "";
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) || /:\s/.test(s) || /\s$/.test(s) || /^\s/.test(s)) {
    return '"' + s.replace(/"/g, '\\"') + '"';
  }
  return s;
}

const TRUTHY = /^(true|yes|on|1)$/i;

export function isTrue(value) {
  return TRUTHY.test(String(value == null ? "" : value).trim());
}

/* ─── one node's own keys ──────────────────────────────────────────────────── */

/**
 * Every scalar key written at exactly `width`, and nothing nested under them.
 *
 * A key whose value is empty owns whatever is indented below it; that block is
 * not read here — `images:` is the only one this editor cares about and it is
 * parsed as a list of its own.
 */
export function readKeys(body, width) {
  const out = {};
  const pad = " ".repeat(width);
  for (const row of rowsOf(body)) {
    if (isBlank(row) || /^\s*#/.test(row)) continue;
    if (indentOf(row) !== width || !row.startsWith(pad)) continue;
    const m = row.slice(width).match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*?)\s*$/);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

/**
 * Write one key into a block of lines, in place.
 *
 * The line and anything indented under it are replaced together; a key the
 * block does not carry is appended at the end of its own-key region, which for
 * an album is immediately before `images:` because that key and its entries are
 * held separately. `null` removes it.
 */
export function setKey(body, width, key, value, eol) {
  const rows = rowsOf(body);
  const pad = " ".repeat(width);
  const head = new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:");

  let at = -1;
  for (let i = 0; i < rows.length; i++) {
    if (indentOf(rows[i]) === width && rows[i].startsWith(pad) && head.test(rows[i].slice(width))) {
      at = i;
      break;
    }
  }

  let end = at;
  if (at >= 0) {
    end = at + 1;
    while (end < rows.length && !isBlank(rows[end]) && indentOf(rows[end]) > width) end += 1;
  }

  if (value === null || value === undefined || value === "") {
    if (at < 0) return rows.join("");
    rows.splice(at, end - at);
    return rows.join("");
  }

  const line = `${pad}${key}: ${quoteYaml(value)}${eol}`;
  if (at < 0) {
    // The last line of a block that ends at EOF may carry no terminator, and
    // appending after it would join two keys onto one line.
    if (rows.length && !/\r?\n$/.test(rows[rows.length - 1])) rows[rows.length - 1] += eol;
    rows.push(line);
  } else {
    rows.splice(at, end - at, line);
  }
  return rows.join("");
}

/* ─── nodes ────────────────────────────────────────────────────────────────── */

let counter = 0;

function nextId() {
  counter += 1;
  return "m" + counter.toString(36);
}

/** `  - ` → `    `: the dash run as spaces, so every key sits at one column. */
function dashless(rows) {
  const first = rows[0] || "";
  const m = first.match(/^([ \t]*)(-[ \t]+)/);
  if (!m) return null;
  const lead = m[1] + m[2];
  return { lead, rows: [" ".repeat(lead.length) + first.slice(lead.length), ...rows.slice(1)] };
}

function withLead(node) {
  const body = node.body;
  if (!node.lead) return body + node.tail;
  return node.lead + body.slice(node.lead.length) + node.tail;
}

function makeNode(lead, body, tail) {
  return { id: nextId(), lead, body, tail: tail || "" };
}

/* ─── images ───────────────────────────────────────────────────────────────── */

function parseImages(rows, eol) {
  if (!rows.length) return [];
  const width = indentOf(rows[0]);
  const starts = [];
  rows.forEach((row, i) => {
    if (indentOf(row) === width && /^[ \t]*-[ \t]/.test(row)) starts.push(i);
  });
  if (!starts.length) return [];

  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : rows.length;
    const split = dashless(rows.slice(from, to));
    if (!split) continue;
    const { body, tail } = splitTail(split.rows);
    const node = makeNode(split.lead, body, tail);
    node.eol = eol;
    out.push(node);
  }
  return out;
}

export function imageFields(node) {
  return readKeys(node.body, node.lead.length);
}

export function setImageField(node, key, value) {
  node.body = setKey(node.body, node.lead.length, key, value, node.eol);
}

export function makeImage(lead, eol, path) {
  const node = makeNode(lead, `${" ".repeat(lead.length)}image: ${quoteYaml(path)}${eol}`, "");
  node.eol = eol;
  return node;
}

/* ─── albums ───────────────────────────────────────────────────────────────── */

const IMAGES_KEY = /^[ \t]*images\s*:/;

function parseItem(rows, eol) {
  const split = dashless(rows);
  if (!split) return { kind: "raw", id: nextId(), body: rows.join(""), tail: "", lead: "" };

  const width = split.lead.length;
  let at = -1;
  for (let i = 0; i < split.rows.length; i++) {
    if (indentOf(split.rows[i]) === width && IMAGES_KEY.test(split.rows[i])) {
      at = i;
      break;
    }
  }

  if (at < 0) {
    const { body, tail } = splitTail(split.rows);
    const node = makeNode(split.lead, body, tail);
    node.kind = "item";
    node.eol = eol;
    node.pre = node.body;
    node.imagesLine = "";
    node.images = [];
    node.imageLead = " ".repeat(width + 2) + "- ";
    node.post = "";
    delete node.body;
    return node;
  }

  const pre = split.rows.slice(0, at).join("");
  const imagesLine = split.rows[at];
  const rest = split.rows.slice(at + 1);

  // Anything after the images that is NOT indented past the `images:` key is a
  // sibling key written below the list — rare, and kept verbatim as `post`.
  let stop = rest.length;
  for (let i = 0; i < rest.length; i++) {
    if (!isBlank(rest[i]) && indentOf(rest[i]) <= width) {
      stop = i;
      break;
    }
  }

  const listRows = rest.slice(0, stop);
  const { body: listBody, tail: listTail } = splitTail(listRows);
  const images = parseImages(rowsOf(listBody), eol);

  // Blank lines that closed the image list belong to the ALBUM, not to its last
  // photograph — removing that photograph must not remove the separator. And the
  // ones at the very end belong to the album's own tail rather than to its body,
  // or removing the album takes the blank line before the next category with it.
  const rest2 = splitTail(rowsOf(listTail + rest.slice(stop).join("")));

  const node = makeNode(split.lead, "", rest2.tail);
  node.kind = "item";
  node.eol = eol;
  node.pre = pre;
  node.imagesLine = imagesLine;
  node.images = images;
  node.imageLead = images.length ? images[0].lead : " ".repeat(width + 2) + "- ";
  node.post = rest2.body;
  delete node.body;
  return node;
}

function emitItem(node) {
  if (node.kind !== "item") return withLead(node);
  const width = node.lead.length;
  let body = node.pre;
  if (node.images.length || node.imagesLine) {
    if (body && !/\r?\n$/.test(body)) body += node.eol;
    body += node.imagesLine || `${" ".repeat(width)}images:${node.eol}`;
    for (const image of node.images) body += withLead(image);
  }
  body += node.post;
  return node.lead + body.slice(width) + node.tail;
}

export function itemFields(node) {
  return readKeys(node.pre, node.lead.length);
}

export function setItemField(node, key, value) {
  node.pre = setKey(node.pre, node.lead.length, key, value, node.eol);
}

export function makeItem(lead, eol, fields) {
  const width = lead.length;
  const node = makeNode(lead, "", "");
  node.kind = "item";
  node.eol = eol;
  node.pre = "";
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === null || value === undefined || value === "") continue;
    node.pre += `${" ".repeat(width)}${key}: ${quoteYaml(value)}${eol}`;
  }
  if (!node.pre) node.pre = `${" ".repeat(width)}name: ${eol}`;
  node.imagesLine = "";
  node.images = [];
  node.imageLead = " ".repeat(width + 2) + "- ";
  node.post = "";
  delete node.body;
  return node;
}

/* ─── categories ───────────────────────────────────────────────────────────── */

const LIST_KEY = /^[ \t]*list\s*:/;
const CATEGORY_KEY = /^[ \t]*links_category\s*:/;

function parseCategory(rows, eol) {
  const split = dashless(rows);
  if (!split) return { kind: "raw", id: nextId(), lead: "", body: rows.join(""), tail: "" };

  const width = split.lead.length;
  let at = -1;
  for (let i = 0; i < split.rows.length; i++) {
    if (indentOf(split.rows[i]) === width && LIST_KEY.test(split.rows[i])) {
      at = i;
      break;
    }
  }

  const node = makeNode(split.lead, "", "");
  node.kind = "category";
  node.eol = eol;

  if (at < 0) {
    const { body, tail } = splitTail(split.rows);
    node.pre = body;
    node.tail = tail;
    node.listLine = "";
    node.items = [];
    node.itemLead = " ".repeat(width) + "- ";
    node.post = "";
    delete node.body;
    return node;
  }

  node.pre = split.rows.slice(0, at).join("");
  node.listLine = split.rows[at];

  const rest = split.rows.slice(at + 1);
  const itemWidth = (() => {
    for (const row of rest) if (!isBlank(row) && /^[ \t]*-[ \t]/.test(row)) return indentOf(row);
    return width;
  })();

  const starts = [];
  rest.forEach((row, i) => {
    if (indentOf(row) === itemWidth && /^[ \t]*-[ \t]/.test(row)) starts.push(i);
  });

  const items = [];
  let post = "";
  if (!starts.length) {
    const { body, tail } = splitTail(rest);
    post = body;
    node.tail = tail;
  } else {
    post = rest.slice(0, starts[0]).join("");
    for (let k = 0; k < starts.length; k++) {
      const from = starts[k];
      const to = k + 1 < starts.length ? starts[k + 1] : rest.length;
      items.push(parseItem(rest.slice(from, to), eol));
    }
  }

  node.items = items;
  node.itemLead = items.length ? items[0].lead : " ".repeat(itemWidth) + "- ";
  node.post = post;
  // The name this category had when the file was READ. A save re-reads the file
  // and has to find this same category in it, which it cannot do by the name the
  // author has since typed into the card.
  node.openedName = String(readKeys(node.pre, width).links_category || "");
  delete node.body;
  return node;
}

function emitCategory(node) {
  if (node.kind !== "category") return withLead(node);
  const width = node.lead.length;
  let body = node.pre;
  if (node.items.length || node.listLine) {
    if (body && !/\r?\n$/.test(body)) body += node.eol;
    body += node.listLine || `${" ".repeat(width)}list:${node.eol}`;
    body += node.post;
    for (const item of node.items) body += emitItem(item);
  } else {
    body += node.post;
  }
  return node.lead + body.slice(width) + node.tail;
}

export function categoryFields(node) {
  return readKeys(node.pre, node.lead.length);
}

export function setCategoryField(node, key, value) {
  node.pre = setKey(node.pre, node.lead.length, key, value, node.eol);
}

export function makeCategory(eol, name, thumbs) {
  const node = makeNode("- ", "", "");
  node.kind = "category";
  node.eol = eol;
  node.pre = `  links_category: ${quoteYaml(name)}${eol}  has_thumbnail: ${thumbs ? "true" : "false"}${eol}`;
  node.listLine = `  list:${eol}`;
  node.items = [];
  node.itemLead = "  - ";
  node.post = "";
  // Empty, and that is the signal: a category with no opened name does not exist
  // in the committed file yet and has to be appended rather than found.
  node.openedName = "";
  delete node.body;
  return node;
}

/** One album block, read back from the text it was emitted as. */
export function parseItemBlock(text, eol) {
  return parseItem(rowsOf(text), eol);
}

/**
 * Put a new category at the end, with a blank line in front of it.
 *
 * Every other top-level entry in this file is separated by one, and a category
 * that arrived flush against the one before it would be the only place the file
 * did not look hand-written.
 */
export function appendCategory(doc, node) {
  const last = doc.nodes[doc.nodes.length - 1];
  if (last && !last.tail) last.tail = doc.eol;
  node.tail = doc.eol;
  doc.nodes.push(node);
  return node;
}

/* ─── the document ─────────────────────────────────────────────────────────── */

export function parseMasonry(text) {
  const source = String(text == null ? "" : text);
  const eol = /\r\n/.test(source) ? "\r\n" : "\n";
  const rows = rowsOf(source);

  const starts = [];
  rows.forEach((row, i) => {
    if (/^-[ \t]/.test(row)) starts.push(i);
  });

  if (!starts.length) return { eol, head: source, nodes: [] };

  const head = rows.slice(0, starts[0]).join("");
  const nodes = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : rows.length;
    const block = rows.slice(from, to);
    // On the DASHLESS rows: a sequence entry writes its first key on the dash
    // line, so `- links_category: x` is the one spelling a plain indent test
    // cannot see — and missing it read every category in the file as an opaque
    // entry with no albums in it.
    const flat = dashless(block);
    if (flat && flat.rows.some((row) => CATEGORY_KEY.test(row))) {
      nodes.push(parseCategory(block, eol));
    } else {
      const { body, tail } = splitTail(block);
      const node = makeNode("", body, tail);
      node.kind = "raw";
      node.eol = eol;
      nodes.push(node);
    }
  }
  return { eol, head, nodes };
}

export function emitMasonry(doc) {
  let out = doc.head;
  for (const node of doc.nodes) {
    out += node.kind === "category" ? emitCategory(node) : withLead(node);
  }
  return out;
}

export { emitItem, emitCategory };

/* ─── removing, which is where the blank lines go ──────────────────────────── */

/**
 * Take one entry out of a list, without taking the blank line that followed it.
 *
 * That line separated this entry from what comes after, so it belongs to
 * whatever now ends the list. Removing the FIRST of several needs no separator
 * put back — the next entry simply follows the header — and removing the only
 * one hands it to `onOrphanTail`, the block that then closes the list.
 */
export function dropFrom(list, index, onOrphanTail) {
  const node = list[index];
  if (!node) return;
  list.splice(index, 1);
  if (!node.tail) return;
  const before = list[index - 1];
  if (before) before.tail += node.tail;
  else if (!list.length && onOrphanTail) onOrphanTail(node.tail);
}

/* ─── finding ──────────────────────────────────────────────────────────────── */

/** The page an album is published at — its identity everywhere on the site. */
export function albumTitle(fields) {
  return String(fields["page-title"] || fields.name || "").trim();
}

export function categories(doc) {
  return doc.nodes.filter((node) => node.kind === "category");
}

/**
 * The album published at `title`, with the category holding it.
 *
 * `draft` picks between the two entries that can share one title: a draft
 * standing in front of a published album carries the published album's title in
 * `supersedes`, and its own `page-title` names the page it will become.
 */
/** The category this file held under `name` when it was read. */
export function findCategory(doc, name) {
  const wanted = String(name || "");
  return categories(doc).find((node) => node.openedName === wanted) || null;
}

/**
 * Put an album into a category's list.
 *
 * The lead is the category's own, so an album written by this editor is indented
 * exactly like the ones written by hand beside it. `at` past the end appends.
 */
export function insertItem(cat, node, at) {
  const eol = cat.eol;
  reindent(node, cat.itemLead);
  node.eol = eol;
  if (node.pre && !/\r?\n$/.test(node.pre)) node.pre += eol;
  if (!node.tail) node.tail = "";

  const index = at == null || at > cat.items.length ? cat.items.length : Math.max(0, at);
  const before = cat.items[index - 1];
  if (before && !/\r?\n$/.test(emitItem(before))) before.tail += eol;
  cat.items.splice(index, 0, node);
  return node;
}

/** Shift every line of an album by the difference between two leads. */
function shift(text, delta) {
  if (!delta) return text;
  return rowsOf(text)
    .map((row) => {
      if (!row.trim()) return row;
      return delta > 0 ? " ".repeat(delta) + row : row.slice(Math.min(delta * -1, indentOf(row)));
    })
    .join("");
}

function reindent(node, lead) {
  const delta = lead.length - node.lead.length;
  node.lead = lead;
  if (!delta) return;
  node.pre = shift(node.pre, delta);
  node.imagesLine = shift(node.imagesLine, delta);
  node.post = shift(node.post, delta);
  node.imageLead = " ".repeat(lead.length + 2) + "- ";
  for (const image of node.images) {
    const was = image.lead;
    image.lead = " ".repeat(was.length + delta - 2) + "- ";
    image.body = shift(image.body, delta);
  }
}

export function findAlbum(doc, title, want) {
  const wanted = String(title || "").trim();
  for (const cat of categories(doc)) {
    for (let i = 0; i < cat.items.length; i++) {
      const item = cat.items[i];
      const fields = itemFields(item);
      if (albumTitle(fields) !== wanted) continue;
      const isDraft = isTrue(fields.draft);
      if (want === "draft" && !isDraft) continue;
      if (want === "published" && isDraft) continue;
      return { cat, item, index: i, fields };
    }
  }
  return null;
}
