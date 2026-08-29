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
 *
 * There is a SECOND, narrower switch below the first, measured the same way. The
 * mobile row is a site title beside three controls, and a long title on a narrow
 * phone overflows it too — at which point the Follow button drops its label and
 * becomes a disc. That is the last thing in the row that can be given up; the
 * button itself stays, because a reader who cannot see it cannot press it.
 */

// Room the row has to regain before it is allowed back, over and above the
// width it was collapsed at. Anything smaller and a window dragged slowly
// across the threshold flickers between the two navbars.
const HYSTERESIS = 24;
// The label is worth less than the links, so it is given back sooner.
const COMPACT_HYSTERESIS = 12;

let content = null;
let needed = 0;
let compactNeeded = 0;
let frame = 0;
let observer = null;

export default function initNavbarCollapse() {
  content = document.querySelector(".navbar-content");
  if (!content) return;

  // A page turn can change the navbar's max-width — the home page runs wider
  // than the rest — so the row that fit a moment ago may not now.
  // `compactNeeded` is deliberately NOT reset with it: the mobile row is the
  // same three controls on every page, so what it measured still holds.
  needed = 0;
  observe();
  schedule();

  if (initNavbarCollapse.wired) return;
  initNavbarCollapse.wired = true;

  window.addEventListener("resize", schedule, { passive: true });
  // Icon and title metrics both move when the webfonts land, and the row is
  // measured in whatever the fallback happened to be until they do.
  if (document.fonts) document.fonts.ready.then(schedule);
}

// The halves, not the row: `.navbar-content` is width:100% and only moves with
// the window, which `resize` already covers. What changes without the window
// moving is what is inside them — the bell swapped for the Follow button.
function observe() {
  if (typeof ResizeObserver === "undefined") return;
  if (!observer) observer = new ResizeObserver(schedule);
  observer.disconnect();
  for (const child of content.children) observer.observe(child);
}

function schedule() {
  if (frame || !content) return;
  frame = requestAnimationFrame(update);
}

// The sum of the halves, not `scrollWidth`: scrollWidth counts decoration that
// hangs off a corner — the unread badge does, deliberately — and read as
// overflow that is a permanent "the links do not fit" in a row with room to
// spare. Neither half can be squeezed below its own content, so this is the
// width the row would take if it were given it.
function rowWidth() {
  let total = 0;
  for (const child of content.children) {
    total += child.getBoundingClientRect().width;
  }
  return total;
}

function update() {
  frame = 0;
  if (!content || !content.isConnected) return;

  const body = document.body;
  const collapsed = body.classList.contains("navbar-collapsed");

  if (!collapsed) {
    const width = rowWidth();
    if (width > content.clientWidth + 1) {
      needed = width;
      body.classList.add("navbar-collapsed");
      // Look again at the row we just switched to: it is a different set of
      // controls, and it has its own threshold below this one.
      schedule();
    }
    return;
  }

  if (needed && content.clientWidth >= needed + HYSTERESIS) {
    body.classList.remove("navbar-collapsed");
    setCompact(false);
    // And look again: the width remembered was measured in the old layout, and
    // if the links still do not fit this puts them straight back.
    schedule();
    return;
  }

  // The mobile row, measured on its own terms.
  if (!body.classList.contains("navbar-follow-compact")) {
    const width = rowWidth();
    if (width > content.clientWidth + 1) {
      compactNeeded = width;
      setCompact(true);
    }
  } else if (compactNeeded && content.clientWidth >= compactNeeded + COMPACT_HYSTERESIS) {
    setCompact(false);
    schedule();
  }
}

function setCompact(on) {
  document.body.classList.toggle("navbar-follow-compact", on);
  if (!on) compactNeeded = 0;
}
