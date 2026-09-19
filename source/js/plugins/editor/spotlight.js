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
 * Presses come in runs. Every call takes down what is on screen INSTANTLY and
 * paints once the article has settled, so holding Ctrl-Z lights the place it
 * finishes at, once, rather than stacking a flash per step — and two marks are
 * never up together at two different sizes, which is what reads as a mark
 * flashing twice.
 */

// The mark is read on the frame the step has finished settling on, not on a
// timer: a block that was just rebuilt, a picture that has just decoded and a
// pinning scroll all land within a frame or two of each other, and a rectangle
// measured before them is a rectangle drawn in the wrong place.
const SETTLE_FRAMES = 2;
const FADE_IN = 130;
// Long enough to still be there once the eye has travelled to it and read the
// line it is on. It costs nothing to leave up: the layer takes no pointer events
// and the caret is somewhere else entirely, so typing over a lit range is
// exactly as possible as typing anywhere else.
const HOLD = 1500;
const FADE_OUT = 520;
const SPAN = FADE_IN + HOLD + FADE_OUT;

// A text range is lit a little proud of the glyphs; a whole block is lit on its
// own edge and needs no padding.
const TEXT_PAD_X = 2;
const TEXT_PAD_Y = 1;

let layer = null;
let token = 0;
let clearing = 0;
let following = 0;
let live = [];

function ensure() {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement("div");
  layer.className = "ed-spot";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);
  return layer;
}

/**
 * Take down whatever is showing, and cancel whatever was about to show.
 *
 * Instantly, always. A mark fading out WHILE its replacement fades in is two
 * marks on screen at two different sizes, which is exactly what "it flashed
 * twice" describes — and the pair is worse than the cut, because the eye reads
 * the wrong one first. One place is lit at a time; being interrupted means the
 * old place is gone before the new one arrives.
 */
export function spotClear() {
  token += 1;
  clearTimeout(clearing);
  cancelAnimationFrame(following);
  clearing = 0;
  following = 0;

  for (const node of live) node.remove();
  live = [];
}

function geometry(mark, rect, pad, base) {
  mark.style.left = rect.left - base.left - (pad ? TEXT_PAD_X : 0) + "px";
  mark.style.top = rect.top - base.top - (pad ? TEXT_PAD_Y : 0) + "px";
  mark.style.width = Math.max(2, rect.width + (pad ? TEXT_PAD_X * 2 : 0)) + "px";
  mark.style.height = Math.max(2, rect.height + (pad ? TEXT_PAD_Y * 2 : 0)) + "px";
}

/**
 * Keep the mark ON the thing it is marking, for as long as it is up.
 *
 * The article is not still while a mark is showing: a picture decodes, an
 * equation is typeset, a folding finishes opening, the page is pinned by a
 * pixel. Measuring once and leaving the rectangle where it was is how a mark
 * came to sit beside the words it was pointing at, at the size they used to be.
 * One rect read per frame, for one element, for as long as the mark is lit.
 */
function follow(read, pad, mine, until) {
  following = requestAnimationFrame(() => {
    following = 0;
    if (mine !== token || !live.length) return;
    const rects = read();
    // A different number of rectangles is a different shape, not a moved one —
    // re-anchoring one of them would be a guess. The mark stays where it is and
    // the watch stops.
    if (rects && rects.length === live.length) {
      // Every read before any write: the layer's own box is the same for all of
      // them, and asking for it between two style writes is a forced reflow per
      // mark per frame.
      const base = live[0].parentNode.getBoundingClientRect();
      for (let i = 0; i < live.length; i++) geometry(live[i], rects[i], pad, base);
    }
    if (Date.now() < until) follow(read, pad, mine, until);
  });
}

function paint(read, kind, mine, round) {
  const rects = read();
  if (!rects || !rects.length) return;

  const host = ensure();
  const pad = kind === "text";
  const base = host.getBoundingClientRect();

  for (const rect of rects) {
    if (!rect || (!rect.width && !rect.height)) continue;
    const mark = document.createElement("span");
    mark.className = "ed-spot-mark is-" + kind;
    // The marked element's own corner, when it has one. A photograph is drawn
    // with a 14px radius and a square mark over it reads as a second, wrong
    // box rather than as the picture being pointed at.
    if (round) mark.style.borderRadius = round;
    host.appendChild(mark);
    geometry(mark, rect, pad, base);
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

  if (!live.length) return;
  follow(read, pad, mine, Date.now() + FADE_IN + HOLD);
  // Already faded to nothing by its own last keyframe, so this only tidies up.
  clearing = setTimeout(spotClear, SPAN + 40);
}

/** Wait for the article to stop moving, then light the place once. */
function schedule(read, kind, round) {
  spotClear();
  const mine = token;
  let left = SETTLE_FRAMES;
  const tick = () => {
    if (mine !== token) return;
    if (left-- > 0) return void requestAnimationFrame(tick);
    paint(read, kind, mine, round);
  };
  requestAnimationFrame(tick);
}

/** The corner the marked box is drawn with, or nothing when it is square. */
function roundOf(el) {
  try {
    const r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    return r > 1 ? r + "px" : "";
  } catch (err) {
    return "";
  }
}

/* ─── what a range is actually worth drawing ───────────────────────────────── */

function usable(rect) {
  return !!rect && rect.width >= 1.5 && rect.height >= 1.5;
}

function box(rect) {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * `getClientRects()` is not a list of places — it is a list of FRAGMENTS.
 *
 * One rectangle per text node, per inline element, per line box, and a
 * zero-width one wherever a boundary anchor sits. Drawn as they come, a range
 * over four words in a sentence carrying a link and a bold word produced six
 * bars, several of them stacked on each other. They are merged back into one bar
 * per line, and anything with no area is dropped.
 */
function tidy(rects) {
  const kept = [];

  for (const raw of rects) {
    if (!usable(raw)) continue;
    const rect = box(raw);
    let merged = false;

    for (let i = 0; i < kept.length; i++) {
      const held = kept[i];
      const sameLine = Math.abs(held.top - rect.top) <= 2 && Math.abs(held.bottom - rect.bottom) <= 2;
      const touching = rect.left <= held.right + 2 && rect.right >= held.left - 2;

      if (sameLine && touching) {
        held.left = Math.min(held.left, rect.left);
        held.top = Math.min(held.top, rect.top);
        held.right = Math.max(held.right, rect.right);
        held.bottom = Math.max(held.bottom, rect.bottom);
        held.width = held.right - held.left;
        held.height = held.bottom - held.top;
        merged = true;
        break;
      }
      if (
        rect.left >= held.left - 0.5 &&
        rect.right <= held.right + 0.5 &&
        rect.top >= held.top - 0.5 &&
        rect.bottom <= held.bottom + 0.5
      ) {
        merged = true;
        break;
      }
    }

    if (!merged) kept.push(rect);
  }

  return kept;
}

/**
 * The characters themselves — one mark per line the range wraps onto.
 *
 * `core` is the range WITHOUT the two characters of padding either side. The
 * padding is there so a one-letter change is still something the eye can land
 * on, and at the end of a line it reaches onto the next one — where it drew a
 * bar over a line break that nothing had happened to. Padding may widen a line
 * the change is on; it may not add a line of its own.
 */
export function spotRange(range, core) {
  if (!range) return;
  schedule(() => {
    const lines = core ? Array.from(core.getClientRects()).filter(usable) : null;
    let rects = Array.from(range.getClientRects());
    if (lines && lines.length) {
      rects = rects.filter((rect) => lines.some((line) => rect.top < line.bottom - 1 && rect.bottom > line.top + 1));
    }
    return tidy(rects);
  }, "text");
}

/**
 * A whole block, when the block IS the change: one arrived, or one moved.
 *
 * `skip` is a strip at the top that is not part of it — the gutter, which out on
 * a desktop sits in the margin beside the block and on a phone takes a row of its
 * own ABOVE the text. Trimmed only when it is actually inside the block's own
 * width, which is exactly the difference between the two.
 */
export function spotElement(el, kind, skip) {
  if (!el) return;
  schedule(() => {
    if (!el.isConnected) return [];
    const rect = el.getBoundingClientRect();
    if (!skip || !skip.isConnected) return [rect];

    const cut = skip.getBoundingClientRect();
    const inside = cut.height > 0 && cut.right > rect.left + 1 && cut.left < rect.right - 1;
    if (!inside || cut.bottom >= rect.bottom - 4) return [rect];

    const top = cut.bottom;
    return [{ left: rect.left, top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.bottom - top }];
  }, kind || "block", roundOf(el));
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
