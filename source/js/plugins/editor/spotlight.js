/**
 * Where an undo or a redo just landed, drawn OVER the article.
 *
 * ── Why an overlay and not a class ──────────────────────────────────────────
 *
 * The thing worth pointing at is usually a few characters, not a paragraph, and
 * there are only two ways to light a character range: wrap it in an element, or
 * paint over it. Wrapping is out — the range lives inside the contenteditable
 * the document is read back from, so a span left there for one second is a span
 * that can be read back into the file. Painting touches nothing: the rectangles
 * are `Range.getClientRects()`, one per line the range covers, drawn in a layer
 * of their own.
 *
 * That also buys the freedom the block-level version did not have. A word, a
 * whole block, a front-matter row and the GAP a deleted block left behind are
 * all just rectangles, so each of them can be shown as what it actually is
 * rather than rounded up to "the block this happened in".
 *
 * ── Document coordinates ────────────────────────────────────────────────────
 *
 * The layer is absolutely positioned at the document origin and every mark is
 * placed against the layer's own measured box, so the marks ride the page when
 * it scrolls — which matters, because a step scrolls to its target and the marks
 * are drawn before that scroll has finished travelling.
 *
 * ── One run, one mark ───────────────────────────────────────────────────────
 *
 * Presses come in runs. Every call replaces what is on screen and the paint is
 * deferred by `WAIT`, so holding Ctrl-Z lights the place it FINISHES at, once,
 * rather than stacking a flash per step.
 */

const WAIT = 90;
const FADE_IN = 190;
const HOLD = 620;
const FADE_OUT = 420;
const SPAN = FADE_IN + HOLD + FADE_OUT;

// A text range is lit a little proud of the glyphs; a whole block is lit on its
// own edge and needs no padding.
const TEXT_PAD_X = 2;
const TEXT_PAD_Y = 1;

let layer = null;
let pending = 0;
let clearing = 0;
let live = [];

function ensure() {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement("div");
  layer.className = "ed-spot";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);
  return layer;
}

/** Take down whatever is showing, and cancel whatever was about to show. */
export function spotClear() {
  clearTimeout(pending);
  clearTimeout(clearing);
  pending = 0;
  clearing = 0;
  for (const node of live) node.remove();
  live = [];
}

function paint(rects, kind) {
  const host = ensure();
  const base = host.getBoundingClientRect();
  const pad = kind === "text";

  for (const rect of rects) {
    if (!rect || (!rect.width && !rect.height)) continue;
    const mark = document.createElement("span");
    mark.className = "ed-spot-mark is-" + kind;
    mark.style.left = rect.left - base.left - (pad ? TEXT_PAD_X : 0) + "px";
    mark.style.top = rect.top - base.top - (pad ? TEXT_PAD_Y : 0) + "px";
    mark.style.width = Math.max(2, rect.width + (pad ? TEXT_PAD_X * 2 : 0)) + "px";
    mark.style.height = Math.max(2, rect.height + (pad ? TEXT_PAD_Y * 2 : 0)) + "px";
    host.appendChild(mark);
    live.push(mark);

    // In, hold, out. One continuous pass rather than a blink: the point is to
    // let the eye find the place, and something that switches on and off twice
    // reads as an error being reported.
    mark.animate(
      [
        { opacity: 0, transform: "scale(0.94)" },
        { opacity: 1, transform: "none", offset: FADE_IN / SPAN },
        { opacity: 1, transform: "none", offset: (FADE_IN + HOLD) / SPAN },
        { opacity: 0, transform: "none" },
      ],
      { duration: SPAN, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "forwards" }
    );
  }

  clearing = setTimeout(spotClear, SPAN + 40);
}

function schedule(read, kind) {
  spotClear();
  pending = setTimeout(() => {
    pending = 0;
    const rects = read();
    if (rects && rects.length) paint(rects, kind);
  }, WAIT);
}

/** The characters themselves — one mark per line the range wraps onto. */
export function spotRange(range) {
  if (!range) return;
  schedule(() => Array.from(range.getClientRects()), "text");
}

/** A whole block, when the block IS the change: one arrived, or one moved. */
export function spotElement(el, kind) {
  if (!el) return;
  schedule(() => (el.isConnected ? [el.getBoundingClientRect()] : []), kind || "block");
}

/**
 * The gap a block left behind.
 *
 * Nothing on screen changed here, which is exactly why it needs marking: a bar
 * drawn in the space between the two survivors says "something was here" without
 * claiming either of them was touched.
 */
export function spotSeam(above, below) {
  schedule(() => {
    const top = above && above.isConnected ? above.getBoundingClientRect() : null;
    const foot = below && below.isConnected ? below.getBoundingClientRect() : null;
    const box = top || foot;
    if (!box) return [];
    const y = top && foot ? (top.bottom + foot.top) / 2 : top ? top.bottom : foot.top;
    return [{ left: box.left, top: y - 2, width: box.width, height: 4 }];
  }, "seam");
}

/* ─── mapping characters to the DOM ────────────────────────────────────────── */

/** Everything `root` says, in the order it says it. */
export function domText(root) {
  if (!root) return "";
  let out = "";
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walk.nextNode())) out += node.nodeValue;
  return out;
}

/** `[from, to)` of `domText(root)`, as a live Range. */
export function domRange(root, from, to) {
  if (!root || to <= from) return null;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();

  let seen = 0;
  let started = false;
  let last = null;
  let node;

  while ((node = walk.nextNode())) {
    const len = node.nodeValue.length;
    if (!started && from <= seen + len) {
      range.setStart(node, Math.max(0, Math.min(len, from - seen)));
      started = true;
    }
    if (started && to <= seen + len) {
      range.setEnd(node, Math.max(0, Math.min(len, to - seen)));
      return range;
    }
    seen += len;
    last = node;
  }

  if (!started || !last) return null;
  range.setEnd(last, last.nodeValue.length);
  return range;
}
