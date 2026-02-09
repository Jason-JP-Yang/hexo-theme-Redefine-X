/**
 * Masonry Gallery - CSS Columns Based Layout
 * 
 * Uses pure CSS columns for masonry layout.
 * Images are lazy-loaded via lazyload.js with preloaders that maintain
 * correct aspect ratios, so layout is stable from page load.
 * No external masonry libraries needed.
 * 
 * Includes overlay overflow detection: if description is too long
 * (overlaps with title or exceeds image bounds), switches to compact mode
 * where only the title is shown centered at the bottom.
 */

/**
 * Check masonry overlay overflow and apply compact mode if needed.
 * Compact mode hides description and centers title at bottom.
 */
function checkMasonryOverflow(container) {
  const items = container.querySelectorAll('.image-container');
  items.forEach(item => {
    const desc = item.querySelector('.image-description');
    const title = item.querySelector('.image-title');
    if (!desc || !title) return;

    // Reset compact mode to re-measure
    item.classList.remove('masonry-compact');

    const containerH = item.offsetHeight;
    if (containerH === 0) return; // Not rendered yet

    const titleRect = title.getBoundingClientRect();
    const descRect = desc.getBoundingClientRect();

    // Check if title and description overlap vertically
    const overlaps = titleRect.bottom > descRect.top && titleRect.top < descRect.bottom;

    // Check if description is too tall relative to the image container
    const tooTall = desc.offsetHeight > containerH * 0.3;

    // Check if description exceeds container bounds
    const containerRect = item.getBoundingClientRect();
    const exceeds = descRect.bottom > containerRect.bottom + 2;

    if (overlaps || tooTall || exceeds) {
      item.classList.add('masonry-compact');
    }
  });
}

export function initMasonry() {
  const masonryContainer = document.querySelector("#masonry-container");
  if (!masonryContainer) return;

  // Container is immediately visible with CSS columns layout
  // Preloaders show with correct aspect ratios
  // Images load progressively via lazyload.js (same as posts)
  masonryContainer.classList.add("masonry-ready");

  // Check overlay overflow after layout stabilizes
  requestAnimationFrame(() => {
    checkMasonryOverflow(masonryContainer);
  });

  // Recheck on window resize (column layout may change)
  let resizeTimer;
  const handleResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => checkMasonryOverflow(masonryContainer), 200);
  };
  window.addEventListener('resize', handleResize);
}

if (data.masonry) {
  try {
    swup.hooks.on("page:view", initMasonry);
  } catch (e) {}

  document.addEventListener("DOMContentLoaded", initMasonry);
}
