/* main function */

import { initTocToggle } from "../tools/tocToggle.js";
import { main } from "../main.js";
import { invalidateMetrics } from "../tools/scrollScheduler.js";

// The active TOC controller for the CURRENT page.
//
// This used to be rebuilt from scratch inside the window scroll handler — twice
// per event (once for a `hasOwnProperty` probe, once for the real call). Each
// rebuild ran three querySelectorAll passes, a getElementById per heading, a
// localStorage read + JSON.parse, and layout-class toggles on `.main-content`
// and `.post-page-container`. At ~60 scroll events/second during Swup's
// animated scroll-to-top, that alone was enough to destroy the frame budget on
// a long article.
//
// Now it is built once per navigation and the scroll pass only asks it two
// cheap questions: which heading is active (pure arithmetic), and please
// activate it (only when the answer changed).
let controller = null;

export function getTOC() {
  return controller;
}

function buildController() {
  const utils = {
    navItems: document.querySelectorAll(".post-toc-wrap .post-toc li"),
    navLinks: [],
    sections: [],
    // Heading offsets in PAGE space. Scrolling cannot change them, so the
    // active-index test becomes `sectionTop - scrollY - 100 > 0` — arithmetic,
    // where it used to be a getBoundingClientRect() per heading per frame.
    sectionTops: [],
    activeLink: null,

    measureSections() {
      utils.navLinks = Array.from(
        document.querySelectorAll(".post-toc li a.nav-link"),
      );
      const scrollY =
        window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
      utils.sections = utils.navLinks.map((element) => {
        const href = element.getAttribute("href") || "";
        return document.getElementById(decodeURI(href).replace("#", ""));
      });
      utils.sectionTops = utils.sections.map((el) =>
        el ? el.getBoundingClientRect().top + scrollY : Number.POSITIVE_INFINITY,
      );
    },

    /**
     * Which heading is active at this scroll position? READ-only and
     * allocation-free — safe to call every frame.
     * Mirrors the original semantics exactly: the first heading still below the
     * 100px line, minus one; or the last heading if none qualifies.
     */
    computeActiveIndex(scrollY) {
      const tops = utils.sectionTops;
      if (!tops.length) return -1;

      let index = -1;
      for (let i = 0; i < tops.length; i++) {
        if (tops[i] - scrollY - 100 > 0) {
          index = i;
          break;
        }
      }
      if (index === -1) index = tops.length - 1;
      else if (index > 0) index--;
      return index;
    },

    // Kept for backwards compatibility with any caller that still drives the
    // TOC without the scheduler.
    updateActiveTOCLink() {
      const scrollY =
        window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
      const i = utils.computeActiveIndex(scrollY);
      if (i >= 0) utils.activateTOCLink(i);
    },

    activateTOCLink(index) {
      const target = utils.navLinks[index];
      if (!target || target === utils.activeLink) return;

      // Only the previously-active link needs clearing — no document-wide
      // querySelectorAll on every change.
      if (utils.activeLink) {
        utils.activeLink.classList.remove("active", "active-current");
      } else {
        document.querySelectorAll(".post-toc .active").forEach((element) => {
          element.classList.remove("active", "active-current");
        });
      }
      target.classList.add("active", "active-current");
      utils.activeLink = target;

      // Scroll to the active TOC item
      const tocElement = document.querySelector(".toc-content-container");
      if (!tocElement) return;
      const tocTop = tocElement.getBoundingClientRect().top;
      const scrollTopOffset =
        tocElement.offsetHeight > window.innerHeight
          ? (tocElement.offsetHeight - window.innerHeight) / 2
          : 0;
      const targetTop = target.getBoundingClientRect().top - tocTop;
      const viewportHeight = Math.max(
        document.documentElement.clientHeight,
        window.innerHeight || 0,
      );
      const distanceToCenter =
        targetTop -
        viewportHeight / 2 +
        target.offsetHeight / 2 -
        scrollTopOffset;
      const scrollTop = tocElement.scrollTop + distanceToCenter;

      tocElement.scrollTo({
        top: scrollTop,
        behavior: "smooth", // Smooth scroll
      });
    },

    showTOCAside() {
      const openHandle = () => {
        const styleStatus = main.getStyleStatus();
        const key = "isOpenPageAside";
        if (styleStatus && styleStatus.hasOwnProperty(key)) {
          initTocToggle().pageAsideHandleOfTOC(styleStatus[key]);
        } else {
          initTocToggle().pageAsideHandleOfTOC(true);
        }
      };

      const initOpenKey = "init_open";

      if (theme.articles.toc.hasOwnProperty(initOpenKey)) {
        theme.articles.toc[initOpenKey]
          ? openHandle()
          : initTocToggle().pageAsideHandleOfTOC(false);
      } else {
        openHandle();
      }
    },
  };

  return utils;
}

export function initTOC() {
  const utils = buildController();
  controller = utils;

  if (utils.navItems.length > 0) {
    utils.showTOCAside();
    utils.measureSections();
  } else {
    controller = null;
    document
      .querySelectorAll(".toc-content-container, .toc-marker")
      .forEach((elem) => {
        elem.remove();
      });
  }

  return utils;
}

// Heading offsets shift whenever the article's height changes — a lazy image
// swapping in, an EXIF card re-laying out, a MathJax block resizing, the aside
// opening. Re-measure then (never per frame).
//
// Deliberately listens for `redefine:content-resized` (fired ONCE per batch of
// changes) rather than `redefine:image-loaded` (fired per image). Re-measuring
// every heading once per image would turn a 50-image batch into 50 full
// measurement passes — the very thing this file exists to stop.
let remeasureFrame = null;
function remeasure() {
  if (remeasureFrame !== null) return;
  remeasureFrame = requestAnimationFrame(() => {
    remeasureFrame = null;
    if (controller) controller.measureSections();
    invalidateMetrics();
  });
}
window.addEventListener("resize", remeasure, { passive: true });
window.addEventListener("redefine:content-resized", remeasure);

// Event listeners
try {
  swup.hooks.on("page:view", () => {
    initTOC();
  });
} catch (e) {}

document.addEventListener("DOMContentLoaded", initTOC);
