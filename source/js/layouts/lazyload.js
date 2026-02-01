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

export const loadedPreloaders = new WeakSet();
const preloadedImages = new Map();
const inflightLoads = new Map();
let intersectionObserver = null;
let preloadEnabled = false;
let preloadQueue = [];
let isPreloading = false;
let isUserScrolling = false;
let userScrollTimeout = null;

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
    
    img.onload = () => resolve(img);
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
  const img = await ensureImageCached(src, alt);
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
 * Replace preloader with loaded image
 */
function replacePreloader(preloader, img) {
  transformPreloaderToImage(preloader, img);
  preloader.classList.add("img-preloader-fade-out");
  
  // Replace DOM node
  setTimeout(() => {
    preloader.parentNode?.replaceChild(img, preloader);
    window.dispatchEvent(new CustomEvent('redefine:image-loaded', { detail: { img } }));
  }, 200);
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

/**
 * Load a single preloader (for viewport intersection)
 */
async function processPreloader(preloader) {
  // Skip if already processed
  if (loadedPreloaders.has(preloader)) return;
  loadedPreloaders.add(preloader);
  
  const src = preloader.dataset.src;
  const alt = preloader.dataset.alt || "";
  
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
  const src = preloader.dataset.src;
  const alt = preloader.dataset.alt || "";
  
  // Skip if already cached or loaded
  if (preloadedImages.has(src) || loadedPreloaders.has(preloader)) {
    return;
  }
  
  try {
    await ensureImageCached(src, alt);
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
 * Check if network is idle (no pending requests)
 */
function isNetworkIdle() {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) {
    return true;
  }
  
  const resources = performance.getEntriesByType('resource');
  const now = performance.now();
  
  // Check if any resource loaded in the last 500ms
  const recentResources = resources.filter(entry => {
    const loadTime = entry.responseEnd || entry.fetchStart;
    return (now - loadTime) < 500;
  });
  
  return recentResources.length === 0;
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
  const allPreloaders = Array.from(document.querySelectorAll(".img-preloader"));
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
  
  // Wait a bit for initial visible images to load
  setTimeout(() => {
    preloadQueue = buildPreloadQueue();
    processPreloadQueue();
  }, 1000);
}

/**
 * Initialize lazy loading
 */
export default function initLazyLoad(config = {}) {
  preloadEnabled = config.preload === true;
  
  const preloaders = document.querySelectorAll(".img-preloader:not([data-observed])");
  if (preloaders.length === 0) return;
  
  const observer = getObserver();
  preloaders.forEach((preloader) => {
    preloader.dataset.observed = "true";
    observer.observe(preloader);
  });
  
  // Start preloading if enabled
  if (preloadEnabled) {
    startPreload();
    
    // Track user scrolling to pause preload during scroll
    window.addEventListener('scroll', () => {
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
    }, { passive: true });
  }
}

/**
 * Force load all preloaders (for encrypted content)
 */
export function forceLoadAllPreloaders() {
  document.querySelectorAll(".img-preloader").forEach(processPreloader);
}
