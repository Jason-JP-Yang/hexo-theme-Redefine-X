/**
 * Getting the page to where a step happened, and KNOWING when it has arrived.
 *
 * Shared by both editors because both have the same two bars pinned over the
 * same column, and a step in either one has to travel under them. The numbers
 * are measured from whichever editor is open: `useChrome` registers it, and
 * every reading below asks that rather than assuming a height.
 *
 * `scrollTo({ behavior: "smooth" })` cannot be awaited, and a FLIP measured
 * while the viewport is still moving reads every rectangle in a viewport that
 * has already moved — so the travel is driven here, one known duration, one
 * promise, one position written per frame.
 */

import { reduced } from "./motion.js";

/** @type {null|(() => {bar?: Element, toolbar?: Element, hidden?: boolean})} */
let chrome = null;

export function useChrome(fn) {
  chrome = typeof fn === "function" ? fn : null;
}

/** Where the pinned chrome ends, measured rather than assumed. */
export function headroom() {
  const now = chrome ? chrome() : null;
  if (!now) return 16;

  let y = 0;
  // The document bar has stepped aside while the bars are away. It is still in
  // the flow, so it still has a box, and counting that box would reserve a band
  // of nothing above the line being edited.
  if (!now.hidden && now.bar && now.bar.isConnected) {
    y = Math.max(y, now.bar.getBoundingClientRect().bottom);
  }
  const tool = now.toolbar;
  if (tool && tool.isConnected && tool.dataset.perch !== "hide") {
    y = Math.max(y, tool.getBoundingClientRect().bottom);
  }
  return Math.max(0, y) + 16;
}

/**
 * The bottom of the band somebody can actually read.
 *
 * On a phone with the keyboard up that is not the bottom of the window: the
 * visual viewport is half the size of the layout one, and an element "brought
 * into view" against `innerHeight` was brought in behind the keyboard.
 */
export function viewBottom() {
  const vv = window.visualViewport;
  const seen = vv ? vv.offsetTop + vv.height : window.innerHeight;
  return Math.max(120, Math.min(window.innerHeight, seen)) - 24;
}

/** Where `el` should come to rest: just under the pinned chrome, with air. */
export function restingY(el) {
  const rect = el.getBoundingClientRect();
  const most = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  return Math.min(most, Math.max(0, window.scrollY + rect.top - headroom() - 12));
}

/** Readable, and not by a sliver. Something taller than the band needs its top. */
export function readable(el) {
  if (!el || !el.isConnected) return true;
  const rect = el.getBoundingClientRect();
  const top = headroom();
  const foot = viewBottom();
  if (rect.height > foot - top) return rect.top <= top + 8 && rect.bottom >= top + 96;
  return rect.top >= top - 1 && rect.bottom <= foot + 1;
}

/** Not a pixel of it is in the readable band. */
export function offScreen(el) {
  if (!el || !el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  return rect.bottom <= headroom() || rect.top >= viewBottom();
}

// Long enough to be followed by the eye, short enough that a step does not feel
// like it is being waited on. Proportional to the distance between the two.
const TRAVEL_MIN = 240;
const TRAVEL_MAX = 620;

/**
 * `EASE` — cubic-bezier(0.32, 0.72, 0, 1) — evaluated in JS.
 *
 * A scroll driven by a different curve from the transforms it travels with is
 * two motions that happen to overlap. This is what lets them be one.
 */
function easeStep(t) {
  const cx = 3 * 0.32;
  const bx = 3 * (0 - 0.32) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * 0.72;
  const by = 3 * (1 - 0.72) - cy;
  const ay = 1 - cy - by;

  let u = t;
  for (let i = 0; i < 6; i++) {
    const off = ((ax * u + bx) * u + cx) * u - t;
    const slope = (3 * ax * u + 2 * bx) * u + cx;
    if (Math.abs(slope) < 1e-6) break;
    u -= off / slope;
  }
  u = Math.min(1, Math.max(0, u));
  return ((ay * u + by) * u + cy) * u;
}

export function scrollTween(to, ms) {
  return new Promise((done) => {
    const from = window.scrollY;
    const delta = to - from;
    if (Math.abs(delta) < 1) return void done(false);

    const span = ms || Math.min(TRAVEL_MAX, Math.max(TRAVEL_MIN, Math.abs(delta) * 0.55));
    const began = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - began) / span);
      window.scrollTo({ top: Math.round(from + delta * easeStep(k)), left: window.scrollX, behavior: "auto" });
      if (k < 1) requestAnimationFrame(step);
      else done(true);
    };
    requestAnimationFrame(step);
  });
}

/**
 * Bring `el` somewhere it can be read, and wait for it.
 *
 * @returns {Promise<boolean>} whether it actually asked the page to travel.
 */
export function travelTo(el, quick) {
  if (!el || !el.isConnected || readable(el)) return Promise.resolve(false);
  const to = restingY(el);
  // A run of presses travels once, at the end. Animating each step of a held
  // Ctrl-Z is a page that never arrives anywhere.
  if (quick || reduced()) {
    window.scrollTo({ top: to, left: window.scrollX, behavior: "auto" });
    return Promise.resolve(true);
  }
  return scrollTween(to);
}

/**
 * Hold one element still on screen across whatever `fn` does to the page.
 *
 * A height that changes ABOVE the viewport slides everything under it. The
 * element the step is about is measured, the change happens, and the page is
 * scrolled by exactly the difference — so the only thing that ever moves the
 * reader's view is the deliberate travel that happens before any of this.
 */
export async function anchored(el, fn) {
  const top = el && el.isConnected ? el.getBoundingClientRect().top : null;
  const out = await fn();
  if (top != null && el.isConnected) {
    const drift = el.getBoundingClientRect().top - top;
    if (Math.abs(drift) > 0.5) window.scrollBy(0, drift);
  }
  return out;
}
