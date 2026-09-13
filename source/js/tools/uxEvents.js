/**
 * Custom events, on a budget.
 *
 * WHY NOT `data-umami-event`
 * ─────────────────────────
 * Umami's tracker carries its own click handler, and it fires on EVERY match.
 * Six clicks on the dark-mode toggle are six events. There is no throttle in it
 * and no place to put one, so a site that marks up its controls honestly ends up
 * with an Events table dominated by whoever fidgeted the most.
 *
 * So the theme marks its controls with `data-ux` instead, and this file decides
 * what actually gets sent. One delegated capture listener for the whole page,
 * one budget per pageview, cleared by main.refresh() — which runs on load and on
 * every swup navigation, i.e. exactly once per pageview Umami records.
 *
 * THE TAXONOMY
 * ────────────
 * Eight names. The category is the NAME; what was clicked is DATA. `nav` with
 * `{to: "archive"}` rather than a `nav-archive` event, because a name per link
 * makes an Events table nobody can read and an event-data table nobody needs.
 *
 *   nav          navbar, drawer, logo, submenu
 *   open-post    a post opened FROM A LIST — home, archive, category, tag,
 *                search, recommendations, vault. `from` says which.
 *   browse       a listing surface used: category, tag, archive, links, masonry
 *   tool         side tools and post tools
 *   post-action  clickable things inside an article
 *   engage       ONCE per pageview: this reader actually read the page
 *   search       the local search was used
 *   social       an outbound link: social icon, friend link, RSS, follow
 *
 * THE BUDGET
 * ──────────
 * A typical visit spends `nav` + `open-post` + `engage` and stops at three. The
 * caps below are what make that a guarantee rather than an expectation: per-name
 * limits first, then a hard ceiling on the pageview as a whole.
 */

import { onScroll } from "./scrollScheduler.js";

// How many of each name may be sent in one pageview. A navigation ends the
// pageview anyway, so the ones worth capping are the ones that do not.
const CAPS = {
  nav: 1,
  "open-post": 1,
  browse: 1,
  tool: 2,
  "post-action": 2,
  engage: 1,
  search: 1,
  social: 1,
};

// Whatever the per-name caps allow, a single pageview never sends more than
// this. It is the backstop for a taxonomy that grows later without the budget
// being revisited.
const CEILING = 6;

// What counts as having read the page: both, not either. Thirty seconds with no
// scrolling is a tab left open; half the page in three seconds is a scroll to
// the comments.
const ENGAGE_MS = 30000;
const ENGAGE_DEPTH = 50;

let spent = null;
let total = 0;
let wired = false;
let unsubscribe = null;
let clock = null;
let deepest = 0;
let startedAt = 0;

/* ─── sending ─────────────────────────────────────────────────────────────── */

function enabled() {
  const a = (window.theme && window.theme.analytics) || {};
  return a.enable === true && a.events !== false && !window.__umamiFramed;
}

function send(name, data) {
  if (!enabled() || total >= CEILING) return;

  const cap = CAPS[name] || 1;
  const used = spent.get(name) || 0;
  if (used >= cap) return;

  const umami = window.umami;
  if (!umami || typeof umami.track !== "function") return;

  spent.set(name, used + 1);
  total++;
  try {
    umami.track(name, data);
  } catch {}
}

/* ─── clicks ──────────────────────────────────────────────────────────────── */

/**
 * `data-ux="name"` plus `data-ux-<key>="value"` for the payload.
 *
 * Read off the closest marked ancestor, so a control can be marked once on its
 * wrapper and every icon and label inside it inherits the mark.
 */
function payload(el) {
  const data = {};
  for (const attr of el.attributes) {
    if (attr.name.startsWith("data-ux-")) {
      data[attr.name.slice(8)] = attr.value;
    }
  }
  return data;
}

/**
 * What a reader did INSIDE an article, matched by selector rather than by an
 * attribute on the element.
 *
 * These controls are built by the theme's own scripts at runtime — the copy
 * button, the image viewer's targets, a folding block's summary — so there is no
 * template to mark. Matching them here keeps the taxonomy in one file instead of
 * scattering `setAttribute` calls through five unrelated modules.
 */
const IN_ARTICLE = [
  [".copy-button", "copy"],
  [".markdown-body img, .markdown-body .img-preloader", "image"],
  [".markdown-body .folding > summary, .markdown-body .tabs .tab", "disclose"],
  [".markdown-body a[href]", "link"],
];

function inArticle(target) {
  if (!target.closest(".article-content, .markdown-body")) return null;

  for (const [selector, kind] of IN_ARTICLE) {
    const el = target.closest(selector);
    if (!el) continue;
    // An in-article link that leaves the site is worth telling apart from one
    // that moves around inside it; both are one event either way.
    if (kind === "link") {
      const href = el.getAttribute("href") || "";
      if (href.startsWith("#")) return { kind: "anchor" };
      const external = /^https?:\/\//i.test(href) && !href.startsWith(location.origin);
      return { kind: external ? "external" : "link" };
    }
    return { kind };
  }
  return null;
}

function onClick(e) {
  // Modifier and middle clicks open a new tab: the reader is collecting links,
  // not navigating, and counting those as `open-post` inflates every list.
  if (e.button > 1 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

  const target = e.target && e.target.closest ? e.target : null;
  if (!target) return;

  const el = target.closest("[data-ux]");
  if (!el) {
    const hit = inArticle(target);
    if (hit) send("post-action", hit);
    return;
  }

  const name = el.getAttribute("data-ux");
  if (!name || !CAPS[name]) return;

  const data = payload(el);
  // A link's own href is the most useful thing about it and the one thing the
  // markup should never have to repeat.
  if (!data.to && el.tagName === "A" && el.getAttribute("href")) {
    data.to = el.getAttribute("href");
  }
  send(name, data);
}

/* ─── engagement ──────────────────────────────────────────────────────────── */

function bucket(pct) {
  if (pct >= 90) return 100;
  if (pct >= 70) return 75;
  if (pct >= 45) return 50;
  return 25;
}

function fireEngage() {
  if (!startedAt) return;
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  send("engage", {
    depth: bucket(deepest),
    // Bucketed, because the exact second is noise and a bucket is what any
    // question about reading time is actually asking.
    seconds: seconds >= 300 ? 300 : seconds >= 120 ? 120 : seconds >= 60 ? 60 : 30,
  });
  startedAt = 0;
}

function watchEngagement() {
  deepest = 0;
  startedAt = Date.now();

  // Read only: the depth is measured in the scheduler's read phase and nothing
  // is written back, which is what keeps this off the layout path entirely.
  unsubscribe = onScroll(
    (m) => {
      if (!startedAt || !m.docH) return;
      const pct = ((m.scrollY + m.viewportH) / m.docH) * 100;
      if (pct > deepest) deepest = Math.min(100, pct);
      if (deepest >= ENGAGE_DEPTH && Date.now() - startedAt >= ENGAGE_MS) fireEngage();
    },
    null,
    "uxEngage",
  );

  // A reader who never scrolls past the fold but stays is still a reader, as
  // long as the page had nothing more to show them.
  clock = setTimeout(() => {
    const doc = document.documentElement;
    const complete = doc.scrollHeight <= window.innerHeight * 1.2;
    if (complete || deepest >= ENGAGE_DEPTH) fireEngage();
  }, ENGAGE_MS);
}

/* ─── search ──────────────────────────────────────────────────────────────── */

/**
 * Called by the local search when a query resolves. Capped at one per pageview,
 * so a reader typing eight characters reports one search and not eight.
 */
export function trackSearch(hits) {
  const n = Number(hits) || 0;
  send("search", { hits: n === 0 ? 0 : n < 5 ? "1-4" : n < 20 ? "5-19" : "20+" });
}

/* ─── run ─────────────────────────────────────────────────────────────────── */

export default function initUxEvents() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  clearTimeout(clock);

  // Anything still owed from the page being left is owed now: swup replaces the
  // content without unloading, so `pagehide` never comes.
  if (startedAt) fireEngage();

  spent = new Map();
  total = 0;

  if (!enabled()) return;

  if (!wired) {
    wired = true;
    // Capture, so a handler that stops propagation on its own control cannot
    // silently remove it from the record.
    document.addEventListener("click", onClick, true);
    // The last pageview of a visit still has its reading to report.
    window.addEventListener("pagehide", () => {
      if (deepest >= ENGAGE_DEPTH) fireEngage();
    });
  }

  watchEngagement();
}
