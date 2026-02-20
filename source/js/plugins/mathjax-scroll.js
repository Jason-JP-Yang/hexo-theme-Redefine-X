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
 */

var _mjResizeBound = false;

const initMathJaxScroll = () => {
  'use strict';

  var BLOCK   = '.mathjax-block';
  var WRAPPER = '.mathjax-scroll-wrapper';
  var THRESH  = 2;

  /* ---- DOM helpers ------------------------------------------------ */

  function mkHint(side) {
    var el = document.createElement('div');
    el.className = 'mathjax-scroll-hint mathjax-scroll-hint--' + side;
    var icon = document.createElement('i');
    icon.className = side === 'left'
      ? 'fa-solid fa-caret-left'
      : 'fa-solid fa-caret-right';
    el.appendChild(icon);
    return el;
  }

  function hints(block) {
    var L = block.querySelector('.mathjax-scroll-hint--left');
    var R = block.querySelector('.mathjax-scroll-hint--right');
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
    var ow = wrapper.scrollWidth - wrapper.clientWidth;
    if (ow > 1) return ow;

    // Fallback: use flex item's own scrollWidth
    var container = wrapper.querySelector('mjx-container');
    if (container) {
      var cw = container.scrollWidth - wrapper.clientWidth;
      if (cw > 1) return cw;
    }
    return 0;
  }

  /* ---- Overflow check & hint toggle ------------------------------- */

  function refresh(block) {
    var w = block.querySelector(WRAPPER);
    if (!w) return;

    var max = getOverflow(w);
    if (max <= 0) {
      block.classList.remove('mathjax-overflow');
      var all = block.querySelectorAll('.mathjax-scroll-hint');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('is-visible');
      return;
    }

    block.classList.add('mathjax-overflow');
    var sl = Math.round(w.scrollLeft);
    var h  = hints(block);
    h.L.classList.toggle('is-visible', sl > THRESH);
    h.R.classList.toggle('is-visible', max - sl > THRESH);
  }

  /* ---- Wheel interception ----------------------------------------- */

  function onWheel(w, e) {
    var max = getOverflow(w);
    if (max <= 0) return;

    var dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    var sl = Math.round(w.scrollLeft);

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

    var w = block.querySelector(WRAPPER);
    if (!w) return;

    w.addEventListener('scroll', function () { refresh(block); }, { passive: true });
    w.addEventListener('wheel',  function (e) { onWheel(w, e); }, { passive: false });
  }

  /* ---- Init all blocks -------------------------------------------- */

  function initAll() {
    var blocks = document.querySelectorAll(BLOCK);
    for (var i = 0; i < blocks.length; i++) {
      bind(blocks[i]);
      refresh(blocks[i]);
    }
  }

  // Delay-retry: defer measurements until after browser layout pass.
  // On Swup page:view the DOM is freshly swapped — calling initAll()
  // synchronously reads scrollWidth before layout is complete, causing
  // every formula to appear overflowed.  rAF guarantees at least one
  // layout/paint cycle has finished before we measure anything.
  function initWithRetry() {
    requestAnimationFrame(function () {
      initAll();
      // Additional retries in case SVG fonts shift dimensions later
      setTimeout(initAll, 300);
      setTimeout(initAll, 1000);
    });
  }

  // Called from main.refresh() which fires on DOMContentLoaded and
  // every Swup page:view event.
  initWithRetry();

  // Register resize listener only once across Swup navigations
  if (!_mjResizeBound) {
    _mjResizeBound = true;
    window.addEventListener('resize', function () {
      requestAnimationFrame(initAll);
    });
  }
};

export default initMathJaxScroll;
