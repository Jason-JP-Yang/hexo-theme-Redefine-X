/**
 * Where the document bar is, published for the floating toolbar to sit under.
 *
 * Shared by both editors, because both add the same bar to the same column and
 * hang the same toolbar off it. Three numbers, all measured, none assumed:
 *
 *   --ed-docbar-h  how much vertical room to leave. Zero unless the bar is
 *                  actually pinned — unpinned it is still down in the page
 *                  clearing nothing, and reserving its height left a band of
 *                  empty page under the navbar.
 *   --ed-docbar-x  where the content column starts.
 *   --ed-docbar-w  how wide it is.
 *
 * The last two are why: the toolbar was centred on the VIEWPORT, and a page with
 * a table of contents is not centred on the viewport — so a toolbar that was
 * 760px wide because the viewport allowed it sat across the contents rail. The
 * document bar is inside the column and already the right width and the right
 * shape, so it is the thing to copy rather than a number to guess.
 *
 * What is published is compared against itself. An earlier version compared the
 * PINNED state and returned early whenever it had not changed — so a bar that
 * grew a notice row while already pinned published nothing, and the toolbar
 * stayed where the shorter bar had left it, underneath the notice.
 */

import { onScroll } from "../../tools/scrollScheduler.js";

export function watchDocbar(bar) {
  let last = "";

  const measure = () => {
    // Sticky means its top stops at the pin line and goes no further, so being
    // at the line IS being pinned. One pixel of slack for fractional layout.
    const style = getComputedStyle(bar);
    const stick = parseFloat(style.top) || 0;
    const rect = bar.getBoundingClientRect();
    const pinned = style.position === "sticky" && rect.top <= stick + 1;

    const h = pinned ? Math.round(bar.offsetHeight) : 0;
    const x = Math.round(rect.left);
    const w = Math.round(rect.width);
    const key = `${h}|${x}|${w}`;
    if (key === last) return;
    last = key;

    const root = document.documentElement.style;
    root.setProperty("--ed-docbar-h", `${h}px`);
    root.setProperty("--ed-docbar-x", `${x}px`);
    root.setProperty("--ed-docbar-w", `${w}px`);
  };

  measure();
  const ro = new ResizeObserver(measure);
  ro.observe(bar);
  // The notice, the progress rail and the tag row are children that appear and
  // disappear; a ResizeObserver on the bar sees the height they cause, and this
  // sees the ones that arrive without changing it yet.
  const mo = new MutationObserver(measure);
  mo.observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
  const off = onScroll(measure, null, "editor docbar pin");
  window.addEventListener("resize", measure);

  return {
    disconnect: () => {
      ro.disconnect();
      mo.disconnect();
      off();
      window.removeEventListener("resize", measure);
    },
  };
}

export function releaseDocbar(watcher) {
  if (watcher) watcher.disconnect();
  const root = document.documentElement.style;
  root.removeProperty("--ed-docbar-h");
  root.removeProperty("--ed-docbar-x");
  root.removeProperty("--ed-docbar-w");
}

/**
 * The toolbar keeps the pinned bar's hours.
 *
 * At the very top of the page the bar is not pinned — it is still down in the
 * page where it was written — and a floating toolbar hanging under the navbar
 * with nothing above it reads as chrome that has come loose. It shows on the way
 * in, gets out of the way when the page is scrolled back to the top, and comes
 * back the moment it is not.
 *
 * Through the theme's scroll scheduler: `read` measures, `write` mutates, and
 * neither ever does the other's job.
 *
 * @param {Function} hidden  true while the bars are put away, when this is the
 *                           only chrome left and the rule above does not apply
 */
export const PERCH_AT = 24;

export function watchPerch(el, hidden) {
  let want = "show";
  return onScroll(
    (m) => {
      want = (m ? m.scrollY : window.scrollY) > PERCH_AT ? "show" : "hide";
    },
    () => {
      const perch = hidden && hidden() ? "show" : want;
      if (el.dataset.perch !== perch) el.dataset.perch = perch;
    },
    "editor toolbar perch"
  );
}
