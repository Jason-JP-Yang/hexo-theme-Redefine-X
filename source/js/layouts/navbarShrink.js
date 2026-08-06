import { navigationState } from "../utils.js";
import { getMetrics } from "../tools/scrollScheduler.js";

export const navbarShrink = {
  navbarDom: null,
  leftAsideDom: null,
  isnavbarShrink: false,
  navbarHeight: 0,

  // init() is the per-navigation WIRING pass: re-acquire the DOM (the whole
  // navbar lives inside #swup and is replaced on every page:view, so refs
  // captured at module load go stale and measure 0), re-measure the height,
  // re-bind the drawer/submenu.
  //
  // It deliberately does NOT register a scroll listener any more. It used to —
  // and because utils' scroll handler called init(), every single scroll event
  // added another listener, which then called init() again on the next event.
  // The scroll path now calls shrink() directly through the shared scheduler.
  init() {
    this.navbarDom = document.querySelector(".navbar-container");
    this.leftAsideDom = document.querySelector(".page-aside");
    if (!this.navbarDom) return;

    this.measure();
    this.shrink();
    this.togglenavbarDrawerShow();
    this.toggleSubmenu();
  },

  // The navbar's own height only changes on a real layout change, never while
  // scrolling — measuring it per frame was a forced layout for a constant.
  measure() {
    if (!this.navbarDom) return;
    const h = this.navbarDom.getBoundingClientRect().height;
    // While shrunk the navbar reports its SHRUNK height; keeping that as the
    // threshold would make the state oscillate around the boundary. Only accept
    // a measurement taken in the expanded state.
    if (h > 0 && !this.isnavbarShrink) this.navbarHeight = h;
  },

  // scrollTop is supplied by the shared scroll pass (already measured for the
  // frame). The fallback keeps direct callers — init(), page:view — working.
  shrink(scrollTop) {
    if (typeof scrollTop !== "number") scrollTop = getMetrics().scrollY;

    if (!this.isnavbarShrink && scrollTop > this.navbarHeight) {
      this.isnavbarShrink = true;
      document.body.classList.add("navbar-shrink");
    } else if (this.isnavbarShrink && scrollTop <= this.navbarHeight) {
      this.isnavbarShrink = false;
      document.body.classList.remove("navbar-shrink");
    }
  },

  togglenavbarDrawerShow() {
    const domList = [
      document.querySelector(".window-mask"),
      document.querySelector(".navbar-bar"),
    ];

    if (document.querySelector(".navbar-drawer")) {
      domList.push(
        ...document.querySelectorAll(
          ".navbar-drawer .drawer-navbar-list .drawer-navbar-item",
        ),
        ...document.querySelectorAll(".navbar-drawer .tag-count-item"),
      );
    }

    domList.forEach((v) => {
      if (!v.dataset.navbarInitialized) {
        v.dataset.navbarInitialized = 1;
        v.addEventListener("click", () => {
          document.body.classList.toggle("navbar-drawer-show");
        });
      }
    });

    const logoTitleDom = document.querySelector(
      ".navbar-container .navbar-content .logo-title",
    );
    if (logoTitleDom && !logoTitleDom.dataset.navbarInitialized) {
      logoTitleDom.dataset.navbarInitialized = 1;
      logoTitleDom.addEventListener("click", () => {
        document.body.classList.remove("navbar-drawer-show");
      });
    }
  },

  toggleSubmenu() {
    const toggleElements = document.querySelectorAll("[navbar-data-toggle]");

    toggleElements.forEach((toggle) => {
      if (!toggle.dataset.eventListenerAdded) {
        toggle.dataset.eventListenerAdded = "true";
        toggle.addEventListener("click", function () {
          // console.log("click");
          const target = document.querySelector(
            '[data-target="' + this.getAttribute("navbar-data-toggle") + '"]',
          );
          const submenuItems = target.children; // Get submenu items
          const icon = this.querySelector(".fa-chevron-right");

          if (target) {
            const isVisible = !target.classList.contains("hidden");

            if (icon) {
              icon.classList.toggle("icon-rotated", !isVisible);
            }

            if (isVisible) {
              // Animate to hide (reverse stagger effect)
              anime({
                targets: submenuItems,
                opacity: 0,
                translateY: -10,
                duration: 300,
                easing: "easeInQuart",
                delay: anime.stagger(80, { start: 20, direction: "reverse" }),
                complete: function () {
                  target.classList.add("hidden");
                },
              });
            } else {
              // Animate to show with stagger effect
              target.classList.remove("hidden");

              anime({
                targets: submenuItems,
                opacity: [0, 1],
                translateY: [10, 0],
                duration: 300,
                easing: "easeOutQuart",
                delay: anime.stagger(80, { start: 20 }),
              });
            }
          }
        });
      }
    });
  },
};

try {
  swup.hooks.on("page:view", () => {
    navbarShrink.init();
    navigationState.isNavigating = false;
  });

  swup.hooks.on("visit:start", () => {
    navigationState.isNavigating = true;
    // Keep the flag in step with the class we just dropped, otherwise shrink()
    // believes it is still shrunk and refuses to re-add the class on the next
    // page until you scroll all the way back above the navbar first.
    navbarShrink.isnavbarShrink = false;
    document.body.classList.remove("navbar-shrink");
  });
} catch (error) {}

window.addEventListener("resize", () => navbarShrink.measure(), { passive: true });

document.addEventListener("DOMContentLoaded", () => {
  navbarShrink.init();
});
