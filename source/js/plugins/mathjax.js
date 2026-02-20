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

  function handleOverflow() {
    var blocks = document.querySelectorAll(".mathjax-block");
    for (var i = 0; i < blocks.length; i++) {
      processBlock(blocks[i]);
    }
  }

  function processBlock(block) {
    // Clean up previous overflow state
    block.classList.remove(
      "math-overflow-scroll",
      "math-overflow-fit",
      "math-overflow-wrap"
    );
    var oldMasks = block.querySelectorAll(".math-scroll-mask");
    for (var i = 0; i < oldMasks.length; i++) oldMasks[i].remove();

    var mjxContainer = block.querySelector("mjx-container");
    if (!mjxContainer) return;

    // Reset any previous transforms
    mjxContainer.style.transform = "";
    mjxContainer.style.transformOrigin = "";
    block.style.height = "";

    var containerWidth = block.clientWidth;
    var mathWidth = mjxContainer.scrollWidth || mjxContainer.offsetWidth;

    // No overflow — nothing to do
    if (mathWidth <= containerWidth + 2) return;

    if (overflowMode === "fit") {
      applyFit(block, mjxContainer, containerWidth, mathWidth);
    } else if (overflowMode === "wrap") {
      // wrap mode: if still overflowing after MathJax linebreaking, fall back to scroll
      if (mjxContainer.scrollWidth > containerWidth + 2) {
        applyScroll(block);
      }
    } else {
      // default: scroll
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
    block.addEventListener("scroll", function () {
      updateScrollIndicators(block);
    });
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
  function applyFit(block, mjxContainer, containerWidth, mathWidth) {
    block.classList.add("math-overflow-fit");
    var scale = containerWidth / mathWidth;
    if (scale > 0.98) return; // close enough, don't bother

    // Clamp minimum scale so formulas don't become unreadable
    scale = Math.max(scale, 0.4);

    mjxContainer.style.transform = "scale(" + scale + ")";
    mjxContainer.style.transformOrigin = "center top";
    // Adjust container height to match scaled content
    var originalHeight = mjxContainer.offsetHeight;
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
