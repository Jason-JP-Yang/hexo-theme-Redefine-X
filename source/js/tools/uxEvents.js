/**
 * Custom events, on a budget.
 *
 * WHY THESE EVENTS EXIST
 * ──────────────────────
 * Umami already counts pageviews, sessions, referrers and time. An event that
 * restates any of those is dead weight. What it cannot see is WHICH SURFACE of
 * the site a reader reached for — the same article opened from the home grid,
 * from a recommendation or from a tag page is one pageview either way, and the
 * navbar, the contents rail, the side tools and the two admin consoles leave no
 * trace at all. That, and only that, is what is recorded here.
 *
 * WHY NOT `data-umami-event`
 * ─────────────────────────
 * Umami's tracker carries its own click handler, and it fires on EVERY match.
 * Six clicks on the dark-mode toggle are six events. There is no throttle in it
 * and no place to put one, so a site that marks up its controls honestly ends up
 * with an Events table dominated by whoever fidgeted the most.
 *
 * So the theme marks its controls with `data-ux` and this file decides what
 * actually gets sent: one delegated capture listener for the whole page, one
 * budget per pageview, cleared by main.refresh() — which runs on load and on
 * every swup navigation, i.e. exactly once per pageview Umami records.
 *
 * THE TAXONOMY
 * ────────────
 * One name per SURFACE, spelled out, because the name is what an Events table
 * shows. What was clicked inside that surface is event data, never a new name:
 * "Use Navbar" with `{to: "archive"}` rather than a `nav-archive` event.
 */

// `data-ux` key → the name Umami records. The markup stays terse; the dashboard
// stays readable.
const NAMES = {
  "home-post": "Open Post from Home",
  recommend: "Open Post from Recommend",
  archives: "Browse Archives",
  categories: "Browse Categories",
  tags: "Browse Tags",
  nav: "Use Navbar",
  bento: "Use Bento Card",
  tool: "Use Side Tools",
  toc: "Use Table of Contents",
  image: "Open Image Viewer",
  editor: "Use Online Editor",
  manage: "Use Blog Management",
  external: "Open External Link",
  search: "Search Site",
};

// How many of each may be sent in one pageview. A navigation ends the pageview
// anyway, so the ones worth capping are the surfaces a reader stays on: the
// tools rail and the two consoles, where the session is one long page.
const CAPS = { tool: 2, editor: 2, manage: 2 };

// Whatever the per-name caps allow, a single pageview never sends more than
// this. It is the backstop for a taxonomy that grows later without the budget
// being revisited.
const CEILING = 4;

// A listing page opens posts too, and that click belongs to the listing rather
// than to a fourth "opened a post" name.
const LIST_SURFACE = {
  archive: "archives",
  category: "categories",
  tag: "tags",
};

// Surfaces built by the theme's own scripts at runtime, so there is no template
// to mark: the image viewer's targets, the contents rail, and the two consoles.
// Matching them here keeps the taxonomy in one file instead of scattering
// `setAttribute` calls through five unrelated modules.
const RUNTIME = [
  [
    ".markdown-body img, .markdown-body .img-preloader, .masonry-item img," +
      " .masonry-item .img-preloader, #shuoshuo-content img, #shuoshuo-content .img-preloader",
    "image",
  ],
  [".post-toc, .toc-content-container", "toc"],
  ['.article-content-container.is-editing, [class^="ed-"], [class*=" ed-"]', "editor"],
  ["#blog-management", "manage"],
];

let spent = null;
let total = 0;
let wired = false;

/* ─── sending ─────────────────────────────────────────────────────────────── */

function enabled() {
  const a = (window.theme && window.theme.backend && window.theme.backend.analytics) || {};
  return a.enable === true && a.events !== false && !window.__umamiFramed;
}

function send(key, data) {
  const name = NAMES[key];
  if (!name || !enabled() || total >= CEILING) return;

  const cap = CAPS[key] || 1;
  const used = spent.get(key) || 0;
  if (used >= cap) return;

  const umami = window.umami;
  if (!umami || typeof umami.track !== "function") return;

  spent.set(key, used + 1);
  total++;
  try {
    umami.track(name, data);
  } catch {}
}

/* ─── clicks ──────────────────────────────────────────────────────────────── */

/**
 * `data-ux="key"` plus `data-ux-<field>="value"` for the payload.
 *
 * Read off the closest marked ancestor, so a control can be marked once on its
 * wrapper and every icon and label inside it inherits the mark.
 */
function payload(el) {
  const data = {};
  for (const attr of el.attributes) {
    if (attr.name.startsWith("data-ux-")) data[attr.name.slice(8)] = attr.value;
  }
  return data;
}

/** The nearest surface that is only recognisable at runtime. */
function runtimeSurface(target) {
  for (const [selector, key] of RUNTIME) {
    const el = target.closest(selector);
    if (!el) continue;
    if (key === "manage") {
      const part = target.closest("[data-part]");
      return [key, { section: (part && part.getAttribute("data-part")) || "console" }];
    }
    if (key === "toc") {
      return [key, { action: target.closest(".nav-link") ? "jump" : "open" }];
    }
    return [key, {}];
  }
  return null;
}

function onClick(e) {
  // Modifier and middle clicks open a new tab: the reader is collecting links,
  // not navigating, and counting those as an open inflates every list.
  if (e.button > 1 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

  const target = e.target && e.target.closest ? e.target : null;
  if (!target) return;

  const el = target.closest("[data-ux]");
  if (!el) {
    const hit = runtimeSurface(target);
    if (hit) send(hit[0], hit[1]);
    return;
  }

  let key = el.getAttribute("data-ux");
  const data = payload(el);

  // A post opened out of a listing is that listing's event, with the action as
  // data — one name per surface, not one per (surface × thing done to it).
  if (key === "list-post") {
    key = LIST_SURFACE[data.from] || "archives";
    data.action = "open-post";
    delete data.from;
  }

  // A link's own href is the most useful thing about it and the one thing the
  // markup should never have to repeat.
  if (!data.to && el.tagName === "A" && el.getAttribute("href")) {
    data.to = el.getAttribute("href");
  }

  send(key, data);
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
  spent = new Map();
  total = 0;

  if (!enabled() || wired) return;

  wired = true;
  // Capture, so a handler that stops propagation on its own control cannot
  // silently remove it from the record.
  document.addEventListener("click", onClick, true);
}
