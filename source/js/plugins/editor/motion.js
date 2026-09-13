/**
 * The editor's motion primitives.
 *
 * The four constants are the management console's, verbatim — the editor is
 * reached from that console and shares its chrome, and a second set of timings
 * would read as a second application. Every helper here is a no-op under
 * `prefers-reduced-motion`, so nothing below has to check.
 *
 * Heights are always MEASURED, never estimated. Tailwind's preflight makes the
 * editor's boxes `border-box`, so `offsetHeight` is the number the animation
 * wants; a box whose content is being swapped is measured on both sides of the
 * swap and the difference is what gets animated.
 */

export const FADE_MS = 130;
export const MORPH_MS = 280;
export const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
export const BLUR = "blur(3px)";

export function reduced() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function settle(animation) {
  return animation ? animation.finished.catch(() => {}) : Promise.resolve();
}

/**
 * One painted frame.
 *
 * Every height below is measured after one of these. A box that has just had
 * its contents replaced is not finished laying out at the end of the task that
 * replaced them — an SVG whose glyph metrics have only just been applied, a
 * textarea that has not yet been asked for its scrollHeight, a font that
 * swapped in — and a height measured in the same tick is a height the animation
 * then has to correct in front of the reader.
 */
function nextFrame() {
  return new Promise((done) => requestAnimationFrame(() => done()));
}

/**
 * Change what is inside `el` while its height travels to whatever the new
 * contents turn out to be.
 *
 * TURN OUT TO BE, not "measure once and go there". Measuring in the tick after
 * the swap is measuring a guess: a tab pane and a folding each mount a canvas of
 * their own, and a canvas holds pictures that are still being fetched, EXIF
 * cards that have not laid out, equations that have not typeset and diagrams
 * that have not drawn. Every one of those lands after the animation has already
 * chosen its destination, so the box arrived at a height that was wrong and then
 * snapped to the right one — which is the jump at the end of a tab switch, and
 * the reason a pane holding a picture never looked right at all.
 *
 * So the target is not a number taken once. A ResizeObserver watches the content
 * and the animation is RE-AIMED from wherever it currently is each time the
 * content settles somewhere new. A picture arriving two seconds late does not
 * jump the box; it bends the box's path.
 *
 * The box is pinned and clipped for the whole of that, so nothing is ever at
 * full size before the travel — the jump would simply move to the front — and
 * nothing spills while the box is smaller than what is in it. `WATCH_MS` is how
 * long after the last change it keeps following; the pin comes off then.
 *
 * Resolves when the FIRST travel lands, so a caller that awaits it is not
 * waiting on a slow network.
 */
const WATCH_MS = 900;
let passes = 0;

export function morphHeight(el, mutate) {
  if (reduced() || !el || !el.firstElementChild) return Promise.resolve(mutate());

  const inner = el.firstElementChild;
  const token = ++passes;
  // Saved on the ELEMENT, so a pass that takes over mid-travel restores what
  // was there before ANY of them started rather than its predecessor's pin.
  if (!el.__morphBack) el.__morphBack = { height: el.style.height, overflow: el.style.overflow };
  el.__morph = token;

  el.style.height = el.offsetHeight + "px";
  el.style.overflow = "hidden";

  /** What `el` would be if it were not pinned — the content, plus its own frame. */
  const target = () => {
    const box = getComputedStyle(el);
    const own = getComputedStyle(inner);
    return Math.round(
      inner.offsetHeight +
        parseFloat(own.marginTop) + parseFloat(own.marginBottom) +
        parseFloat(box.paddingTop) + parseFloat(box.paddingBottom) +
        parseFloat(box.borderTopWidth) + parseFloat(box.borderBottomWidth)
    );
  };

  let run = null;
  let aimed = -1;
  let quiet = 0;
  let landed = null;
  const first = new Promise((done) => (landed = done));

  const release = () => {
    if (el.__morph !== token) return;
    watcher.disconnect();
    clearTimeout(quiet);
    el.style.height = el.__morphBack.height;
    el.style.overflow = el.__morphBack.overflow;
    el.__morphBack = null;
    contentChanged();
    landed();
  };

  const aim = () => {
    if (el.__morph !== token) return;
    const to = target();
    if (to === aimed) return;
    aimed = to;

    // Read where it IS before cancelling: an animation owns `height` while it
    // runs, and cancelling first would snap the reading back to the pin.
    const now = el.offsetHeight;
    if (run) run.cancel();
    el.style.height = now + "px";

    clearTimeout(quiet);
    quiet = setTimeout(release, MORPH_MS + WATCH_MS);

    if (now === to) return;
    const mine = el.animate([{ height: now + "px" }, { height: to + "px" }], { duration: MORPH_MS, easing: EASE });
    run = mine;
    mine.finished.catch(() => {}).then(() => {
      // `run !== mine` means this one was cancelled by a re-aim, and writing its
      // stale destination would undo the pin the new one is travelling from.
      if (el.__morph !== token || run !== mine) return;
      el.style.height = to + "px";
      contentChanged();
      landed();
    });
  };

  const watcher = new ResizeObserver(aim);

  return Promise.resolve(mutate())
    .catch(() => {})
    .then(() => nextFrame())
    .then(() => {
      if (el.__morph !== token) return;
      watcher.observe(inner);
      aim();
      // Nothing to travel: the caller is not made to wait, but the watch stays
      // on — a picture in the new pane may still be seconds away.
      if (!run) landed();
      return first;
    });
}

/**
 * The swap every source⇄render toggle uses: the old content blurs out, the new
 * one arrives, and the box travels to its new height WHILE that happens.
 *
 * The height used to be its own step between the two fades, which is a quarter
 * of a second in which the box is empty and moving. On an equation that is the
 * whole of the effect — a small textarea becomes a tall rendered formula, so
 * the reader watches an invisible box stretch a long way and only then get its
 * contents. Overlapping them means the formula arrives as the space for it does.
 */
export async function crossFade(el, mutate) {
  if (reduced()) return void (await mutate());

  await settle(
    el.animate(
      [{ opacity: 1, filter: "none" }, { opacity: 0, filter: BLUR }],
      { duration: FADE_MS, easing: "ease-in", fill: "forwards" }
    )
  );

  const from = measureFlow(el);
  await mutate();
  await nextFrame();
  const to = measureFlow(el);

  el.getAnimations().forEach((a) => a.cancel());

  const runs = [
    el.animate(
      [{ opacity: 0, filter: BLUR }, { opacity: 1, filter: "none" }],
      { duration: FADE_MS, easing: "ease-out" }
    ),
  ];
  // The margins travel with the height for the same reason they do in `enter`:
  // an explicit height stops the contents' own margins collapsing out of the
  // box, so animating the height alone moved everything below by that difference
  // for the length of the swap and put it back at the end of it.
  const moved = from.height !== to.height || from.mt1 !== to.mt1 || from.mb1 !== to.mb1;
  if (moved) {
    el.style.overflow = "clip";
    runs.push(
      el.animate(
        [
          { height: from.height + "px", marginTop: from.mt1 + "px", marginBottom: from.mb1 + "px" },
          { height: to.height + "px", marginTop: to.mt1 + "px", marginBottom: to.mb1 + "px" },
        ],
        { duration: MORPH_MS, easing: EASE }
      )
    );
  }
  await Promise.all(runs.map(settle));
  if (moved) el.style.overflow = "";
}

/**
 * What a box COSTS the page, and the two margins that hand that cost back.
 *
 * A height animation alone cannot open or close a gap, because a box's height
 * is not what it occupies. Three things sit outside it:
 *
 *   · its own margins, which on the document bar are 22px and 14px of real
 *     space that the height animation never touched — they landed whole, in one
 *     frame, the instant the bar was inserted;
 *   · the flex `gap` on either side of it, another 26px each in the console's
 *     column, which landed the same way;
 *   · the margins of what is INSIDE it. `.ed-block` is a bare wrapper with no
 *     padding and no border, so a paragraph's 1rem margins collapse straight
 *     through it — they are the block's outer margins, and its `offsetHeight`
 *     does not include them.
 *
 * That last one is also why the old animation ended with a jolt. `overflow:
 * hidden` makes a box a block formatting context, and a formatting context does
 * not let its children's margins collapse out — so pinning the block for the
 * animation moved roughly 2rem of margin from OUTSIDE the box to INSIDE it, and
 * releasing the pin at the end moved it back, in one frame, under the reader's
 * cursor. How much depended entirely on what the block's neighbours were: a full
 * 32px between two paragraphs, 24px against the tail's smaller gap, something
 * else again inside a note — which is why no two insertions jumped alike.
 * `overflow: clip` does the same clipping and establishes no formatting context,
 * so the box keeps the shape it will keep.
 *
 * So the cost is MEASURED, by asking the page what moves, and then given back
 * through the margins — which are the only properties that can cancel space the
 * box does not contain. Four readings, each correcting the last:
 *
 *   `mt1`/`mb1`  pinned at full height, the box costs exactly what it costs at
 *                rest — so the animation's final frame IS the resting layout and
 *                clearing the inline styles changes nothing.
 *   `mt0`/`mb0`  collapsed, the box costs NOTHING — its top edge sits exactly
 *                where the following content was, and that content has not
 *                moved a pixel.
 *
 * Between those two the travel is continuous, and the gap under the box stays
 * the gap it will end up being for the whole of it.
 */
/**
 * The first box below `el` that a change in `el`'s height actually moves.
 *
 * It CLIMBS. A block inserted at the end of the article — or at the end of a
 * nested block, which is the same shape one level down — has no following
 * sibling, and this used to give up there and fall back to the parent's own
 * height. That reading is a lie in exactly the case it was needed: a last
 * child's bottom margin COLLAPSES THROUGH its parent's bottom edge, so
 * `parent.offsetHeight` does not change when the margin does. The compensation
 * computed from it was therefore zero, while the collapsed margin escaped the
 * parent and shoved everything after the article down by a whole paragraph gap
 * on the animation's first frame. That is the jolt — and it happened only at a
 * tail, because anywhere else there is a sibling and the reading is honest.
 *
 * Climbing to the parent's next sibling reads a box OUTSIDE the collapsing
 * chain, which does move, and moves continuously.
 *
 * `offsetTop` is 0 on a box that is not rendered, says nothing about what is
 * above it when the box is out of the flow, and reports where a sticky box is
 * STUCK rather than where it belongs — so those are skipped. Only differences
 * between readings of the SAME probe are ever used, so it does not matter that
 * a climbed probe measures from a different offset parent than `el` does.
 */
function flowProbe(el) {
  let at = el;
  while (at && at !== document.body && at !== document.documentElement) {
    for (let next = at.nextElementSibling; next; next = next.nextElementSibling) {
      const style = getComputedStyle(next);
      if (style.display === "none") continue;
      if (style.position !== "static" && style.position !== "relative") continue;
      return next;
    }
    at = at.parentElement;
  }
  return null;
}

/**
 * What the box below an insertion point measures right now.
 *
 * Taken by the caller BEFORE the new block is in the tree, because that is the
 * one reading the measurement below cannot take for itself: a block pulled out
 * of the flow is still a SIBLING, so `:first-child` and `:last-of-type` have
 * already moved to it — and those three rules in editor.styl are worth a whole
 * paragraph margin on the block that used to hold them. `before` is whatever
 * the new block will be inserted in front of.
 */
export function flowCost(parent, before) {
  if (before) return before.offsetTop;
  // The same probe `measureFlow` will find once the block is the last child:
  // no siblings of its own, so the chain starts at the parent. Read the same
  // way, or the difference the caller hands back means nothing.
  const probe = flowProbe(parent);
  return probe ? probe.offsetTop : parent.offsetHeight;
}

function measureFlow(el, gone) {
  const parent = el.parentElement;
  const probe = flowProbe(el);
  // Only a SIBLING sits where this box is about to be. A climbed probe is
  // further down the page and past a margin that collapses, so the whole of the
  // compensation belongs on the bottom margin — the same as having no probe at
  // all, which is what this used to be.
  const beside = !!probe && probe.parentElement === parent;
  // What the box costs, in one number: where the next thing starts, or failing
  // that how tall the parent is.
  const cost = probe ? () => probe.offsetTop : () => (parent ? parent.offsetHeight : 0);

  const own = getComputedStyle(el);
  const natMT = parseFloat(own.marginTop) || 0;
  const natMB = parseFloat(own.marginBottom) || 0;
  const back = {
    height: el.style.height,
    overflow: el.style.overflow,
    marginTop: el.style.marginTop,
    marginBottom: el.style.marginBottom,
    position: el.style.position,
  };

  // Every reading below is a FLOW reading, and a stuck sticky box — the document
  // bar, on a console that is already scrolled — reports where it is stuck
  // instead. `relative` with no offsets is the same box in the same place minus
  // the stickiness, so the flow is legible again; `back` puts it back.
  const inFlow = own.position === "sticky" ? "relative" : back.position;
  el.style.position = inFlow;

  const height = el.offsetHeight;
  const topAtRest = el.offsetTop;
  const costAtRest = cost();

  // Taken out of the flow rather than hidden. `display: none` blurs whatever is
  // focused inside the box, and a block is very often deleted from the caret
  // that is still sitting in it.
  el.style.position = "absolute";
  const loose = cost();
  el.style.position = inFlow;
  const zero = gone == null ? loose : gone;

  el.style.overflow = "clip";
  el.style.height = height + "px";
  el.style.marginTop = natMT + "px";
  el.style.marginBottom = natMB + "px";
  const mt1 = natMT + (topAtRest - el.offsetTop);
  const mb1 = natMB + (costAtRest - cost());

  el.style.height = "0px";
  el.style.marginTop = mt1 + "px";
  el.style.marginBottom = mb1 + "px";
  // Nothing directly below to be overlapped: the whole of the compensation goes
  // on the bottom margin.
  const mt0 = beside ? mt1 + (zero - el.offsetTop) : mt1;
  el.style.marginTop = mt0 + "px";
  const mb0 = mb1 + (zero - cost());

  Object.assign(el.style, back);
  return { height, mt0, mb0, mt1, mb1, loose };
}

function frames(flow) {
  return [
    { height: "0px", marginTop: flow.mt0 + "px", marginBottom: flow.mb0 + "px", opacity: 0, filter: BLUR },
    {
      height: flow.height + "px",
      marginTop: flow.mt1 + "px",
      marginBottom: flow.mb1 + "px",
      opacity: 1,
      filter: "none",
    },
  ];
}

/**
 * A block arriving: it grows from nothing while the ones below it move down.
 *
 * `ready` is the block's own first paint, where it has one — a diagram, an
 * equation and a code block all render asynchronously, and a height measured
 * before that finished is a height the block then jumps away from the instant
 * the animation ends. The block is held collapsed until it can be measured
 * truthfully, and held at NO COST while it waits, so a diagram taking a second
 * to draw does not hold the page open around an empty box. It never flashes at
 * full size first either: everything between clearing the pin to measure and
 * putting it back happens inside one task, so the browser has no frame in which
 * to paint the open state.
 */
export async function enter(el, ready, gone) {
  if (reduced()) return;

  let flow = measureFlow(el, gone);
  if (ready) {
    el.style.overflow = "clip";
    el.style.height = "0px";
    el.style.marginTop = flow.mt0 + "px";
    el.style.marginBottom = flow.mb0 + "px";
    await Promise.resolve(ready).catch(() => {});
    await nextFrame();
    el.style.height = "";
    el.style.marginTop = "";
    el.style.marginBottom = "";
    el.style.overflow = "";

    // The caller's reading was absolute, and a block that took a second to draw
    // itself has let the page move under it. What carries over is the DIFFERENCE
    // that reading revealed — what the first/last selectors are worth — rather
    // than the number, re-anchored to where the page is now.
    const selectors = gone == null ? 0 : gone - flow.loose;
    flow = measureFlow(el);
    if (selectors) flow = measureFlow(el, flow.loose + selectors);
  }

  el.style.overflow = "clip";
  const run = el.animate(frames(flow), { duration: MORPH_MS, easing: EASE });
  // Cleared while the animation owns them, so there is no frame in which the
  // inline values and the animation disagree — and none left behind at the end,
  // where the animation's last frame is already the resting layout.
  el.style.height = "";
  el.style.marginTop = "";
  el.style.marginBottom = "";
  await settle(run);
  el.style.overflow = "";
}

/** A block leaving. Resolves once it is safe to remove from the DOM — by then it
 *  costs the page nothing, so removing it moves nothing. */
export async function exit(el) {
  if (reduced()) return;
  const flow = measureFlow(el);
  el.style.overflow = "clip";
  await settle(
    el.animate(frames(flow).reverse(), { duration: MORPH_MS, easing: EASE, fill: "forwards" })
  );
}

/**
 * FLIP over a set of siblings. `mutate` reorders them; everything that moved
 * travels from where it was rather than jumping.
 */
export async function flip(nodes, mutate) {
  if (reduced()) return void mutate();

  const before = new Map();
  for (const node of nodes) before.set(node, node.getBoundingClientRect());

  mutate();

  const runs = [];
  for (const node of nodes) {
    const from = before.get(node);
    if (!from) continue;
    const to = node.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (!dx && !dy) continue;
    runs.push(
      node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: MORPH_MS, easing: EASE }
      )
    );
  }
  await Promise.all(runs.map(settle));
}

/**
 * The floating toolbar arriving and leaving.
 *
 * Slower than `pop`, and deliberately: this is a whole surface appearing over
 * the article rather than a menu answering a click, and the same 180ms that
 * reads as responsive on a popover reads as a flicker on something this size.
 * It travels from under the document bar, which is where it belongs.
 */
export const TOOLBAR_IN_MS = 360;
export const TOOLBAR_OUT_MS = 240;

export function toolbarIn(el) {
  if (reduced()) return Promise.resolve();
  return settle(
    el.animate(
      [
        { opacity: 0, transform: "translateY(-14px) scale(0.965)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: TOOLBAR_IN_MS, easing: EASE }
    )
  );
}

/**
 * Leaving. The box is FROZEN first — the toolbar's width and left edge are
 * `var(--ed-docbar-x/w)`, published by the document bar, and teardown takes
 * those away: without this the toolbar snapped to the full viewport width for
 * the length of its own exit animation before disappearing.
 */
export function toolbarOut(el) {
  const box = el.getBoundingClientRect();
  el.style.left = box.left + "px";
  el.style.width = box.width + "px";
  el.style.top = box.top + "px";
  el.style.transition = "none";

  if (reduced()) return Promise.resolve();
  return settle(
    el.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-10px) scale(0.97)" },
      ],
      { duration: TOOLBAR_OUT_MS, easing: "ease-in", fill: "forwards" }
    )
  );
}

/** The pop a menu or popover makes. */
export function pop(el) {
  if (reduced()) return;
  el.animate(
    [
      { opacity: 0, transform: "translateY(8px) scale(0.98)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 180, easing: EASE }
  );
}

/**
 * The drag image, given something the browser can measure.
 *
 * `setDragImage(el, dx, dy)` snapshots the whole of `el`'s paint, and a block
 * paints a gutter that is absolutely positioned OUTSIDE its border box: the
 * bitmap began a column's width to the left of the rectangle the offsets were
 * measured against, so the pointer sat too far left inside it and the ghost rode
 * to the right. The API was right and the element handed to it was wrong. It
 * gets a clipped clone of exactly the border box instead, and the browser draws,
 * scales and positions it as it always has.
 */
export function setDragImage(e, el) {
  if (!e.dataTransfer || !e.dataTransfer.setDragImage) return;
  const box = el.getBoundingClientRect();

  const shot = el.cloneNode(true);
  shot.className = el.className + " ed-dragshot";
  shot.style.width = box.width + "px";
  shot.style.height = box.height + "px";
  // A cloned skeleton is still a preloader to the lazyload observer, and it
  // would fetch the picture again to fill a snapshot that lives for one frame.
  for (const node of shot.querySelectorAll(".img-preloader")) node.dataset.ghost = "1";

  document.body.appendChild(shot);
  e.dataTransfer.setDragImage(shot, e.clientX - box.left, e.clientY - box.top);
  setTimeout(() => shot.remove(), 0);
}

/**
 * Hold a drag near an edge and the thing under it scrolls, faster the closer to
 * the edge you hold.
 *
 * `dragover` fires often enough to track the pointer but nowhere near evenly
 * enough to scroll from, so it only records a position and a rAF loop does the
 * moving. `el` is the container that scrolls; pass nothing for the page.
 */
const EDGE = 90;
const EDGE_SPEED = 18;

export function createEdgeScroll(el) {
  let raf = 0;
  let y = 0;

  const step = () => {
    raf = 0;
    const rect = el ? el.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const zone = Math.max(24, Math.min(EDGE, (rect.bottom - rect.top) / 3));

    let delta = 0;
    if (y < rect.top + zone) delta = -EDGE_SPEED * Math.min(1, (rect.top + zone - y) / zone);
    else if (y > rect.bottom - zone) delta = EDGE_SPEED * Math.min(1, (y - rect.bottom + zone) / zone);

    if (delta) {
      if (el) el.scrollTop += delta;
      else window.scrollBy(0, delta);
    }
    raf = requestAnimationFrame(step);
  };

  return {
    track(next) {
      y = next;
      if (!raf) raf = requestAnimationFrame(step);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

/** Tell the theme's scroll scheduler the page just changed height. */
export function contentChanged() {
  try {
    window.dispatchEvent(new CustomEvent("redefine:content-resized"));
  } catch (err) {
    /* the scheduler is optional */
  }
}
