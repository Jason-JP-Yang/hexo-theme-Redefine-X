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
 * Change what is inside `el` while animating its height between the two
 * measurements. `mutate` may be async — a block that has to typeset before its
 * height is knowable is the normal case, not the exception.
 */
export async function morphHeight(el, mutate) {
  if (reduced()) return void (await mutate());

  const from = el.offsetHeight;
  await mutate();
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
 * The swap every source⇄render toggle uses: the old content leaves through a
 * short blur while the box resizes underneath it, and the new one arrives the
 * same way. Same shape as editing an instant-note bubble.
 */
export async function crossFade(el, mutate) {
  if (reduced()) return void (await mutate());

  await settle(
    el.animate(
      [{ opacity: 1, filter: "none" }, { opacity: 0, filter: BLUR }],
      { duration: FADE_MS, easing: "ease-in", fill: "forwards" }
    )
  );

  await morphHeight(el, mutate);

  el.getAnimations().forEach((a) => a.cancel());
  await settle(
    el.animate(
      [{ opacity: 0, filter: BLUR }, { opacity: 1, filter: "none" }],
      { duration: FADE_MS, easing: "ease-out" }
    )
  );
}

/** A block arriving: it grows from nothing while the ones below it move down. */
export async function enter(el) {
  if (reduced()) return;
  const height = el.offsetHeight;
  await settle(
    el.animate(
      [
        { height: 0, opacity: 0, filter: BLUR, marginBottom: 0 },
        { height: height + "px", opacity: 1, filter: "none" },
      ],
      { duration: MORPH_MS, easing: EASE }
    )
  );
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

/* ─── drag ghost ───────────────────────────────────────────────────────────── */

/**
 * The picture that travels with the pointer while a block is being carried.
 *
 * `setDragImage(el, dx, dy)` lets the BROWSER decide which rectangle `el`
 * occupies, and it decides differently from us twice over. The gutter is
 * absolutely positioned outside the block, so the snapshot starts a column's
 * width left of the border box the offsets were measured against and the ghost
 * rides to the right of the cursor. And under a scaled viewport — device
 * emulation, pinch zoom — the bitmap is captured in device pixels and drawn
 * unscaled, so it arrives magnified with the drift scaled up to match.
 *
 * Neither is reachable from script, so the native image is suppressed and the
 * ghost is an ordinary fixed clone we place ourselves: the block at the size it
 * has on the page, under the point it was picked up by.
 */
const BLANK = new Image();
BLANK.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

let ghost = null;
let ghostX = 0;
let ghostY = 0;

export function startGhost(el, e) {
  stopGhost();
  if (e.dataTransfer && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(BLANK, 0, 0);

  const box = el.getBoundingClientRect();
  ghostX = e.clientX - box.left;
  ghostY = e.clientY - box.top;

  ghost = el.cloneNode(true);
  ghost.classList.add("ed-ghost");
  ghost.classList.remove("is-dragging");
  ghost.removeAttribute("data-drop");
  ghost.style.width = box.width + "px";
  for (const node of ghost.querySelectorAll("[contenteditable]")) node.contentEditable = "false";
  // A cloned skeleton is still a preloader to the observer, and it would fetch
  // the picture again to fill a ghost that is about to be thrown away.
  for (const node of ghost.querySelectorAll(".img-preloader")) node.dataset.ghost = "1";

  document.body.appendChild(ghost);
  moveGhost(e.clientX, e.clientY);
}

export function moveGhost(x, y) {
  if (!ghost || (!x && !y)) return;
  ghost.style.transform = `translate3d(${Math.round(x - ghostX)}px, ${Math.round(y - ghostY)}px, 0)`;
}

export function stopGhost() {
  if (ghost) ghost.remove();
  ghost = null;
}

/** Tell the theme's scroll scheduler the page just changed height. */
export function contentChanged() {
  try {
    window.dispatchEvent(new CustomEvent("redefine:content-resized"));
  } catch (err) {
    /* the scheduler is optional */
  }
}
