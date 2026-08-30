/* main function */

import { main } from "../main.js";

/**
 * The table-of-contents toggle.
 *
 * NOTHING is cached, and the open/closed flag is module state rather than a
 * field on the returned object. Both matter for an encrypted post: its article
 * is mounted long after this module first runs, so a `.post-page-container`
 * looked up at init is null, and the click listener — attached once — closed
 * over that null and over a stale `isOpenPageAside`. The toggle then flipped its
 * own private boolean and changed nothing on screen.
 */

let isOpen = false;

const dom = {
  get bar() {
    return document.querySelector(".page-aside-toggle");
  },
  get icon() {
    return document.querySelector(".page-aside-toggle i");
  },
  get container() {
    return document.querySelector(".post-page-container");
  },
  get main() {
    return document.querySelector(".main-content");
  },
};

function toggleClassName(element, className, condition) {
  if (element) element.classList.toggle(className, condition);
}

function applyLayout(open) {
  isOpen = open;
  toggleClassName(dom.icon, "fas", open);
  toggleClassName(dom.icon, "fa-indent", open);
  toggleClassName(dom.icon, "fa-outdent", !open);
  toggleClassName(dom.container, "show-toc", open);
  toggleClassName(dom.main, "has-toc", open);
}

export function initTocToggle() {
  const bar = dom.bar;
  if (bar && !bar.dataset.hasTocListener) {
    bar.dataset.hasTocListener = "true";
    bar.addEventListener("click", () => {
      applyLayout(!isOpen);
      main.styleStatus.isOpenPageAside = isOpen;
      main.setStyleStatus();
    });
  }

  return {
    get isOpenPageAside() {
      return isOpen;
    },
    pageAsideHandleOfTOC(open) {
      if (dom.bar) dom.bar.style.display = "flex";
      applyLayout(open);
    },
  };
}

// Event listeners
try {
  swup.hooks.on("page:view", () => {
    initTocToggle();
  });
} catch (e) {}

document.addEventListener("DOMContentLoaded", initTocToggle);
