/**
 * Image EXIF Info Card – Runtime Layout Handler
 *
 * Responsible for:
 *   1. Choosing the best layout mode (Side → Float → Block)
 *   2. Computing the correct CSS grid column count for .image-exif-data
 *   3. Handling collapse/expand toggle animation in Block mode
 *   4. Re-checking on resize, image load, lazyload and SPA navigation
 *
 * Grid-column rules (n = number of .image-exif-section elements):
 *   • columns must be a **divisor** of n so every row is symmetric
 *   • Side / Float + odd n  →  1 column only
 *   • Block + odd n          →  n columns (one row) if width permits, else 1
 *   • Prefer 2 columns for even n (side/float/block)
 */
(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────
  const MIN_COL_WIDTH = 140;   // px – minimum width per grid column
  const COL_GAP       = 10;    // px – ≈ 0.6rem gap between columns
  const CARD_PAD      = 21;    // px – ≈ 0.65rem × 2 card padding
  const SIDE_GAP      = 24;    // px – 1.5rem gap between image & card
  const SIDE_BUFFER   = 10;    // px – safety buffer for side layout
  const SIDE_MIN_W    = 130;   // px – minimum card width for side mode
  const SIDE_MAX_W    = 400;   // px – CSS max-width cap for side mode
  const RESIZE_DELAY  = 150;   // ms – debounce window

  // Developer override: 'None' | 'Side' | 'Float' | 'Block'
  const DEV_FORCE_LAYOUT_MODE = 'None';

  // ── Helpers ──────────────────────────────────────────────────────

  /** Return sorted divisors of n (ascending). */
  function getDivisors(n) {
    const d = [];
    for (let i = 1; i <= n; i++) if (n % i === 0) d.push(i);
    return d;
  }

  /** Width needed in px for `cols` grid columns. */
  function gridWidth(cols) {
    return cols * MIN_COL_WIDTH + Math.max(0, cols - 1) * COL_GAP;
  }

  /**
   * Compute the best column count for the EXIF data grid.
   *
   * @param {number} n              Number of .image-exif-section elements
   * @param {number} availableWidth Available width in px for the grid
   * @param {'side'|'float'|'block'|'viewer'} mode
   * @returns {number}
   */
  function computeGridCols(n, availableWidth, mode) {
    if (n <= 0) return 1;
    const divisors = getDivisors(n);

    // Side / Float with odd section count → single column only
    if ((mode === 'side' || mode === 'float') && n % 2 !== 0) {
      return 1;
    }

    // Block with odd section count → all-in-one-row if fits, else 1
    if (mode === 'block' && n % 2 !== 0) {
      return gridWidth(n) <= availableWidth ? n : 1;
    }

    // Viewer: maximise columns (minimise height), symmetric only
    if (mode === 'viewer') {
      for (let i = divisors.length - 1; i >= 0; i--) {
        if (gridWidth(divisors[i]) <= availableWidth) return divisors[i];
      }
      return 1;
    }

    // Side / Float / Block (even n): prefer 2 columns if they fit
    if (divisors.includes(2) && gridWidth(2) <= availableWidth) return 2;
    return 1;
  }

  /** Set inline grid-template-columns on the .image-exif-data element. */
  function applyGridCols(dataEl, cols) {
    if (!dataEl) return;
    if (cols <= 1) {
      dataEl.style.gridTemplateColumns = '1fr';
    } else {
      dataEl.style.gridTemplateColumns = `repeat(${cols}, minmax(${MIN_COL_WIDTH}px, 1fr))`;
    }
  }

  /** Count .image-exif-section children inside a data element. */
  function sectionCount(container) {
    const data = container.querySelector('.image-exif-data');
    return data ? data.querySelectorAll('.image-exif-section').length : 0;
  }

  /** Get rendered dimensions of the image (or preloader). */
  function getImageDimensions(container) {
    const wrapper = container.querySelector('.image-exif-image-wrapper');
    if (!wrapper) return { w: 0, h: 0 };
    const img = wrapper.querySelector('img.image-exif-img');
    const pre = wrapper.querySelector('.img-preloader');
    if (img && img.complete && img.naturalHeight > 0) {
      return { w: img.offsetWidth || img.clientWidth, h: img.offsetHeight || img.clientHeight };
    }
    if (pre) {
      return { w: pre.offsetWidth || pre.clientWidth, h: pre.offsetHeight || pre.clientHeight };
    }
    return { w: 0, h: 0 };
  }

  // ── Mode: Side ───────────────────────────────────────────────────

  function trySideLayout(container) {
    const infoCard  = container.querySelector('.image-exif-info-card');
    const dataEl    = container.querySelector('.image-exif-data');
    if (!infoCard) return false;

    const { w: imgW, h: imgH } = getImageDimensions(container);
    if (imgW === 0 || imgH === 0) return false;

    const containerW = container.getBoundingClientRect().width;
    const availableSpace = containerW - imgW - SIDE_GAP - SIDE_BUFFER;
    if (availableSpace < SIDE_MIN_W) return false;

    const cardWidth = Math.min(availableSpace, SIDE_MAX_W);
    const n = sectionCount(container);
    const innerWidth = cardWidth - CARD_PAD;

    // Compute columns (side logic: odd → 1; even → prefer 2)
    const cols = computeGridCols(n, innerWidth, 'side');

    // Measure if the card would fit vertically.
    // Clone the card, set it to the calculated width/cols, and measure height.
    const clone = infoCard.cloneNode(true);
    clone.classList.remove('expanded');
    const cs = getComputedStyle(infoCard);
    Object.assign(clone.style, {
      display: 'block', visibility: 'hidden', position: 'absolute',
      top: 0, left: 0, zIndex: -9999,
      width: cardWidth + 'px', height: 'auto', maxHeight: 'none',
      padding: cs.padding, border: cs.border,
      boxSizing: cs.boxSizing, fontSize: cs.fontSize,
      fontFamily: cs.fontFamily, lineHeight: cs.lineHeight
    });
    const cloneData = clone.querySelector('.image-exif-data');
    if (cloneData) {
      Object.assign(cloneData.style, {
        display: 'grid', height: 'auto', opacity: '1', marginTop: '0.6rem'
      });
      applyGridCols(cloneData, cols);
    }
    const cloneBtn = clone.querySelector('.image-exif-toggle-btn');
    if (cloneBtn) cloneBtn.style.display = 'none';

    container.appendChild(clone);
    const cardH = clone.offsetHeight;
    container.removeChild(clone);

    // Card height must not exceed 110 % of image height
    if (cardH > imgH * 1.1) return false;

    // Apply
    if (!container.classList.contains('image-exif-side')) {
      container.classList.add('image-exif-side');
      container.classList.remove('image-exif-overflow-fallback');
      infoCard.style.display = '';
      infoCard.style.visibility = '';
      infoCard.style.opacity = '';
    }
    infoCard.style.maxWidth = cardWidth + 'px';
    applyGridCols(dataEl, cols);
    return true;
  }

  // ── Mode: Float ──────────────────────────────────────────────────

  function tryFloatLayout(container) {
    if (container.classList.contains('image-exif-side')) return;

    const wrapper  = container.querySelector('.image-exif-image-wrapper');
    const infoCard = container.querySelector('.image-exif-info-card');
    const dataEl   = container.querySelector('.image-exif-data');
    if (!wrapper || !infoCard) return;

    const { w: imgW, h: imgH } = getImageDimensions(container);
    if (imgH === 0) return;

    const n = sectionCount(container);
    const maxCardW = imgW * 0.6;
    const innerWidth = maxCardW - CARD_PAD;
    const cols = computeGridCols(n, innerWidth, 'float');

    // Measure height with the chosen cols
    const clone = infoCard.cloneNode(true);
    clone.classList.remove('expanded');
    const cs = getComputedStyle(infoCard);
    Object.assign(clone.style, {
      display: 'block', visibility: 'hidden', position: 'absolute',
      top: 0, left: 0, zIndex: -9999,
      width: 'max-content', maxWidth: '60%',
      height: 'auto', maxHeight: 'none', overflow: 'visible',
      background: 'transparent',
      padding: cs.padding, border: cs.border,
      boxSizing: cs.boxSizing, fontSize: cs.fontSize,
      fontFamily: cs.fontFamily, lineHeight: cs.lineHeight
    });
    const cloneData = clone.querySelector('.image-exif-data');
    if (cloneData) {
      Object.assign(cloneData.style, {
        display: 'grid', height: 'auto', opacity: '1', marginTop: '0.6rem'
      });
      applyGridCols(cloneData, cols);
    }
    const cloneBtn = clone.querySelector('.image-exif-toggle-btn');
    if (cloneBtn) cloneBtn.style.display = 'none';

    wrapper.appendChild(clone);
    const cardH = Math.max(clone.offsetHeight, clone.scrollHeight);
    wrapper.removeChild(clone);

    const availableH = imgH - 24; // 12px top/bottom padding

    if (cardH > availableH - 2) {
      // Overflow → fallback to block
      if (!container.classList.contains('image-exif-overflow-fallback')) {
        container.classList.add('image-exif-overflow-fallback');
        infoCard.style.display = '';
        infoCard.style.visibility = '';
        infoCard.style.opacity = '';
      }
      // Block-fallback grid: use block logic
      const blockCols = computeGridCols(n, container.getBoundingClientRect().width - CARD_PAD, 'block');
      applyGridCols(dataEl, blockCols);
    } else {
      // Fits → remove fallback
      if (container.classList.contains('image-exif-overflow-fallback')) {
        infoCard.style.transition = 'none';
        container.classList.remove('image-exif-overflow-fallback');
        infoCard.offsetHeight; // reflow
        infoCard.style.transition = '';
      }
      applyGridCols(dataEl, cols);
    }
  }

  // ── Main layout orchestrator ─────────────────────────────────────

  function checkLayout(container) {
    // Persist original layout class
    if (!container.dataset.originalLayout) {
      container.dataset.originalLayout =
        container.classList.contains('image-exif-float') ? 'float' : 'block';
    }

    const infoCard = container.querySelector('.image-exif-info-card');
    const dataEl   = container.querySelector('.image-exif-data');

    // ── Dev override ──
    if (DEV_FORCE_LAYOUT_MODE !== 'None') {
      if (DEV_FORCE_LAYOUT_MODE === 'Side') {
        if (!trySideLayout(container)) {
          // Force apply anyway
          container.classList.add('image-exif-side');
          container.classList.remove('image-exif-overflow-fallback');
        }
        return;
      }
      if (DEV_FORCE_LAYOUT_MODE === 'Float') {
        container.classList.remove('image-exif-side', 'image-exif-overflow-fallback');
        if (infoCard) cleanSideInline(infoCard, dataEl);
        tryFloatLayout(container);
        return;
      }
      if (DEV_FORCE_LAYOUT_MODE === 'Block') {
        container.classList.remove('image-exif-side');
        if (infoCard) cleanSideInline(infoCard, dataEl);
        if (container.dataset.originalLayout === 'float') {
          container.classList.add('image-exif-overflow-fallback');
        }
        applyBlockGrid(container);
        return;
      }
    }

    // 1. Try Side-by-Side (highest priority)
    if (trySideLayout(container)) return;

    // Side not viable → clean up side artefacts
    container.classList.remove('image-exif-side');
    if (infoCard) cleanSideInline(infoCard, dataEl);

    // 2. Original float → check float, may fallback to block
    if (container.dataset.originalLayout === 'float') {
      tryFloatLayout(container);
      return;
    }

    // 3. Block mode (default)
    container.classList.remove('image-exif-overflow-fallback');
    if (infoCard) {
      infoCard.style.display = '';
      infoCard.style.visibility = '';
      infoCard.style.opacity = '';
    }
    applyBlockGrid(container);
  }

  /** Apply correct grid cols for block mode. */
  function applyBlockGrid(container) {
    const dataEl = container.querySelector('.image-exif-data');
    const n = sectionCount(container);
    const w = container.getBoundingClientRect().width - CARD_PAD;
    applyGridCols(dataEl, computeGridCols(n, w, 'block'));
  }

  /** Remove inline styles left by side mode. */
  function cleanSideInline(card, dataEl) {
    card.style.maxWidth = '';
    if (dataEl) dataEl.style.gridTemplateColumns = '';
  }

  // ── Toggle (block collapse / expand) ─────────────────────────────

  function handleToggle(btn) {
    const card = btn.closest('.image-exif-info-card');
    if (!card) return;
    const data = card.querySelector('.image-exif-data');
    if (!data) return;

    if (card.classList.contains('expanded')) {
      // collapse
      data.style.height = data.scrollHeight + 'px';
      data.offsetHeight; // reflow
      card.classList.remove('expanded');
      data.style.height = '0';
    } else {
      // expand
      data.style.height = '0px';
      data.offsetHeight; // reflow
      card.classList.add('expanded');
      data.style.height = data.scrollHeight + 'px';
      data.addEventListener('transitionend', function onEnd() {
        if (card.classList.contains('expanded')) data.style.height = 'auto';
        data.removeEventListener('transitionend', onEnd);
      });
    }
  }

  // ── ResizeObserver ───────────────────────────────────────────────

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      requestAnimationFrame(() => {
        if (entry.target.classList.contains('image-exif-container')) {
          checkLayout(entry.target);
        }
      });
    }
  });

  // ── Initialisation ───────────────────────────────────────────────

  function initImageExif() {
    document.querySelectorAll('.image-exif-container').forEach((container) => {
      if (container.dataset.imageExifInit) return;
      container.dataset.imageExifInit = 'true';

      resizeObserver.observe(container);

      // Toggle buttons
      container.querySelectorAll('.image-exif-toggle-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleToggle(btn);
        });
      });

      // Initial layout check
      checkLayout(container);
      setTimeout(() => checkLayout(container), 300);

      // Image load → re-check
      container.querySelectorAll('img.image-exif-img').forEach((img) => {
        if (!img.complete) {
          img.addEventListener('load', () => checkLayout(container));
        }
      });

      // Lazyload (preloader → real image swap)
      const wrapper = container.querySelector('.image-exif-image-wrapper');
      if (wrapper && wrapper.querySelector('.img-preloader')) {
        new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.tagName === 'IMG') {
                const run = () => requestAnimationFrame(() => checkLayout(container));
                node.complete ? run() : node.addEventListener('load', run);
              }
            }
          }
        }).observe(wrapper, { childList: true });
      }
    });
  }

  // ── Debounced global resize ──────────────────────────────────────

  let resizeTimer = null;
  let resizing = false;

  function handleResize() {
    document.querySelectorAll('.image-exif-container').forEach(checkLayout);
  }

  function debouncedResize() {
    if (resizing) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizing = true;
      requestAnimationFrame(() => {
        handleResize();
        resizing = false;
      });
    }, RESIZE_DELAY);
  }

  // ── Boot ─────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initImageExif);
  } else {
    initImageExif();
  }

  document.addEventListener('swup:contentReplaced', initImageExif);
  document.addEventListener('pjax:complete', initImageExif);
  try {
    if (typeof swup !== 'undefined' && swup?.hooks?.on) {
      swup.hooks.on('page:view', () => {
        initImageExif();
        setTimeout(initImageExif, 50);
      });
    }
  } catch (_) {}

  window.addEventListener('resize', debouncedResize);

  const toggleBar = document.querySelector('.page-aside-toggle');
  if (toggleBar) {
    toggleBar.addEventListener('click', () => setTimeout(handleResize, 300));
  }

  window.addEventListener('redefine:force-exif-check', debouncedResize);

  window.addEventListener('redefine:image-loaded', (e) => {
    const img = e.detail?.img;
    if (img) {
      const c = img.closest('.image-exif-container');
      if (c) requestAnimationFrame(() => checkLayout(c));
    }
  });
})();
