/**
 * Redefine-X MathJax Plugin — Runtime overflow handling & Swup re-typesetting
 *
 * Handles three overflow modes for display equations wider than the container:
 *   scroll — hidden scrollbar + fade masks with FontAwesome caret arrow hints
 *   fit    — auto-scale the formula down to fit the container width
 *   wrap   — MathJax automatic line breaking (fallback to scroll on failure)
 */
(function () {
  "use strict";

  var overflowMode = window.__mathJaxOverflowMode || "scroll";

  /* ======================== Overflow Handling ======================== */

  /**
   * Re-evaluate overflow for every block.
   *
   * Split into a RESET pass, a MEASURE pass and an APPLY pass. The original
   * looped once per block doing reset-writes → measurement reads → more writes,
   * so every formula on the page forced its own synchronous layout. With N
   * formulas that is N full layouts back-to-back, and it runs on every Swup
   * page:view — right when the animated scroll-to-top is in flight.
   * Three separated passes cost one layout for the whole page.
   */
  function handleOverflow() {
    var blocks = document.querySelectorAll(".mathjax-block");
    var i;

    // 1 — reset (writes only)
    var live = [];
    for (i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      block.classList.remove(
        "math-overflow-scroll",
        "math-overflow-fit",
        "math-overflow-wrap"
      );
      var oldMasks = block.querySelectorAll(".math-scroll-mask");
      for (var m = 0; m < oldMasks.length; m++) oldMasks[m].remove();

      var mjxContainer = block.querySelector("mjx-container");
      if (!mjxContainer) continue;

      mjxContainer.style.transform = "";
      mjxContainer.style.transformOrigin = "";
      block.style.height = "";
      block.style.overflow = "";
      live.push({ block: block, mjx: mjxContainer });
    }

    // 2 — measure (reads only)
    for (i = 0; i < live.length; i++) {
      live[i].containerWidth = live[i].block.clientWidth;
      live[i].mathWidth = live[i].mjx.scrollWidth || live[i].mjx.offsetWidth;
      live[i].height = live[i].mjx.offsetHeight;
    }

    // 3 — apply (writes only)
    for (i = 0; i < live.length; i++) applyBlock(live[i]);
  }

  function applyBlock(info) {
    var block = info.block;
    var mjxContainer = info.mjx;
    var containerWidth = info.containerWidth;
    var mathWidth = info.mathWidth;

    // No overflow — nothing to do
    if (mathWidth <= containerWidth + 2) return;

    if (overflowMode === "fit") {
      applyFit(block, mjxContainer, containerWidth, mathWidth, info.height);
    } else {
      // "wrap" falls back to scroll when MathJax linebreaking did not resolve
      // the overflow — which, given we just measured it, is the case here.
      applyScroll(block);
    }
  }

  /* ---- scroll mode ---- */
  function applyScroll(block) {
    block.classList.add("math-overflow-scroll");

    var leftMask = document.createElement("div");
    leftMask.className = "math-scroll-mask math-scroll-left";
    leftMask.innerHTML = '<i class="fa-solid fa-caret-left"></i>';

    var rightMask = document.createElement("div");
    rightMask.className = "math-scroll-mask math-scroll-right";
    rightMask.innerHTML = '<i class="fa-solid fa-caret-right"></i>';

    block.appendChild(leftMask);
    block.appendChild(rightMask);

    updateScrollIndicators(block);

    // handleOverflow() re-runs applyScroll on every retypeset (i.e. every
    // page:view). Without this guard each pass stacked another scroll listener
    // on the same block, so horizontally scrolling one formula eventually ran
    // the indicator update dozens of times per event.
    if (!block.dataset.mathScrollBound) {
      block.dataset.mathScrollBound = "1";
      block.addEventListener("scroll", function () {
        updateScrollIndicators(block);
      }, { passive: true });
    }
  }

  function updateScrollIndicators(block) {
    var scrollLeft = block.scrollLeft;
    var maxScroll = block.scrollWidth - block.clientWidth;

    var leftMask = block.querySelector(".math-scroll-left");
    var rightMask = block.querySelector(".math-scroll-right");

    if (leftMask) {
      if (scrollLeft > 5) {
        leftMask.classList.add("visible");
      } else {
        leftMask.classList.remove("visible");
      }
    }
    if (rightMask) {
      if (scrollLeft < maxScroll - 5) {
        rightMask.classList.add("visible");
      } else {
        rightMask.classList.remove("visible");
      }
    }
  }

  /* ---- fit mode ---- */
  // originalHeight is measured in handleOverflow's read pass so this stays
  // write-only (it used to read offsetHeight after writing the transform,
  // forcing a layout per fitted formula).
  function applyFit(block, mjxContainer, containerWidth, mathWidth, originalHeight) {
    block.classList.add("math-overflow-fit");
    var scale = containerWidth / mathWidth;
    if (scale > 0.98) return; // close enough, don't bother

    // Clamp minimum scale so formulas don't become unreadable
    scale = Math.max(scale, 0.4);

    mjxContainer.style.transform = "scale(" + scale + ")";
    mjxContainer.style.transformOrigin = "center top";
    // Adjust container height to match scaled content
    if (typeof originalHeight !== "number") originalHeight = mjxContainer.offsetHeight;
    block.style.height = originalHeight * scale + "px";
    block.style.overflow = "hidden";
  }

  /* ======================== Expose for MathJax callback ======================== */
  window.__redefineXMathJaxOverflow = handleOverflow;

  /* ======================== Swup Integration ======================== */
  function retypeset() {
    if (window.MathJax && MathJax.typesetPromise) {
      // Clear MathJax's internal cache for removed elements
      if (MathJax.startup && MathJax.startup.document) {
        MathJax.startup.document.clear();
        MathJax.startup.document.updateDocument();
      }
      MathJax.typesetPromise()
        .then(handleOverflow)
        .catch(function (err) {
          console.warn("[MathJax] Typeset error:", err);
        });
    }
  }

  // Register swup hook if available (swup.ejs loads AFTER scripts.ejs)
  function tryRegisterSwup() {
    if (window.swup) {
      try {
        swup.hooks.on("page:view", function () {
          retypeset();
        });
      } catch (e) {}
      return;
    }
    // Swup might not be initialized yet; retry briefly
    var attempts = 0;
    var timer = setInterval(function () {
      attempts++;
      if (window.swup) {
        clearInterval(timer);
        try {
          swup.hooks.on("page:view", function () {
            retypeset();
          });
        } catch (e) {}
      } else if (attempts > 20) {
        clearInterval(timer);
      }
    }, 100);
  }

  // Init
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryRegisterSwup);
  } else {
    tryRegisterSwup();
  }
})();
