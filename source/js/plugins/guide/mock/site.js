/**
 * Guide mocks — the blog itself, drawn with its own stylesheet.
 *
 * The navigation bar, the home banner and the notifications panel a
 * walkthrough shows are the site's real markup under the site's real CSS, read
 * once out of the home page as the server sends it — so nothing the reader's
 * own page has done to them (an inbox left on its second page, a height it was
 * animated to) comes along. The inbox rows come from the panel's own renderer;
 * the post they announce is the newest public one, from the build.
 * Media queries answer for the reader's screen, not for the device in the mock,
 * so the few properties that switch with the screen are pinned per device in
 * guide-mock.styl (`.gd-site.is-desk` / `.is-phone`), and the navbar's measured
 * switches are measured again in the mock (`fit`).
 */

import { t, newest, escapeHTML as e } from "../store.js";
import { itemHTML } from "../../notifications-inbox.js";

let home = null;
let loading = null;

const clean = (el) => {
  if (!el) return "";
  el.querySelectorAll("script, style, noscript, #instant-notes").forEach((n) => n.remove());
  for (const n of [el, ...el.querySelectorAll("*")]) {
    n.removeAttribute("id");
    for (const a of Array.from(n.attributes)) {
      if (a.name.startsWith("data-ux") || a.name === "tabindex" || a.name.startsWith("aria-")) n.removeAttribute(a.name);
    }
    n.classList.remove("active", "guide-hover", "guide-reveal", "is-open", "is-active", "has-unread", "is-busy");
  }
  return el.outerHTML;
};

// What scripts wrote onto a live element: its inline styles and states.
const settle = (el) => {
  for (const n of [el, ...el.querySelectorAll("[style], [disabled], [inert]")]) {
    n.removeAttribute("style");
    n.removeAttribute("disabled");
    n.removeAttribute("inert");
  }
  return el;
};

/** The home page's first screen, its navbar and its inbox — read once per visit. */
export function prepare() {
  if (home) return Promise.resolve(home);
  if (!loading) {
    const root = String((window.config && window.config.root) || "/").replace(/\/?$/, "/");
    loading = fetch(root, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => "")
      .then((html) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const subtitle = (((window.theme || {}).home_banner || {}).subtitle || {}).text || [];
        const typed = doc.querySelector("#subtitle");
        if (typed) typed.textContent = subtitle[0] || "";
        home = {
          bg: clean(doc.querySelector(".home-banner-background")),
          banner: clean(doc.querySelector(".home-banner-container")),
          nav: doc.querySelector(".navbar-container"),
          panel: doc.querySelector("#notifications-panel"),
        };
        return home;
      });
  }
  return loading;
}

/** The post a "published" notification would be about: the newest public one, never the pinned one. */
export function newestPost() {
  const post = newest();
  return post && post.title ? { title: post.title, body: post.body || "" } : { title: t("mock.post_title"), body: "" };
}

function navbar() {
  const src = (home && home.nav) || document.querySelector(".navbar-container");
  if (!src) return "";
  const nav = settle(src.cloneNode(true));
  nav.querySelectorAll(".navbar-drawer, .window-mask").forEach((n) => n.remove());
  const content = nav.querySelector(".navbar-content");
  if (content) content.classList.add("has-home-banner");
  return clean(nav);
}

function inboxItems() {
  const minute = 60 * 1000;
  const iso = (ago) => new Date(Date.now() - ago).toISOString();
  const post = newestPost();
  return [
    { id: "g1", type: "post", title: post.title, body: post.body, url: "#", published_at: iso(minute), read_at: null },
    { id: "g2", type: "note", title: t("mock.note_title"), body: "", url: "#", published_at: iso(180 * minute), read_at: null },
    { id: "g3", type: "announcement", title: t("mock.announce_title"), body: "", url: "#", published_at: iso(1500 * minute), read_at: "1" },
  ];
}

function panel() {
  const src = (home && home.panel) || document.getElementById("notifications-panel");
  if (!src) return "";
  const p = settle(src.cloneNode(true));
  p.dataset.page = "inbox";
  p.querySelectorAll('.np-page[data-page="manage"]').forEach((n) => n.remove());
  const page = p.querySelector('.np-page[data-page="inbox"]');
  if (page) page.classList.add("is-current");
  const title = p.querySelector(".np-title");
  if (title) title.textContent = ((window.theme || {}).notifications_i18n || {}).title || title.textContent;
  const mark = p.querySelector(".np-mark-read");
  if (mark) mark.hidden = false;
  const back = p.querySelector(".np-back");
  if (back) back.hidden = true;
  const body = p.querySelector(".np-body");
  if (body) body.innerHTML = `<div class="np-list">${inboxItems().map(itemHTML).join("")}</div>`;
  const foot = p.querySelector(".np-foot");
  const manage = ((window.theme || {}).notifications_i18n || {}).manage || "Manage subscription";
  if (foot) {
    foot.innerHTML = `<button type="button" class="np-action np-to-manage"><i class="fa-solid fa-sliders" aria-hidden="true"></i> <span class="np-btn-label">${e(manage)}</span></button>`;
  }
  return clean(p);
}

/**
 * The blog in a viewport of w × h pixels.
 * @param {object} o
 * @param {"desk"|"phone"} o.device
 * @param {number} o.w  @param {number} o.h
 * @param {number} [o.vh]          what `svh` is there, when bars float over the page
 * @param {boolean} [o.following]  the bell instead of the Follow button
 * @param {boolean} [o.inbox]      include the notifications panel, closed
 */
export function site({ device, w, h, vh = h, following = false, inbox = false }) {
  const phone = device === "phone";
  // A phone's root size, which a desktop page does not have: the site sets 0.9×.
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const base = matchMedia("(max-width: 640px)").matches ? root / 0.9 : matchMedia("(max-width: 768px)").matches ? root / 0.96 : root;
  const rem = phone ? base * 0.9 : base;
  const h0 = home || { bg: "", banner: "" };
  return (
    `<div class="gd-site ${phone ? "is-phone navbar-collapsed" : "is-desk"}" data-follow="${following ? 1 : 0}"` +
    ` style="width:${w}px;height:${h}px;--gd-vh:${vh}px;--gd-rem:${rem.toFixed(3)}px">` +
    `<div class="page-container">${h0.bg}${h0.banner}</div>` +
    `<div class="gd-site-head">${navbar()}</div>` +
    (inbox ? `<div class="notifications-mask"></div>${panel()}` : "") +
    `</div>`
  );
}

/**
 * The navbar's two measured switches (layouts/navbarCollapse.js), taken again
 * at the mock's width: links that do not fit give way to the mobile row, and a
 * mobile row that does not fit folds Follow into its disc. Measured with Follow
 * showing — the wider of the two states a scene passes through.
 */
export function fit(scene) {
  scene.world.querySelectorAll(".gd-site").forEach((s) => {
    const content = s.querySelector(".navbar-content");
    if (!content) return;
    const was = s.dataset.follow;
    s.dataset.follow = "0";
    const over = () => Array.from(content.children).reduce((w, c) => w + c.offsetWidth, 0) > content.clientWidth + 1;
    if (s.classList.contains("is-desk") && over()) s.classList.add("navbar-collapsed");
    if (s.classList.contains("navbar-collapsed") && over()) s.classList.add("navbar-follow-compact");
    s.dataset.follow = was;
  });
}

/** The inbox opening, the way the bell opens it. */
export function openInbox(scene, on = true) {
  scene.set(".notifications-panel", "is-open", on);
  scene.set(".notifications-mask", "is-open", on);
  scene.world.querySelectorAll(".notifications-bell").forEach((b) => b.classList.toggle("is-active", on));
}

export function badge(scene, n) {
  scene.world.querySelectorAll(".notifications-bell").forEach((bell) => {
    const b = bell.querySelector(".bell-badge");
    if (b) b.textContent = String(n);
    bell.classList.toggle("has-unread", n > 0);
  });
}

export function follow(scene, on = true) {
  const s = scene.q(".gd-site");
  if (s) s.dataset.follow = on ? "1" : "0";
}
