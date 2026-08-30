import { requestScrollPass, invalidateMetrics } from "../tools/scrollScheduler.js";
import initAutoHover, { syncHomeAutoHover } from "./autoHover.js";
import initBentoFit, { syncBentoFit } from "./bentoFit.js";
import initTileSpotlight from "./tileSpotlight.js";
import initCoverParallax, {
  setCoverParallaxSuspended,
  syncCoverParallax,
} from "./coverParallax.js";
import { refreshHomeRelativeTime } from "../utils.js";
import { initNotoAnim } from "../plugins/noto-anim.js";

/**
 * Redefine-X — in-document home pagination.
 *
 * Both modes swap CARDS inside the current document; neither one loads a new
 * page. The banner, the sidebar, the player and the instant-notes panel are
 * never torn down and rebuilt, which is the whole point: paging is a change of
 * content, not a change of place.
 *
 *   paged      Page buttons. The visible cards flip away, the list is replaced
 *              while every one of them is edge-on, the view returns to the top
 *              of the list, and the new cards flip back in. The URL is kept in
 *              step with history.pushState, so refresh, sharing and
 *              back/forward all behave normally.
 *
 *   load_more  One button that appends the next page underneath the current
 *              cards, growing the list — and therefore the footer — on an
 *              easing curve rather than in one jump.
 *
 * Cards always come from the server-rendered `/page/N/` document, parsed out of
 * the fetched HTML. Tier resolution, cover selection, excerpt budgets and the
 * running index numeral therefore have exactly ONE implementation — the
 * template — instead of a second, drifting copy in JavaScript.
 *
 * Swup: the pagination element carries `data-no-swup`, so swup's `ignoreVisit`
 * default leaves those links alone. Our history entries are stamped with a
 * source that is deliberately not "swup", so swup's default
 * `skipPopStateHandling` leaves those alone too.
 */

const HISTORY_SOURCE = "redefine-home-pagination";
const PAGE_TOKEN = "__PAGE__";

const FLIP_OUT_MS = 280;
const FLIP_IN_MS = 420;
const FLIP_STAGGER_MS = 42;
// Total stagger budget for one direction of the flip. The per-card delay is
// squeezed to fit this, so a page of ten cards is not five times slower to turn
// than a page of two.
const STAGGER_BUDGET = 190;

// The flip is allowed to start before the scroll has stopped: waiting for a dead
// halt turns one page-turn into two consecutive waits. Once the remaining
// distance is under this much of a viewport, the cards that will be on screen
// when it lands are already on screen, so flipping them reads as one motion.
const SCROLL_OVERLAP_VIEWPORTS = 0.6;

const EASE_FLIP_OUT = "cubic-bezier(0.55, 0, 0.78, 0.25)";
const EASE_FLIP_IN = "cubic-bezier(0.16, 0.84, 0.28, 1)";

const state = {
  root: null,
  list: null,
  container: null,
  mode: "paged",
  current: 1,
  total: 1,
  firstUrl: "/",
  pageUrlTemplate: "",
  pageMatcher: null,
  cache: new Map(),
  busy: false,
  globalWired: false,
};

/**
 * Encrypted posts, if this reader has any, are not in the markup the server
 * sends for a page — plugins/vault.js registers here so the arrangement it holds
 * can be folded into a page turn instead of landing as a second, visible reflow
 * after it.
 *
 * Two steps rather than one, deliberately. The hook is AWAITED while the
 * previous page is still on screen and returns a SYNCHRONOUS applier, which runs
 * on the incoming list while it is still off-document. Doing the fetching after
 * the insertion would hand the browser a paint in which the new cards are flat,
 * visible, and about to be flipped.
 */
let vaultHook = null;

export function setHomeVaultHook(fn) {
  vaultHook = fn;
}

async function prepareVault(list) {
  if (!vaultHook) return null;
  try {
    return await vaultHook(list);
  } catch (e) {
    return null;
  }
}

export default function initHomePagination() {
  const root = document.querySelector(".home-pagination");
  const list = document.querySelector(".home-article-list");
  const container = document.querySelector(".home-content-container");

  if (!root || !list || !container) {
    state.root = null;
    state.list = null;
    state.container = null;
    return;
  }

  state.root = root;
  state.list = list;
  state.container = container;
  readDataset(root);

  // A fresh document means fresh markup for every page; the old HTML strings
  // are no longer guaranteed to match.
  state.cache.clear();

  if (root.dataset.paginationWired !== "1") {
    root.dataset.paginationWired = "1";
    root.addEventListener("click", onRootClick);
  }

  if (!state.globalWired) {
    state.globalWired = true;
    window.addEventListener("popstate", onPopState);
  }

  prefetchNeighbours(state.current);
}

function readDataset(root) {
  const d = root.dataset;
  state.mode = d.mode === "load_more" ? "load_more" : "paged";
  state.current = Number(d.current) || 1;
  state.total = Number(d.total) || 1;
  state.firstUrl = d.firstUrl || "/";
  state.pageUrlTemplate = d.pageUrl || "";
  state.pageMatcher = buildPageMatcher(state.firstUrl, state.pageUrlTemplate);
}

/* ─── URLs ─────────────────────────────────────────────────────────────────── */

function urlForPage(n) {
  if (n <= 1) return state.firstUrl;
  return state.pageUrlTemplate.replace(PAGE_TOKEN, String(n));
}

function buildPageMatcher(firstUrl, template) {
  if (!template) return null;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    first: new RegExp("^" + escape(trimSlash(firstUrl)) + "/?$"),
    page: new RegExp("^" + escape(trimSlash(template)).replace(PAGE_TOKEN, "(\\d+)") + "/?$"),
  };
}

function trimSlash(url) {
  return String(url).replace(/\/+$/, "");
}

/** Page number for a same-origin path, or null if it is not a home URL. */
function pageFromPath(pathname) {
  if (!state.pageMatcher) return null;
  const path = trimSlash(pathname);
  const hit = state.pageMatcher.page.exec(path);
  if (hit) return Number(hit[1]);
  if (state.pageMatcher.first.test(path)) return 1;
  return null;
}

/* ─── Events ───────────────────────────────────────────────────────────────── */

function onRootClick(event) {
  if (state.mode === "load_more") {
    const button = event.target.closest(".home-load-more");
    if (!button) return;
    event.preventDefault();
    loadMore();
    return;
  }

  const link = event.target.closest("a[href]");
  if (!link || !state.root.contains(link)) return;
  if (link.target === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
    return;
  }

  let target;
  try {
    target = new URL(link.href, location.href);
  } catch (e) {
    return;
  }
  if (target.origin !== location.origin) return;

  const n = pageFromPath(target.pathname);
  if (n === null) return;

  // Only now is this ours to handle; anything else keeps its normal behaviour.
  event.preventDefault();
  goToPage(n, { push: true });
}

function onPopState(event) {
  if (!state.root || state.mode !== "paged") return;
  // Entries swup pushed belong to swup; it will navigate for real.
  if (event.state && event.state.source === "swup") return;

  const n = pageFromPath(location.pathname);
  if (n === null || n === state.current) return;
  goToPage(n, { push: false });
}

/* ─── Fetching ─────────────────────────────────────────────────────────────── */

async function fetchPage(n) {
  if (state.cache.has(n)) return state.cache.get(n);

  const response = await fetch(urlForPage(n), {
    credentials: "same-origin",
    headers: { "X-Requested-With": "redefine-pagination" },
  });
  if (!response.ok) throw new Error(`page ${n} responded ${response.status}`);

  const doc = new DOMParser().parseFromString(await response.text(), "text/html");
  const list = doc.querySelector(".home-article-list");
  if (!list) throw new Error(`page ${n} has no article list`);

  // Parsed in an inert document, so nothing is fetched until the nodes are
  // actually adopted — no cover is downloaded twice.
  const payload = { list, pagination: doc.querySelector(".home-pagination") };
  state.cache.set(n, payload);
  return payload;
}

function prefetchNeighbours(n) {
  const wanted = [n + 1, n - 1].filter((p) => p >= 1 && p <= state.total && !state.cache.has(p));
  if (!wanted.length) return;
  const run = () => wanted.forEach((p) => fetchPage(p).catch(() => {}));
  if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 2500 });
  else setTimeout(run, 600);
}

/* ─── Paged mode ───────────────────────────────────────────────────────────── */

async function goToPage(n, options) {
  if (state.busy || n === state.current || n < 1 || n > state.total) return;

  state.busy = true;
  state.root.setAttribute("aria-busy", "true");

  // Started together on purpose: the next and previous pages are prefetched, so
  // the fetch has usually already resolved, and when it has not its latency
  // hides underneath the scroll instead of adding to it.
  const scroll = scrollToListTop();

  let payload;
  try {
    payload = await fetchPage(n);
  } catch (err) {
    // A failed fetch must not strand the reader on a page they tried to leave.
    console.error("[homePagination] falling back to a full navigation:", err);
    window.location.href = urlForPage(n);
    return;
  }

  const applyVault = await prepareVault(payload.list);

  // Not `scroll.finished`: the two motions overlap.
  await scroll.overlap;

  try {
    await flipToPage(payload, n, options, scroll, applyVault);
  } finally {
    state.busy = false;
    state.root.removeAttribute("aria-busy");
  }
}

async function flipToPage(payload, n, options, scroll, applyVault) {
  const animate = !prefersReducedMotion();

  // The scroll is something the reader WATCHES, and it starts before anything
  // flips — doing it the other way round (flip, then jump) moves the paginator,
  // the sidebar and the footer at the one moment the cards are edge-on and
  // cannot cover for it, which is the seam this transition exists to avoid.
  //
  // It has not necessarily FINISHED yet, though, so "visible" has to mean
  // visible when it lands rather than visible right now. Layout does not change
  // while the page scrolls, so where each card ends up is just its current rect
  // shifted by the distance still to travel.
  const remaining = scroll.target - window.scrollY;
  const oldCards = animate ? cardsInViewport(state.list, remaining) : [];

  // A rotating card's bounding box is its squashed projection, which the cover
  // parallax would happily read as "this cover has 400px of crop to travel".
  // It stops looking until the cards are flat again.
  setCoverParallaxSuspended(true);
  try {
    await swapAndFlipIn(payload, n, options, oldCards, animate, scroll, applyVault);
  } finally {
    // Never leave the parallax switched off, whatever went wrong in between.
    setCoverParallaxSuspended(false);
  }

  prefetchNeighbours(n);
}

async function swapAndFlipIn(payload, n, options, oldCards, animate, scroll, applyVault) {
  if (oldCards.length) await runFlip(oldCards, "out");

  // The out-flip normally outlasts the tail of the scroll, but nothing may be
  // measured or replaced until the viewport has actually stopped.
  await scroll.finished;

  // ── The swap, performed while every visible card is edge-on ───────────────
  // This is what makes the tier layouts interchangeable. A page of
  // [wide, standard, standard] becoming [standard, compact, wide, standard] is
  // a completely different grid with a different height, and none of it is ever
  // seen mid-morph — there is nothing on screen to morph. No geometry has to be
  // paired up, measured or interpolated between the two layouts.
  const incoming = document.importNode(payload.list, true);

  // Still off-document, so the reflow costs nothing and is never seen.
  if (applyVault) {
    try {
      applyVault(incoming);
    } catch (e) {
      console.error("[homePagination] the encrypted arrangement did not apply:", e);
    }
  }

  // Tiles carry a scroll-driven entrance animation, and a freshly inserted tile
  // is at the start of its range. Left on, it would hold every card at opacity 0
  // underneath the flip and drive `translate` while the flip drives `transform`.
  // The class switches it off for the length of the turn; by the time it comes
  // off, the cards on screen are past their entry range and resolve to the end
  // state, and the ones below still animate when they are scrolled to.
  if (animate) incoming.classList.add("is-flipping");

  state.list.replaceWith(incoming);
  state.list = incoming;

  if (payload.pagination) adoptPagination(payload.pagination, n);
  state.current = n;

  // Re-anchor rather than re-scroll: a shorter page can leave the offset we
  // were sitting at unreachable, in which case the browser has already clamped
  // it. This is a correction of at most a few pixels, made while every card is
  // still edge-on.
  anchorListTop();
  // A different mix of tiers is a different total height, so the cached document
  // metrics behind the progress bar are stale the moment the list is swapped.
  settleMetrics();
  if (!options || options.push !== false) pushPageState(n);

  refreshHomeRelativeTime();
  initNotoAnim();

  // Everything from here to the flip runs in ONE task, with no await between
  // the insertion and the priming, so the browser never gets a rendering
  // opportunity while the new cards are flat. That window is what lets the
  // covers be measured with honest geometry — and measuring them here rather
  // than after the flip is what stops every cover jumping into its parallax
  // offset the instant the cards land.
  //
  // The fit goes first and synchronously: a different set of posts is a
  // different cell height, and every cover's frame is a fraction of it.
  //
  // Everything a card's LANDED state depends on is settled in here too, while
  // it is still flat: the lift the centre band gives it, and the rim light. Left
  // until after the flip they would arrive a frame late, on cards that have just
  // stopped moving, and read as a card spontaneously growing.
  let entering = [];
  initBentoFit();
  syncBentoFit();
  initCoverParallax();
  syncCoverParallax();
  initAutoHover();
  syncHomeAutoHover();
  initTileSpotlight();
  if (animate) {
    entering = cardsInViewport(state.list);
    entering.forEach((card) => primeForFlipIn(card));
  }

  if (entering.length) await runFlip(entering, "in");

  // A card that flipped in has HAD its entrance. Without this the scroll-driven
  // one reattaches the moment `is-flipping` comes off, and every card still
  // inside its entry range — anything low in the viewport — drops back to a
  // partial opacity it has no way to explain. Cards below the fold are
  // untouched and still animate when they are scrolled to.
  entering.forEach((card) => card.classList.add("has-entered"));

  state.list.classList.remove("is-flipping");
  settleMetrics();
}

function adoptPagination(incoming, n) {
  state.root.innerHTML = incoming.innerHTML;
  // The fetched markup describes the page it came from; only the counters move.
  state.root.dataset.current = String(n);
}

function pushPageState(n) {
  const url = urlForPage(n);
  try {
    history.pushState({ source: HISTORY_SOURCE, page: n }, "", url);
    // Swup keeps its own idea of where the reader is. Left stale, its
    // "link to self" check would swallow a later click on the Home link while
    // we are sitting on page 3.
    if (window.swup && typeof window.swup.currentPageUrl === "string") {
      window.swup.currentPageUrl = url;
    }
  } catch (e) {
    /* history is unavailable (file://, sandbox) — paging still works */
  }
}

/** Where the list's top edge should sit: just clear of the navbar. */
function listTopOffset() {
  const top = state.container.getBoundingClientRect().top + window.scrollY;
  const navbar = document.querySelector(".navbar");
  const offset = (navbar ? navbar.getBoundingClientRect().height : 70) + 16;
  return Math.max(0, top - offset);
}

function anchorListTop() {
  window.scrollTo({ top: listTopOffset(), behavior: "auto" });
}

/**
 * Animated scroll back to the top of the list. Deliberately not
 * `behavior: "smooth"`: the browser picks that duration from the distance, so
 * turning a page from the bottom of a long list would take twice as long as
 * from halfway down. A fixed curve makes the page turn feel like one gesture
 * whatever the reader's scroll position was. The banner is left above, so
 * carrying on upwards still reaches the top of the site.
 *
 * Returns two promises rather than one. `overlap` resolves early, as soon as the
 * cards that will be on screen at the end have arrived on screen — that is when
 * the flip may begin. `finished` resolves when the viewport has actually
 * stopped, which is when it becomes safe to measure and replace anything.
 */
function scrollToListTop() {
  const target = listTopOffset();
  const startY = window.scrollY;
  const delta = target - startY;

  let resolveOverlap;
  let resolveFinished;
  const overlap = new Promise((r) => (resolveOverlap = r));
  const finished = new Promise((r) => (resolveFinished = r));
  const handle = { target, overlap, finished };

  if (Math.abs(delta) < 2 || prefersReducedMotion()) {
    window.scrollTo({ top: target, behavior: "auto" });
    resolveOverlap();
    resolveFinished();
    return handle;
  }

  const duration = Math.min(700, Math.max(320, Math.abs(delta) * 0.35));
  const started = performance.now();
  // easeInOutCubic — leaves and arrives at rest, so it reads as one movement
  // rather than a snap in either direction.
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const overlapDistance = window.innerHeight * SCROLL_OVERLAP_VIEWPORTS;
  let overlapped = false;

  function step(now) {
    const t = Math.min(1, (now - started) / duration);
    const y = startY + delta * ease(t);
    window.scrollTo({ top: y, behavior: "auto" });

    if (!overlapped && Math.abs(target - y) <= overlapDistance) {
      overlapped = true;
      resolveOverlap();
    }

    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      if (!overlapped) resolveOverlap();
      resolveFinished();
    }
  }
  requestAnimationFrame(step);

  return handle;
}

/* ─── The flip ─────────────────────────────────────────────────────────────── */
//
// Each card rotates about its own horizontal midline, with the perspective
// declared IN the card's own transform rather than on the list. A single
// `perspective` on a 4000px-tall list would give every card a different, wildly
// off-axis projection depending on how far it sat from the vanishing point;
// per-card perspective gives all of them the same one.
//
// Out runs 0deg -> -90deg and in runs +90deg -> 0deg, which is one continuous
// 180-degree rotation across the swap: the reader sees a card turn over, not a
// card leave and a different card arrive. Opacity only moves in the last tenth,
// where the card is already a hairline — enough to kill the anti-aliased edge,
// far too late to read as a fade.

const FLIP_OUT_FRAMES = [
  { offset: 0, transform: "perspective(1200px) translateZ(0px) rotateX(0deg)", filter: "brightness(1)", opacity: 1 },
  { offset: 0.55, transform: "perspective(1200px) translateZ(-30px) rotateX(-46deg)", filter: "brightness(0.86)", opacity: 1 },
  { offset: 0.9, transform: "perspective(1200px) translateZ(-54px) rotateX(-80deg)", filter: "brightness(0.72)", opacity: 1 },
  { offset: 1, transform: "perspective(1200px) translateZ(-60px) rotateX(-90deg)", filter: "brightness(0.7)", opacity: 0 },
];

const FLIP_IN_FRAMES = [
  { offset: 0, transform: "perspective(1200px) translateZ(-60px) rotateX(90deg)", filter: "brightness(0.7)", opacity: 0 },
  { offset: 0.1, transform: "perspective(1200px) translateZ(-56px) rotateX(80deg)", filter: "brightness(0.72)", opacity: 1 },
  { offset: 0.55, transform: "perspective(1200px) translateZ(-22px) rotateX(34deg)", filter: "brightness(0.9)", opacity: 1 },
  { offset: 1, transform: "perspective(1200px) translateZ(0px) rotateX(0deg)", filter: "brightness(1)", opacity: 1 },
];

export function primeForFlipIn(card) {
  card.style.willChange = "transform, opacity";
  card.style.backfaceVisibility = "hidden";
  card.style.transform = "perspective(1200px) translateZ(-60px) rotateX(90deg)";
  card.style.opacity = "0";
}

function clearFlipStyles(card) {
  card.style.willChange = "";
  card.style.backfaceVisibility = "";
  card.style.transform = "";
  card.style.opacity = "";
  card.style.filter = "";
}

export function runFlip(cards, direction) {
  if (!cards.length) return Promise.resolve();

  const frames = direction === "out" ? FLIP_OUT_FRAMES : FLIP_IN_FRAMES;
  const duration = direction === "out" ? FLIP_OUT_MS : FLIP_IN_MS;
  const easing = direction === "out" ? EASE_FLIP_OUT : EASE_FLIP_IN;
  const stagger =
    cards.length > 1
      ? Math.min(FLIP_STAGGER_MS, Math.round(STAGGER_BUDGET / (cards.length - 1)))
      : 0;

  const running = cards.map((card, i) => {
    card.style.willChange = "transform, opacity";
    card.style.backfaceVisibility = "hidden";
    return card.animate(frames, {
      duration,
      delay: i * stagger,
      easing,
      fill: "both",
    });
  });

  return Promise.all(running.map((a) => a.finished.catch(() => {}))).then(() => {
    if (direction !== "in") return;
    // Order matters and both halves must land in the same turn: `fill: both`
    // keeps the animation's end state applied until it is cancelled, and the
    // inline styles underneath it still say "edge-on". Clearing first, then
    // cancelling, means neither state is ever the one that gets painted.
    cards.forEach((card) => clearFlipStyles(card));
    running.forEach((a) => a.cancel());
  });
}

/**
 * @param shift  pixels the page has still to scroll; the cards are selected by
 *               where they will be once it has, not by where they are now.
 *
 * The site cards turn with everything else. They carry the same content on
 * every page, so there was a case for holding them still — but a band of tiles
 * rotating around two that do not read as two tiles that failed to animate, not
 * as furniture, and the eye goes straight to them.
 */
export function cardsInViewport(list, shift) {
  const viewportH = window.innerHeight;
  const offset = shift || 0;
  const tiles = list.querySelectorAll(".home-article-item, .home-feature-tile");
  return Array.from(tiles).filter((card) => {
    const rect = card.getBoundingClientRect();
    const top = rect.top - offset;
    return top + rect.height > 0 && top < viewportH;
  });
}

/* ─── Load-more mode ───────────────────────────────────────────────────────── */

async function loadMore() {
  if (state.busy || state.current >= state.total) return;
  const next = state.current + 1;

  state.busy = true;
  setButtonBusy(true);

  try {
    const payload = await fetchPage(next);
    const applyVault = await prepareVault(payload.list);
    const incoming = document.importNode(payload.list, true);
    if (applyVault) {
      try {
        applyVault(incoming);
      } catch (e) {
        console.error("[homePagination] the encrypted arrangement did not apply:", e);
      }
    }
    const cards = Array.from(incoming.children);
    shiftRows(cards, incoming);
    await appendCards(cards);

    state.current = next;
    state.root.dataset.current = String(next);

    refreshHomeRelativeTime();
    initNotoAnim();
    initAutoHover();
    initTileSpotlight();
    // Same order as the flip: the appended tiles are part of the same grid, so
    // the cell height is re-fitted over the whole of it before any cover is
    // measured against it.
    initBentoFit();
    syncBentoFit();
    initCoverParallax();
    settleMetrics();

    if (state.current >= state.total) await retireButton();
    prefetchNeighbours(next);
  } catch (err) {
    console.error("[homePagination] could not load the next page:", err);
    state.root.dataset.loadError = "1";
  } finally {
    state.busy = false;
    setButtonBusy(false);
  }
}

/**
 * Every tile carries the grid row it was planned into, counted from the top of
 * its OWN page (scripts/helpers/bento-helpers.js) — which is the only thing that
 * lets a row be sized from the tiles standing in it. Appending a page into the
 * grid already on screen therefore has to move its rows past the ones already
 * there, or page 2 is laid over page 1.
 *
 * Both grids are shifted, not just the live one: the reader can turn the window
 * from three columns to two after appending, and the two have different row
 * counts for the same posts.
 */
function shiftRows(cards, incoming) {
  const list = state.list;
  const offset = { lg: Number(list.dataset.lgRows) || 0, md: Number(list.dataset.mdRows) || 0 };
  if (!offset.lg && !offset.md) return;

  for (const card of cards) {
    for (const grid of ["lg", "md"]) {
      const row = Number(card.style.getPropertyValue("--" + grid + "-rs"));
      if (row > 0) card.style.setProperty("--" + grid + "-rs", String(row + offset[grid]));
    }
  }

  list.dataset.lgRows = String(offset.lg + (Number(incoming.dataset.lgRows) || 0));
  list.dataset.mdRows = String(offset.md + (Number(incoming.dataset.mdRows) || 0));
}

async function appendCards(cards) {
  if (!cards.length) return;
  const list = state.list;

  // Same reason as the flip: the appended cards have their own reveal, and the
  // scroll-driven entrance would be a second one running against it. Every card
  // appended here runs that reveal whether or not it is on screen, so every one
  // of them is marked as having entered before the switch goes back on.
  list.classList.add("is-flipping");
  cards.forEach((card) => card.classList.add("has-entered"));

  await animateHeight(list, () => {
    cards.forEach((card) => list.appendChild(card));
    // Transform and opacity only, so these never feed back into the height
    // being measured around them. `backwards` fill holds the start state during
    // the delay, so nothing flashes at full opacity before its turn.
    cards.forEach((card, i) =>
      card.animate(
        [
          { opacity: 0, transform: "translateY(18px) scale(0.985)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 460, delay: 90 + i * 70, easing: EASE_FLIP_IN, fill: "backwards" },
      ),
    );
  });

  list.classList.remove("is-flipping");
}

async function retireButton() {
  const button = state.root.querySelector(".home-load-more");
  const end = state.root.querySelector(".home-load-more-end");
  if (!button && !end) return;

  await animateHeight(state.root, () => {
    if (button) button.remove();
    if (end) {
      end.hidden = false;
      end.animate(
        [
          { opacity: 0, transform: "translateY(8px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 420, delay: 80, easing: EASE_FLIP_IN, fill: "backwards" },
      );
    }
  });
}

function setButtonBusy(busy) {
  const button = state.root.querySelector(".home-load-more");
  if (!button) return;
  button.classList.toggle("is-busy", busy);
  button.disabled = busy;
  button.setAttribute("aria-busy", busy ? "true" : "false");
}

/**
 * Run `mutate`, then animate the element from the height it had to the height it
 * now wants. Everything below — the button, the paginator, the footer — travels
 * on the same curve instead of snapping to the new position.
 */
export async function animateHeight(element, mutate, duration = 420) {
  // The height is pinned BEFORE mutating. Appending first and animating
  // afterwards leaves one frame rendered at the full new height before the
  // animation's first sample pulls it back — that frame is the visible lurch
  // when Load more is pressed.
  const start = element.getBoundingClientRect().height;
  element.style.height = start + "px";
  // Held for the duration: without it the not-yet-revealed cards spill past the
  // constrained height and overlap whatever sits below.
  element.style.overflow = "hidden";

  mutate();

  element.style.height = "";
  const end = element.getBoundingClientRect().height;

  if (prefersReducedMotion() || Math.abs(end - start) < 1) {
    element.style.overflow = "";
    settleMetrics();
    return;
  }

  element.style.height = start + "px";

  await new Promise((resolve) => {
    const started = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    function step(now) {
      const t = Math.min(1, (now - started) / duration);
      element.style.height = start + (end - start) * ease(t) + "px";
      settleMetrics();
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });

  element.style.height = "";
  element.style.overflow = "";
  settleMetrics();
}

/**
 * The document just changed height, and nothing else notices: `html` is 100%
 * tall, so the scheduler's ResizeObserver never fires on content growth, and its
 * cached `scrollHeight` is what the progress bar and the scroll percentage are
 * computed from. Left alone they keep quoting the height from before the click.
 */
function settleMetrics() {
  invalidateMetrics();
  requestScrollPass();
}

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {
    return false;
  }
}
