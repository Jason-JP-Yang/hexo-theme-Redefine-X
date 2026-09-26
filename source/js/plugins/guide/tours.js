/**
 * Guide — the walkthroughs, as content.
 *
 * Following is shown for the reader's own system — Windows, macOS, iPhone and
 * iPad, or Android — with a picker to change it: each draws its own browser,
 * notification and permission prompt, iPhone and iPad deliver push only to a
 * site on the Home Screen, and a Mac can keep the blog in the Dock. The blog in
 * every scene is the real site under its own CSS (mock/site.js); the devices and
 * GitHub's pages are drawn by mock/device.js and mock/github.js.
 *
 * Framing, set step by step: a step opens and closes on the whole device, and
 * the camera goes in only where there is something to read — the banner that
 * arrived, the inbox, the form being filled in, the prompt that opened — each
 * shot at the zoom that suits it, and comes back out afterwards. A button
 * outside the frame is panned into it before it is pressed.
 *
 * Every scene builds its markup lazily, at play time, after the home page has
 * been read (`site.prepare()`).
 */

import { Tour } from "./tour.js";
import { t, tf, escapeHTML as e } from "./store.js";
import { PLATFORMS, PLATFORM_ICONS, detectPlatform, isPhone } from "./platform.js";
import * as site from "./mock/site.js";
import * as dev from "./mock/device.js";
import * as gh from "./mock/github.js";

const M = (k) => e(t(`mock.${k}`));

// The navbar has a desktop row and a mobile row; a mock shows the one it measured room for.
const inRow = (sel) => `.gd-site:not(.navbar-collapsed) .desktop ${sel}, .gd-site.navbar-collapsed .mobile ${sel}`;
const BELL = { desk: inRow(".notifications-bell"), phone: ".gd-site .mobile .notifications-bell" };
const FOLLOW = { desk: inRow(".follow-trigger"), phone: ".gd-site .mobile .follow-trigger" };
const PANEL = ".gd-site .notifications-panel";
const SCREEN = ".gd-screen";
const GH_LOGIN = "github.com/login";
const GH_SIGNUP = "github.com/signup";
const GH_AUTHORIZE = "github.com/login/oauth/authorize";

// ─── building blocks ─────────────────────────────────────────
/** The blog in `where`'s page area (a key of dev.VIEW). */
function blog(os, where, opts = {}) {
  const v = dev.VIEW[where];
  return site.site(Object.assign({ device: isPhone(os) ? "phone" : "desk", w: v.w, h: v.h, vh: v.vh || v.h }, opts));
}

/** GitHub's page area: the desktop browser's, or null for a phone's own width. */
const ghView = (os) => (isPhone(os) ? null : dev.VIEW[os]);

/** Two pages in one browser; `is-b` on `.gd-swap` navigates to the second. */
const swap = (a, b) => `<div class="gd-swap"><div class="gd-swap-a">${a}</div><div class="gd-swap-b">${b}</div></div>`;

const deskBrowser = (os, page, url) => (os === "macos" ? dev.macSafari(page, url) : dev.winChrome(page, { url }));

function go(url, extra) {
  return (s) => {
    s.set(".gd-swap", "is-b");
    if (url) s.text(".gd-url", url);
    if (extra) extra(s);
  };
}

// The whole device — where every step starts and ends, and where the camera
// steps back to between two things far apart.
const WHOLE = { do: "shot", fit: true };

/**
 * Up close on `on` (one selector or several), with `pad` stage pixels round it,
 * but never closer than `zoom` × the whole device: each shot sets its own, for
 * what there is to read there. `still` frames it where it is now and stays.
 */
const focus = (on, zoom, pad = 20, still = false) => ({ do: "shot", on, pad, max: zoom, still });

/**
 * A scene on this system's device, opening on the whole of it. A phone plays in
 * a taller stage and scrolls by dragging.
 */
function scene(os, html, beats, extra = {}) {
  const phone = isPhone(os);
  const setup = extra.setup;
  return Object.assign(
    {
      size: phone ? dev.PHONE : dev.DESK,
      html,
      view: { fit: true },
      beats,
      // For a shot that sets none: half a desktop across, two thirds of a phone down.
      zoom: phone ? 1.8 : 2,
      tall: phone,
      touch: phone,
    },
    extra,
    {
      setup: (s) => {
        site.fit(s);
        if (setup) setup(s);
      },
    },
  );
}

// ─── following ───────────────────────────────────────────────
function published(os) {
  const push = () => {
    const post = site.newestPost();
    return dev.banner(os, { title: post.title, body: post.body || t("mock.post_body") });
  };
  const later = (s) => {
    s.set(".gd-push", "is-on", false);
    site.badge(s, 1);
  };
  const phone = isPhone(os);
  const bell = phone ? BELL.phone : BELL.desk;
  const html = phone
    ? () => {
        const page = blog(os, os === "ios" ? "app" : "android", { following: true, inbox: true });
        return dev.phone(os, (os === "ios" ? dev.iosApp(page) : dev.andChrome(page)) + push());
      }
    : () => dev.desk(os, deskBrowser(os, blog(os, os, { following: true, inbox: true })), push());
  // Noticed on the whole screen, then read up close — held while it leaves. A
  // Mac's banner lands beside the bell and the camera goes straight on to the
  // inbox; elsewhere it steps back first.
  const onward = phone || os === "windows" ? [WHOLE] : [];
  return scene(os, html, [
    { do: "wait", ms: 300 },
    { do: "auto", then: (s) => s.set(".gd-push", "is-on"), ms: 650 },
    focus(phone ? [".gd-push", ".gd-site-head"] : ".gd-push", phone ? 1.8 : 2.4, 20, true),
    { do: "wait", ms: 1700 },
    { do: "auto", then: later, ms: 350 },
    ...(phone ? [] : [...onward, focus([bell, PANEL], 1.9)]),
    { do: "press", at: bell, then: (s) => site.openInbox(s), ms: 650 },
    ...(phone ? [...onward, focus(PANEL, 1.7)] : []),
    { do: "wait", ms: 2400 },
    WHOLE,
    { do: "wait", ms: 600 },
  ]);
}

function installIOS() {
  const html = () =>
    dev.phone(
      "ios",
      dev.iosSafari(blog("ios", "safari")) +
        dev.iosMore() +
        '<div class="gd-ios-dim"></div>' +
        dev.iosShare() +
        dev.iosAddHome() +
        dev.iosHome() +
        `<div class="gd-ios-launch">${dev.iosApp(blog("ios", "app"))}</div>`,
    );
  const screen = (on, off) => (s) => {
    if (off) s.set(SCREEN, off, false);
    s.set(SCREEN, on);
  };
  return scene("ios", html, [
    { do: "wait", ms: 400 },
    // Safari's bar, where ⋯ opens its menu.
    focus([".gd-ios-tabbar", ".gd-ios-menu"], 1.8, 16, true),
    { do: "press", at: ".gd-f-more", then: screen("is-menu"), ms: 900 },
    { do: "press", at: ".gd-f-share", then: screen("is-share", "is-menu"), ms: 1000 },
    focus(".gd-ios-share", 1.6, 12),
    { do: "scroll", in: ".gd-ios-list", to: ".gd-f-home", ms: 700 },
    { do: "press", at: ".gd-f-home", then: screen("is-add"), ms: 1000 },
    focus([".gd-ios-add-nav", ".gd-ios-toggle-row"], 1.8, 16),
    { do: "press", at: ".gd-f-webapp", then: (s) => s.set(".gd-f-webapp", "is-on"), ms: 800 },
    { do: "press", at: ".gd-f-add", then: screen("is-home", "is-add"), ms: 700 },
    // The Home Screen as a whole, the blog's icon among the apps.
    WHOLE,
    { do: "press", at: ".gd-f-icon", then: screen("is-app"), ms: 1600 },
  ]);
}

function installMac() {
  const html = () => dev.desk("macos", dev.macSafari(blog("macos", "macos")), dev.macFileMenu() + dev.macAddDock());
  const desk = (on, off) => (s) => {
    if (off) s.set(".gd-desk", off, false);
    if (on) s.set(".gd-desk", on);
  };
  return scene("macos", html, [
    { do: "wait", ms: 400 },
    focus([".gd-f-file", ".gd-mac-menu"], 2, 20, true),
    { do: "press", at: ".gd-f-file", then: desk("is-menu"), ms: 900 },
    { do: "press", at: ".gd-f-dock", then: desk("is-add", "is-menu"), ms: 800 },
    focus(".gd-mac-add", 2.2),
    { do: "press", at: ".gd-f-add", then: desk("is-docked", "is-add"), ms: 400 },
    // The Dock taking the icon, and the blog opening from it, seen whole.
    WHOLE,
    {
      do: "press",
      at: ".gd-dock-new",
      then: (s) => {
        desk("is-app")(s);
        s.text(".gd-mw .gd-url", dev.siteName());
      },
      ms: 1800,
    },
  ]);
}

/** The blog, then GitHub's sign-in page, reached by pressing Follow. */
function signin(os) {
  const view = ghView(os);
  const html = () => {
    if (view) return dev.desk(os, deskBrowser(os, swap(blog(os, os), gh.signin(view))));
    return dev.phone(
      os,
      os === "ios"
        ? dev.iosApp(blog(os, "app")) + dev.iosInApp(gh.signin(), "github.com")
        : dev.andChrome(swap(blog(os, "android"), gh.signin())),
    );
  };
  const open = os === "ios" ? (s) => s.set(SCREEN, "is-web") : go(GH_LOGIN);
  return scene(os, html, [
    { do: "wait", ms: 300 },
    { do: "press", at: view ? FOLLOW.desk : FOLLOW.phone, then: open, ms: 1000 },
    focus([".gd-gh-signin h1", ".gd-gh-signin .gd-gh-fields"], view ? 2 : 1.8),
    { do: "type", at: ".gd-f-login", text: "your-name" },
    { do: "type", at: ".gd-f-password", text: "correct-horse", mask: true },
    { do: "move", at: ".gd-f-signin", ms: 900 },
    WHOLE,
    { do: "wait", ms: 500 },
  ]);
}

/** From the sign-in page to GitHub's sign-up page, filled in. */
function register(os) {
  const view = ghView(os);
  const page = () => swap(gh.signin(view), gh.signup(view));
  const html = () => {
    if (view) return dev.desk(os, deskBrowser(os, page(), GH_LOGIN));
    return dev.phone(os, os === "ios" ? dev.iosApp(blog(os, "app")) + dev.iosInApp(page(), "github.com") : dev.andChrome(page(), GH_LOGIN));
  };
  const z = view ? 2 : 1.8;
  return scene(
    os,
    html,
    [
      { do: "wait", ms: 400 },
      { do: "press", at: ".gd-f-create", then: go(os === "ios" ? "" : GH_SIGNUP), ms: 1200 },
      focus([".gd-gh-signup .gd-gh-form h1", ".gd-gh-signup .gd-gh-fields"], z),
      { do: "type", at: ".gd-f-email", text: "you@example.com" },
      { do: "type", at: ".gd-f-pass", text: "correct-horse-battery", mask: true },
      { do: "type", at: ".gd-f-user", text: "your-name" },
      { do: "scroll", in: ".gd-gh-signup .gd-gh-right", to: ".gd-f-go" },
      focus(".gd-gh-signup .gd-gh-submit", z),
      { do: "press", at: ".gd-f-go", ms: 900 },
      WHOLE,
      { do: "wait", ms: 500 },
    ],
    // The sheet on iPhone is already open on GitHub.
    os === "ios" ? { setup: (s) => s.set(SCREEN, "is-web") } : {},
  );
}

/**
 * GitHub asks whether giscus may act for the reader. Authorize shows it is
 * working, then GitHub hands the reader back to the blog.
 */
function authorize(os, login) {
  const view = ghView(os);
  const html = () => {
    if (view) return dev.desk(os, deskBrowser(os, swap(gh.authorize(view, login), blog(os, os)), GH_AUTHORIZE));
    if (os === "ios") return dev.phone(os, dev.iosApp(blog(os, "app")) + dev.iosInApp(gh.authorize(null, login), "github.com"));
    return dev.phone(os, dev.andChrome(swap(gh.authorize(null, login), blog(os, "android")), GH_AUTHORIZE));
  };
  const back = os === "ios" ? (s) => s.set(SCREEN, "is-web", false) : go(dev.host());
  return scene(
    os,
    html,
    [
      { do: "wait", ms: 400 },
      // What giscus asks for, and the button that grants it.
      focus([".gd-gh-box", ".gd-f-auth"], view ? 2 : 1.8),
      { do: "wait", ms: 1200 },
      { do: "press", at: ".gd-f-auth", then: (s) => s.set(".gd-f-auth", "is-busy"), ms: 1500 },
      WHOLE,
      { do: "auto", then: back, ms: 1400 },
    ],
    os === "ios" ? { setup: (s) => s.set(SCREEN, "is-web") } : {},
  );
}

/** Follow again, and allow the system's notification prompt. */
function allow(os) {
  const ask = { windows: dev.chromeAllow, macos: dev.macAllow, ios: dev.iosAllow, android: dev.andAllow }[os];
  const prompt = { windows: ".gd-cperm", macos: ".gd-mac-perm", ios: ".gd-ios-alert", android: ".gd-and-perm" }[os];
  const phone = isPhone(os);
  const root = phone ? SCREEN : ".gd-desk";
  const kind = phone ? "phone" : "desk";
  const html = () => {
    if (!phone) return dev.desk(os, deskBrowser(os, blog(os, os)), ask());
    return dev.phone(os, (os === "ios" ? dev.iosApp(blog(os, "app")) : dev.andChrome(blog(os, "android"))) + ask());
  };
  return scene(os, html, [
    { do: "wait", ms: 300 },
    { do: "press", at: FOLLOW[kind], then: (s) => s.set(root, "is-ask"), ms: 600 },
    focus(prompt, phone ? 1.8 : 2.2),
    {
      do: "press",
      at: ".gd-f-allow",
      then: (s) => {
        s.set(root, "is-ask", false);
        site.follow(s, true);
      },
      ms: 400,
    },
    // Back out to the whole page, where Follow has become the bell.
    WHOLE,
    { do: "move", at: BELL[kind], ms: 1600 },
  ]);
}

function step(tour, id, sceneSpec, key = id) {
  return { id, title: t(`tours.${tour}.steps.${key}.title`), body: t(`tours.${tour}.steps.${key}.body`), scene: sceneSpec };
}

function followTour(ctx, platform) {
  const os = PLATFORMS.includes(platform) ? platform : detectPlatform();
  const steps = [step("follow", "published", published(os))];
  if (os === "ios") steps.push(step("follow", "install", installIOS(), "install_ios"));
  if (os === "macos") steps.push(step("follow", "install", installMac(), "install_mac"));
  const first = step("follow", "signin", signin(os));
  if (ctx.signedIn && ctx.login) first.body += `<p class="gd-note">${tf("tours.follow.signed_in", { login: ctx.login })}</p>`;
  steps.push(
    first,
    step("follow", "register", register(os)),
    step("follow", "authorize", authorize(os, ctx.login || "your-name")),
    Object.assign(step("follow", "allow", allow(os)), { final: true }),
  );
  return {
    id: "follow",
    name: t("tours.follow.name"),
    steps,
    following: !!ctx.following,
    platform: os,
    platforms: PLATFORMS.map((id) => ({ id, name: t(`platforms.${id}`), icon: PLATFORM_ICONS[id] })),
    rebuild: (p) => followTour(ctx, p),
  };
}

// ─── comments ────────────────────────────────────────────────
// Authored on the old 360×225 canvas (`canvas`), in the mock kit of guide.styl.
const photo = (cls) => `<div class="gd-v-photo ${cls}"><i></i></div>`;

const comment = (name, body, reactions, cls = "") =>
  `<div class="gd-c-item ${cls}"><span class="gd-m-avatar"></span><div class="gd-c-main">` +
  `<div class="gd-c-meta"><b>${name}</b><small>${M("days_ago")}</small></div><div class="gd-c-text">${body}</div>` +
  `<div class="gd-c-react">${reactions}</div></div></div>`;

function threadScene() {
  return {
    canvas: true,
    cls: "gd-s-comments",
    html:
      `<div class="gd-c-head"><b>${M("comments_count")}</b><span class="gd-c-gh"><i class="fa-brands fa-github" aria-hidden="true"></i>GitHub Discussions</span></div>` +
      `<div class="gd-c-box"><span class="gd-m-btn gd-gh-dark gd-f-signin"><i class="fa-brands fa-github" aria-hidden="true"></i>${M("sign_in")}</span></div>` +
      comment("reader-one", M("sample_comment"), `<span>👍 3</span><span>❤️ 1</span>`, "gd-f-first") +
      comment("jason-jp-yang", M("sample_reply"), `<span>🎉 2</span>`, "is-reply"),
    beats: [
      { do: "move", at: ".gd-f-first", fx: 0.62, fy: 0.3, ms: 1200 },
      { do: "move", at: ".gd-f-first .gd-c-react", fx: 0.3, ms: 1100 },
      { do: "press", at: ".gd-f-signin", ms: 1300 },
    ],
  };
}

function writeScene() {
  return {
    canvas: true,
    cls: "gd-s-comments is-write",
    size: { w: 360, h: 300 },
    view: { x: 180, y: 112, zoom: 1 },
    html:
      `<div class="gd-c-box is-signed"><div class="gd-c-tabs"><span class="gd-c-tab is-on">${M("write")}</span>` +
      `<span class="gd-c-tab gd-f-preview">${M("preview")}</span></div>` +
      `<div class="gd-c-edit"><span class="gd-m-input gd-c-area gd-f-text"><span class="gd-m-val"></span><i class="gd-m-caret"></i></span>` +
      `<div class="gd-c-rendered">${t("mock.sample_rendered")}</div></div>` +
      `<div class="gd-c-actions"><span class="gd-m-btn gd-gh-green gd-f-send">${M("comment")}</span></div></div>` +
      `<div class="gd-c-list">` +
      comment("reader-one", M("sample_comment"), `<span>👍 3</span>`) +
      comment("your-name", t("mock.sample_rendered"), "", "gd-c-mine") +
      `</div>`,
    beats: [
      { do: "type", at: ".gd-f-text", text: t("mock.sample_markdown") },
      { do: "press", at: ".gd-f-preview", then: (s) => s.set(".gd-s-comments", "is-preview") },
      { do: "press", at: ".gd-f-send", then: (s) => s.set(".gd-s-comments", "is-sent"), ms: 500 },
      { do: "focus", view: { x: 180, y: 200, zoom: 1 }, ms: 800 },
      { do: "wait", ms: 1200 },
    ],
  };
}

function reactScene() {
  const picker = ["👍", "👎", "😄", "🎉", "😕", "❤️", "🚀", "👀"]
    .map((x) => `<span class="${x === "🎉" ? "gd-f-party" : ""}">${x}</span>`)
    .join("");
  return {
    canvas: true,
    cls: "gd-s-comments is-react",
    html:
      `<div class="gd-c-list">` +
      comment(
        "reader-one",
        M("sample_comment"),
        `<span class="gd-c-add gd-f-smile"><i class="fa-regular fa-face-smile" aria-hidden="true"></i></span><span>👍 3</span><span class="gd-c-party">🎉 1</span>`,
      ) +
      `</div><div class="gd-c-picker">${picker}</div>` +
      `<div class="gd-c-photo">${photo("p2")}<span class="gd-c-heart gd-f-heart"><i class="fa-regular fa-heart" aria-hidden="true"></i>` +
      `<i class="fa-solid fa-heart" aria-hidden="true"></i><b><span class="n0">4</span><span class="n1">5</span></b></span></div>`,
    beats: [
      { do: "press", at: ".gd-f-smile", then: (s) => s.set(".gd-s-comments", "is-pick") },
      {
        do: "press",
        at: ".gd-f-party",
        then: (s) => {
          s.set(".gd-s-comments", "is-pick", false);
          s.set(".gd-s-comments", "is-reacted");
        },
      },
      { do: "press", at: ".gd-f-heart", then: (s) => s.set(".gd-s-comments", "is-liked"), ms: 1500 },
    ],
  };
}

function commentsTour(ctx) {
  const os = detectPlatform();
  const steps = [step("comments", "thread", threadScene())];
  if (!ctx.signedIn) {
    steps.push(step("follow", "register", register(os)));
    steps.push(step("comments", "authorize", authorize(os, "your-name")));
  }
  steps.push(step("comments", "write", writeScene()));
  steps.push(step("comments", "react", reactScene()));
  return { id: "comments", name: t("tours.comments.name"), steps };
}

const TOURS = { follow: followTour, comments: commentsTour };
const ICONS = { follow: "fa-regular fa-bell", comments: "fa-regular fa-comments" };

export async function openTour(id, ctx, opts = {}) {
  const build = TOURS[id];
  if (!build) return null;
  await site.prepare();
  return new Tour(build(ctx || {}), opts).open();
}

export function openMenu(ctx, opts = {}) {
  ctx = ctx || {};
  const available = Object.keys(TOURS).filter((id) => id !== "follow" || ctx.notifications);
  const entries = available.map((id) => {
    const def = TOURS[id](ctx);
    return {
      id,
      icon: ICONS[id],
      name: def.name,
      desc: t(`tours.${id}.desc`),
      count: tf("menu_steps", { n: def.steps.length }),
    };
  });
  const build = async (id) => {
    if (!TOURS[id]) return null;
    await site.prepare();
    return TOURS[id](ctx);
  };
  return new Tour({ menu: true, entries, build }, opts).open();
}

export function closeAll() {
  Tour.closeCurrent();
}
