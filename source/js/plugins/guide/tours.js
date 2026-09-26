/**
 * Guide — the walkthroughs, as content.
 *
 * Every walkthrough is built for the reader in front of it: steps a signed-in
 * reader has already done are left out, the iPhone step is a required step on
 * an iPhone in Safari and an aside everywhere else, the permission prompt is
 * the one this device will actually show, and zooming is a pinch on a touch
 * screen and a scroll wheel elsewhere.
 *
 * The mocks borrow the blog's own labels from `notifications_i18n`, so the inbox
 * in a scene says exactly what the real one says. GitHub's pages are English
 * everywhere, so theirs are not translated.
 */

import { Tour } from "./tour.js";
import { t, tf, escapeHTML as e } from "./store.js";
import { firstShown } from "./dom.js";

const S = (k) => t(`scenes.${k}`);
const M = (k) => e(t(`mock.${k}`));
const N = (k, fallback) => e(((window.theme && window.theme.notifications_i18n) || {})[k] || fallback);

function host() {
  return (window.config && window.config.hostname) || location.hostname;
}

function site() {
  const el = document.querySelector(".navbar-content .logo-title");
  return (el && el.textContent.trim()) || host();
}

// Today, the way a lock screen in the reader's language would print it.
function today() {
  try {
    const lang = document.documentElement.lang || undefined;
    return new Intl.DateTimeFormat(lang, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  } catch {
    return "";
  }
}

// ─── mock kit ────────────────────────────────────────────────
const lines = (...widths) => `<div class="gd-m-lines">${widths.map((w) => `<i style="width:${w}%"></i>`).join("")}</div>`;

const browser = (url, inner, cls = "") =>
  `<div class="gd-m-browser ${cls}"><div class="gd-m-bar"><i></i><i></i><i></i>` +
  `<span class="gd-m-url"><i class="fa-solid fa-lock" aria-hidden="true"></i><span class="gd-m-url-text">${e(url)}</span></span></div>` +
  `<div class="gd-m-page">${inner}</div></div>`;

const nav = (right) =>
  `<div class="gd-m-nav"><span class="gd-m-logo">${e(site())}</span>` +
  `<span class="gd-m-links"><i></i><i></i><i></i></span><span class="gd-m-right">${right}</span></div>`;

const follow = (cls = "") =>
  `<span class="gd-m-follow ${cls}"><i class="fa-regular fa-bell" aria-hidden="true"></i>${N("follow_nav", "Follow")}</span>`;

const bell = (cls = "", badge = "") =>
  `<span class="gd-m-bell ${cls}"><i class="fa-regular fa-bell" aria-hidden="true"></i>` +
  `<b class="gd-m-badge">${badge}</b></span>`;

const field = (label, cls, type = "") =>
  `<div class="gd-m-field ${cls}"><span class="gd-m-label">${label}</span>` +
  `<span class="gd-m-input ${type}"><span class="gd-m-val"></span><i class="gd-m-caret"></i></span></div>`;

const toggle = (cls = "", on = false) => `<span class="gd-m-toggle ${cls}${on ? " is-on" : ""}"><i></i></span>`;

const phone = (screen, cls = "") =>
  `<div class="gd-m-phone ${cls}"><div class="gd-m-screen">` +
  `<div class="gd-ios-status"><span>9:41</span><span class="gd-ios-icons"><i class="fa-solid fa-signal" aria-hidden="true"></i>` +
  `<i class="fa-solid fa-wifi" aria-hidden="true"></i><i class="fa-solid fa-battery-full" aria-hidden="true"></i></span></div>` +
  `${screen}<div class="gd-m-island"></div><div class="gd-m-homebar"></div></div></div>`;

const photo = (cls) => `<div class="gd-v-photo ${cls}"><i></i></div>`;

// The site's own Home Screen icon, so the installed app in a scene is this blog.
function appIcon() {
  const link = document.querySelector('link[rel="apple-touch-icon"], link[rel="icon"]');
  const href = link && link.href ? String(link.href).replace(/["'()\\]/g, "") : "";
  return href ? `<span class="gd-m-appicon" style="background-image:url('${href}')"></span>` : `<span class="gd-m-appicon"></span>`;
}

// ─── scenes: following ───────────────────────────────────────
function feedScene() {
  const title = M("post_title");
  return {
    cls: "gd-s-feed",
    html:
      browser(
        host(),
        nav(bell("gd-f-bell") + '<span class="gd-m-avatar"></span>') +
          `<div class="gd-m-body">` +
          `<div class="gd-m-card gd-m-new"><span class="gd-m-chip">${M("new")}</span><b>${title}</b>${lines(88, 64)}</div>` +
          `<div class="gd-m-card"><b class="gd-m-skel"></b>${lines(92, 70)}</div>` +
          `<div class="gd-m-card"><b class="gd-m-skel"></b>${lines(80)}</div>` +
          `</div>` +
          `<i class="gd-m-fly"></i>` +
          `<div class="gd-m-drop"><div class="gd-m-drop-head">${N("title", "Notifications")}</div>` +
          `<div class="gd-m-drop-item is-unread"><i></i><b>${title}</b><small>${M("now")}</small></div>` +
          `<div class="gd-m-drop-item"><i></i><b>${M("note_title")}</b><small>2d</small></div></div>`,
      ) +
      `<div class="gd-m-toast">${appIcon()}<span class="gd-m-toast-text">` +
      `<b>${e(site())}</b><small>${M("push_title")} · ${title}</small></span></div>`,
    beats: [
      { do: "auto", say: S("new_post"), then: (s) => s.set(".gd-m-page", "is-new"), ms: 1200 },
      { do: "auto", say: S("to_inbox"), then: (s) => s.set(".gd-m-page", "is-sent"), ms: 1400 },
      { do: "auto", say: S("push"), then: (s) => s.set(".gd-s-feed", "is-toast"), ms: 1700 },
      { do: "press", at: ".gd-f-bell", say: S("open_bell"), then: (s) => s.set(".gd-m-page", "is-open"), ms: 1600 },
    ],
  };
}

function signupScene() {
  return {
    cls: "gd-s-signup",
    html: browser(
      "github.com/signup",
      `<div class="gd-gh">` +
        `<div class="gd-gh-panel gd-gh-form">` +
        `<div class="gd-gh-title"><i class="fa-brands fa-github" aria-hidden="true"></i>Sign up to GitHub</div>` +
        field("Email", "gd-f-email") +
        field("Password", "gd-f-pass") +
        field("Username", "gd-f-user") +
        `<span class="gd-m-btn gd-gh-dark gd-f-go">Continue</span></div>` +
        `<div class="gd-gh-panel gd-gh-verify"><div class="gd-gh-title">Verify your account</div>` +
        `<small>Solve this puzzle so we know you are a real person</small>` +
        `<div class="gd-gh-tiles"><i class="t1"><b class="fa-solid fa-dog"></b></i><i class="t2 gd-f-tile"><b class="fa-solid fa-dog"></b></i>` +
        `<i class="t3"><b class="fa-solid fa-dog"></b></i></div></div>` +
        `<div class="gd-gh-panel gd-gh-code"><div class="gd-gh-title">Confirm your email address</div>` +
        `<small>Enter the code sent to you@example.com</small>` +
        `<span class="gd-m-input gd-gh-digits gd-f-code"><span class="gd-m-val"></span><i class="gd-m-caret"></i></span></div>` +
        `<div class="gd-gh-panel gd-gh-done"><i class="fa-solid fa-circle-check" aria-hidden="true"></i><b>Welcome to GitHub</b>` +
        `<small>@your-name</small></div>` +
        `</div>`,
    ),
    beats: [
      { do: "type", at: ".gd-f-email", text: "you@example.com", say: S("email") },
      { do: "type", at: ".gd-f-pass", text: "correct-horse", mask: true, say: S("password") },
      { do: "type", at: ".gd-f-user", text: "your-name", say: S("username") },
      { do: "press", at: ".gd-f-go", say: S("create"), then: (s) => s.set(".gd-gh", "is-verify") },
      { do: "press", at: ".gd-f-tile", say: S("puzzle"), then: (s) => s.set(".gd-gh", "is-code") },
      { do: "type", at: ".gd-f-code", text: "48152673", say: S("code") },
      { do: "auto", say: S("welcome"), then: (s) => s.set(".gd-gh", "is-done"), ms: 1600 },
    ],
  };
}

function authorizeScene(variant) {
  const fromComments = variant === "comments";
  const blog = fromComments
    ? `<div class="gd-auth-blog is-comments">${lines(90, 84, 60)}<div class="gd-c-box">` +
      `<span class="gd-m-btn gd-gh-dark gd-f-start"><i class="fa-brands fa-github" aria-hidden="true"></i>${M("sign_in")}</span>` +
      `<span class="gd-c-signed"><span class="gd-m-avatar"></span><span class="gd-m-input"><span class="gd-m-val">${M("write_comment")}</span></span></span></div></div>`
    : `<div class="gd-auth-blog">` +
      nav(follow("gd-f-start") + '<span class="gd-m-avatar gd-auth-me"></span>') +
      `<div class="gd-m-body">${lines(92, 86, 70, 90, 54)}</div>` +
      `<span class="gd-m-okay"><i class="fa-solid fa-circle-check" aria-hidden="true"></i>${M("signed_in")}</span></div>`;

  return {
    cls: "gd-s-auth",
    html: browser(
      host(),
      blog +
        `<div class="gd-auth-gh"><div class="gd-auth-pair"><span class="gd-auth-app">g</span>` +
        `<span class="gd-auth-dots"><i></i><i></i><i></i></span><span class="gd-m-avatar"></span></div>` +
        `<div class="gd-gh-title">Authorize giscus</div>` +
        `<div class="gd-auth-sub"><b>giscus</b> by giscus would like permission to:</div>` +
        `<ul class="gd-auth-perms">` +
        `<li><i class="fa-regular fa-id-badge" aria-hidden="true"></i>Verify your GitHub identity (your-name)</li>` +
        `<li><i class="fa-regular fa-folder-open" aria-hidden="true"></i>Know which resources you can access</li>` +
        `<li><i class="fa-regular fa-user-pen" aria-hidden="true"></i>Act on your behalf</li></ul>` +
        `<span class="gd-m-btn gd-gh-green gd-f-auth">Authorize giscus</span>` +
        `<small class="gd-auth-note">Authorizing will redirect to https://giscus.app</small></div>` +
        `<div class="gd-auth-wait"><i class="gd-m-spin"></i>${M("redirecting")}</div>`,
    ),
    beats: [
      {
        do: "press",
        at: ".gd-f-start",
        say: S(fromComments ? "press_signin" : "press_follow"),
        then: (s) => {
          s.set(".gd-m-page", "is-gh");
          s.text(".gd-m-url-text", "github.com/login/oauth/authorize");
        },
      },
      { do: "wait", say: S("to_github"), ms: 1200 },
      { do: "press", at: ".gd-f-auth", say: S("authorize"), then: (s) => s.set(".gd-m-page", "is-wait") },
      {
        do: "auto",
        say: S("signed_in"),
        then: (s) => {
          s.set(".gd-m-page", "is-back");
          s.text(".gd-m-url-text", host());
        },
        ms: 1800,
      },
    ],
  };
}

function iosScreen() {
  const rows = [
    ["ios_copy", "fa-regular fa-copy"],
    ["ios_reading_list", "fa-regular fa-glasses"],
    ["ios_bookmark", "fa-regular fa-book"],
    ["ios_favorites", "fa-regular fa-star"],
    ["ios_quick_note", "fa-regular fa-note-sticky"],
    ["ios_find", "fa-regular fa-magnifying-glass"],
    ["ios_add_home", "fa-regular fa-square-plus", "gd-f-home"],
    ["ios_markup", "fa-regular fa-pen-nib"],
    ["ios_print", "fa-regular fa-print"],
  ];
  const apps = Array.from({ length: 11 }, (_, i) => `<i class="a${i % 8}"></i>`).join("");
  return (
    `<div class="gd-ios-safari">` +
    `<div class="gd-ios-page">${nav(follow())}${lines(90, 76, 88, 60, 84, 70, 92, 50)}</div>` +
    `<div class="gd-ios-bar"><span class="gd-ios-btn"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></span>` +
    `<span class="gd-ios-addr">${e(host())}</span>` +
    `<span class="gd-ios-btn gd-f-more"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></span></div>` +
    `<div class="gd-ios-menu"><div class="gd-ios-mi gd-f-share"><span>${M("ios_share")}</span>` +
    `<i class="fa-regular fa-arrow-up-from-bracket" aria-hidden="true"></i></div>` +
    `<div class="gd-ios-mi"><span>${M("ios_bookmark")}</span><i class="fa-regular fa-book" aria-hidden="true"></i></div>` +
    `<div class="gd-ios-mi"><span>${M("ios_reader")}</span><i class="fa-regular fa-align-left" aria-hidden="true"></i></div></div>` +
    `<div class="gd-ios-sheet"><div class="gd-ios-sheet-head">${appIcon()}` +
    `<span><b>${e(site())}</b><small>${e(host())}</small></span></div>` +
    `<div class="gd-ios-list"><div class="gd-ios-scroll">` +
    rows
      .map(([k, icon, cls = ""]) => `<div class="gd-ios-row ${cls}"><span>${M(k)}</span><i class="${icon}" aria-hidden="true"></i></div>`)
      .join("") +
    `</div></div></div>` +
    `<div class="gd-ios-add"><div class="gd-ios-add-head"><span>${M("ios_cancel")}</span><b>${M("ios_add_home")}</b>` +
    `<span class="gd-ios-add-go gd-f-add">${M("ios_add")}</span></div>` +
    `<div class="gd-ios-add-card">${appIcon()}<span><b>${e(site())}</b><small>${e(host())}</small></span></div>` +
    `<div class="gd-ios-add-row"><span>${M("ios_web_app")}</span>${toggle("gd-f-webapp")}</div></div>` +
    `</div>` +
    `<div class="gd-ios-home"><div class="gd-ios-grid">${apps}<span class="gd-ios-new gd-f-icon">${appIcon()}` +
    `<small>${e(site())}</small></span></div><div class="gd-ios-dock"><i class="a1"></i><i class="a3"></i><i class="a5"></i><i class="a7"></i></div></div>` +
    `<div class="gd-ios-app">${nav(follow())}${lines(88, 72, 90, 64, 80)}</div>`
  );
}

function pwaScene() {
  return {
    cls: "gd-s-pwa",
    size: { w: 360, h: 420 },
    camera: { x: 180, y: 297, zoom: 1.2 },
    park: { x: 256, y: 372 },
    html: phone(iosScreen()),
    beats: [
      { do: "press", at: ".gd-f-more", say: S("tap_more"), then: (s) => s.set(".gd-m-phone", "is-menu") },
      {
        do: "press",
        at: ".gd-f-share",
        say: S("tap_share"),
        then: (s) => {
          s.set(".gd-m-phone", "is-menu", false);
          s.set(".gd-m-phone", "is-sheet");
        },
      },
      { do: "swipe", at: ".gd-ios-list", fy: 0.8, dy: -46, say: S("scroll"), then: (s) => s.set(".gd-m-phone", "is-scrolled") },
      { do: "press", at: ".gd-f-home", say: S("tap_add_home"), then: (s) => s.set(".gd-m-phone", "is-add") },
      { do: "focus", x: 180, y: 118, zoom: 1.2, ms: 650 },
      { do: "press", at: ".gd-f-webapp", say: S("web_app"), then: (s) => s.set(".gd-f-webapp", "is-on") },
      { do: "press", at: ".gd-f-add", say: S("tap_add"), then: (s) => s.set(".gd-m-phone", "is-home") },
      { do: "focus", x: 180, y: 120, zoom: 1.2, ms: 650 },
      { do: "wait", say: S("on_home"), ms: 900 },
      { do: "press", at: ".gd-f-icon", say: S("open_icon"), then: (s) => s.set(".gd-m-phone", "is-app"), ms: 1600 },
    ],
  };
}

function allowScene(ctx) {
  const mobile = ctx.ios || ctx.android;
  if (!mobile) {
    return {
      cls: "gd-s-allow",
      html:
        browser(
          host(),
          nav(follow("gd-f-follow") + bell("gd-m-bell-new") + '<span class="gd-m-avatar"></span>') +
            `<div class="gd-m-body">${lines(92, 80, 88, 66, 90)}</div>` +
            `<span class="gd-m-okay"><i class="fa-solid fa-circle-check" aria-hidden="true"></i>${M("followed")}</span>`,
        ) +
        `<div class="gd-perm"><div class="gd-perm-head">${tf("mock.perm_wants", { host: host() })}</div>` +
        `<div class="gd-perm-row"><i class="fa-regular fa-bell" aria-hidden="true"></i>${M("perm_show")}</div>` +
        `<div class="gd-perm-btns"><span class="gd-m-btn gd-perm-no">${M("perm_block")}</span>` +
        `<span class="gd-m-btn gd-perm-yes gd-f-allow">${M("perm_allow")}</span></div></div>`,
      beats: [
        { do: "press", at: ".gd-f-follow", say: S("press_follow"), then: (s) => s.set(".gd-s-allow", "is-ask") },
        { do: "press", at: ".gd-f-allow", say: S("allow"), then: (s) => s.set(".gd-s-allow", "is-allowed") },
        { do: "wait", say: S("now_bell"), ms: 1700 },
      ],
    };
  }

  const prompt = ctx.ios
    ? `<div class="gd-ios-alert"><b>${tf("mock.ios_alert", { site: site() })}</b><small>${M("ios_alert_body")}</small>` +
      `<div class="gd-ios-alert-btns"><span>${M("ios_dont")}</span><span class="gd-f-allow">${M("ios_allow")}</span></div></div>`
    : `<div class="gd-and-perm"><i class="fa-regular fa-bell" aria-hidden="true"></i>` +
      `<b>${tf("mock.perm_android", { host: host() })}</b>` +
      `<div class="gd-and-btns"><span>${M("perm_block")}</span><span class="gd-f-allow">${M("perm_allow")}</span></div></div>`;
  return {
    cls: "gd-s-allow is-phone",
    size: { w: 360, h: 420 },
    camera: { x: 180, y: 112, zoom: 1.2 },
    park: { x: 250, y: 150 },
    html: phone(
      `<div class="gd-ios-app is-on">${nav(follow("gd-f-follow") + bell("gd-m-bell-new"))}${lines(88, 72, 90, 64, 80, 70)}</div>` +
        `<div class="gd-phone-dim"></div>${prompt}`,
    ),
    beats: [
      { do: "press", at: ".gd-f-follow", say: S("press_follow"), then: (s) => s.set(".gd-m-phone", "is-ask") },
      { do: "focus", x: 180, y: ctx.ios ? 210 : 330, zoom: 1.2, ms: 600 },
      { do: "press", at: ".gd-f-allow", say: S("allow"), then: (s) => s.set(".gd-m-phone", "is-allowed") },
      { do: "focus", x: 180, y: 112, zoom: 1.2, ms: 600 },
      { do: "wait", say: S("now_bell"), ms: 1600 },
    ],
  };
}

function inboxScene() {
  const item = (cls, title, meta) =>
    `<div class="gd-np-item ${cls}"><i></i><span><b>${title}</b><small>${meta}</small></span></div>`;
  return {
    cls: "gd-s-inbox",
    html:
      browser(host(), nav(bell("gd-f-bell has-count", "3") + '<span class="gd-m-avatar"></span>') + `<div class="gd-m-body">${lines(92, 84, 70, 88, 60)}</div>`) +
      `<div class="gd-np"><div class="gd-np-head"><b>${N("title", "Notifications")}</b><small>${N("mark_read", "Mark all read")}</small></div>` +
      `<div class="gd-np-view"><div class="gd-np-pages">` +
      `<div class="gd-np-page">` +
      item("is-unread", M("post_title"), M("now")) +
      item("is-unread", M("note_title"), "3h") +
      item("is-unread", M("announce_title"), "1d") +
      `<div class="gd-np-foot gd-f-manage">${N("manage", "Manage subscription")}<i class="fa-solid fa-chevron-right" aria-hidden="true"></i></div></div>` +
      `<div class="gd-np-page"><div class="gd-np-sec">${N("section_delivery", "What you receive")}</div>` +
      `<div class="gd-np-row"><span>${N("opt_posts", "Receive new blog posts")}</span>${toggle("", true)}</div>` +
      `<div class="gd-np-row"><span>${N("opt_notes", "Receive new instant notes")}</span>${toggle("gd-f-notes", true)}</div>` +
      `<div class="gd-np-row"><span>${N("opt_announcements", "Receive blog announcements")}</span>${toggle("", true)}</div>` +
      `<div class="gd-np-sec">${N("section_devices", "Registered devices")}</div>` +
      `<div class="gd-np-dev"><i class="fa-regular fa-laptop" aria-hidden="true"></i><span>${N("this_browser", "This browser")}</span>` +
      `<small>${N("device_laptop", "Laptop")}</small></div></div>` +
      `</div></div></div>`,
    beats: [
      { do: "press", at: ".gd-f-bell", say: S("open_inbox"), then: (s) => s.set(".gd-s-inbox", "is-open"), ms: 1300 },
      { do: "press", at: ".gd-f-manage", say: S("manage"), then: (s) => s.set(".gd-s-inbox", "is-manage"), ms: 1000 },
      { do: "press", at: ".gd-f-notes", say: S("toggle_topic"), then: (s) => s.set(".gd-f-notes", "is-on", false) },
    ],
  };
}

function pushScene(ctx) {
  const title = M("post_title");
  if (ctx.ios || ctx.android) {
    return {
      cls: "gd-s-push is-phone",
      size: { w: 360, h: 420 },
      camera: { x: 180, y: 120, zoom: 1.2 },
      park: { x: 250, y: 200 },
      html: phone(
        `<div class="gd-lock"><div class="gd-lock-time">9:41</div><div class="gd-lock-date">${e(today())}</div>` +
          `<div class="gd-lock-note gd-f-note">${appIcon()}<span><b>${e(site())}</b>` +
          `<small>${M("push_title")}: ${title}</small></span><em>${M("now")}</em></div></div>` +
          `<div class="gd-ios-app gd-push-post">${nav("")}<div class="gd-post-title">${title}</div>${lines(90, 80, 86, 62, 88)}</div>`,
      ),
      beats: [
        { do: "auto", say: S("arrives"), then: (s) => s.set(".gd-m-phone", "is-note"), ms: 1400 },
        { do: "press", at: ".gd-f-note", say: S("open_post"), then: (s) => s.set(".gd-m-phone", "is-post"), ms: 1600 },
      ],
    };
  }
  return {
    cls: "gd-s-push",
    html:
      `<div class="gd-desk">` +
      browser("example.com", `<div class="gd-m-body">${lines(80, 92, 70, 86, 60, 90)}</div>`, "gd-desk-win") +
      browser(host(), nav("") + `<div class="gd-m-body"><div class="gd-post-title">${title}</div>${lines(90, 84, 70, 88)}</div>`, "gd-desk-post") +
      `<div class="gd-toast gd-f-note">${appIcon()}<span><b>${e(site())}</b>` +
      `<small>${e(host())}</small><em>${M("push_title")}: ${title}</em></span></div></div>`,
    beats: [
      { do: "auto", say: S("arrives"), then: (s) => s.set(".gd-desk", "is-note"), ms: 1400 },
      { do: "press", at: ".gd-f-note", say: S("open_post"), then: (s) => s.set(".gd-desk", "is-post"), ms: 1700 },
    ],
  };
}

function checklistScene(rows) {
  return {
    cls: "gd-s-check",
    html:
      `<div class="gd-check">` +
      rows.map((r) => `<div class="gd-check-row"><i class="fa-solid fa-circle-check" aria-hidden="true"></i><span>${e(r)}</span></div>`).join("") +
      `</div>`,
    beats: rows.map((_, i) => ({
      do: "auto",
      then: (s) => s.world.querySelectorAll(".gd-check-row")[i].classList.add("is-on"),
      ms: 520,
    })),
    hold: 3200,
  };
}

// ─── scenes: the image viewer ────────────────────────────────
function viewerWorld(state) {
  return {
    cls: `gd-s-viewer ${state}`,
    html:
      `<div class="gd-v-article">${lines(92, 84, 70)}<div class="gd-v-thumb gd-f-img">${photo("p1")}</div>${lines(90, 66)}</div>` +
      `<div class="gd-v-backdrop gd-f-backdrop"></div>` +
      `<div class="gd-v-frame"><div class="gd-v-track">${photo("p1 gd-f-full")}${photo("p2")}</div></div>` +
      `<span class="gd-v-side prev"><i class="fa-regular fa-angle-left" aria-hidden="true"></i></span>` +
      `<span class="gd-v-side next gd-f-next"><i class="fa-regular fa-angle-right" aria-hidden="true"></i></span>` +
      `<div class="gd-v-switch"><i class="fa-regular fa-angle-left" aria-hidden="true"></i><span class="gd-v-dots"><b></b><b></b><b></b></span>` +
      `<i class="fa-regular fa-angle-right" aria-hidden="true"></i></div>` +
      `<span class="gd-v-info gd-f-info"><i class="fa-solid fa-comment-image" aria-hidden="true"></i></span>` +
      `<div class="gd-v-panel"><b>${M("photo_caption")}</b>` +
      `<dl><dt>${M("exif_camera")}</dt><dd>X100VI</dd><dt>${M("exif_lens")}</dt><dd>23mm</dd>` +
      `<dt>${M("exif_exposure")}</dt><dd>f/2.8 · 1/500s</dd><dt>ISO</dt><dd>160</dd></dl></div>`,
  };
}

function viewerScenes(ctx) {
  const open = Object.assign(viewerWorld(""), {
    beats: [
      { do: "press", at: ".gd-f-img", say: S("tap_image"), then: (s) => s.set(".gd-s-viewer", "is-open"), ms: 1500 },
    ],
  });
  const zoom = Object.assign(viewerWorld("is-open is-still"), {
    beats: [
      ctx.touch
        ? { do: "pinch", at: ".gd-v-frame", fx: 0.58, fy: 0.46, say: S("pinch"), then: (s) => s.set(".gd-s-viewer", "is-zoom"), ms: 1300 }
        : { do: "wheel", at: ".gd-v-frame", fx: 0.58, fy: 0.46, say: S("wheel"), then: (s) => s.set(".gd-s-viewer", "is-zoom"), ms: 1300 },
      { do: "wait", ms: 900 },
    ],
  });
  const pan = Object.assign(viewerWorld("is-open is-still is-zoom"), {
    beats: [
      { do: "swipe", at: ".gd-v-frame", fx: 0.55, fy: 0.55, dx: -58, dy: -22, ms: 800, say: S("drag"), then: (s) => s.set(".gd-s-viewer", "is-pan") },
      { do: "press", at: ".gd-f-next", say: S(ctx.touch ? "swipe_next" : "next_image"), then: (s) => s.set(".gd-s-viewer", "is-next"), ms: 1500 },
    ],
  });
  const info = Object.assign(viewerWorld("is-open is-still"), {
    beats: [
      { do: "press", at: ".gd-f-info", say: S("info"), then: (s) => s.set(".gd-s-viewer", "is-info"), ms: 1900 },
      { do: "press", at: ".gd-f-backdrop", fx: 0.08, fy: 0.9, say: S("close_viewer"), then: (s) => s.set(".gd-s-viewer", "is-closed"), ms: 1500 },
    ],
  });
  return { open, zoom, pan, info };
}

// ─── scenes: comments ────────────────────────────────────────
const comment = (name, body, reactions, cls = "") =>
  `<div class="gd-c-item ${cls}"><span class="gd-m-avatar"></span><div class="gd-c-main">` +
  `<div class="gd-c-meta"><b>${name}</b><small>${M("days_ago")}</small></div><div class="gd-c-text">${body}</div>` +
  `<div class="gd-c-react">${reactions}</div></div></div>`;

function threadScene() {
  return {
    cls: "gd-s-comments",
    html:
      `<div class="gd-c-head"><b>${M("comments_count")}</b><span class="gd-c-gh"><i class="fa-brands fa-github" aria-hidden="true"></i>GitHub Discussions</span></div>` +
      `<div class="gd-c-box"><span class="gd-m-btn gd-gh-dark gd-f-signin"><i class="fa-brands fa-github" aria-hidden="true"></i>${M("sign_in")}</span></div>` +
      comment("reader-one", M("sample_comment"), `<span>👍 3</span><span>❤️ 1</span>`, "gd-f-first") +
      comment("jason-jp-yang", M("sample_reply"), `<span>🎉 2</span>`, "is-reply"),
    beats: [
      { do: "move", at: ".gd-f-first", fx: 0.62, fy: 0.3, say: S("thread"), ms: 1200 },
      { do: "move", at: ".gd-f-first .gd-c-react", fx: 0.3, say: S("reactions"), ms: 1100 },
      { do: "press", at: ".gd-f-signin", say: S("sign_in_box"), ms: 1300 },
    ],
  };
}

function writeScene() {
  return {
    cls: "gd-s-comments is-write",
    size: { w: 360, h: 300 },
    camera: { x: 180, y: 112, zoom: 1 },
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
      { do: "type", at: ".gd-f-text", text: t("mock.sample_markdown"), say: S("type_comment") },
      { do: "press", at: ".gd-f-preview", say: S("preview"), then: (s) => s.set(".gd-s-comments", "is-preview") },
      { do: "press", at: ".gd-f-send", say: S("send"), then: (s) => s.set(".gd-s-comments", "is-sent"), ms: 500 },
      { do: "focus", x: 180, y: 200, zoom: 1, ms: 800 },
      { do: "wait", ms: 1200 },
    ],
  };
}

function reactScene() {
  const picker = ["👍", "👎", "😄", "🎉", "😕", "❤️", "🚀", "👀"]
    .map((x) => `<span class="${x === "🎉" ? "gd-f-party" : ""}">${x}</span>`)
    .join("");
  return {
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
      { do: "press", at: ".gd-f-smile", say: S("react"), then: (s) => s.set(".gd-s-comments", "is-pick") },
      {
        do: "press",
        at: ".gd-f-party",
        then: (s) => {
          s.set(".gd-s-comments", "is-pick", false);
          s.set(".gd-s-comments", "is-reacted");
        },
      },
      { do: "press", at: ".gd-f-heart", say: S("heart"), then: (s) => s.set(".gd-s-comments", "is-liked"), ms: 1500 },
    ],
  };
}

// ─── walkthroughs ────────────────────────────────────────────
const followTarget = () =>
  firstShown([".navbar-content .navbar-follow .follow-trigger", ".home-content-container .follow-cta", ".follow-cta"]);
const bellTarget = () =>
  firstShown([".navbar-list .notifications-bell", ".navbar-content .mobile .notifications-bell"]);

function step(tour, id, scene, extra = {}) {
  return Object.assign(
    { id, title: t(`tours.${tour}.steps.${id}.title`), body: t(`tours.${tour}.steps.${id}.body`), scene },
    extra,
  );
}

function followTour(ctx) {
  const steps = [];
  const signed = ctx.signedIn;
  const why = step("follow", "why", feedScene());
  if (signed && ctx.login) why.body += `<p class="gd-note">${tf("tours.follow.signed_in", { login: ctx.login })}</p>`;
  steps.push(why);
  if (!signed) {
    steps.push(step("follow", "github", signupScene()));
    steps.push(step("follow", "authorize", authorizeScene("follow")));
  }
  if (ctx.ios && !ctx.standalone) steps.push(step("follow", "ios", pwaScene()));
  steps.push(step("follow", "allow", allowScene(ctx)));
  steps.push(step("follow", "inbox", inboxScene()));
  steps.push(step("follow", "push", pushScene(ctx)));
  if (!ctx.ios) steps.push(step("follow", "iphone", pwaScene()));

  const rows = [t("mock.check_github"), t("mock.check_authorize"), t("mock.check_allow")];
  if (ctx.ios) rows.push(t("mock.check_home"));
  const following = ctx.following;
  steps.push(
    step("follow", following ? "ready_following" : "ready_off", checklistScene(rows), {
      live: following ? bellTarget : followTarget,
      liveTitle: t(`tours.follow.steps.${following ? "ready_following" : "ready"}.title`),
      liveBody: t(`tours.follow.steps.${following ? "ready_following" : "ready"}.body`),
    }),
  );
  return { id: "follow", name: t("tours.follow.name"), steps };
}

function viewerTour(ctx) {
  const s = viewerScenes(ctx);
  return {
    id: "viewer",
    name: t("tours.viewer.name"),
    steps: [
      step("viewer", "open", s.open),
      step("viewer", "zoom", s.zoom),
      step("viewer", "pan", s.pan),
      step("viewer", "info", s.info),
    ],
  };
}

function commentsTour(ctx) {
  const steps = [step("comments", "thread", threadScene())];
  if (!ctx.signedIn) {
    steps.push(step("follow", "github", signupScene()));
    steps.push(step("comments", "authorize", authorizeScene("comments")));
  }
  steps.push(step("comments", "write", writeScene()));
  steps.push(step("comments", "react", reactScene()));
  return { id: "comments", name: t("tours.comments.name"), steps };
}

const TOURS = { follow: followTour, viewer: viewerTour, comments: commentsTour };
const ICONS = { follow: "fa-regular fa-bell", viewer: "fa-regular fa-image", comments: "fa-regular fa-comments" };

export function openTour(id, ctx, opts = {}) {
  const build = TOURS[id];
  if (!build) return Promise.resolve(null);
  return new Tour(build(ctx || {}), opts).open();
}

export function openMenu(ctx, opts = {}) {
  ctx = ctx || {};
  const available = Object.keys(TOURS).filter((id) => id !== "follow" || (ctx && ctx.notifications));
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
  return new Tour({ menu: true, entries, build: (id) => (TOURS[id] ? TOURS[id](ctx) : null) }, opts).open();
}

export function closeAll() {
  Tour.closeCurrent();
}
