/**
 * Guide mocks — the devices following happens on.
 *
 * A Mac, a Windows PC, an iPhone and an Android phone, each with the browser,
 * the notification and the permission prompt it really shows, at real size: a
 * scene is authored in device pixels and the camera frames it. Drawn in DOM and
 * CSS (guide-mock.styl) over the systems' own wallpapers (images/guide); Apple's
 * app icons are its own (apple.js), the rest are drawn in icons.js.
 */

import { t, tf, escapeHTML as e } from "../store.js";
import { finder, trash, chrome, edge, windowsLogo, explorer, taskView, STATUS } from "./icons.js";
import { appIcon } from "./apple.js";

export const DESK = { w: 1280, h: 800 };
// The phone and the room its shadow falls in.
export const PHONE = { w: 490, h: 964 };

// The page area of each browser, in its world, and the height `svh` resolves to.
export const VIEW = {
  macos: { w: 1100, h: 602 },
  windows: { w: 1120, h: 596 },
  safari: { w: 390, h: 790, vh: 706 },
  app: { w: 390, h: 790 },
  inapp: { w: 390, h: 746 },
  android: { w: 390, h: 736 },
};

const M = (k) => e(t(`mock.${k}`));

export const host = () => (window.config && window.config.hostname) || location.hostname;

export function siteName() {
  const el = document.querySelector(".navbar-content .logo-title");
  return (el && el.textContent.trim()) || host();
}

/** The blog's own icon, transparency and all; the primary colour stands in for a site without one. */
export function blogIcon(cls = "") {
  const link = document.querySelector('link[rel="apple-touch-icon"], link[rel="icon"]');
  const href = link && link.href ? String(link.href).replace(/["'()\\]/g, "") : "";
  return href
    ? `<span class="gd-blogicon ${cls}" style="background-image:url('${href}')"></span>`
    : `<span class="gd-blogicon is-empty ${cls}"></span>`;
}

function lang() {
  return document.documentElement.lang || undefined;
}

function format(opts) {
  try {
    return new Intl.DateTimeFormat(lang(), opts).format(new Date());
  } catch {
    return "";
  }
}

const lights = '<span class="gd-lights"><i></i><i></i><i></i></span>';

// ═══ macOS ═══════════════════════════════════════════════════
const MENUS = ["file", "edit", "view", "history", "bookmarks", "window", "help"];
const DOCK = ["safari", "facetime", "findmy", "music", "voicememos", "clock", "shortcuts", "appstore"];

function macBar() {
  return (
    '<div class="gd-mac-bar"><span class="gd-mac-menus"><i class="fa-brands fa-apple" aria-hidden="true"></i><b>Safari</b>' +
    MENUS.map((m) => `<span class="gd-mac-m gd-f-${m}">${M(`mac_${m}`)}</span>`).join("") +
    '</span><span class="gd-mac-status"><i class="fa-solid fa-battery-full" aria-hidden="true"></i>' +
    '<i class="fa-solid fa-wifi" aria-hidden="true"></i><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>' +
    '<i class="fa-solid fa-sliders-simple" aria-hidden="true"></i>' +
    `<span>${e(format({ weekday: "short", month: "short", day: "numeric" }))}&nbsp; 9:41</span></span></div>`
  );
}

function macDock() {
  return (
    `<div class="gd-dock"><span class="gd-dock-i is-run">${finder()}</span>` +
    DOCK.map((k) => `<span class="gd-dock-i${k === "safari" ? " is-run" : ""}">${appIcon(k)}</span>`).join("") +
    `<span class="gd-dock-i gd-dock-new">${blogIcon()}</span>` +
    `<span class="gd-dock-sep"></span><span class="gd-dock-i is-bare">${trash()}</span></div>`
  );
}

/** Safari on a Mac, showing `page` at `url`. */
export function macSafari(page, url = host()) {
  return (
    `<div class="gd-mw">` +
    `<div class="gd-mw-bar">${lights}` +
    '<span class="gd-mw-ic"><i class="fa-regular fa-sidebar" aria-hidden="true"></i></span>' +
    '<span class="gd-mw-ic is-dim"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></span>' +
    '<span class="gd-mw-ic is-dim"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></span>' +
    `<span class="gd-mw-addr"><i class="fa-solid fa-lock" aria-hidden="true"></i><span class="gd-url">${e(url)}</span></span>` +
    '<span class="gd-mw-ic gd-f-share"><i class="fa-regular fa-arrow-up-from-bracket" aria-hidden="true"></i></span>' +
    '<span class="gd-mw-ic"><i class="fa-regular fa-plus" aria-hidden="true"></i></span>' +
    '<span class="gd-mw-ic"><i class="fa-regular fa-clone" aria-hidden="true"></i></span></div>' +
    `<div class="gd-page">${page}</div></div>`
  );
}

/** Safari's File menu, open under the menu bar. */
export function macFileMenu() {
  const rows = [
    ["new_window", "⌘N"],
    ["new_private", "⇧⌘N"],
    ["new_tab", "⌘T"],
    ["open_file", "⌘O"],
    ["open_location", "⌘L"],
    null,
    ["close_window", "⇧⌘W"],
    ["close_all", "⌥⌘W"],
    ["close_tab", "⌘W"],
    ["save_as", "⌘S"],
    null,
    ["share", "›"],
    ["export_pdf", ""],
    ["add_dock", "", "gd-f-dock"],
    null,
    ["print", "⌘P"],
  ];
  return (
    '<div class="gd-mac-menu">' +
    rows
      .map((r) =>
        r
          ? `<div class="gd-mac-row ${r[2] || ""}"><span>${M(`mac_${r[0]}`)}</span><kbd>${r[1]}</kbd></div>`
          : '<div class="gd-mac-sep"></div>',
      )
      .join("") +
    "</div>"
  );
}

/** Safari's "Add to Dock" sheet. */
export function macAddDock() {
  return (
    '<div class="gd-mac-sheet gd-mac-add">' +
    `<div class="gd-mac-add-icon">${blogIcon()}</div>` +
    `<div class="gd-mac-add-main"><b>${M("mac_add_title")}</b>` +
    `<label>${M("mac_name")}</label><span class="gd-mac-field">${e(siteName())}</span>` +
    `<small>${e(host())}</small></div>` +
    `<div class="gd-mac-btns"><span class="gd-mac-btn">${M("ios_cancel")}</span>` +
    `<span class="gd-mac-btn is-default gd-f-add">${M("mac_add")}</span></div></div>`
  );
}

/** Safari asking whether the site may send notifications. */
export function macAllow() {
  return (
    '<div class="gd-mac-sheet gd-mac-perm">' +
    '<span class="gd-mac-perm-icon"><i class="fa-regular fa-bell" aria-hidden="true"></i></span>' +
    `<b>${tf("mock.mac_alert", { host: host() })}</b><p>${M("mac_alert_body")}</p>` +
    `<div class="gd-mac-btns"><span class="gd-mac-btn">${M("ios_dont")}</span>` +
    `<span class="gd-mac-btn is-default gd-f-allow">${M("ios_allow")}</span></div></div>`
  );
}

// ═══ Windows ═════════════════════════════════════════════════
function taskbar() {
  const pin = (svg, cls = "") => `<span class="gd-tb-i ${cls}">${svg}</span>`;
  return (
    '<div class="gd-taskbar"><span class="gd-tb-mid">' +
    pin(windowsLogo()) +
    `<span class="gd-tb-search"><i class="fa-regular fa-magnifying-glass" aria-hidden="true"></i>${M("win_search")}</span>` +
    pin(taskView()) + pin(explorer()) + pin(edge()) + pin(chrome(), "is-run") +
    '</span><span class="gd-tb-tray"><i class="fa-solid fa-chevron-up" aria-hidden="true"></i><i class="fa-solid fa-wifi" aria-hidden="true"></i>' +
    '<i class="fa-solid fa-volume-high" aria-hidden="true"></i><i class="fa-solid fa-battery-full" aria-hidden="true"></i>' +
    `<span class="gd-tb-clock"><span>9:41</span><span>${e(format({ year: "numeric", month: "numeric", day: "numeric" }))}</span></span>` +
    '<i class="fa-regular fa-bell" aria-hidden="true"></i></span></div>'
  );
}

/** Chrome on Windows, one tab, showing `page`. */
export function winChrome(page, { title = siteName(), url = host(), icon = blogIcon() } = {}) {
  return (
    '<div class="gd-cw"><div class="gd-cw-tabs">' +
    `<span class="gd-cw-tab">${icon}<span class="gd-cw-title">${e(title)}</span><i class="fa-regular fa-xmark" aria-hidden="true"></i></span>` +
    '<span class="gd-cw-new"><i class="fa-regular fa-plus" aria-hidden="true"></i></span>' +
    '<span class="gd-cw-ctl"><i class="fa-regular fa-minus" aria-hidden="true"></i><i class="fa-regular fa-square" aria-hidden="true"></i>' +
    '<i class="fa-regular fa-xmark" aria-hidden="true"></i></span></div>' +
    '<div class="gd-cw-bar"><i class="fa-regular fa-arrow-left" aria-hidden="true"></i><i class="fa-regular fa-arrow-right is-dim" aria-hidden="true"></i>' +
    '<i class="fa-regular fa-rotate-right" aria-hidden="true"></i>' +
    `<span class="gd-omni"><i class="fa-regular fa-sliders-simple" aria-hidden="true"></i><span class="gd-url">${e(url)}</span>` +
    '<i class="fa-regular fa-star" aria-hidden="true"></i></span>' +
    '<span class="gd-cw-me"></span><i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i></div>' +
    `<div class="gd-page">${page}</div></div>`
  );
}

/** Chrome's permission prompt, under the address bar. */
export function chromeAllow() {
  return (
    `<div class="gd-cperm"><b>${tf("mock.perm_wants", { host: host() })}</b>` +
    `<span><i class="fa-regular fa-bell" aria-hidden="true"></i>${M("perm_show")}</span>` +
    `<div class="gd-cperm-btns"><span class="gd-cbtn">${M("perm_block")}</span>` +
    `<span class="gd-cbtn is-primary gd-f-allow">${M("perm_allow")}</span></div></div>`
  );
}

/** A desktop: `win` is the browser window; `over` is anything above it. */
export function desk(os, win, over = "") {
  const mac = os === "macos";
  return (
    `<div class="gd-desk ${mac ? "is-mac" : "is-win"}">` +
    `<div class="gd-wall"></div>${mac ? macBar() : ""}${win}${mac ? macDock() : taskbar()}${over}</div>`
  );
}

// ═══ phones ══════════════════════════════════════════════════
function iosStatus() {
  return `<div class="gd-ios-status"><span class="gd-ios-time">9:41</span><span class="gd-ios-icons">${STATUS.signal}${STATUS.wifi}${STATUS.battery}</span></div>`;
}

function andStatus() {
  return (
    '<div class="gd-and-status"><span>9:41</span><span class="gd-and-icons"><i class="fa-solid fa-wifi" aria-hidden="true"></i>' +
    '<i class="fa-solid fa-signal" aria-hidden="true"></i><i class="fa-solid fa-battery-full" aria-hidden="true"></i></span></div>'
  );
}

/** A phone around `screen`. `dark` puts light status text over a dark top. */
export function phone(os, screen, { dark = false } = {}) {
  const ios = os === "ios";
  return (
    `<div class="gd-phone ${ios ? "is-ios" : "is-and"}"><div class="gd-screen${dark ? " is-dark" : ""}">` +
    screen +
    (ios ? iosStatus() + '<div class="gd-island"></div>' : andStatus() + '<div class="gd-punch"></div>') +
    '<div class="gd-homebar"></div></div></div>'
  );
}

/** Safari on iPhone: the page with the floating bar over its bottom. */
export function iosSafari(page) {
  return (
    `<div class="gd-ios-web"><div class="gd-page">${page}</div></div>` +
    '<div class="gd-ios-tabbar"><span class="gd-glass gd-ios-round"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></span>' +
    `<span class="gd-glass gd-ios-addr"><span class="gd-url">${e(host())}</span></span>` +
    '<span class="gd-glass gd-ios-round gd-f-more"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></span></div>'
  );
}

/** The blog opened from its Home Screen icon: no browser around it. */
export function iosApp(page) {
  return `<div class="gd-ios-web is-app"><div class="gd-page">${page}</div></div>`;
}

/** A site outside the web app opens in Safari's sheet with a Done button. */
export function iosInApp(page, url) {
  return (
    `<div class="gd-ios-sheetweb"><div class="gd-ios-sheetbar"><span class="gd-ios-done">${M("ios_done")}</span>` +
    `<span class="gd-url"><i class="fa-solid fa-lock" aria-hidden="true"></i>${e(url)}</span><span></span></div>` +
    `<div class="gd-page">${page}</div></div>`
  );
}

/** Chrome on Android. */
export function andChrome(page, url = host()) {
  return (
    '<div class="gd-and-web"><div class="gd-and-bar"><i class="fa-regular fa-house" aria-hidden="true"></i>' +
    `<span class="gd-and-omni"><i class="fa-regular fa-sliders-simple" aria-hidden="true"></i><span class="gd-url">${e(url)}</span></span>` +
    '<span class="gd-and-tabs">1</span><i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i></div>' +
    `<div class="gd-page">${page}</div></div>`
  );
}

// ─── iPhone: installing ──────────────────────────────────────
export function iosMore() {
  const row = (k, icon, cls = "") => `<div class="gd-ios-mi ${cls}"><span>${M(k)}</span><i class="${icon}" aria-hidden="true"></i></div>`;
  return (
    '<div class="gd-glass gd-ios-menu">' +
    row("ios_share", "fa-regular fa-arrow-up-from-bracket", "gd-f-share") +
    row("ios_bookmark", "fa-regular fa-book") +
    row("ios_reader", "fa-regular fa-align-left") +
    row("ios_new_tab", "fa-regular fa-plus") +
    "</div>"
  );
}

export function iosShare() {
  // AirDrop, then the people the sheet suggests, as contact monograms.
  const people = ["Alex", "Mia", "Sam", "Jordan"];
  const targets = [["AirDrop", '<span class="gd-airdrop"><i class="fa-solid fa-wifi" aria-hidden="true"></i></span>']].concat(
    people.map((n) => [n, `<span class="gd-mono">${n[0]}</span>`]),
  );
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
  return (
    '<div class="gd-ios-share"><div class="gd-ios-share-head">' +
    `${blogIcon()}<span><b>${e(siteName())}</b><small>${e(host())}</small></span>` +
    '<span class="gd-ios-x"><i class="fa-solid fa-xmark" aria-hidden="true"></i></span></div>' +
    '<div class="gd-ios-targets">' +
    targets.map(([name, icon]) => `<span class="gd-ios-target">${icon}<small>${e(name)}</small></span>`).join("") +
    '</div><div class="gd-ios-list"><div class="gd-ios-scroll">' +
    rows.map(([k, icon, cls = ""]) => `<div class="gd-ios-row ${cls}"><span>${M(k)}</span><i class="${icon}" aria-hidden="true"></i></div>`).join("") +
    "</div></div></div>"
  );
}

export function iosAddHome() {
  return (
    '<div class="gd-ios-add"><div class="gd-ios-add-nav">' +
    `<span>${M("ios_cancel")}</span><b>${M("ios_add_home")}</b><span class="gd-ios-add-go gd-f-add">${M("ios_add")}</span></div>` +
    `<div class="gd-ios-card">${blogIcon()}<span class="gd-ios-card-main"><b>${e(siteName())}</b><small>${e(host())}</small></span></div>` +
    `<div class="gd-ios-card gd-ios-toggle-row"><span>${M("ios_web_app")}</span><span class="gd-ios-toggle gd-f-webapp"><i></i></span></div>` +
    "</div>"
  );
}

const HOME = ["facetime", "clock", "files", "findmy", "measure", "voicememos", "shortcuts"];
const HOME_DOCK = ["safari", "camera", "music", "appstore"];

/** The Home Screen, with the blog's new icon waiting in the next free place. */
export function iosHome() {
  const cell = (k) => `<span class="gd-ios-app"><span class="gd-app">${appIcon(k)}</span><small>${M(`apps.${k}`)}</small></span>`;
  return (
    '<div class="gd-ios-home"><div class="gd-wall"></div><div class="gd-ios-grid">' +
    HOME.map(cell).join("") +
    `<span class="gd-ios-app gd-ios-new gd-f-icon"><span class="gd-app">${blogIcon()}</span><small>${e(siteName())}</small></span>` +
    `</div><span class="gd-glass gd-ios-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>${M("ios_search")}</span>` +
    `<div class="gd-glass gd-ios-dock">${HOME_DOCK.map((k) => `<span class="gd-app">${appIcon(k)}</span>`).join("")}</div></div>`
  );
}

// ─── notifications ───────────────────────────────────────────
/**
 * A push notification the way each system draws one: a banner on iPhone, a
 * heads-up card on Android, the top-right corner on a Mac, a toast above the
 * Windows taskbar.
 */
export function banner(os, { title, body }) {
  const now = M("now");
  if (os === "ios") {
    return (
      `<div class="gd-glass gd-push is-ios">${blogIcon()}<span class="gd-push-main">` +
      `<span class="gd-push-top"><b>${e(title)}</b><small>${now}</small></span><span class="gd-push-body">${e(body)}</span></span></div>`
    );
  }
  if (os === "android") {
    return (
      `<div class="gd-push is-and"><span class="gd-push-main"><span class="gd-push-app"><span class="gd-push-chrome">${chrome()}</span>` +
      `Chrome · ${e(host())} · ${now}</span><b>${e(title)}</b><span class="gd-push-body">${e(body)}</span></span>${blogIcon()}</div>`
    );
  }
  if (os === "macos") {
    return (
      `<div class="gd-push is-mac">${blogIcon()}<span class="gd-push-main">` +
      `<span class="gd-push-top"><b>${e(siteName())}</b><small>${now}</small></span><b>${e(title)}</b>` +
      `<span class="gd-push-body">${e(body)}</span></span></div>`
    );
  }
  return (
    `<div class="gd-push is-win"><span class="gd-push-app"><span class="gd-push-chrome">${chrome()}</span>Google Chrome` +
    '<i class="fa-solid fa-ellipsis" aria-hidden="true"></i><i class="fa-regular fa-xmark" aria-hidden="true"></i></span>' +
    `<span class="gd-push-row">${blogIcon()}<span class="gd-push-main"><b>${e(title)}</b><span class="gd-push-body">${e(body)}</span>` +
    `<small>${e(host())}</small></span></span></div>`
  );
}

// ─── permission prompts ──────────────────────────────────────
export function iosAllow() {
  return (
    '<div class="gd-ios-dim"></div><div class="gd-glass gd-ios-alert">' +
    `<b>${tf("mock.ios_alert", { site: siteName() })}</b><small>${M("ios_alert_body")}</small>` +
    `<div class="gd-ios-alert-btns"><span>${M("ios_dont")}</span><span class="gd-f-allow">${M("ios_allow")}</span></div></div>`
  );
}

export function andAllow() {
  return (
    '<div class="gd-and-dim"></div><div class="gd-and-perm"><i class="fa-regular fa-bell" aria-hidden="true"></i>' +
    `<b>${tf("mock.perm_android", { host: host() })}</b>` +
    `<div class="gd-and-btns"><span>${M("perm_block")}</span><span class="gd-f-allow">${M("perm_allow")}</span></div></div>`
  );
}
