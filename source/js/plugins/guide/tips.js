/**
 * Guide — every stop the cursor makes, as data.
 *
 * `plan(ctx)` is the page's route, in the order the cursor walks it: who the
 * guide is (once, ever), then the page's own tour — the home page, an article,
 * an album — with the side tools after the home page and before every other
 * page's own stops. The director (index.js) walks it; nothing here schedules
 * anything.
 *
 * Modes:
 *   next    walked in order. Below the screen, the cursor waits at the bottom edge
 *           for the reader to scroll to it; above, the reader has gone past it and
 *           it waits for the next visit — unless `up`, when the cursor asks the
 *           reader to scroll back up to it
 *   reach   tied to reading — a photo, a code block, a note: due once one of its
 *           `targets` has stayed in view a moment; never asked for
 *   place   no target: said from a point on the screen (`at`)
 *
 * Hooks:
 *   target()/targets()  the element(s); `accept(el)` has the last word on a candidate
 *   ready(el)           it exists but is not there yet (a list still loading)
 *   host()              whose visibility decides whether it can be shown (a tool
 *                       inside a folded list is shown by the list)
 *   skip()              not this time: the reader is past where it applies
 *   progress / after    not before this share of the page is read / that stop is over
 *   prepare(el)         reveal something before pointing (a menu, a tool list);
 *                       returns the undo. `resolve(el)`: the exact element then
 *   point               where on it, as fractions — or a function of it
 *   tryIt(el, g)        Let's try: do it with the page's own controls. `canTry(el)`;
 *                       `g.explore()` takes the detour through the inbox
 *   tour / tourFrom     View More opens that walkthrough
 *   prompt              what the cursor says while waiting for a scroll
 *   fulfilled()         the reader has done it already: close, and count it
 *
 * `key` is what Understand stores; two stops that give the same advice on
 * different layouts share one.
 */

import { t, tf } from "./store.js";
import { q, qa, shown, firstShown, borrowClass } from "./dom.js";
import { getMetrics } from "../../tools/scrollScheduler.js";

const copy = (key) => () => ({ title: t(`tips.${key}.title`), body: t(`tips.${key}.body`) });

function stop(def) {
  return Object.assign({ mode: "next", ratio: 0.6, point: [0.5, 0.55] }, def, { key: def.key || def.id });
}

// Let's try, for most stops: the cursor presses the control and the control does
// what it always does.
const press = (pick) => async (el, g) => {
  const node = pick ? pick(el) : el;
  if (node && (await g.press(node))) node.click();
};

const siteTitle = () => {
  const el = q(".navbar-content .logo-title");
  return (el && el.textContent.trim()) || document.title;
};

// The home page's first screen has been left behind for the posts.
const pastBanner = () => getMetrics().scrollY > window.innerHeight * 0.5;

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

// The drawer's "Posts" row, whose sub-list holds the photo wall.
function drawerPosts() {
  const link = q('.navbar-drawer a[href*="/masonry"]');
  const list = link && link.closest("[data-target]");
  return list ? q(`[navbar-data-toggle="${list.getAttribute("data-target")}"]`) : null;
}

const bell = () =>
  firstShown([".navbar-list .notifications-bell", ".navbar-content .mobile .notifications-bell"]);

const following = () => document.documentElement.classList.contains("blog-following");

const notesMore = () => {
  const btn = q("#instant-notes .instant-notes-more-btn");
  return btn && !btn.classList.contains("is-hidden") && shown(btn) ? btn : null;
};

const pagerNext = () => {
  const dots = qa(".home-content-container .sb-dots:not([hidden]) .sb-dot:not([hidden])");
  if (dots.length < 2) return null;
  const on = dots.findIndex((d) => d.classList.contains("is-on"));
  return dots[(on + 1) % dots.length];
};

// The side tools: the gear folds the list the other tools live in, and the whole
// rail fades out at the very top of the home page and the foot of every page.
const toolsRail = () => q(".side-tools-container");
const toolsList = () => q(".side-tools-container .hidden-tools-list");
const openTools = () => {
  const list = toolsList();
  return list && !list.classList.contains("show") ? borrowClass(list, "show") : null;
};

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

// One of a list, chosen once and kept for the page view: the cursor waits for,
// points at and opens the same one.
function pickOne(f, name, list) {
  const kept = f.kept.get(name);
  if (kept && kept.isConnected) return kept;
  const pool = list.filter((el) => el.getClientRects().length);
  const one = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  f.kept.set(name, one);
  return one;
}

// ─── the stops ───────────────────────────────────────────────
const intro = stop({
  id: "intro",
  mode: "place",
  at: "middle",
  ok: "lets_go",
  text: () => ({ title: t("intro.title"), body: tf("intro.body", { site: siteTitle() }) }),
});

function home(ctx) {
  const root = ".home-content-container";
  // Signed in, following is one press away: Let's try presses it — or, for a
  // follower, opens the inbox — and the cursor walks through the inbox before
  // carrying on here. Signed out, View More shows the whole way there.
  const first = ctx.following
    ? stop({
        id: "bell",
        target: bell,
        text: copy("bell"),
        ...(ctx.signedIn ? { tryIt: (el, g) => g.explore() } : { tour: "follow", tourFrom: "published" }),
      })
    : stop({
        id: "follow",
        when: (c) => c.notifications,
        target: () => firstShown([".navbar-content .navbar-follow .follow-trigger", `${root} .follow-cta`]),
        point: [0.5, 0.6],
        fulfilled: following,
        ...(ctx.signedIn
          ? {
              text: copy("follow_signed"),
              tryIt: async (el, g) => {
                if (await g.press(el)) el.click();
                await g.explore(true);
              },
            }
          : { text: copy("follow"), tour: "follow" }),
      });
  return [
    first,
    stop({
      id: "ios-push",
      when: (c) => c.notifications && c.following && c.ios && !c.standalone,
      target: bell,
      tour: "follow",
      tourFrom: "install",
      text: copy("ios_push"),
    }),
    stop({
      id: "navbar",
      target: () => menuItemFor("archives"),
      prepare: (item) => borrowClass(item, "guide-hover"),
      settle: 260,
      resolve: (item) => item.querySelector(":scope > a") || item,
      point: [0.5, 0.62],
      text: copy("navbar"),
    }),
    stop({
      id: "masonry",
      target: () => menuItemFor("/masonry"),
      prepare: (item) => borrowClass(item, "guide-hover"),
      settle: 260,
      resolve: (item) => menuLinkIn(item, "/masonry"),
      point: [0.3, 0.6],
      tryIt: press(),
      text: copy("masonry"),
    }),
    stop({
      id: "navbar-mobile",
      key: "navbar",
      target: () => firstShown([".navbar-content .mobile .navbar-bar"]),
      // Opens the drawer and unfolds Posts, where the photo wall is.
      tryIt: async (el, g) => {
        if (!(await g.press(el))) return;
        el.click();
        await g.wait(520);
        const posts = drawerPosts();
        if (posts && (await g.press(posts, 0.2, 0.5))) posts.click();
      },
      text: copy("navbar_mobile"),
    }),
    stop({
      id: "notes",
      target: () => q("#instant-notes .instant-notes-avatar"),
      ready: () => {
        const field = q("#instant-notes-field");
        return !!(field && field.children.length);
      },
      skip: pastBanner,
      canTry: () => !!notesMore(),
      tryIt: press(notesMore),
      text: copy("notes"),
    }),
    stop({
      id: "banner-scroll",
      target: () => q(".home-banner-scroll-to-main"),
      skip: pastBanner,
      tryIt: press(),
      text: copy("banner_scroll"),
    }),
    stop({
      id: "author",
      target: () => firstShown([`${root} .feature-info .sidebar-content`, `${root} .sidebar-content`]),
      point: [0.5, 0.4],
      canTry: () => !!pagerNext(),
      tryIt: press(pagerNext),
      text: () => copy(pagerNext() ? "author_pager" : "author")(),
    }),
    stop({ id: "links", target: () => firstShown([`${root} .sidebar-links`]), point: [0.5, 0.35], text: copy("links") }),
    stop({ id: "pulse", target: () => firstShown([`${root} .sidebar-pulse`]), point: [0.62, 0.62], text: copy("pulse") }),
    stop({
      id: "post",
      target: (c, f) => pickOne(f, "post", qa(`${root} .home-article-item`).slice(0, 10)),
      point: [0.5, 0.32],
      tryIt: press((card) => card.querySelector('a[data-ux="home-post"]') || card.querySelector("a[href]")),
      text: copy("post"),
    }),
  ];
}

function tools() {
  const inList = { host: toolsRail, prepare: openTools, settle: 240 };
  return [
    stop({
      id: "tools",
      target: () => q(".side-tools-container .toggle-tools-list"),
      host: toolsRail,
      canTry: () => !(toolsList() && toolsList().classList.contains("show")),
      tryIt: press(),
      text: copy("tools"),
    }),
    stop(Object.assign({ id: "tools-font", target: () => q(".side-tools-container .tool-font-adjust-plus"), text: copy("tools_font") }, inList)),
    stop(
      Object.assign(
        { id: "tools-theme", target: () => q(".side-tools-container .tool-dark-light-toggle"), tryIt: press(), text: copy("tools_theme") },
        inList,
      ),
    ),
    stop(
      Object.assign(
        { id: "tools-guide", key: "guide_entry", target: () => q(".side-tools-container .tool-guide"), tryIt: press(), text: copy("guide_entry") },
        inList,
      ),
    ),
    stop({
      id: "tools-top",
      // The one with the reading percentage when there is one: it only appears once the page has moved.
      target: () => q(".side-tools-container .visible-tools-list .tool-scroll-to-top") || q(".side-tools-container .tool-scroll-to-top"),
      ready: (el) => el.getClientRects().length > 0,
      host: toolsRail,
      prepare: (el) => (el.closest(".hidden-tools-list") ? openTools() : null),
      settle: 200,
      tryIt: press(),
      text: copy("tools_top"),
    }),
  ];
}

function article(ctx) {
  const root = ".article-content";
  return [
    ...notes(ctx),
    stop({
      id: "exif-toggle",
      key: "exif",
      mode: "reach",
      ratio: 0.5,
      targets: () => qa(`${root} .image-exif-container`).slice(0, 20),
      accept: (box) => shown(box.querySelector(".image-exif-toggle-btn")),
      resolve: (box) => box.querySelector(".image-exif-toggle-btn"),
      point: [0.5, 0.5],
      tryIt: press(),
      text: copy("exif_toggle"),
    }),
    stop({
      id: "exif-hover",
      key: "exif",
      mode: "reach",
      when: (c) => c.hover,
      targets: () => qa(`${root} .image-exif-container`).slice(0, 20),
      accept: (box) =>
        box.classList.contains("image-exif-float") && !box.classList.contains("image-exif-overflow-fallback"),
      prepare: (box) => borrowClass(box, "guide-reveal"),
      settle: 260,
      resolve: (box) => box.querySelector(".image-exif-info-card"),
      point: [0.25, 0.3],
      text: copy("exif_hover"),
    }),
    stop({
      id: "viewer",
      mode: "reach",
      targets: () => {
        const el = q(root);
        return el ? imageBoxes(el, 30) : [];
      },
      accept: (box) => !!imageIn(box),
      resolve: imageIn,
      point: [0.5, 0.5],
      tryIt: press(),
      text: copy("viewer"),
    }),
    stop({
      id: "errorbook",
      mode: "reach",
      ratio: 0.5,
      targets: () => qa(`${root} .eb-card`).slice(0, 5),
      resolve: (card) => card.querySelector(".eb-options, .eb-answer") || card,
      point: [0.5, 0.3],
      text: copy("errorbook"),
    }),
    stop({
      id: "code",
      mode: "reach",
      ratio: 0.7,
      targets: () => qa(`${root} .code-container`).slice(0, 10),
      accept: (box) => !!box.querySelector(".copy-button"),
      prepare: (box) => borrowClass(box, "guide-reveal"),
      settle: 240,
      resolve: (box) => box.querySelector(".copy-button"),
      tryIt: press(),
      text: copy("code"),
    }),
    stop({
      id: "toc",
      progress: 0.12,
      target: () => firstShown([".post-tools-container .page-aside-toggle"]),
      tryIt: press(),
      text: copy("toc"),
    }),
    // Near the end: down to the discussion, then back up to what to read next.
    stop({
      id: "comments",
      progress: 0.7,
      prompt: "prompt_comments",
      target: () => q(".comments-container"),
      resolve: (box) => {
        const frame = box.querySelector(".giscus-frame, iframe");
        return frame && shown(frame) ? frame : box.querySelector(".comment-area-title") || box;
      },
      point: [0.5, 0.14],
      tour: "comments",
      text: copy("comments"),
    }),
    stop({
      id: "recommend",
      progress: 0.7,
      after: "comments",
      up: true,
      prompt: "prompt_recommend",
      target: (c, f) => pickOne(f, "recommend", qa(".recommended-article .recommended-article-item")),
      point: [0.5, 0.4],
      tryIt: press(),
      text: copy("recommend"),
    }),
  ];
}

// ─── the inbox, explored ─────────────────────────────────────
// Let's Explore at the end of the follow walkthrough, or Let's try on the home
// page's first stop for a signed-in reader. Run on request, whatever has been
// understood before; the page's own route picks up again after it.
const panel = () => document.getElementById("notifications-panel");
const panelOpen = () => {
  const p = panel();
  return !!(p && p.classList.contains("is-open"));
};
// The settings are the card's second page; the stops on it turn to it first.
const onManage = () => {
  const p = panel();
  const to = p && p.dataset.page !== "manage" && p.querySelector(".np-to-manage");
  if (to) to.click();
  return null;
};
const pushSwitch = () => q('#notifications-panel .np-switch[data-switch="push"]');
const onPage = { host: panel, prepare: onManage, settle: 480 };
// A point on the page the card does not cover: beside a desktop card, above a phone's sheet.
const outside = () => {
  const r = panel().getBoundingClientRect();
  if (r.left > window.innerWidth * 0.4) return [0.22, 0.5];
  return r.top > window.innerHeight * 0.3 ? [0.5, 0.16] : [0.5, 0.88];
};

export const inbox = {
  // Opened the way the reader opens it: with the bell.
  open: async (g) => {
    if (panelOpen()) return;
    const b = bell();
    if (b && (await g.press(b))) b.click();
    await g.wait(520);
  },
  alive: panelOpen,
  stops: [
    stop({
      id: "inbox-manage",
      target: () => q("#notifications-panel .np-to-manage"),
      host: panel,
      tryIt: press(),
      text: copy("inbox_manage"),
    }),
    stop(
      Object.assign(
        {
          id: "inbox-push",
          target: pushSwitch,
          // Only while this device is not receiving yet, and can.
          skip: () => {
            const s = pushSwitch();
            return !s || s.classList.contains("is-on") || s.disabled;
          },
          tryIt: press(),
          text: copy("inbox_push"),
        },
        onPage,
      ),
    ),
    // No Let's try: a press here could switch off what the reader wants to keep.
    stop(Object.assign({ id: "inbox-topics", target: () => q("#notifications-panel .np-manage .np-section"), point: [0.5, 0.62], text: copy("inbox_topics") }, onPage)),
    stop(Object.assign({ id: "inbox-back", target: () => q("#notifications-panel .np-back"), tryIt: press(), text: copy("inbox_back") }, onPage)),
    stop({
      id: "inbox-close",
      target: () => q("#notifications-mask"),
      host: panel,
      point: outside,
      tryIt: async (el, g) => {
        const [fx, fy] = outside();
        if (await g.press(el, fx, fy)) el.click();
      },
      text: copy("inbox_close"),
    }),
  ],
};

/** The route through this page. */
export function plan(ctx) {
  const stops = [intro];
  if (ctx.kind === "home") stops.push(...home(ctx), ...tools());
  else stops.push(...tools());
  if (ctx.kind === "article") stops.push(...article(ctx));
  if (ctx.kind === "album") {
    stops.push(
      stop({
        id: "album-photo",
        mode: "reach",
        targets: () => qa("#masonry-container .masonry-item").slice(0, 8),
        resolve: (item) => item.querySelector("img, .img-preloader") || item,
        point: [0.5, 0.45],
        tryIt: press(),
        text: copy("album_photo"),
      }),
      stop({
        id: "album-heart",
        mode: "reach",
        ratio: 1,
        targets: () => qa("#masonry-container .masonry-heart-btn").slice(0, 8),
        text: copy("album_heart"),
      }),
    );
  }
  if (ctx.kind === "albums") {
    stops.push(
      stop({
        id: "albums",
        mode: "reach",
        ratio: 0.7,
        targets: () => qa("[data-masonry-heading] + ul > li").slice(0, 6),
        resolve: (li) => li.querySelector("a[href]") || li,
        point: [0.5, 0.4],
        tryIt: press(),
        text: copy("albums"),
      }),
    );
  }
  if (ctx.kind === "listing") {
    stops.push(
      stop({
        id: "search",
        target: () => firstShown([".navbar-list .search-popup-trigger", ".navbar-content .mobile .search-popup-trigger"]),
        tryIt: press(),
        text: copy("search"),
      }),
    );
  }
  return stops.filter((s) => {
    try {
      return !s.when || !!s.when(ctx);
    } catch {
      return false;
    }
  });
}

/**
 * The author's own notes, written into a post with {% guide %}. Each points at
 * the block that follows it and is keyed by a hash of its text, so editing a
 * note shows it again to readers who understood the old one.
 */
function notes(ctx) {
  return qa(".article-content .guide-note")
    .map((note) => {
      const id = note.getAttribute("data-guide-id");
      const block = blockAfter(note);
      if (!id || !block) return null;
      return stop({
        id: `note:${id}`,
        mode: "reach",
        ratio: 0.5,
        targets: () => [block],
        point: [0.5, 0.5],
        text: () => ({
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
