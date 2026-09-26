/**
 * Guide — every tip the cursor can give, as data.
 *
 * A tip names WHERE it applies (page kinds), WHEN it is due (`when`, evaluated
 * once per page view), HOW it is triggered, WHAT it points at, and what it says.
 * The director (index.js) owns pacing, order and persistence; nothing in here
 * schedules anything.
 *
 * Triggers:
 *   sequence  due as soon as the page is calm and the target is on screen, in
 *             `order`; consecutive ones chain, the cursor flying target to target
 *   view      due once a target has stayed in view for a moment — the first
 *             photo, the first code block — so it arrives where the reader is
 *   read      a sequence tip that waits until the reader is `progress` of the
 *             way down the page
 *
 * Hooks:
 *   target()/targets()  the element(s); view tips observe every candidate
 *   accept(el)          last word on a candidate, checked when it is offered
 *   prepare(el)         reveal something before pointing (a menu, hidden
 *                       buttons); returns the undo
 *   resolve(el)         the exact element to point at once prepared
 *   frame(el)           extra elements the card must not cover
 *   fulfilled()         the reader has done it already: close, and count it
 *
 * `key` is what Understand stores. Two tips that are the same advice on
 * different layouts share one, so understanding one retires both.
 */

import { t, doneCount } from "./store.js";
import { q, qa, shown, firstShown, borrowClass } from "./dom.js";

const copy = (key) => ({ title: t(`tips.${key}.title`), body: t(`tips.${key}.body`) });

function tip(def) {
  return Object.assign(
    { pages: [], trigger: "sequence", order: 50, ratio: 0.6, point: [0.5, 0.55], progress: 0 },
    def,
    { key: def.key || def.id },
  );
}

/** The desktop navbar item whose sub-menu links somewhere containing `part`. */
function menuItemFor(part) {
  for (const a of qa(".navbar-list .sub-menu a")) {
    if (!(a.getAttribute("href") || "").includes(part)) continue;
    const item = a.closest(".navbar-item");
    if (item && shown(item)) return item;
  }
  return null;
}

function menuLinkIn(item, part) {
  for (const a of item.querySelectorAll(".sub-menu a")) {
    if ((a.getAttribute("href") || "").includes(part)) return a;
  }
  return null;
}

const bell = () =>
  firstShown([".navbar-list .notifications-bell", ".navbar-content .mobile .notifications-bell"]);

/**
 * Lazily loaded images are REPLACED when they arrive — the placeholder div is
 * swapped for an <img> — so what is observed is the stable box around them.
 */
function imageBoxes(root, limit) {
  const boxes = new Set();
  for (const el of qa("img, .img-preloader", root)) {
    if (el.closest(".image-viewer-container, .guide-note") || el.hasAttribute("data-no-viewer")) continue;
    if (el.parentElement && el.parentElement.closest(".img-preloader")) continue;
    boxes.add(el.closest("figure") || el.parentElement);
    if (boxes.size >= limit) break;
  }
  return Array.from(boxes);
}

const imageIn = (box) => box.querySelector("img:not(.img-preloader-shim), .img-preloader");

export function catalog() {
  const home = ".home-content-container";
  const article = ".article-content";

  return [
    // ── every page ──────────────────────────────────────────────
    tip({
      id: "bell",
      pages: ["*"],
      order: 5,
      when: (c) => c.notifications && c.following,
      target: bell,
      tour: "follow",
      tourFrom: "inbox",
      text: () => copy("bell"),
    }),
    tip({
      id: "ios-push",
      pages: ["*"],
      order: 6,
      when: (c) => c.notifications && c.following && c.ios && !c.standalone,
      target: bell,
      tour: "follow",
      tourFrom: "ios",
      text: () => copy("ios_push"),
    }),

    // ── home ────────────────────────────────────────────────────
    tip({
      id: "follow",
      pages: ["home"],
      order: 10,
      when: (c) => c.notifications && !c.following,
      target: () => firstShown([".navbar-content .navbar-follow .follow-trigger", `${home} .follow-cta`]),
      point: [0.5, 0.6],
      tour: "follow",
      fulfilled: () => document.documentElement.classList.contains("blog-following"),
      text: () => copy("follow"),
    }),
    tip({
      id: "navbar",
      pages: ["home"],
      order: 20,
      target: () => menuItemFor("archives") || firstShown([".navbar-content .mobile .navbar-bar"]),
      prepare: (el) => (el.classList.contains("navbar-item") ? borrowClass(el, "guide-hover") : null),
      settle: 260,
      resolve: (el) => (el.classList.contains("navbar-item") ? el.querySelector(":scope > a") || el : el),
      frame: (el) => [el.closest(".navbar-item") && el.closest(".navbar-item").querySelector(".sub-menu")],
      point: [0.5, 0.62],
      text: (c, el) => copy(el.closest(".navbar-item") ? "navbar" : "navbar_mobile"),
    }),
    tip({
      id: "notes",
      pages: ["home"],
      order: 25,
      target: () => {
        const field = q("#instant-notes-field");
        return field && field.children.length ? firstShown(["#instant-notes .instant-notes-avatar"]) : null;
      },
      text: () => copy("notes"),
    }),
    tip({
      id: "masonry-menu",
      key: "masonry",
      pages: ["home"],
      order: 30,
      target: () => menuItemFor("/masonry"),
      prepare: (item) => borrowClass(item, "guide-hover"),
      settle: 260,
      resolve: (item) => menuLinkIn(item, "/masonry"),
      frame: (a) => [a.closest(".sub-menu")],
      point: [0.3, 0.6],
      text: () => copy("masonry"),
    }),
    tip({
      id: "masonry-tile",
      key: "masonry",
      pages: ["home"],
      trigger: "view",
      order: 31,
      ratio: 1,
      targets: () => qa(`${home} .sidebar-links a.links`).filter((a) => (a.getAttribute("href") || "").includes("/masonry")),
      text: () => copy("masonry"),
    }),
    tip({
      id: "posts",
      pages: ["home"],
      trigger: "view",
      order: 40,
      ratio: 0.55,
      targets: () => qa(`${home} .home-article-item`).slice(0, 6),
      point: [0.5, 0.32],
      text: () => copy("posts"),
    }),
    tip({
      id: "pulse",
      pages: ["home"],
      trigger: "view",
      order: 45,
      ratio: 0.85,
      targets: () => qa(`${home} .sidebar-pulse`),
      point: [0.62, 0.62],
      text: () => copy("pulse"),
    }),
    tip({
      id: "pager",
      pages: ["home"],
      trigger: "view",
      order: 46,
      ratio: 1,
      targets: () => qa(`${home} .sb-dots:not([hidden])`),
      point: [0.5, 0.5],
      text: () => copy("pager"),
    }),

    // ── articles ────────────────────────────────────────────────
    tip({
      id: "exif-toggle",
      key: "exif",
      pages: ["article"],
      trigger: "view",
      order: 5,
      ratio: 0.5,
      targets: () => qa(`${article} .image-exif-container`).slice(0, 20),
      accept: (box) => shown(box.querySelector(".image-exif-toggle-btn")),
      resolve: (box) => box.querySelector(".image-exif-toggle-btn"),
      frame: (btn) => [btn.closest(".image-exif-info-card")],
      point: [0.5, 0.5],
      text: () => copy("exif_toggle"),
    }),
    tip({
      id: "exif-hover",
      key: "exif",
      pages: ["article"],
      trigger: "view",
      order: 6,
      ratio: 0.6,
      when: (c) => c.hover,
      targets: () => qa(`${article} .image-exif-container`).slice(0, 20),
      accept: (box) =>
        box.classList.contains("image-exif-float") && !box.classList.contains("image-exif-overflow-fallback"),
      prepare: (box) => borrowClass(box, "guide-reveal"),
      settle: 260,
      resolve: (box) => box.querySelector(".image-exif-info-card"),
      frame: (card) => [card.closest(".image-exif-image-wrapper")],
      point: [0.25, 0.3],
      text: () => copy("exif_hover"),
    }),
    tip({
      id: "viewer",
      pages: ["article"],
      trigger: "view",
      order: 10,
      ratio: 0.6,
      targets: () => {
        const root = q(article);
        return root ? imageBoxes(root, 30) : [];
      },
      accept: (box) => !!imageIn(box),
      resolve: imageIn,
      point: [0.5, 0.5],
      tour: "viewer",
      text: () => copy("viewer"),
    }),
    tip({
      id: "errorbook",
      pages: ["article"],
      trigger: "view",
      order: 15,
      ratio: 0.5,
      targets: () => qa(`${article} .eb-card`).slice(0, 5),
      resolve: (card) => card.querySelector(".eb-options, .eb-answer") || card,
      point: [0.5, 0.3],
      text: () => copy("errorbook"),
    }),
    tip({
      id: "code",
      pages: ["article"],
      trigger: "view",
      order: 20,
      ratio: 0.7,
      targets: () => qa(`${article} .code-container`).slice(0, 10),
      accept: (box) => !!box.querySelector(".copy-button"),
      prepare: (box) => borrowClass(box, "guide-reveal"),
      settle: 240,
      resolve: (box) => box.querySelector(".copy-button"),
      text: () => copy("code"),
    }),
    tip({
      id: "toc",
      pages: ["article"],
      trigger: "read",
      progress: 0.12,
      order: 30,
      target: () => firstShown([".post-tools-container .page-aside-toggle"]),
      text: () => copy("toc"),
    }),
    tip({
      id: "tools",
      pages: ["article"],
      trigger: "read",
      progress: 0.3,
      order: 40,
      target: () => firstShown([".side-tools-container .toggle-tools-list"]),
      text: () => copy("tools"),
    }),
    tip({
      id: "comments-rail",
      key: "comments",
      pages: ["article"],
      trigger: "read",
      progress: 0.55,
      order: 50,
      target: () => firstShown([".post-tools-container .go-comment"]),
      tour: "comments",
      text: () => copy("comments"),
    }),
    tip({
      id: "comments-area",
      key: "comments",
      pages: ["article"],
      trigger: "view",
      order: 51,
      ratio: 1,
      targets: () => qa(".comments-container .comment-area-title"),
      tour: "comments",
      text: () => copy("comments"),
    }),
    tip({
      id: "guide-entry",
      pages: ["article", "home"],
      trigger: "read",
      progress: 0.45,
      order: 90,
      when: () => doneCount() >= 2,
      target: () => {
        const list = q(".side-tools-container .hidden-tools-list");
        const entry = list && list.classList.contains("show") && firstShown([".side-tools-container .tool-guide"]);
        return entry || firstShown([".side-tools-container .toggle-tools-list"]);
      },
      text: () => copy("guide_entry"),
    }),

    // ── the photo wall ──────────────────────────────────────────
    tip({
      id: "album-photo",
      pages: ["album"],
      trigger: "view",
      order: 10,
      targets: () => qa("#masonry-container .masonry-item").slice(0, 8),
      point: [0.5, 0.45],
      tour: "viewer",
      text: () => copy("album_photo"),
    }),
    tip({
      id: "album-heart",
      pages: ["album"],
      trigger: "view",
      order: 20,
      ratio: 1,
      targets: () => qa("#masonry-container .masonry-heart-btn").slice(0, 8),
      text: () => copy("album_heart"),
    }),
    tip({
      id: "albums",
      pages: ["albums"],
      trigger: "view",
      order: 10,
      ratio: 0.7,
      targets: () => qa("[data-masonry-heading] + ul > li").slice(0, 6),
      point: [0.5, 0.4],
      text: () => copy("albums"),
    }),

    // ── listings ────────────────────────────────────────────────
    tip({
      id: "search",
      pages: ["listing"],
      order: 10,
      target: () =>
        firstShown([".navbar-list .search-popup-trigger", ".navbar-content .mobile .search-popup-trigger"]),
      text: () => copy("search"),
    }),
  ];
}

/**
 * The author's own notes, written into a post with {% guide %}. Each points at
 * the block that follows it and is keyed by a hash of its text, so editing a
 * note shows it again to readers who understood the old one.
 */
export function notes(ctx) {
  if (ctx.kind !== "article") return [];
  return qa(".article-content .guide-note")
    .map((note) => {
      const id = note.getAttribute("data-guide-id");
      const block = blockAfter(note);
      if (!id || !block) return null;
      return tip({
        id: `note:${id}`,
        pages: ["article"],
        trigger: "view",
        order: 1,
        ratio: 0.5,
        targets: () => [block],
        point: [0.5, 0.5],
        text: () => ({
          kicker: t("note_kicker"),
          title: note.getAttribute("data-guide-title") || t("note_title"),
          body: note.getAttribute("data-guide-body") || "",
        }),
      });
    })
    .filter(Boolean);
}

function blockAfter(note) {
  const usable = (el) => el && !el.classList.contains("guide-note") && el.getClientRects().length > 0;
  let el = note.nextElementSibling;
  while (el && !usable(el)) el = el.nextElementSibling;
  if (el) return el;
  el = note.previousElementSibling;
  while (el && !usable(el)) el = el.previousElementSibling;
  return el || note.parentElement;
}
