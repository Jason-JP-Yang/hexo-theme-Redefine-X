/**
 * Redefine-X — the profile card's pager.
 *
 * The site card pages between the blog's own author and every collaborator who
 * has actually contributed something. Three things make it feel like one
 * surface rather than a widget bolted on:
 *
 * ── It never ends ───────────────────────────────────────────────────────────
 *
 * A clone of the first page is appended after the last one, so advancing off
 * the end travels FORWARD into something that already looks like page one, and
 * the reset to index 0 happens with the transition switched off in the frame
 * after it lands. Rewinding through every page to get home is the thing that
 * makes a short carousel read as a mechanism; this way there is no seam to see.
 * The clone is built here rather than in the markup because it is not content —
 * it is the same page twice, and a template that emitted it would be saying so
 * to a reader with no JavaScript.
 *
 * ── It only moves while it is being LOOKED at ───────────────────────────────
 *
 * The auto-advance is armed by an IntersectionObserver at threshold 1: the card
 * has to be WHOLLY in view, and it has to stay that way for the full dwell
 * before the first turn. Scrolling past, a hidden tab, a pointer resting on the
 * card and a focused dot all disarm it. A card that turns pages while half off
 * screen is a card that has changed by the time it is read.
 *
 * ── It answers the pointer ──────────────────────────────────────────────────
 *
 * Dragging moves the track under the finger and releasing snaps to whichever
 * page is nearest, with a short throw counting as a flick. Pointer events, so
 * mouse, pen and touch are one code path — and `touch-action: pan-y` in the
 * stylesheet is what keeps a vertical scroll from being stolen by it.
 *
 * No scroll listener: this is viewport membership and pointer input, neither of
 * which belongs in the scroll scheduler.
 */

// How long the card must be wholly visible before it turns, and between turns.
const DWELL_MS = 3000;

// The slide itself. Long enough to read as travel, short enough that a dot
// pressed twice in a row does not queue up.
const SLIDE_MS = 520;
const SLIDE_EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";

// A drag shorter than this is a tap on whatever is under it, not a throw.
const DRAG_SLOP = 6;

// Past this fraction of the card's width, releasing commits to the next page
// however slowly it was dragged.
const COMMIT = 0.22;

let instances = [];

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

function build(pager) {
  const track = pager.querySelector("[data-profile-track]");
  if (!track) return null;

  const card = pager.closest(".sidebar-content") || pager.parentElement;
  const rail = card ? card.querySelector("[data-profile-dots]") : null;

  // A page whose count is still zero for THIS reader is in the DOM and hidden;
  // the vault pass reveals it and re-inits. Hidden pages are out of the flex
  // flow, so visible page k really is at k × 100% — see `.sb-page[hidden]`.
  const real = Array.from(track.children).filter(
    (page) => !page.hidden && !page.classList.contains("is-clone")
  );
  const dots = rail
    ? Array.from(rail.querySelectorAll("[data-profile-dot]")).filter((dot) => !dot.hidden)
    : [];

  // One page is not a pager. The rail goes with it rather than sitting there as
  // a single dot that does nothing.
  if (real.length < 2) {
    if (rail) rail.hidden = true;
    return null;
  }
  if (rail) rail.hidden = false;

  // The seam-free wrap. `aria-hidden` because it is page one a second time, and
  // a screen reader should be told about it once.
  const clone = real[0].cloneNode(true);
  clone.setAttribute("aria-hidden", "true");
  clone.classList.add("is-clone");
  clone.removeAttribute("data-collab");
  track.appendChild(clone);

  const self = {
    pager,
    track,
    card,
    dots,
    count: real.length,
    index: 0,
    timer: 0,
    visible: false,
    held: false,
    drag: null,
    observer: null,
    teardown: [],
  };

  const on = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    self.teardown.push(() => target.removeEventListener(type, handler, options));
  };

  function width() {
    return pager.clientWidth || 1;
  }

  function place(offset, animated) {
    track.style.transition = animated ? `transform ${SLIDE_MS}ms ${SLIDE_EASE}` : "none";
    track.style.transform = `translate3d(${offset}px, 0, 0)`;
  }

  function paintDots() {
    const live = self.index % self.count;
    for (let i = 0; i < self.dots.length; i++) {
      self.dots[i].classList.toggle("is-on", i === live);
      self.dots[i].setAttribute("aria-current", i === live ? "true" : "false");
    }
  }

  /** Land on `next`, which may be the clone (index === count). */
  function go(next, animated) {
    self.index = clamp(next, 0, self.count);
    place(-self.index * width(), animated !== false);
    paintDots();

    if (self.index !== self.count) return;
    // Arrived on the clone: become page one, in the frame AFTER the slide ends,
    // with the transition off so nothing travels back.
    const settle = () => {
      // Only if nothing has moved us since — a dot pressed mid-wrap has already
      // chosen a page, and settling on top of it would take it away again.
      if (self.index !== self.count) return;
      self.index = 0;
      place(0, false);
      // Read a layout value back so the untransitioned position is committed
      // before any later frame can put a transition on it again.
      void track.offsetWidth;
    };
    if (animated === false) return void settle();

    // A transition that never starts — a collapsed card, a reduced-motion
    // engine — would otherwise leave the pager parked on the clone forever.
    let guard = 0;
    const done = (event) => {
      if (event && event.target !== track) return;
      clearTimeout(guard);
      track.removeEventListener("transitionend", done);
      settle();
    };
    guard = setTimeout(done, SLIDE_MS + 120);
    track.addEventListener("transitionend", done);
  }

  function advance() {
    go(self.index + 1);
  }

  function stop() {
    if (self.timer) clearInterval(self.timer);
    self.timer = 0;
  }

  function start() {
    stop();
    if (!self.visible || self.held || document.hidden) return;
    self.timer = setInterval(advance, DWELL_MS);
  }

  function hold(on) {
    self.held = on;
    if (on) stop();
    else start();
  }

  // ── viewport membership ────────────────────────────────────────────────────
  self.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        self.visible = entry.isIntersecting && entry.intersectionRatio >= 0.99;
      }
      start();
    },
    { threshold: [0, 0.99, 1] }
  );
  self.observer.observe(pager);

  // ── the dots ───────────────────────────────────────────────────────────────
  self.dots.forEach((dot, i) => {
    on(dot, "click", () => {
      // Never sideways through the pages in between: a dot is a destination.
      go(i);
      start();
    });
    on(dot, "focus", () => hold(true));
    on(dot, "blur", () => hold(false));
  });

  // The whole CARD, not just the track: the dots sit outside the pager, and a
  // pointer resting on them is a reader deciding which page to open.
  const hoverTarget = self.card || pager;
  on(hoverTarget, "pointerenter", () => hold(true));
  on(hoverTarget, "pointerleave", () => hold(false));
  on(document, "visibilitychange", start);

  // ── dragging ───────────────────────────────────────────────────────────────
  on(pager, "pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    // Mid-wrap: the clone is on screen and the settle has not run yet. Taking
    // the drag now would start it from a position about to be replaced.
    if (self.index === self.count) return;
    self.drag = { x: event.clientX, y: event.clientY, dx: 0, moved: false, id: event.pointerId };
    hold(true);
  });

  on(pager, "pointermove", (event) => {
    const drag = self.drag;
    if (!drag || drag.id !== event.pointerId) return;
    drag.dx = event.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(drag.dx) < DRAG_SLOP) return;
      // A gesture that is mostly vertical belongs to the page, not to this.
      if (Math.abs(drag.dx) < Math.abs(event.clientY - drag.y)) {
        self.drag = null;
        hold(false);
        return;
      }
      drag.moved = true;
      pager.setPointerCapture(event.pointerId);
      pager.classList.add("is-dragging");
    }
    // Resistance at both ends, so the first and last page feel like ends.
    const span = width();
    let travel = drag.dx;
    if ((self.index === 0 && travel > 0) || (self.index === self.count - 1 && travel < 0)) {
      travel *= 0.35;
    }
    place(-self.index * span + travel, false);
  });

  function release(event) {
    const drag = self.drag;
    if (!drag || drag.id !== event.pointerId) return;
    self.drag = null;
    if (drag.moved) {
      pager.classList.remove("is-dragging");
      if (pager.hasPointerCapture(event.pointerId)) pager.releasePointerCapture(event.pointerId);
      const past = Math.abs(drag.dx) / width() > COMMIT;
      go(self.index + (past ? (drag.dx < 0 ? 1 : -1) : 0));
    }
    hold(false);
  }

  on(pager, "pointerup", release);
  on(pager, "pointercancel", release);

  // A card whose column changed width has to re-land on its page, in pixels
  // measured now — the track is translated by a length, not by a percentage,
  // because a percentage of a flex track is not a percentage of one page.
  const resize = new ResizeObserver(() => place(-self.index * width(), false));
  resize.observe(pager);
  self.teardown.push(() => resize.disconnect());

  place(0, false);
  paintDots();
  return self;
}

function dispose() {
  for (const self of instances) {
    if (self.timer) clearInterval(self.timer);
    if (self.observer) self.observer.disconnect();
    for (const off of self.teardown) off();
  }
  instances = [];
  // The wrap clone belongs to the pass that made it. Left behind, a re-init
  // after the vault pass would clone page one again and again.
  document.querySelectorAll("[data-profile-track] > .is-clone").forEach((node) => node.remove());
  document.querySelectorAll("[data-profile-track]").forEach((track) => {
    track.style.transition = "none";
    track.style.transform = "translate3d(0, 0, 0)";
  });
}

/**
 * Build, or rebuild. Called again by plugins/vault.js once a reader's grants
 * have changed which pages have anything to say.
 */
export default function initProfilePager() {
  dispose();
  const pagers = document.querySelectorAll("[data-profile-pager]");
  for (const pager of pagers) {
    const self = build(pager);
    if (self) instances.push(self);
  }
}
