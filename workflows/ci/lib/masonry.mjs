/**
 * Merging one person's view of masonry.yml back into the real one.
 *
 * The album editor works on the whole file, because the file is written by a
 * parser that keeps its comments, its ordering and its blank lines — and a
 * second writer that only understood the parts it cared about would disagree
 * with the first within a release.
 *
 * But a collaborator is not shown the whole file. What they open is the same
 * file with the encrypted and draft albums taken out, so what they send back is
 * missing everything they were never allowed to see. Replacing the real file
 * with it would delete exactly the albums the permissions exist to protect.
 *
 * So nothing is replaced. The real file is edited IN PLACE, one album at a
 * time, and only the albums the receipt named:
 *
 *   in both, and in the receipt      the incoming block replaces the old one
 *   in the incoming file only        inserted into the category it names
 *   in the real file only            removed — but only if the receipt named it
 *   anywhere else                    left exactly as it was, byte for byte
 *
 * The last line is what makes this safe rather than merely careful: an album a
 * collaborator could not see is an album their save cannot mention, so its
 * absence means nothing and is treated as meaning nothing.
 *
 * ── Why the text and not the parse tree ─────────────────────────────────────
 *
 * Because re-emitting the file from a parse tree throws away every comment in
 * it, and masonry.yml opens with the template that documents its own format.
 * The parse is used to say WHAT is where; the bytes that move are the bytes
 * that were already there.
 */

import { albumId, albumDraftId } from "./vault.mjs";

/**
 * Where every album's block starts and ends in the text.
 *
 * Line-based, and deliberately narrow: this reads the one file shape the theme
 * defines — a top-level sequence of categories, each with a `list:` of albums —
 * rather than trying to be a YAML parser. The parse tree supplies the content;
 * this supplies the offsets, and the two are paired by position because both
 * walk the file in the same order.
 */
/**
 * The line ending the file already uses.
 *
 * masonry.yml is edited on Windows and read on a Linux runner, so it is CRLF —
 * and a merge that rejoined it with "\n" would rewrite every line in the file
 * as a side effect of changing one album.
 */
export function eolOf(text) {
  return /\r\n/.test(text) ? "\r\n" : "\n";
}

function scan(text) {
  const lines = text.split(/\r?\n/);
  const cats = [];
  let cat = null;
  let listIndent = -1;
  let item = null;

  const closeItem = (endLine) => {
    if (item) {
      item.end = endLine;
      cat.items.push(item);
      item = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#|$)/.test(line) && !item) continue;

    const top = /^-\s/.test(line);
    if (top) {
      closeItem(i);
      if (cat) {
        cat.end = i;
        cats.push(cat);
      }
      cat = { start: i, end: lines.length, items: [], listLine: -1, indent: -1, name: "" };
      const named = line.match(/^-\s+links_category:\s*(.*)$/);
      if (named) cat.name = unquote(named[1]);
      listIndent = -1;
      continue;
    }
    if (!cat) continue;

    if (!cat.name) {
      const named = line.match(/^\s+links_category:\s*(.*)$/);
      if (named) cat.name = unquote(named[1]);
    }

    if (listIndent < 0 && /^\s*list:\s*$/.test(line)) {
      cat.listLine = i;
      continue;
    }

    if (cat.listLine >= 0) {
      const m = line.match(/^(\s*)-\s/);
      if (m && (listIndent < 0 || m[1].length === listIndent)) {
        if (listIndent < 0) {
          listIndent = m[1].length;
          cat.indent = listIndent;
        }
        closeItem(i);
        item = { start: i, end: lines.length };
        continue;
      }
      // A line that dedents past the list ends both the item and the list.
      if (!m && line.trim() && line.search(/\S/) <= (listIndent < 0 ? 0 : listIndent) - 1) {
        closeItem(i);
        cat.listLine = -1;
        listIndent = -1;
      }
    }
  }

  closeItem(lines.length);
  if (cat) {
    cat.end = lines.length;
    cats.push(cat);
  }
  return { lines, cats };
}

/** The identity the rest of the system derives from an album's title. */
export function idOf(item) {
  const title = (item && (item["page-title"] || item.name)) || "";
  if (!title) return "";
  return item.draft === true ? albumDraftId(title) : albumId(title);
}

/**
 * Pair the parse with the scan, so each album's id has a text range beside it.
 * A file the scanner and the parser disagree about is refused rather than
 * guessed at: an off-by-one here would splice one album's block over another's.
 */
function index(text, yaml) {
  const doc = yaml.load(text);
  const { lines, cats } = scan(text);

  // Paired by NAME, not by position. The file opens with a `- title:` entry
  // that is the page's own heading rather than a category, and any sequence
  // entry the theme adds later would shift a positional pairing by one and
  // splice one album's block over another's.
  const blocks = new Map();
  for (const cat of cats) if (cat.name) blocks.set(cat.name, cat);

  const albums = new Map();
  const byCategory = new Map();

  for (const category of Array.isArray(doc) ? doc : []) {
    if (!category || !category.links_category) continue;
    const name = String(category.links_category);
    const block = blocks.get(name);
    if (!block) throw new Error(`masonry.yml: no block found for category "${name}"`);

    const list = Array.isArray(category.list) ? category.list : [];
    if (list.length !== block.items.length) {
      throw new Error(
        `masonry.yml: category "${name}" has ${block.items.length} blocks for ${list.length} albums`
      );
    }
    byCategory.set(name, block);

    for (let i = 0; i < list.length; i++) {
      const id = idOf(list[i]);
      if (!id) continue;
      albums.set(id, {
        id,
        item: list[i],
        category: name,
        start: block.items[i].start,
        end: block.items[i].end,
        indent: block.indent,
      });
    }
  }

  return { lines, albums, byCategory };
}

function unquote(value) {
  return String(value || "")
    .trim()
    .replace(/\s+#.*$/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * Apply the albums a receipt cleared, and nothing else.
 *
 * @returns {{text: string, touched: string[]}}
 * @throws when the incoming file changes an album the receipt did not name.
 */
export function merge(yaml, oldText, newText, allowed, admin) {
  const before = index(oldText, yaml);
  const after = index(newText, yaml);

  const edits = [];
  const touched = [];

  for (const [id, row] of after.albums) {
    const old = before.albums.get(id);
    const same = old && JSON.stringify(old.item) === JSON.stringify(row.item) && old.category === row.category;
    if (same) continue;

    if (!allowed.has(id)) {
      const title = (row.item && (row.item["page-title"] || row.item.name)) || id;
      throw new Error(`album "${title}" is not one this save was cleared for`);
    }
    if (!admin && !old && row.item.draft !== true) {
      const title = (row.item && (row.item["page-title"] || row.item.name)) || id;
      throw new Error(`a new album must start as a draft — "${title}" does not`);
    }
    touched.push(id);

    const block = after.lines.slice(row.start, row.end);
    if (old && old.category === row.category) {
      edits.push({ start: old.start, end: old.end, lines: reindent(block, row.indent, old.indent) });
      continue;
    }
    // Moved, or brand new. The old block goes; the new one is appended to the
    // category it now names, which is created if the file does not have it.
    if (old) edits.push({ start: old.start, end: old.end, lines: [] });
    const target = before.byCategory.get(row.category);
    if (!target) throw new Error(`masonry.yml has no category "${row.category}" to put this album in`);
    const at = target.items.length ? target.items[target.items.length - 1].end : target.listLine + 1;
    const indent = target.indent >= 0 ? target.indent : 2;
    edits.push({ start: at, end: at, lines: reindent(block, row.indent, indent) });
  }

  // A removal is only a removal when the receipt named it. An album the sender
  // was never shown is absent from their file for a reason that has nothing to
  // do with wanting it gone.
  for (const [id, old] of before.albums) {
    if (after.albums.has(id) || !allowed.has(id)) continue;
    if (!admin && old.item.draft !== true) {
      const title = (old.item && (old.item["page-title"] || old.item.name)) || id;
      throw new Error(`only an admin may remove the album "${title}"`);
    }
    touched.push(id);
    edits.push({ start: old.start, end: old.end, lines: [] });
  }

  if (!edits.length) return { text: oldText, touched };

  // Applied from the bottom up, so an earlier edit's offsets stay valid.
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  const out = before.lines.slice();
  for (const edit of edits) out.splice(edit.start, edit.end - edit.start, ...edit.lines);
  return { text: out.join(eolOf(oldText)), touched };
}

/**
 * The same file with named albums taken out of it, byte-identical elsewhere.
 *
 * This is what a collaborator opens: masonry.yml with every encrypted and draft
 * album removed. It is produced by the BUILD, sealed under a key of its own and
 * published, so the album editor has a whole well-formed file to work on
 * without ever being handed the parts of it that are not theirs to see.
 *
 * Deliberately the same scanner `merge` uses. The two have to agree about where
 * an album's block begins and ends, or a round trip through the editor would
 * put one album's lines back over another's.
 *
 * @param {Set<string>} hidden  album ids to leave out
 */
export function strip(yaml, text, hidden) {
  const { lines, albums } = index(text, yaml);
  const cuts = [];
  for (const [id, row] of albums) if (hidden.has(id)) cuts.push(row);
  if (!cuts.length) return text;

  cuts.sort((a, b) => b.start - a.start);
  const out = lines.slice();
  for (const cut of cuts) out.splice(cut.start, cut.end - cut.start);
  return out.join(eolOf(text));
}

/** Move a block between two list indents without disturbing anything inside it. */
function reindent(lines, from, to) {
  if (from === to || from < 0 || to < 0) return lines.slice();
  const shift = to - from;
  return lines.map((line) => {
    if (!line.trim()) return line;
    if (shift > 0) return " ".repeat(shift) + line;
    return line.startsWith(" ".repeat(-shift)) ? line.slice(-shift) : line.replace(/^\s+/, "");
  });
}
