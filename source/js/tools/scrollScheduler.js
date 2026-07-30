/**
 * Redefine-X — central scroll scheduler.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The theme used to attach its own `scroll` listener per feature (utils,
 * navbarShrink, toc, autoHover ×3, bookmarkNav, lazyload). Every one of them
 * mixed geometry READS (getBoundingClientRect / scrollHeight / offsetTop) with
 * style WRITES (classList, style.width, textContent) inside the same callback,
 * so each handler forced a fresh synchronous layout on top of the previous
 * handler's writes — classic layout thrashing, N× per scroll event.
 *
 * Worse, several of those listeners were re-registered on every Swup
 * `page:view`, and `navbarShrink.init()` — which itself registered a listener —
 * was being called FROM inside a scroll handler, so the listener count grew
 * without bound for as long as the page kept scrolling.
 *
 * Swup's scroll plugin animates page transitions by calling `window.scrollTo()`
 * from a requestAnimationFrame spring, which emits a `scroll` event EVERY
 * FRAME. All of the above therefore ran ~60×/s throughout every navigation —
 * the "scroll-to-top after clicking a link is janky" bug, and the reason it got
 * worse the longer you browsed.
 *
 * THE CONTRACT
 * ────────────
 *  • ONE passive window `scroll` listener for the whole theme, ever.
 *  • Work is coalesced into ONE requestAnimationFrame pass per frame, however
 *    many scroll events fired in between.
 *  • Each pass runs in two strict phases: every subscriber's `read()` first,
 *    then every subscriber's `write()`. A read therefore never observes a
 *    half-written frame and never forces a re-layout.
 *  • Viewport/document metrics are measured ONCE per pass and shared. The
 *    expensive one (`scrollHeight`, which forces layout) is cached and only
 *    re-measured when something actually invalidated it.
 *
 * Subscribers MUST NOT write in `read()` and MUST NOT measure in `write()`.
 * Doing either silently reintroduces the thrash this module exists to remove.
 *
 * SCROLL FLIGHT
 * ─────────────
 * `isScrollFlight()` is true while Swup is running its animated scroll. Work
 * that is invisible mid-flight but expensive (swapping a lazy image into the
 * DOM, re-measuring an EXIF card, re-measuring every MathJax block) should be
 * parked with `afterFlight()` and flushed once the page has settled. A watchdog
 * force-ends the flight if `scroll:end` never arrives, so deferred work can
 * never be stranded.
 *
 * Also published as `window.__redefineScroll` for the theme's CLASSIC (non-module)
 * scripts — imageExif.js and mathjax.js — which cannot `import`. Those load
 * BEFORE this module, so they must look the global up lazily at call time.
 */

const subs = [];
const rawSubs = [];
let flightEndQueue = [];
let subsDirty = false;

let frameQueued = false;

// `scrollHeight` forces layout, so it is cached behind a dirty flag; everything
// else in the metrics bag is free to read.
let docH = 0;
let bodyH = 0;
let metricsDirty = true;

const metrics = {
  scrollY: 0,
  viewportH: 0,
  viewportW: 0,
  docH: 0,
  bodyH: 0,
};

let flight = false;
let flightWatchdog = null;
const FLIGHT_WATCHDOG_MS = 4000;

/* ─── Metrics ──────────────────────────────────────────────────────────────── */

export function invalidateMetrics() {
  metricsDirty = true;
}

function refreshMetrics() {
  metrics.scrollY =
    window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
  metrics.viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
  metrics.viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
  if (metricsDirty) {
    docH = document.documentElement.scrollHeight;
    bodyH = document.body ? document.body.scrollHeight : docH;
    metricsDirty = false;
  }
  metrics.docH = docH;
  metrics.bodyH = bodyH;
}

export function getMetrics() {
  // Callers outside a pass (init paths) still need trustworthy numbers.
  if (!frameQueued) refreshMetrics();
  return metrics;
}

/* ─── Subscription ─────────────────────────────────────────────────────────── */

/**
 * Subscribe to the shared scroll pass.
 *
 * @param {(m: typeof metrics) => void|null} read   measure only — no DOM writes
 * @param {(m: typeof metrics) => void|null} write  mutate only — no measuring
 * @param {string} name  shown in the console if the subscriber throws
 * @returns {() => void} unsubscribe
 */
export function onScroll(read, write, name = "anonymous") {
  const sub = { read, write, name, dead: false };
  subs.push(sub);
  // Tombstone rather than splice: unsubscribing from inside a pass would
  // otherwise shift the array mid-iteration and silently skip the next
  // subscriber. Dead entries are compacted between frames.
  return () => {
    sub.dead = true;
    sub.read = null;
    sub.write = null;
    subsDirty = true;
  };
}

/**
 * Flag-only callbacks that must observe the RAW event (e.g. "the user is
 * scrolling right now") and therefore cannot wait for the rAF pass. These must
 * touch no geometry and no styles — just set a variable.
 */
export function onRawScroll(cb) {
  rawSubs.push(cb);
  return () => {
    const i = rawSubs.indexOf(cb);
    if (i !== -1) rawSubs.splice(i, 1);
  };
}

/** Force a pass on the next frame (after a Swup navigation, a resize, …). */
export function requestScrollPass() {
  schedule();
}

function schedule() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(runPass);
}

function fail(phase, sub, err) {
  console.error(
    `[scrollScheduler] "${sub.name}" threw during its ${phase} phase. ` +
      `The rest of this frame still ran, but this subscriber is misbehaving — fix it: ` +
      `read() must not write and write() must not measure.`,
    err,
  );
}

function runPass() {
  frameQueued = false;

  if (subsDirty) {
    subsDirty = false;
    for (let i = subs.length - 1; i >= 0; i--) {
      if (subs[i].dead) subs.splice(i, 1);
    }
  }

  refreshMetrics();

  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    if (!s.read) continue;
    try {
      s.read(metrics);
    } catch (err) {
      fail("read", s, err);
    }
  }
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    if (!s.write) continue;
    try {
      s.write(metrics);
    } catch (err) {
      fail("write", s, err);
    }
  }
}

/* ─── Scroll flight (Swup's animated scroll-to-top) ────────────────────────── */

export function isScrollFlight() {
  return flight;
}

/**
 * Run `cb` now if the page is settled, or once the current Swup scroll
 * animation finishes. Deferred callbacks always run — see the watchdog.
 */
export function afterFlight(cb) {
  if (!flight) {
    cb();
    return;
  }
  flightEndQueue.push(cb);
}

function beginFlight() {
  flight = true;
  clearTimeout(flightWatchdog);
  flightWatchdog = setTimeout(() => {
    console.warn(
      `[scrollScheduler] Swup never emitted "scroll:end" within ${FLIGHT_WATCHDOG_MS}ms. ` +
        `Force-ending the scroll flight so deferred work (lazy image swaps, EXIF ` +
        `re-layout, MathJax overflow hints) is not stranded.`,
    );
    endFlight();
  }, FLIGHT_WATCHDOG_MS);
}

function endFlight() {
  clearTimeout(flightWatchdog);
  flightWatchdog = null;
  if (!flight) return;
  flight = false;
  metricsDirty = true;

  if (!flightEndQueue.length) {
    schedule();
    return;
  }
  const pending = flightEndQueue;
  flightEndQueue = [];
  requestAnimationFrame(() => {
    for (let i = 0; i < pending.length; i++) {
      try {
        pending[i]();
      } catch (err) {
        console.error("[scrollScheduler] a deferred afterFlight() callback threw.", err);
      }
    }
    schedule();
  });
}

/* ─── Wiring ───────────────────────────────────────────────────────────────── */

window.addEventListener(
  "scroll",
  () => {
    for (let i = 0; i < rawSubs.length; i++) {
      try {
        rawSubs[i]();
      } catch (err) {
        console.error("[scrollScheduler] a raw scroll subscriber threw.", err);
      }
    }
    schedule();
  },
  { passive: true },
);

window.addEventListener(
  "resize",
  () => {
    metricsDirty = true;
    schedule();
  },
  { passive: true },
);

// Content growing (images decoding in, EXIF cards re-laying out, MathJax
// resizing) changes scrollHeight without a scroll or resize event.
if (typeof ResizeObserver !== "undefined") {
  try {
    new ResizeObserver(() => {
      metricsDirty = true;
    }).observe(document.documentElement);
  } catch (e) {
    /* non-fatal: metrics are still invalidated on resize + page:view */
  }
}

// Batched signal (one per group of swaps / EXIF relayouts), not the per-image
// `redefine:image-loaded`.
window.addEventListener("redefine:content-resized", invalidateMetrics);

// Swup's scroll plugin creates these hooks in its mount(). swup.ejs renders
// AFTER scripts.ejs, so the first attempt can legitimately fail — retry once
// the document is ready.
let swupWired = false;
function wireSwup() {
  if (swupWired) return;
  try {
    const s = typeof swup !== "undefined" ? swup : window.swup;
    if (!s || !s.hooks) return;
    s.hooks.on("scroll:start", beginFlight);
    s.hooks.on("scroll:end", endFlight);
    s.hooks.on("page:view", () => {
      metricsDirty = true;
      schedule();
    });
    swupWired = true;
  } catch (e) {
    /* no swup on this page — the scheduler works fine without it */
  }
}
wireSwup();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireSwup);
} else {
  wireSwup();
}

/* Classic-script bridge (imageExif.js, mathjax.js). */
window.__redefineScroll = {
  onScroll,
  onRawScroll,
  requestScrollPass,
  getMetrics,
  invalidateMetrics,
  isScrollFlight,
  afterFlight,
};
