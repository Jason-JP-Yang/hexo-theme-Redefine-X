import { onScroll, requestScrollPass } from '../tools/scrollScheduler.js';

// initBookmarkNav() runs on every Swup page:view AND from main.refresh(), and it
// used to attach a fresh throttled window scroll listener each time — two more
// permanent listeners per navigation, each re-reading offsetTop/offsetHeight for
// every section (a forced layout) and rewriting classes on every nav item.
// The subscription below is registered once; `state` is swapped per page.
let state = null;
let wired = false;

export default function initBookmarkNav() {
  const navItems = document.querySelectorAll('.bookmark-nav-item');
  const sections = document.querySelectorAll('section[id]');

  if (!navItems.length || !sections.length) {
    state = null;
    return;
  }

  // Section geometry is measured once per page (and on resize), not per frame.
  const bounds = Array.from(sections).map(section => ({
    id: section.getAttribute('id'),
    top: section.offsetTop,
    height: section.offsetHeight,
  }));

  state = { navItems, bounds, activeId: undefined, pendingId: undefined };

  function setActiveNavItem() {
    readActive(window.scrollY);
    writeActive();
  }

  // // Handle click events on nav items
  // navItems.forEach(item => {
  //   item.addEventListener('click', (e) => {
  //     e.preventDefault();
  //     const targetId = item.getAttribute('data-category');
  //     const targetSection = document.getElementById(targetId);
  //     if (targetSection) {
  //       targetSection.scrollIntoView();
  //     }
  //   });
  // });

  if (!wired) {
    wired = true;
    onScroll(
      (m) => readActive(m.scrollY),
      writeActive,
      'bookmarkNav',
    );
  }

  // Initial check
  setActiveNavItem();
  requestScrollPass();
}

// READ phase: pure arithmetic against the cached section bounds.
function readActive(scrollY) {
  if (!state) return;
  const fromTop = scrollY + 100;
  let currentId = null;
  for (const b of state.bounds) {
    if (fromTop >= b.top && fromTop < b.top + b.height) currentId = b.id;
  }
  state.pendingId = currentId;
}

// WRITE phase: only touches the DOM when the active section actually changed.
function writeActive() {
  if (!state || state.pendingId === state.activeId) return;
  state.activeId = state.pendingId;
  state.navItems.forEach(item => {
    item.classList.toggle(
      'bg-second-background-color',
      state.activeId !== null && item.getAttribute('data-category') === state.activeId,
    );
  });
}

window.addEventListener('resize', () => {
  // Section offsets moved — re-measure rather than reading them every frame.
  if (state) initBookmarkNav();
}, { passive: true });

try {
  swup.hooks.on("page:view", initBookmarkNav);
} catch (e) {}

document.addEventListener("DOMContentLoaded", initBookmarkNav);
