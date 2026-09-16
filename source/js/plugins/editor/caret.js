/**
 * Caret helpers for the rich blocks.
 *
 * A block editor asks the selection three things and nothing else: is the caret
 * at the very start of this box, at the very end, and where is it so a menu can
 * be put beside it. Everything harder — moving across a block boundary, undoing
 * a split — is expressed as those three plus a focus call, which is what keeps
 * the keyboard handling in blocks.js short enough to reason about.
 */

export function selection() {
  const sel = window.getSelection();
  return sel && sel.rangeCount ? sel : null;
}

function boundaryRange(el, toStart) {
  const sel = selection();
  if (!sel || !el.contains(sel.anchorNode)) return null;
  const probe = sel.getRangeAt(0).cloneRange();
  probe.collapse(toStart);
  const bound = probe.cloneRange();
  bound.selectNodeContents(el);
  if (toStart) bound.setEnd(probe.startContainer, probe.startOffset);
  else bound.setStart(probe.endContainer, probe.endOffset);
  return bound;
}

/** What the author actually typed: the editor's own caret anchors do not count. */
function typed(range) {
  return range.toString().replace(/​/g, "");
}

/** True when nothing but whitespace lies between the caret and the start. */
export function atStart(el) {
  const range = boundaryRange(el, true);
  return range ? typed(range).length === 0 : false;
}

export function atEnd(el) {
  const range = boundaryRange(el, false);
  return range ? typed(range).length === 0 : false;
}

export function isCollapsed() {
  const sel = selection();
  return !sel || sel.isCollapsed;
}

/** Characters between the start of `el` and the caret — what `/` menus need. */
export function offsetIn(el) {
  const range = boundaryRange(el, true);
  return range ? typed(range).length : 0;
}

const ZWSP = 0x200b;

function collapse(node, offset) {
  const range = document.createRange();
  range.setStart(node, Math.max(0, Math.min(offset, node.nodeValue ? node.nodeValue.length : 0)));
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Where the caret is inside `el`, or null when it is somewhere else entirely.
 *
 * `offsetIn` answers 0 for both "at the start" and "not here", which is fine for
 * a slash menu and wrong for the thing this is used for: putting the caret back
 * after a block has been rewritten under it. Only a block that HELD the caret
 * should get it back.
 */
export function caretMark(el) {
  const sel = selection();
  if (!el || !sel || !el.contains(sel.anchorNode)) return null;
  return offsetIn(el);
}

/**
 * The inverse of `offsetIn`: put the caret `offset` typed characters into `el`.
 *
 * Boundary anchors are skipped on the way in exactly as they are skipped on the
 * way out, so a paragraph that gained or lost a mark while being rewritten still
 * puts the caret back beside the same character. `preventScroll` is not a
 * nicety — focusing without it scrolls the block into the browser's idea of
 * view, which on a phone fights the editor's own scrolling and bounces the page.
 */
export function placeAt(el, offset) {
  if (!el) return;
  el.focus({ preventScroll: true });

  const want = Math.max(0, offset || 0);
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last = null;
  let node;

  while ((node = walk.nextNode())) {
    const raw = node.nodeValue;
    last = node;
    for (let i = 0; i <= raw.length; i++) {
      if (seen === want) return void collapse(node, i);
      if (i < raw.length && raw.charCodeAt(i) !== ZWSP) seen += 1;
    }
  }

  if (last) return void collapse(last, last.nodeValue.length);
  focusEnd(el);
}

export function focusStart(el) {
  // `preventScroll` throughout: the browser's idea of "in view" is the middle of
  // the window, and letting it scroll there fights the editor's own travel and
  // bounces the page — hardest on a phone, where it also fires under the
  // keyboard. Where the caret should be on screen is decided in index.js.
  el.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

export function focusEnd(el) {
  el.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Where the caret is on screen, for anchoring a popover. */
export function caretRect() {
  const sel = selection();
  if (!sel) return null;
  const range = sel.getRangeAt(0).cloneRange();
  const rects = range.getClientRects();
  if (rects.length) return rects[rects.length - 1];

  // A collapsed caret in an empty element produces no rect of its own, so a
  // zero-width probe is inserted, measured and removed in the same frame.
  const probe = document.createElement("span");
  probe.appendChild(document.createTextNode("​"));
  range.insertNode(probe);
  const rect = probe.getBoundingClientRect();
  const parent = probe.parentNode;
  parent.removeChild(probe);
  // Deliberately NOT normalize(): merging adjacent text nodes would swallow the
  // zero-width boundary anchors either side of a mark, and those are the only
  // reason the caret can be put inside a format rather than beside it.
  return rect;
}

/** Split the block's content at the caret; returns the HTML that moves out. */
export function splitAtCaret(el) {
  const sel = selection();
  if (!sel) return "";
  const range = sel.getRangeAt(0).cloneRange();
  range.setEndAfter(el.lastChild || el);
  const tail = range.extractContents();
  const holder = document.createElement("div");
  holder.appendChild(tail);
  return holder.innerHTML;
}

/** Replace the `length` characters before the caret with `node`. */
export function replaceBefore(el, length, node) {
  const sel = selection();
  if (!sel) return;
  const range = sel.getRangeAt(0).cloneRange();
  const anchor = range.startContainer;
  if (anchor.nodeType !== 3 || range.startOffset < length) return;

  range.setStart(anchor, range.startOffset - length);
  range.deleteContents();
  range.insertNode(node);

  const after = document.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
}

/** Wrap the current selection in `tag`, or unwrap it if it is already wrapped. */
export function toggleWrap(tag, attrs) {
  const sel = selection();
  if (!sel || sel.isCollapsed) return false;

  const range = sel.getRangeAt(0);
  const existing = closestTag(range.commonAncestorContainer, tag);
  if (existing) {
    const parent = existing.parentNode;
    while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
    parent.removeChild(existing);
    parent.normalize();
    return true;
  }

  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  try {
    node.appendChild(range.extractContents());
    range.insertNode(node);
    const after = document.createRange();
    after.selectNodeContents(node);
    sel.removeAllRanges();
    sel.addRange(after);
    return true;
  } catch (err) {
    return false;
  }
}

export function closestTag(node, tag) {
  let cursor = node && node.nodeType === 3 ? node.parentNode : node;
  const name = tag.toUpperCase();
  while (cursor && cursor.classList && !cursor.classList.contains("ed-rich")) {
    if (cursor.tagName === name) return cursor;
    cursor = cursor.parentNode;
  }
  return null;
}
