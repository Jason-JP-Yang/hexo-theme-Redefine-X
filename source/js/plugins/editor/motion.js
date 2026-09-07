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
 * Change what is inside `el` while animating its height between the two
 * measurements. `mutate` may be async — a block that has to typeset before its
 * height is knowable is the normal case, not the exception.
 */
export async function morphHeight(el, mutate) {
  if (reduced()) return void (await mutate());

  const from = el.offsetHeight;
  await mutate();
  await nextFrame();
  const to = el.offsetHeight;
  if (from === to) return;

  await settle(
    el.animate(
      [{ height: from + "px" }, { height: to + "px" }],
      { duration: MORPH_MS, easing: EASE }
    )
  );
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

  const from = el.offsetHeight;
  await mutate();
  await nextFrame();
  const to = el.offsetHeight;

  el.getAnimations().forEach((a) => a.cancel());

  const runs = [
    el.animate(
      [{ opacity: 0, filter: BLUR }, { opacity: 1, filter: "none" }],
      { duration: FADE_MS, easing: "ease-out" }
    ),
  ];
  if (from !== to) {
    runs.push(el.animate([{ height: from + "px" }, { height: to + "px" }], { duration: MORPH_MS, easing: EASE }));
  }
  await Promise.all(runs.map(settle));
}

/**
 * A block arriving: it grows from nothing while the ones below it move down.
 *
 * `ready` is the block's own first paint, where it has one — a diagram, an
 * equation and a code block all render asynchronously, and a height measured
 * before that finished is a height the block then jumps away from the instant
 * the animation ends. The block is held collapsed until it can be measured
 * truthfully, which is also why it never flashes at full size first: the inline
 * height goes back to `0` in the same tick it was cleared to measure, so the
 * browser has no frame in which to paint the open state.
 */
export async function enter(el, ready) {
  if (reduced()) return;
  el.style.overflow = "hidden";

  let height;
  if (ready) {
    // Held shut while it renders, so it never flashes at full size first: the
    // inline height goes back to `0` in the same tick it was cleared to
    // measure, and the browser has no frame in which to paint the open state.
    el.style.height = "0px";
    await Promise.resolve(ready).catch(() => {});
    await nextFrame();
    el.style.height = "";
    height = el.offsetHeight;
    el.style.height = "0px";
  } else {
    // A paragraph knows its height the moment it exists, and waiting a frame
    // for it would mean the caret landing in a box that has not opened yet.
    height = el.offsetHeight;
  }

  const run = el.animate(
    [
      { height: 0, opacity: 0, filter: BLUR, marginBottom: 0 },
      { height: height + "px", opacity: 1, filter: "none" },
    ],
    { duration: MORPH_MS, easing: EASE }
  );
  // Cleared while the animation owns the property, so there is no frame in
  // which the inline `0` and the animation disagree.
  el.style.height = "";
  await settle(run);
  el.style.overflow = "";
}

/** A block leaving. Resolves once it is safe to remove from the DOM. */
export async function exit(el) {
  if (reduced()) return;
  await settle(
    el.animate(
      [
        { height: el.offsetHeight + "px", opacity: 1, filter: "none" },
        { height: 0, opacity: 0, filter: BLUR, marginBottom: 0 },
      ],
      { duration: MORPH_MS, easing: EASE, fill: "forwards" }
    )
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
