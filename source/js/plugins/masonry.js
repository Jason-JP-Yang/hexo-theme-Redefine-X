/**
 * Masonry Gallery - CSS Columns Based Layout
 * 
 * Uses pure CSS columns for masonry layout.
 * Images are lazy-loaded via lazyload.js with preloaders that maintain
 * correct aspect ratios, so layout is stable from page load.
 * No external masonry libraries needed.
 */

export function initMasonry() {
  const masonryContainer = document.querySelector("#masonry-container");
  if (!masonryContainer) return;

  // Container is immediately visible with CSS columns layout
  // Preloaders show with correct aspect ratios
  // Images load progressively via lazyload.js (same as posts)
  masonryContainer.classList.add("masonry-ready");
}

if (data.masonry) {
  try {
    swup.hooks.on("page:view", initMasonry);
  } catch (e) {}

  document.addEventListener("DOMContentLoaded", initMasonry);
}
