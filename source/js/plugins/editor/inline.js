/**
 * Inline marks, applied to a RANGE rather than to an element.
 *
 * The old version asked "is there a <strong> around the selection?" and toggled
 * that element. Three things follow from that question being the wrong one, and
 * all three were reachable in a sentence of ordinary typing:
 *
 *   - Un-bolding two words inside a bold sentence un-bolded the sentence. The
 *     unit of editing was the tag, never the selection.
 *   - Bolding a range that was already half bold nested <strong> inside
 *     <strong>, which markdown cannot express, so the emitted `****` collapsed.
 *   - A range that began inside one mark and ended outside it could not be
 *     expressed at all.
 *
 * So the unit here is the TEXT NODE. The range is carved at both ends, every
 * text node it covers is collected, and the mark is added to or removed from
 * each one independently; a mark that only half-covers the range is split. The
 * usual editor convention decides the direction: a range that is ENTIRELY
 * marked toggles off, anything less fills the gaps in. `tidy` then merges what
 * ended up adjacent and drops what ended up nested, so the DOM stays in the
 * shape `htmlToInline` can serialise.
 *
 * ── What may not nest ───────────────────────────────────────────────────────
 * Inline code and inline math are LITERAL in markdown: `**x**` inside backticks
 * is four asterisks, not bold. So they take no marks inside them (the toolbar
 * disables the rest while the caret is in one) and flatten whatever they are
 * applied over. A link cannot contain a link. Everything else nests freely, and
 * a mark inside itself is not nesting — it is the same mark twice.
 */

import { selection } from "./caret.js";

/** Highlight colours, drawn from the box palette so the site keeps one set. */
export const HIGHLIGHTS = [
  "amber", "yellow", "lime", "green", "teal", "cyan",
  "blue", "indigo", "purple", "pink", "red", "gray",
];

export const MARKS = [
  { key: "strong", tag: "strong", alias: ["B"], icon: "fa-bold", label: "Bold", shortcut: "b" },
  { key: "em", tag: "em", alias: ["I"], icon: "fa-italic", label: "Italic", shortcut: "i" },
  { key: "strike", tag: "del", alias: ["S"], icon: "fa-strikethrough", label: "Strikethrough" },
  { key: "mark", tag: "mark", icon: "fa-highlighter", label: "Highlight", colours: true },
  { key: "code", tag: "code", icon: "fa-code", label: "Inline code", literal: true },
  { key: "link", tag: "a", icon: "fa-link", label: "Link", asks: "url" },
  { key: "kbd", tag: "kbd", icon: "fa-keyboard", label: "Key" },
  { key: "sup", tag: "sup", icon: "fa-superscript", label: "Superscript" },
  { key: "sub", tag: "sub", icon: "fa-subscript", label: "Subscript" },
  { key: "u", tag: "u", icon: "fa-underline", label: "Underline" },
];

const BY_KEY = new Map(MARKS.map((m) => [m.key, m]));

/** Every tag this module treats as a mark, whoever wrote it. */
const MARK_TAGS = new Set(["STRONG", "B", "EM", "I", "DEL", "S", "MARK", "CODE", "A", "KBD", "SUP", "SUB", "U", "SMALL", "ABBR"]);

/** Where a mark can never reach past. */
const STRUCTURE = new Set([
  "LI", "P", "DIV", "TD", "TH", "BLOCKQUOTE", "UL", "OL", "TABLE", "TBODY",
  "THEAD", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "FIGURE", "FIGCAPTION",
]);

/** Nodes whose contents are literal text: nothing may be marked inside them. */
function literalAround(node, root) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  while (cur && cur !== root && cur.nodeType === 1) {
    if (cur.tagName === "CODE") return "code";
    if (cur.dataset && (cur.dataset.md === "math" || cur.dataset.mdSrc != null)) return "literal";
    if (STRUCTURE.has(cur.tagName)) return "";
    cur = cur.parentNode;
  }
  return "";
}

function matches(el, spec) {
  if (el.tagName === spec.tag.toUpperCase()) return true;
  return !!(spec.alias && spec.alias.includes(el.tagName));
}

function closestMark(node, spec, root) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  while (cur && cur !== root && cur.nodeType === 1) {
    if (matches(cur, spec)) return cur;
    if (STRUCTURE.has(cur.tagName)) return null;
    cur = cur.parentNode;
  }
  return null;
}

/** The element a mark may not be split past — a list item, a cell, the block. */
function stopFor(node, root) {
  let cur = node.parentNode;
  while (cur && cur !== root && !STRUCTURE.has(cur.tagName)) cur = cur.parentNode;
  return cur || root;
}

/* ─── the four primitives ──────────────────────────────────────────────────── */

/**
 * Split every ancestor between `node` and `stop` so that the chain from `stop`
 * down to `node` holds nothing else. Returns the top of that isolated chain —
 * which, when `stop` is a mark's parent, IS that mark holding only this node.
 */
function isolate(node, stop) {
  let cur = node;
  while (cur.parentNode && cur.parentNode !== stop) {
    const parent = cur.parentNode;
    if (!parent.parentNode) break;

    if (cur.previousSibling) {
      const left = parent.cloneNode(false);
      while (parent.firstChild !== cur) left.appendChild(parent.firstChild);
      parent.parentNode.insertBefore(left, parent);
    }
    if (cur.nextSibling) {
      const right = parent.cloneNode(false);
      while (cur.nextSibling) right.appendChild(cur.nextSibling);
      parent.parentNode.insertBefore(right, parent.nextSibling);
    }
    cur = parent;
  }
  return cur;
}

function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function dress(el, spec, opts) {
  if (spec.key === "mark") {
    const colour = opts && opts.colour;
    if (colour) el.className = "hl-" + colour;
    else el.removeAttribute("class");
    return;
  }
  if (spec.key === "link") el.setAttribute("href", (opts && opts.href) || "#");
  el.setAttribute("data-md", spec.key);
}

function addMark(node, spec, root, opts) {
  if (closestMark(node, spec, root)) return null;
  const el = document.createElement(spec.tag);
  dress(el, spec, opts);
  node.parentNode.insertBefore(el, node);
  el.appendChild(node);
  return el;
}

function dropMark(node, spec, root) {
  const el = closestMark(node, spec, root);
  if (!el) return;
  unwrap(isolate(node, el.parentNode));
}

function retarget(node, spec, root, opts) {
  const el = closestMark(node, spec, root);
  if (!el) return addMark(node, spec, root, opts);
  dress(isolate(node, el.parentNode), spec, opts);
  return null;
}

/* ─── range handling ───────────────────────────────────────────────────────── */

/** Split both ends so the range begins and ends between whole text nodes. */
function carve(range) {
  const sc = range.startContainer;
  const so = range.startOffset;
  const ec = range.endContainer;
  const eo = range.endOffset;
  const same = sc === ec;

  if (ec.nodeType === 3 && eo > 0 && eo < ec.nodeValue.length) ec.splitText(eo);

  if (sc.nodeType === 3 && so > 0 && so < sc.nodeValue.length) {
    const tail = sc.splitText(so);
    // End first: moving the start past a stale end collapses the range.
    if (same) range.setEnd(tail, tail.nodeValue.length);
    range.setStart(tail, 0);
  }
}

/** Every text node the range covers, in document order. */
function covered(range, root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue.length) continue;
    const probe = document.createRange();
    probe.selectNodeContents(node);
    if (
      range.compareBoundaryPoints(Range.START_TO_START, probe) <= 0 &&
      range.compareBoundaryPoints(Range.END_TO_END, probe) >= 0
    ) {
      out.push(node);
    }
  }
  return out;
}

/** Every text node the range touches at all — read-only, splits nothing. */
function touched(range, root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue.trim()) continue;
    const probe = document.createRange();
    probe.selectNodeContents(node);
    if (
      range.compareBoundaryPoints(Range.END_TO_START, probe) < 0 &&
      range.compareBoundaryPoints(Range.START_TO_END, probe) > 0
    ) {
      out.push(node);
    }
  }
  return out;
}

/* ─── tidying ──────────────────────────────────────────────────────────────── */

function signature(el) {
  if (!el || el.nodeType !== 1 || !MARK_TAGS.has(el.tagName)) return null;
  const href = el.getAttribute("href") || "";
  return el.tagName + "|" + (el.className || "") + "|" + href;
}

function insideSame(el, root) {
  const sig = signature(el);
  let cur = el.parentNode;
  while (cur && cur !== root && cur.nodeType === 1) {
    if (signature(cur) === sig) return true;
    if (STRUCTURE.has(cur.tagName)) return false;
    cur = cur.parentNode;
  }
  return false;
}

/**
 * Put the tree back into a shape markdown can express: no empty marks, no mark
 * inside the same mark, and no two identical marks side by side.
 *
 * Text nodes are never destroyed here — no `normalize()` — because the caller
 * still holds references to them and puts the selection back with those.
 */
function tidy(root) {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (!el.parentNode || !MARK_TAGS.has(el.tagName)) continue;

    if (!el.firstChild || (!el.textContent && !el.querySelector("img, br"))) {
      el.remove();
      continue;
    }
    if (insideSame(el, root)) {
      unwrap(el);
      continue;
    }
    const prev = el.previousSibling;
    if (prev && signature(prev) && signature(prev) === signature(el)) {
      while (el.firstChild) prev.appendChild(el.firstChild);
      el.remove();
    }
  }
}

/* ─── what the toolbar reads ───────────────────────────────────────────────── */

/**
 * `active` is what covers the WHOLE selection, `partial` what covers part of
 * it — the distinction the button's on/mixed state is drawn from. With the
 * caret collapsed there is no partial: it is simply what the caret sits inside.
 */
export function markState(root) {
  const sel = selection();
  if (!sel || !sel.rangeCount || !root || !root.contains(sel.anchorNode)) return null;

  const range = sel.getRangeAt(0);
  const collapsed = sel.isCollapsed;
  const nodes = collapsed ? [sel.anchorNode] : touched(range, root);
  const live = nodes.filter((n) => n && root.contains(n));
  if (!live.length) return { collapsed, active: new Set(), partial: new Set(), literal: "", colour: "", href: "" };

  const active = new Set();
  const partial = new Set();
  for (const spec of MARKS) {
    let on = 0;
    for (const node of live) if (closestMark(node, spec, root)) on += 1;
    if (on === live.length) active.add(spec.key);
    else if (on) partial.add(spec.key);
  }

  const anchorMark = closestMark(live[0], BY_KEY.get("mark"), root);
  const anchorLink = closestMark(live[0], BY_KEY.get("link"), root);

  return {
    collapsed,
    active,
    partial,
    literal: literalAround(live[0], root),
    colour: anchorMark ? (anchorMark.className || "").replace(/^hl-/, "") : "",
    href: anchorLink ? anchorLink.getAttribute("href") || "" : "",
  };
}

/* ─── the one entry point ──────────────────────────────────────────────────── */

/**
 * Toggle, or retarget, one mark over the live selection.
 *
 * `opts.colour` re-colours a highlight instead of removing it; `opts.href`
 * re-points a link instead of removing it. Returns false when there was nothing
 * to act on, so the caller can leave the document untouched.
 */
export function applyMark(root, key, opts = {}) {
  const spec = BY_KEY.get(key);
  const sel = selection();
  if (!spec || !sel || !sel.rangeCount || sel.isCollapsed) return false;

  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return false;

  carve(range);
  const nodes = covered(range, root).filter((n) => n.nodeValue.length);
  if (!nodes.length) return false;

  const all = nodes.every((n) => closestMark(n, spec, root));
  const wants = spec.key === "mark" ? "colour" : spec.key === "link" ? "href" : "";
  const given = wants && opts[wants] !== undefined && opts[wants] !== "";

  if (all && given) {
    const now = nodes.map((n) => {
      const el = closestMark(n, spec, root);
      return spec.key === "mark" ? (el.className || "").replace(/^hl-/, "") : el.getAttribute("href") || "";
    });
    // Asking for what it already is means "take it off"; asking for something
    // else means "make it that" — never nest a second one inside the first.
    if (now.every((value) => value === opts[wants])) nodes.forEach((n) => dropMark(n, spec, root));
    else nodes.forEach((n) => retarget(n, spec, root, opts));
  } else if (all) {
    nodes.forEach((n) => dropMark(n, spec, root));
  } else {
    if (spec.literal) for (const node of nodes) stripAround(node, root);
    const made = nodes.map((n) => addMark(n, spec, root, opts)).filter(Boolean);

    // Flattening replaces the text nodes, so the selection is put back around
    // the elements that now hold them.
    if (spec.literal && made.length) {
      for (const el of made) el.textContent = el.textContent;
      tidy(root);
      select(sel, made);
      return true;
    }
  }

  tidy(root);
  select(sel, nodes);
  return true;
}

/** Everything a literal mark is about to swallow has to come off first. */
function stripAround(node, root) {
  const stop = stopFor(node, root);
  const top = isolate(node, stop);
  let cur = top;
  while (cur && cur !== node) {
    const next = cur.firstChild;
    if (MARK_TAGS.has(cur.tagName)) unwrap(cur);
    cur = next;
  }
}

/** Strip every mark off the selection, leaving the words where they are. */
export function clearMarks(root) {
  const sel = selection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return false;

  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return false;

  carve(range);
  const nodes = covered(range, root).filter((n) => n.nodeValue.length);
  if (!nodes.length) return false;

  for (const node of nodes) stripAround(node, root);
  tidy(root);
  select(sel, nodes);
  return true;
}

/** Put the selection back around what was just operated on. */
function select(sel, nodes) {
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!first || !last || !first.parentNode || !last.parentNode) return;

  const out = document.createRange();
  if (first.nodeType === 3) out.setStart(first, 0);
  else out.setStartBefore(first);
  if (last.nodeType === 3) out.setEnd(last, last.nodeValue.length);
  else out.setEndAfter(last);

  sel.removeAllRanges();
  sel.addRange(out);
}

/**
 * Put `node` where the caret is, and leave the caret after it.
 *
 * The zero-width text node is load-bearing: without something to sit in, the
 * caret stays INSIDE the element that was just inserted and the next keystroke
 * lands inside the link, the code span or the image's alt text.
 */
export function insertInline(root, node) {
  const sel = selection();
  if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return false;

  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(node);

  const tail = document.createTextNode("​");
  node.parentNode.insertBefore(tail, node.nextSibling);

  const after = document.createRange();
  after.setStart(tail, 1);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
  return true;
}
