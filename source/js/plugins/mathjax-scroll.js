/**
 * MathJax Scroll — overflow detection, scroll hints, wheel interception.
 *
 * Architecture:
 *   .mathjax-block                  ← outer wrapper, position:relative (does NOT scroll)
 *     .mathjax-scroll-wrapper       ← inner overflow container (scrolls horizontally)
 *       <mjx-container>…</mjx-container>
 *     .mathjax-scroll-hint--left    ← gradient + caret (appended by JS)
 *     .mathjax-scroll-hint--right
 *
 * Overflow detection checks wrapper.scrollWidth > wrapper.clientWidth.
 * Hints are absolutely positioned on the non-scrolling outer block so
 * they stay fixed while content scrolls beneath them.
 *
 * Exported as initMathJaxScroll() and called via main.refresh() so it
 * integrates with the theme's Swup PJAX lifecycle automatically.
 *
 * PERFORMANCE NOTES
 * ─────────────────
 * Measuring a block is not cheap: reading wrapper.scrollWidth forces a
 * synchronous layout, and resolving the hint background walks the ancestor
 * chain calling getComputedStyle at every level. The original implementation
 * did both for EVERY block on the page, in a single write→read→write loop (so
 * each block forced its own layout), and ran that three times per navigation
 * (rAF, +300ms, +1000ms). On a maths-heavy article those retries landed right
 * inside Swup's animated scroll-to-top — which is why scrolling past a lot of
 * LaTeX stuttered.
 *
 * Three changes, no visual difference:
 *   1. Measurement is viewport-scoped via IntersectionObserver. Off-screen
 *      formulas cost nothing; a hint you cannot see has nothing to say.
 *   2. Batches are measured then applied in separate passes — one layout for
 *      the whole batch instead of one per block.
 *   3. Background resolution is memoised across the ancestor chain, and the
 *      custom property (which invalidates a whole subtree) is only written when
 *      the value actually changed.
 *
 * All shared state lives at module scope: initMathJaxScroll() runs again on
 * every page:view, and per-call closures would leave the IntersectionObserver
 * holding a stale cache from the first page it ever ran on.
 */

import { afterFlight } from '../tools/scrollScheduler.js';

const BLOCK   = '.mathjax-block';
const WRAPPER = '.mathjax-scroll-wrapper';
const THRESH  = 2;

let globalsBound = false;
let observerInstance = null;
let pending = new Set();
let pendingFrame = null;
let bgCache = new Map();

/* ---- Background resolution -------------------------------------- */

function resolveBackgroundColor(block) {
  const chain = [];
  let node = block;
  let found = null;

  while (node && node.nodeType === 1) {
    if (bgCache.has(node)) { found = bgCache.get(node); break; }
    chain.push(node);
    const color = window.getComputedStyle(node).backgroundColor;
    if (color && color !== 'transparent' && !/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)$/i.test(color)) {
      found = color;
      break;
    }
    node = node.parentElement;
  }
  if (found === null) found = window.getComputedStyle(document.body).backgroundColor;

  for (let i = 0; i < chain.length; i++) bgCache.set(chain[i], found);
  return found;
}

// Writing a custom property invalidates style for the element's whole subtree,
// so only write when the value actually differs.
function syncHintBackground(block) {
  const bg = resolveBackgroundColor(block);
  if (block._mjBg === bg) return;
  block._mjBg = bg;
  block.style.setProperty('--mathjax-scroll-bg-color', bg);
}

// Detached nodes must not be retained, and a colour-scheme switch invalidates
// every resolved value.
function clearBgCache() {
  bgCache = new Map();
}

/* ---- DOM helpers ------------------------------------------------ */

function mkHint(side) {
  const el = document.createElement('div');
  el.className = 'mathjax-scroll-hint mathjax-scroll-hint--' + side;
  const icon = document.createElement('i');
  icon.className = side === 'left'
    ? 'fa-solid fa-caret-left'
    : 'fa-solid fa-caret-right';
  el.appendChild(icon);
  return el;
}

function hints(block) {
  let L = block.querySelector('.mathjax-scroll-hint--left');
  let R = block.querySelector('.mathjax-scroll-hint--right');
  if (!L) { L = mkHint('left');  block.appendChild(L); }
  if (!R) { R = mkHint('right'); block.appendChild(R); }
  return { L: L, R: R };
}

/* ---- Overflow measurement --------------------------------------- */

/**
 * Return the pixel amount by which the formula overflows its wrapper.
 *
 * CSS layout: .mathjax-scroll-wrapper is display:flex with
 * justify-content:center.  mjx-container is a flex item with
 * flex-shrink:0, so it keeps its full intrinsic (SVG) width.
 * wrapper.scrollWidth therefore reflects the actual formula width.
 *
 * Primary:  wrapper.scrollWidth - wrapper.clientWidth
 * Fallback: mjx-container.scrollWidth - wrapper.clientWidth
 *   (catches browsers that may report wrapper.scrollWidth incorrectly
 *    while the flex child's own scrollWidth is still accurate)
 */
function getOverflow(wrapper) {
  const ow = wrapper.scrollWidth - wrapper.clientWidth;
  if (ow > 1) return ow;

  // Fallback: use flex item's own scrollWidth
  const container = wrapper.querySelector('mjx-container');
  if (container) {
    const cw = container.scrollWidth - wrapper.clientWidth;
    if (cw > 1) return cw;
  }
  return 0;
}

/* ---- Measure / apply split -------------------------------------- */

function measure(block) {
  const w = block.querySelector(WRAPPER);
  if (!w) return null;
  // A block the browser is currently SKIPPING (content-visibility: auto, still
  // off-screen) has no laid-out contents, so scrollWidth/clientWidth report 0
  // and every formula would look non-overflowing. Leave it alone; the
  // contentvisibilityautostatechange listener in bind() re-queues it the moment
  // the browser starts rendering it. Same guard covers display:none.
  if (w.clientWidth === 0) return null;
  return { block, w, max: getOverflow(w), sl: Math.round(w.scrollLeft) };
}

function apply(mm) {
  const block = mm.block;

  if (mm.max <= 0) {
    if (block.classList.contains('mathjax-overflow')) {
      block.classList.remove('mathjax-overflow');
      const all = block.querySelectorAll('.mathjax-scroll-hint');
      for (let i = 0; i < all.length; i++) all[i].classList.remove('is-visible');
    }
    return;
  }

  block.classList.add('mathjax-overflow');
  const h = hints(block);
  h.L.classList.toggle('is-visible', mm.sl > THRESH);
  h.R.classList.toggle('is-visible', mm.max - mm.sl > THRESH);
}

// Drain the pending set: all backgrounds, then all measurements, then all
// mutations — so a batch of N blocks costs one layout, not N.
function flushPending() {
  pendingFrame = null;
  if (!pending.size) return;
  const blocks = Array.from(pending).filter((b) => b.isConnected);
  pending.clear();
  if (!blocks.length) return;

  for (let i = 0; i < blocks.length; i++) syncHintBackground(blocks[i]);

  const measured = [];
  for (let j = 0; j < blocks.length; j++) {
    const mm = measure(blocks[j]);
    if (mm) measured.push(mm);
  }
  for (let k = 0; k < measured.length; k++) apply(measured[k]);
}

function schedule(block) {
  pending.add(block);
  if (pendingFrame !== null) return;
  pendingFrame = requestAnimationFrame(flushPending);
}

/* ---- Wheel interception ----------------------------------------- */

function onWheel(w, e) {
  const max = getOverflow(w);
  if (max <= 0) return;

  const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const sl = Math.round(w.scrollLeft);

  // At the edges → let page scroll normally
  if (dx > 0 && max - sl < 1) return;
  if (dx < 0 && sl < 1) return;

  e.preventDefault();
  w.scrollLeft += dx;
}

/* ---- Bind one block --------------------------------------------- */

function bind(block) {
  if (block.dataset.mjBound) return;
  block.dataset.mjBound = '1';

  // Authoritative signal for content-visibility:auto blocks: fires the instant
  // the browser starts (or stops) rendering this subtree. Measuring here is the
  // only way to be sure layout exists — the IntersectionObserver below can win
  // the race and measure a still-skipped block.
  block.addEventListener('contentvisibilityautostatechange', (e) => {
    if (!e.skipped) schedule(block);
  });

  const w = block.querySelector(WRAPPER);
  if (!w) return;

  w.addEventListener('scroll', function () { schedule(block); }, { passive: true });
  w.addEventListener('wheel',  function (e) { onWheel(w, e); }, { passive: false });
}

/* ---- Viewport-scoped observation -------------------------------- */

function observer() {
  if (observerInstance) return observerInstance;
  observerInstance = new IntersectionObserver(
    (entries) => {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) schedule(entries[i].target);
      }
    },
    // Generous margin so hints are settled well before the block is readable.
    { rootMargin: '400px 0px', threshold: 0 },
  );
  return observerInstance;
}

function initAll() {
  clearBgCache();
  const blocks = document.querySelectorAll(BLOCK);
  const io = observer();
  for (let i = 0; i < blocks.length; i++) {
    bind(blocks[i]);
    io.observe(blocks[i]); // re-observing an existing target is a no-op
  }
}

// Re-measure only what is on screen (resize, late font shift, theme switch).
function refreshVisible() {
  clearBgCache();
  const blocks = document.querySelectorAll(BLOCK);
  const vh = window.innerHeight;
  for (let i = 0; i < blocks.length; i++) {
    const r = blocks[i].getBoundingClientRect();
    if (r.bottom > -400 && r.top < vh + 400) schedule(blocks[i]);
  }
}

/* ---- Entry point ------------------------------------------------ */

const initMathJaxScroll = () => {
  // Delay-retry: defer measurements until after the browser's layout pass.
  // On Swup page:view the DOM is freshly swapped — measuring synchronously
  // reads scrollWidth before layout is complete, causing every formula to
  // appear overflowed. rAF guarantees at least one layout/paint cycle has
  // finished before we measure anything.
  //
  // The retries (MathJax SVG fonts can shift dimensions later) now wait out the
  // scroll flight rather than firing 300ms/1000ms into it.
  requestAnimationFrame(() => {
    initAll();
    setTimeout(() => afterFlight(refreshVisible), 300);
    setTimeout(() => afterFlight(refreshVisible), 1000);
  });

  // Register global listeners only once across Swup navigations.
  if (!globalsBound) {
    globalsBound = true;
    window.addEventListener('resize', () => {
      requestAnimationFrame(refreshVisible);
    }, { passive: true });
    // Light/dark switch changes the resolved hint background.
    window.addEventListener('redefine:color-scheme-change', refreshVisible);
  }
};

export default initMathJaxScroll;
