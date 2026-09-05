/**
 * Redefine-X Image Preloader - Rewritten from scratch
 * 
 * Clean and efficient lazy loading:
 * - IntersectionObserver for viewport detection
 * - Direct Image() loading without XHR/blob/CORS complications
 * - Single request per image, instant display
 * - Graceful error handling
 * - Optional preload for out-of-viewport images when network is idle
 */

import {
  onRawScroll,
  isScrollFlight,
  afterFlight,
  invalidateMetrics,
} from "../tools/scrollScheduler.js";

export const loadedPreloaders = new WeakSet();

// Membership, not an attribute. `data-observed` used to mark an observed
// preloader, and it survived being serialised into an innerHTML snapshot — a
// restored node looked observed while no observer had ever seen it, and sat on
// its skeleton forever. Identity cannot be serialised, so it cannot lie.
const observedPreloaders = new WeakSet();
const claimedImages = new WeakSet();
const preloadedImages = new Map();
const inflightLoads = new Map();

/** Hand a preloader back to the observer: it never made it into the document. */
function release(preloader) {
  loadedPreloaders.delete(preloader);
  observedPreloaders.delete(preloader);
}
let intersectionObserver = null;
let preloadEnabled = false;
let preloadQueue = [];
let isPreloading = false;
let isUserScrolling = false;
let userScrollTimeout = null;
let scrollWired = false;
let preloadStartTimer = null;

// ─── Batched DOM commit ──────────────────────────────────────────────────────
// Swapping a preloader for a real <img> is a layout-changing DOM mutation that
// also fires `redefine:image-loaded`, which makes the EXIF card re-measure
// itself (a clone + offsetHeight round trip = one forced layout each). Doing
// that per image, as each one finished, meant an image-heavy page produced a
// storm of interleaved decodes and layouts.
//
// Two things fix it:
//   1. All swaps ready in the same frame commit together, in ONE rAF, so the
//      browser lays out once instead of once per image.
//   2. While Swup is flying the page to the top, swaps are parked entirely.
//      The network fetch still runs (the bytes stay warm), but nothing touches
//      the DOM until the scroll settles — the images being swept past at speed
//      are not on screen when it lands, so nothing visible is lost.
const pendingSwaps = [];
let swapFrame = null;

function queueSwap(preloader, img) {
  pendingSwaps.push({ preloader, img });
  if (isScrollFlight()) {
    afterFlight(flushSwaps);
    return;
  }
  if (swapFrame !== null) return;
  swapFrame = requestAnimationFrame(flushSwaps);
}

function flushSwaps() {
  if (swapFrame !== null) {
    cancelAnimationFrame(swapFrame);
    swapFrame = null;
  }
  if (!pendingSwaps.length) return;
  const batch = pendingSwaps.splice(0, pendingSwaps.length);

  // Mutate everything first…
  const swapped = [];
  for (const { preloader, img } of batch) {
    // Detached mid-flight — the editor took the article apart while this was
    // loading. Dropping it silently is what left a skeleton behind when the
    // article came back, so it is released instead and loaded again then.
    if (!preloader.parentNode) {
      release(preloader);
      continue;
    }
    preloader.parentNode.replaceChild(img, preloader);
    swapped.push(img);
  }
  if (!swapped.length) return;

  // …then let the listeners (EXIF layout, auto-hover, TOC offsets) react once
  // the whole batch is in the document.
  invalidateMetrics();
  for (const img of swapped) {
    window.dispatchEvent(new CustomEvent("redefine:image-loaded", { detail: { img } }));
  }
  window.dispatchEvent(new CustomEvent("redefine:content-resized"));
}

/**
 * Check if URL is same-origin
 */
function isSameOrigin(url) {
  try {
    const urlObj = new URL(url, window.location.href);
    return urlObj.origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Load image - simple and direct
 */
function loadImage(src, alt) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.alt = alt;
    
    // Only set crossOrigin for same-origin images to avoid CORS issues
    if (isSameOrigin(src)) {
      img.crossOrigin = "anonymous";
    }
    
    // Decode BEFORE the image ever enters the document. Without this the
    // browser decodes at first paint — on the main thread, right in the middle
    // of whatever animation is running. AVIF (what the build pipeline emits) is
    // expensive to decode, so on an image-heavy page this was a visible stall
    // per image. decode() failures are non-fatal: fall through and let the
    // normal paint path handle it.
    img.onload = () => {
      if (typeof img.decode === "function") {
        img.decode().then(() => resolve(img), () => resolve(img));
      } else {
        resolve(img);
      }
    };
    img.onerror = () => reject(new Error(`Failed to load: ${src}`));

    img.src = src;
  });
}

async function ensureImageCached(src, alt) {
  if (preloadedImages.has(src)) return preloadedImages.get(src);
  if (inflightLoads.has(src)) return inflightLoads.get(src);

  const p = loadImage(src, alt).then((img) => {
    preloadedImages.set(src, img);
    inflightLoads.delete(src);
    return img;
  }).catch((err) => {
    inflightLoads.delete(src);
    throw err;
  });
  inflightLoads.set(src, p);
  return p;
}

export async function requestImageBySrc(src, alt = "") {
  let img = await ensureImageCached(src, alt);

  // Two preloaders on the same picture share one in-flight load and would
  // otherwise be handed the same element: inserting it twice MOVES it, and the
  // first place it landed empties out. The second caller gets its own node —
  // the bytes are cached by then, so it costs no request.
  if (claimedImages.has(img)) img = await loadImage(src, alt);
  claimedImages.add(img);

  if (alt) img.alt = alt;
  if (preloadedImages.get(src) === img) preloadedImages.delete(src);
  return img;
}

export function transformPreloaderToImage(preloader, img) {
  // Transfer classes
  const classes = Array.from(preloader.classList).filter(c => !c.startsWith("img-preloader"));
  classes.forEach(c => img.classList.add(c));
  
  // Set dimensions
  const width = preloader.dataset.width;
  const height = preloader.dataset.height;
  if (width) img.width = parseInt(width, 10);
  if (height) img.height = parseInt(height, 10);
  
  // Mark
  img.classList.add("img-preloader-loaded");
  img.dataset.originalSrc = preloader.dataset.src;
  
  return img;
}

/**
 * Replace preloader with loaded image.
 *
 * The 200ms fade-out is the visible cross-fade and is preserved exactly; only
 * the DOM commit at the end of it is batched (and deferred past a scroll
 * flight) instead of firing standalone per image.
 */
function replacePreloader(preloader, img) {
  transformPreloaderToImage(preloader, img);
  preloader.classList.add("img-preloader-fade-out");

  setTimeout(() => queueSwap(preloader, img), 200);
}

/**
 * Show error state
 */
function showError(preloader, src) {
  // Remove shim if exists to prevent layout issues
  const shim = preloader.querySelector(".img-preloader-shim");
  if (shim) shim.remove();

  preloader.classList.add("img-preloader-error");
  // Error state requirements: width 100%, height fit-content to show error message
  preloader.style.width = "100%";
  preloader.style.height = "fit-content";
  
  preloader.style.removeProperty("aspect-ratio");
  preloader.style.removeProperty("max-height");
  preloader.style.removeProperty("max-width");
  preloader.style.removeProperty("margin");
  const skeleton = preloader.querySelector(".img-preloader-skeleton");
  if (skeleton) {
    skeleton.innerHTML = `
      <i class="fa-solid fa-circle-xmark img-preloader-error-icon"></i>
      <div class="img-preloader-error-text">
        <div class="error-message">Failed to load image</div>
        <div class="error-url">${src}</div>
      </div>
    `;
  }
  
  // Trigger layout update for things like Exif cards
  window.dispatchEvent(new CustomEvent('redefine:force-exif-check'));
}

// ─── Deferred sources ────────────────────────────────────────────────────────
// A preloader whose bytes are not addressable by URL. An encrypted post's images
// are ciphertext at a hashed path and only become a blob: URL once the reader's
// key has opened them, so `data-src` is empty and the hash sits in
// `data-vault-asset` instead.
//
// Resolving them HERE rather than at unlock time is the whole point: the article
// mounts immediately, and each image is fetched and decrypted when it is about
// to be seen — the same request pattern, and the same ordering, every other
// image on the site gets.
let srcResolver = null;

export function registerSrcResolver(fn) {
  srcResolver = fn;
}

async function srcFor(preloader) {
  const direct = preloader.dataset.src;
  if (direct) return direct;
  if (!srcResolver) return "";
  try {
    return (await srcResolver(preloader)) || "";
  } catch (e) {
    return "";
  }
}

/**
 * Load a single preloader (for viewport intersection)
 */
async function processPreloader(preloader) {
  // Skip if already processed
  if (loadedPreloaders.has(preloader)) return;
  loadedPreloaders.add(preloader);

  const alt = preloader.dataset.alt || "";
  const src = await srcFor(preloader);
  if (!src) return void showError(preloader, preloader.dataset.src || "");

  try {
    const img = await requestImageBySrc(src, alt);
    replacePreloader(preloader, img);
  } catch (error) {
    console.error("[lazyload]", error);
    showError(preloader, src);
  }
}

/**
 * Preload image to cache without rendering
 */
async function preloadImageToCache(preloader) {
  if (loadedPreloaders.has(preloader)) return;

  const src = await srcFor(preloader);
  if (!src || preloadedImages.has(src)) return;

  try {
    await ensureImageCached(src, preloader.dataset.alt || "");
  } catch (error) {
    // Silently fail for preload, will show error when entering viewport
    console.warn("[lazyload preload]", error);
  }
}

/**
 * Create intersection observer
 */
function getObserver() {
  if (!intersectionObserver) {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            intersectionObserver.unobserve(entry.target);
            processPreloader(entry.target);
          }
        });
      },
      {
        rootMargin: "100px",
        threshold: 0.01,
      }
    );
  }
  return intersectionObserver;
}

/**
 * Check if network is idle (no pending requests).
 *
 * This used to snapshot and filter performance.getEntriesByType('resource') —
 * the ENTIRE buffer, hundreds of entries on a media-heavy page — from inside a
 * 200ms polling loop. A PerformanceObserver gives the same answer by keeping a
 * single timestamp up to date as entries arrive.
 */
let lastResourceEnd = -Infinity;
let resourceObserverReady = false;

if (typeof PerformanceObserver !== "undefined") {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const t = entry.responseEnd || entry.fetchStart || 0;
        if (t > lastResourceEnd) lastResourceEnd = t;
      }
    }).observe({ type: "resource", buffered: true });
    resourceObserverReady = true;
  } catch (e) {
    // Fall back to the scan below.
  }
}

function isNetworkIdle() {
  if (typeof performance === 'undefined') return true;

  if (resourceObserverReady) {
    return performance.now() - lastResourceEnd >= 500;
  }

  if (!performance.getEntriesByType) return true;
  const resources = performance.getEntriesByType('resource');
  const now = performance.now();
  for (let i = resources.length - 1; i >= 0; i--) {
    const entry = resources[i];
    const loadTime = entry.responseEnd || entry.fetchStart;
    if (now - loadTime < 500) return false;
  }
  return true;
}

/**
 * Get viewport position info for a preloader
 */
function getViewportPosition(element) {
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  
  if (rect.top < 0) {
    return { position: 'above', distance: Math.abs(rect.bottom) };
  } else if (rect.top > viewportHeight) {
    return { position: 'below', distance: rect.top - viewportHeight };
  } else {
    return { position: 'visible', distance: 0 };
  }
}

/**
 * Build preload queue based on viewport position
 * Order: below(3) -> above(3) -> below(all) -> above(all)
 */
function buildPreloadQueue() {
  const allPreloaders = Array.from(document.querySelectorAll(".img-preloader:not([data-ghost])"));
  const unloaded = allPreloaders.filter(p => !loadedPreloaders.has(p));
  
  if (unloaded.length === 0) return [];
  
  // Categorize by position
  const above = [];
  const below = [];
  
  unloaded.forEach(preloader => {
    const { position, distance } = getViewportPosition(preloader);
    if (position === 'above') {
      above.push({ preloader, distance });
    } else if (position === 'below') {
      below.push({ preloader, distance });
    }
  });
  
  // Sort by distance
  above.sort((a, b) => a.distance - b.distance);
  below.sort((a, b) => a.distance - b.distance);
  
  // Build queue: below(3) -> above(3) -> below(rest) -> above(rest)
  const queue = [];
  
  // First 3 below viewport
  queue.push(...below.slice(0, 3).map(item => item.preloader));
  
  // First 3 above viewport
  queue.push(...above.slice(0, 3).map(item => item.preloader));
  
  // Remaining below viewport
  queue.push(...below.slice(3).map(item => item.preloader));
  
  // Remaining above viewport
  queue.push(...above.slice(3).map(item => item.preloader));
  
  return queue;
}

/**
 * Process preload queue one by one (cache only, no render)
 */
async function processPreloadQueue() {
  if (isPreloading || preloadQueue.length === 0) return;
  
  isPreloading = true;
  
  while (preloadQueue.length > 0) {
    // Pause if user is scrolling
    if (isUserScrolling) {
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }
    
    // Wait for network idle before loading next image
    while (!isNetworkIdle()) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    const preloader = preloadQueue.shift();
    
    // Preload to cache only, don't render
    await preloadImageToCache(preloader);
    
    // Small delay between loads
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  isPreloading = false;
}

/**
 * Start preloading out-of-viewport images
 */
function startPreload() {
  if (!preloadEnabled) return;

  // One pending start at a time — this runs again on every Swup page:view.
  clearTimeout(preloadStartTimer);
  preloadStartTimer = setTimeout(() => {
    preloadQueue = buildPreloadQueue();
    processPreloadQueue();
  }, 1000);
}

/**
 * Initialize lazy loading
 */
export default function initLazyLoad(config = {}) {
  preloadEnabled = config.preload === true;
  
  const observer = getObserver();
  let added = 0;
  for (const preloader of document.querySelectorAll(".img-preloader:not([data-ghost])")) {
    if (observedPreloaders.has(preloader) || loadedPreloaders.has(preloader)) continue;
    observedPreloaders.add(preloader);
    observer.observe(preloader);
    added += 1;
  }
  if (added === 0) return;

  // Start preloading if enabled
  if (preloadEnabled) {
    startPreload();

    // Track user scrolling to pause preload during scroll.
    // Registered ONCE: initLazyLoad() runs on every page:view, and this used to
    // add another permanent listener each time.
    if (!scrollWired) {
      scrollWired = true;
      onRawScroll(() => {
        isUserScrolling = true;
        clearTimeout(userScrollTimeout);

        userScrollTimeout = setTimeout(() => {
          isUserScrolling = false;

          // Re-check preload queue after scroll ends
          if (!isPreloading && preloadQueue.length === 0) {
            preloadQueue = buildPreloadQueue();
            processPreloadQueue();
          }
        }, 500);
      });
    }
  }
}

/**
 * Force load all preloaders (for encrypted content)
 */
export function forceLoadAllPreloaders() {
  document.querySelectorAll(".img-preloader:not([data-ghost])").forEach(processPreloader);
}
