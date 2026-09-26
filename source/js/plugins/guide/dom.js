/**
 * Guide — the questions every tip asks of the page: is this element really on
 * screen, how much of it, and where exactly should the cursor point.
 */

import { clamp } from "./motion.js";

export const q = (s, root = document) => root.querySelector(s);
export const qa = (s, root = document) => Array.from(root.querySelectorAll(s));

/**
 * Laid out, painted and not faded out — a box the reader could actually see.
 * Opacity is not inherited, so the ancestors are asked too: the side tools fade
 * their whole container out at the top and bottom of a page.
 */
export function shown(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (getComputedStyle(el).visibility === "hidden") return false;
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (parseFloat(getComputedStyle(n).opacity) < 0.05) return false;
  }
  return true;
}

export function firstShown(selectors, root = document) {
  for (const s of [].concat(selectors)) {
    for (const el of root.querySelectorAll(s)) if (shown(el)) return el;
  }
  return null;
}

/**
 * How much of a rect is on screen, 0–1. A box taller than the viewport can
 * never be 60% visible, so the denominator is capped at a little under half the
 * viewport: a photo filling the screen counts as fully in view.
 */
export function rectRatio(r) {
  if (!r) return 0;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const area = r.width * r.height;
  if (!area) return 0;
  const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  return Math.min(1, (w * h) / Math.min(area, vw * vh * 0.45));
}

export const ratioInView = (el) => (el && el.isConnected ? rectRatio(el.getBoundingClientRect()) : 0);

/** The union of several elements' rects — what a card must not cover. */
export function unionRect(els) {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const el of els) {
    if (!el || !el.isConnected) continue;
    const x = el.getBoundingClientRect();
    if (!x.width && !x.height) continue;
    l = Math.min(l, x.left);
    t = Math.min(t, x.top);
    r = Math.max(r, x.right);
    b = Math.max(b, x.bottom);
  }
  return l === Infinity ? null : { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
}

/**
 * A live point on an element, as fractions of its box. Clamped to the part of
 * the element that is on screen, so a tall photo half scrolled away is pointed
 * at where the reader can see it.
 */
export function anchorOf(el, point = [0.5, 0.5]) {
  const fx = point[0];
  const fy = point[1];
  return () => {
    if (!el.isConnected) return null;
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const x = r.left + r.width * fx;
    const y = r.top + r.height * fy;
    const left = Math.max(r.left, 6);
    const right = Math.min(r.right, vw - 6);
    const top = Math.max(r.top, 6);
    const bottom = Math.min(r.bottom, vh - 6);
    return {
      x: right > left ? clamp(x, left, right) : x,
      y: bottom > top ? clamp(y, top, bottom) : y,
    };
  };
}

/**
 * Add a class for as long as a tip needs it; the returned function gives it
 * back. The release is late on purpose: when the next tip in a chain borrows the
 * same class — the navbar menu the cursor is about to point further into — it
 * picks up the loan instead of the menu snapping shut and open again.
 */
const loans = new Map();
const RELEASE_MS = 1100;

export function borrowClass(el, cls) {
  if (!el) return null;
  let byEl = loans.get(el);
  let loan = byEl && byEl.get(cls);
  if (loan) {
    clearTimeout(loan.timer);
    loan.count++;
  } else {
    // Somebody else's class (autoHover's, a real hover) is not ours to take back.
    if (el.classList.contains(cls)) return null;
    if (!byEl) loans.set(el, (byEl = new Map()));
    el.classList.add(cls);
    byEl.set(cls, (loan = { count: 1, timer: 0 }));
  }
  let returned = false;
  return () => {
    if (returned) return;
    returned = true;
    if (--loan.count > 0) return;
    loan.timer = setTimeout(() => {
      if (loan.count > 0) return;
      el.classList.remove(cls);
      byEl.delete(cls);
      if (!byEl.size) loans.delete(el);
    }, RELEASE_MS);
  };
}

export function isIOS() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  try {
    return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}
