/**
 * Redefine-X — the navbar's desktop/mobile switch.
 *
 * The threshold is MEASURED, not declared. A theme is installed on blogs whose
 * navbars are nothing alike — two links or nine, English or CJK, with icons or
 * without, under a site title of any length — so no viewport width is the width
 * at which "the links no longer fit". The only thing that knows is the navbar.
 *
 * So the links are told never to wrap (see `white-space` in the stylesheet),
 * which turns "does not fit" from a silently reflowed two-line navbar into an
 * honest overflow, and this watches for it: the moment the row is wider than the
 * space it has, `body.navbar-collapsed` goes on and the mobile presentation —
 * search icon and drawer button — takes over.
 *
 * Coming back is decided against a REMEMBERED width rather than a live one: the
 * links are `display: none` while collapsed and a hidden row measures zero, so
 * it would otherwise expand instantly and collapse again on the next frame. What
 * is remembered is the row's own width, which does not depend on the window, and
 * the hysteresis below keeps a slow drag across the threshold from flickering.
 *
 * The viewport media queries stay as they are. They are a FLOOR — a phone gets
 * the mobile navbar on the first frame, before any of this has run — and this
 * adds the case they cannot see: a window wide enough for the breakpoint and too
 * narrow for the links.
 */

// Room the row has to regain before it is allowed back, over and above the
// width it was collapsed at. Anything smaller and a window dragged slowly
// across the threshold flickers between the two navbars.
const HYSTERESIS = 24;

let content = null;
let needed = 0;
let frame = 0;

export default function initNavbarCollapse() {
  content = document.querySelector(".navbar-content");
  if (!content) return;

  // A page turn can change the navbar's max-width — the home page runs wider
  // than the rest — so the row that fit a moment ago may not now.
  needed = 0;
  schedule();

  if (initNavbarCollapse.wired) return;
  initNavbarCollapse.wired = true;

  window.addEventListener("resize", schedule, { passive: true });
  // Icon and title metrics both move when the webfonts land, and the row is
  // measured in whatever the fallback happened to be until they do.
  if (document.fonts) document.fonts.ready.then(schedule);
}

function schedule() {
  if (frame || !content) return;
  frame = requestAnimationFrame(update);
}

function update() {
  frame = 0;
  if (!content || !content.isConnected) return;

  const collapsed = document.body.classList.contains("navbar-collapsed");

  if (!collapsed) {
    // `scrollWidth` is the row's own width once nothing in it may wrap, so this
    // is "the links stopped fitting" and not an approximation of it.
    if (content.scrollWidth > content.clientWidth + 1) {
      needed = content.scrollWidth;
      document.body.classList.add("navbar-collapsed");
    }
    return;
  }

  if (needed && content.clientWidth >= needed + HYSTERESIS) {
    document.body.classList.remove("navbar-collapsed");
    // And look again: the width remembered was measured in the old layout, and
    // if the links still do not fit this puts them straight back.
    schedule();
  }
}
