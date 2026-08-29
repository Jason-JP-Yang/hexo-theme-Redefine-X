/**
 * Notifications — the panel.
 *
 * Everything in this file is presentation: it renders whatever state it is
 * handed and reports clicks back through callbacks. It performs no network
 * calls and holds no auth state, which is what keeps the panel testable by
 * simply calling render() with a made-up state object.
 *
 * The panel markup is server-rendered (layout/components/notifications/inbox.ejs)
 * and lives OUTSIDE the #swup container, so a same-page navigation never
 * destroys an open panel or the list it just fetched.
 *
 * ─── one card, two pages ────────────────────────────────────
 *
 * The inbox and the subscription settings are two pages of the SAME card. They
 * are stacked inside `.np-viewport`, which clips them, and switching pages
 * translates both by one viewport height while the viewport's own height
 * animates from one page's natural height to the other's. Nothing fades: a
 * cross-fade would read as two cards swapped, and this is one card scrolling.
 *
 * The height is measured from the CONTENT element inside the scroller, never
 * from the scroller itself — a scroller stretched by `flex: 1` reports
 * `scrollHeight` as its own box whenever the content is shorter than it, which
 * means a card that has grown can never shrink again.
 */

const OPEN = "is-open";

// Floor for the animated viewport. Below this a nearly-empty page reads as a
// rendering fault rather than as an empty list.
const MIN_PAGE = 148;

// How long a destructive button stays armed after its first press. Long enough
// to read the label that replaced it, short enough that walking away disarms it.
const CONFIRM_MS = 4000;

// ─── time ────────────────────────────────────────────────────
const UNITS = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/**
 * Relative time using the theme's own `ago` strings, so the panel speaks the
 * same language as the rest of the site without loading a formatting library.
 *
 * Takes either an ISO string (notification rows, which SQLite formats) or a unix
 * epoch in seconds (device rows, which it does not — formatting them server-side
 * would spend a Worker's CPU on something the browser does for free).
 */
export function timeAgo(value) {
  const then = typeof value === "number" ? value * 1000 : new Date(value).getTime();
  const strings = window.lang_ago || {};
  if (isNaN(then)) return "";

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  for (const [unit, size] of UNITS) {
    if (seconds >= size || unit === "second") {
      const value = Math.floor(seconds / size);
      const template = strings[unit] || `%s ${unit}s ago`;
      return template.replace("%s", String(value));
    }
  }
  return "";
}

export function escapeHTML(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function t(key, fallback) {
  const strings = (window.theme && window.theme.notifications_i18n) || {};
  return strings[key] || fallback;
}

// ─── panel lookup ────────────────────────────────────────────
export function getPanel() {
  return document.getElementById("notifications-panel");
}

export function isOpen() {
  const panel = getPanel();
  return !!panel && panel.classList.contains(OPEN);
}

// ─── hiding things that still hold focus ─────────────────────
/**
 * Take focus out of a subtree that is ABOUT to be hidden.
 *
 * Hiding a focused element from assistive technology is a contradiction the
 * browser refuses outright: `aria-hidden` on an ancestor of `document.
 * activeElement` is ignored and logged, because it would leave a screen reader
 * pointing at something that, as far as the a11y tree is concerned, no longer
 * exists. Both of this panel's hiding paths could reach it — closing the card
 * with a notification link focused, and sliding away a page with one of its
 * buttons focused.
 *
 * @param {Element} root      the subtree being hidden
 * @param {boolean} toTrigger send focus back to the control that opened it,
 *        rather than merely dropping it. Right when a dialog closes on its own
 *        terms; wrong when the reader is following a link out of it.
 */
function releaseFocus(root, toTrigger = false) {
  const active = document.activeElement;
  if (!active || !root.contains(active)) return;

  if (toTrigger) {
    // Several candidates exist in the markup at once — the desktop row's bell
    // and the mobile row's, or the Follow button standing in for them — and all
    // but one are display:none. Whichever is actually on screen is the control
    // the reader pressed to get here.
    const trigger = Array.from(
      document.querySelectorAll(".notifications-bell, .follow-trigger")
    ).find((el) => el.offsetParent !== null);
    if (trigger) {
      trigger.focus({ preventScroll: true });
      return;
    }
  }
  active.blur();
}

/**
 * `inert` is what the spec offers in place of the above: it removes a subtree
 * from the a11y tree AND from the tab order, which `aria-hidden` alone never
 * did. Applied on the next frame purely so that closing the panel from a click
 * on a notification link cannot interfere with that link's own navigation.
 */
function setInertLater(el, inert) {
  if (inert) {
    requestAnimationFrame(() => {
      if (el.isConnected && !el.classList.contains(OPEN)) el.setAttribute("inert", "");
    });
  } else {
    el.removeAttribute("inert");
  }
}

/**
 * @param {boolean} open
 * @param {{returnFocus?: boolean}} options
 *        returnFocus — put focus back on the bell. False when the panel is
 *        closing because the reader is on their way somewhere else.
 */
export function setOpen(open, { returnFocus = true } = {}) {
  const panel = getPanel();
  if (!panel) return;
  const mask = document.getElementById("notifications-mask");

  // Focus first, hide second. The other order is the violation.
  if (!open) releaseFocus(panel, returnFocus);

  panel.classList.toggle(OPEN, open);
  panel.setAttribute("aria-hidden", open ? "false" : "true");
  setInertLater(panel, !open);
  if (mask) mask.classList.toggle(OPEN, open);

  // Opening always starts on the inbox, and starts there WITHOUT animating: the
  // card should appear at the size it needs, not grow into it.
  if (open) setPage("inbox", false);
  else disarmConfirm();

  // The bell is re-created by every Swup navigation, so its pressed state is
  // read from the panel rather than stored anywhere.
  document.querySelectorAll(".notifications-bell").forEach((bell) => {
    bell.setAttribute("aria-expanded", open ? "true" : "false");
    bell.classList.toggle("is-active", open);
  });
}

// ─── badge ───────────────────────────────────────────────────
export function setBadge(count) {
  document.querySelectorAll(".notifications-bell").forEach((bell) => {
    const badge = bell.querySelector(".bell-badge");
    if (!badge) return;
    const n = Number(count) || 0;
    badge.textContent = n > 99 ? "99+" : String(n);
    bell.classList.toggle("has-unread", n > 0);
  });
}

// ─── busy ────────────────────────────────────────────────────
/**
 * Mark one control as waiting on the network.
 *
 * Every button here reaches a Worker, and until this existed none of them said
 * so — a slow round trip was indistinguishable from a click that had missed.
 * The control's own icon becomes the spinner, so nothing moves and the button
 * keeps its width.
 */
export function setBusy(el, on) {
  if (!el) return;
  el.classList.toggle("is-busy", !!on);
  if ("disabled" in el) el.disabled = !!on;

  const icon = el.querySelector("i");
  if (!icon) return;
  if (on) {
    if (!icon.dataset.rest) icon.dataset.rest = icon.className;
    icon.className = "fa-solid fa-circle-notch fa-spin";
  } else if (icon.dataset.rest) {
    icon.className = icon.dataset.rest;
    delete icon.dataset.rest;
  }
}

/**
 * Dim the card while something is in flight, WITHOUT a re-render — the control
 * showing the spinner is usually inside the part a render would replace, and
 * replacing it is how a spinner disappears the instant it appears.
 */
export function setPanelBusy(on) {
  const panel = getPanel();
  if (panel) panel.classList.toggle("is-busy", !!on);
}

// ─── two-step confirm ────────────────────────────────────────
// Clearing the inbox, cutting this browser off from push and revoking a device
// are all one press away and none of them can be undone, so each takes two: the
// first press turns the control red and renames it, the second carries it out.
let armedEl = null;
let armedKey = "";
let armedTimer = 0;

export function disarmConfirm() {
  if (armedTimer) clearTimeout(armedTimer);
  armedTimer = 0;
  if (armedEl && armedEl.isConnected) {
    armedEl.classList.remove("is-confirm");
    const label = armedEl.querySelector(".np-btn-label");
    if (label && armedEl.dataset.rest) label.textContent = armedEl.dataset.rest;
    const icon = armedEl.querySelector("i");
    if (icon && icon.dataset.armed) {
      icon.className = icon.dataset.armed;
      delete icon.dataset.armed;
    }
    delete armedEl.dataset.rest;
  }
  armedEl = null;
  armedKey = "";
}

/**
 * @returns {boolean} true when this press is the CONFIRMING one and the caller
 *          should go ahead; false when it only armed the control.
 */
export function confirmStep(el, key, label) {
  if (armedKey === key && armedEl === el) {
    disarmConfirm();
    return true;
  }
  disarmConfirm();

  armedEl = el;
  armedKey = key;
  el.classList.add("is-confirm");

  const text = el.querySelector(".np-btn-label");
  if (text) {
    el.dataset.rest = text.textContent;
    text.textContent = label;
  }
  const icon = el.querySelector("i");
  if (icon) {
    icon.dataset.armed = icon.className;
    icon.className = "fa-solid fa-check";
  }

  armedTimer = setTimeout(disarmConfirm, CONFIRM_MS);
  return false;
}

// ─── pages ───────────────────────────────────────────────────
let currentPage = "inbox";

export function getPage() {
  return currentPage;
}

/**
 * Show one page of the card.
 *
 * The transforms are CSS, driven off `data-page` on the panel; what JS owns is
 * the viewport height, because only it can measure what the incoming page needs.
 */
export function setPage(name, animate = true) {
  const panel = getPanel();
  if (!panel) return;

  const next = name === "manage" ? "manage" : "inbox";
  const changed = next !== currentPage;
  currentPage = next;
  if (changed) disarmConfirm();

  panel.dataset.page = currentPage;
  panel.querySelectorAll(".np-page").forEach((page) => {
    const current = page.dataset.page === currentPage;
    // Same rule as closing the card: focus cannot be left inside a page that is
    // about to be hidden from assistive technology. It is the button the reader
    // just pressed — "Manage subscription", or "Back to notifications" — that
    // holds it, so this fires on every switch, not just keyboard ones.
    if (!current) releaseFocus(page);

    page.classList.toggle("is-current", current);
    page.setAttribute("aria-hidden", current ? "false" : "true");
    if (current) page.removeAttribute("inert");
    else page.setAttribute("inert", "");

    // Arriving at a page always starts at its top; the one being left keeps its
    // place, so coming back lands where the reader was.
    if (current && changed) {
      const scroll = page.querySelector(".np-scroll");
      if (scroll) scroll.scrollTop = 0;
    }
  });

  syncHead(panel);
  fitViewport(animate);
}

// Whether the inbox has anything to mark read. Kept here because the head is
// shared between the pages and has to be re-decided on a page switch, which is
// not a re-render.
let canMarkRead = false;
// A blocked identity has one page, not two, so the head loses the way back.
let isBanned = false;

function syncHead(panel) {
  const manage = currentPage === "manage";
  const title = panel.querySelector(".np-title");
  const back = panel.querySelector(".np-back");
  const markRead = panel.querySelector(".np-mark-read");
  if (title) {
    title.textContent = manage
      ? t("manage_title", "Manage subscription")
      : t("title", "Notifications");
  }
  if (back) back.hidden = !manage || isBanned;
  if (markRead) markRead.hidden = manage || !canMarkRead;
}

/** The tallest a page may be: the panel's own ceiling, less its fixed chrome. */
function pageCap(panel) {
  const max = parseFloat(getComputedStyle(panel).maxHeight);
  const ceiling = Number.isFinite(max) ? max : window.innerHeight * 0.8;
  let chrome = 0;
  panel.querySelectorAll(".np-head, .np-progress").forEach((el) => {
    chrome += el.getBoundingClientRect().height;
  });
  return Math.max(MIN_PAGE, ceiling - chrome);
}

/**
 * What the current page would take if nothing constrained it.
 *
 * Measured off the scroller's CONTENT child, never the scroller: the scroller is
 * a stretched flex item, so its own height is whatever the viewport currently
 * is — asking it would make every page exactly as tall as the last one.
 */
function naturalHeight(page) {
  const scroll = page.querySelector(".np-scroll");
  const content = scroll && scroll.firstElementChild;
  const foot = page.querySelector(".np-foot");
  // Sub-pixel, then rounded UP. offsetHeight rounds to whole pixels and a
  // fractional content height rounded down leaves the box one pixel short of
  // its own contents — which is a page that is scrollable for no reason.
  const height =
    (content ? content.getBoundingClientRect().height : 0) +
    (foot ? foot.getBoundingClientRect().height : 0);
  return Math.ceil(height);
}

export function fitViewport(animate = true) {
  const panel = getPanel();
  if (!panel) return;
  const viewport = panel.querySelector(".np-viewport");
  const page = panel.querySelector(".np-page.is-current");
  if (!viewport || !page) return;

  const target = Math.min(
    Math.floor(pageCap(panel)),
    Math.max(MIN_PAGE, naturalHeight(page))
  );

  if (animate) {
    viewport.style.height = `${target}px`;
  } else {
    // Landing at a size rather than growing into it. The reflow between the two
    // assignments is what stops the restored transition from animating this one.
    viewport.style.transition = "none";
    viewport.style.height = `${target}px`;
    void viewport.offsetHeight;
    viewport.style.transition = "";
  }
  updateProgress();
}

// ─── scroll progress ─────────────────────────────────────────
/**
 * The card has no scrollbar. It has a progress bar under the title instead —
 * the same 2px primary rule the site uses for page scroll — because a native
 * scrollbar inside a 440px card is a second, differently-styled piece of
 * furniture that appears and disappears as content lands.
 *
 * It is always visible, and reads 100% when there is nothing to scroll: the bar
 * says how much of this page you have seen, and "all of it" is a true answer.
 */
function updateProgress() {
  const panel = getPanel();
  if (!panel) return;
  const bar = panel.querySelector(".np-progress-bar");
  const scroll = panel.querySelector(".np-page.is-current .np-scroll");
  if (!bar || !scroll) return;

  const range = scroll.scrollHeight - scroll.clientHeight;
  const seen = range <= 1 ? 1 : Math.min(1, Math.max(0, scroll.scrollTop / range));
  bar.style.width = `${(seen * 100).toFixed(2)}%`;
}

let progressFrame = 0;

function scheduleProgress() {
  if (progressFrame) return;
  progressFrame = requestAnimationFrame(() => {
    progressFrame = 0;
    updateProgress();
  });
}

/**
 * Bound once per panel. The scrollers are server-rendered and only their
 * CONTENTS are replaced, so these listeners outlive every render.
 */
function wireChrome(panel) {
  if (panel.dataset.chromeWired) return;
  panel.dataset.chromeWired = "1";

  panel.querySelectorAll(".np-scroll").forEach((scroll) => {
    scroll.addEventListener("scroll", scheduleProgress, { passive: true });
  });
  // The page's own height is still moving for the length of the slide, and the
  // fraction it can scroll moves with it.
  const viewport = panel.querySelector(".np-viewport");
  if (viewport) {
    viewport.addEventListener("transitionend", (event) => {
      if (event.propertyName === "height") updateProgress();
    });
  }
}

// ─── list ────────────────────────────────────────────────────
function itemHTML(item) {
  const unread = !item.read_at;
  const icon =
    item.type === "note"
      ? "fa-comment-dots"
      : item.type === "announcement"
        ? "fa-bullhorn"
        : "fa-file-lines";

  return `
    <a class="np-item${unread ? " is-unread" : ""}" href="${escapeHTML(item.url)}" data-id="${escapeHTML(item.id)}">
      <span class="np-item-icon"><i class="fa-solid ${icon}" aria-hidden="true"></i></span>
      <span class="np-item-main">
        <span class="np-item-title">${escapeHTML(item.title)}</span>
        ${item.body ? `<span class="np-item-body">${escapeHTML(item.body)}</span>` : ""}
        <span class="np-item-time">${escapeHTML(timeAgo(item.published_at))}</span>
      </span>
    </a>`;
}

// ─── devices ─────────────────────────────────────────────────
const DEVICE_ICONS = {
  laptop: "fa-solid fa-laptop",
  desktop: "fa-solid fa-desktop",
  mobile: "fa-solid fa-mobile-screen-button",
  tablet: "fa-solid fa-tablet-screen-button",
};

// Order matters: every one of these ships "Safari" in its string, and most ship
// "Chrome" too, so the most specific marker has to be tested first.
const BROWSERS = [
  [/Edg[A-Z]?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser/, "Samsung Internet"],
  [/Firefox\/|FxiOS/, "Firefox"],
  [/CriOS|Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const SYSTEMS = [
  [/Windows NT|Windows Phone/, "Windows"],
  [/iPhone|iPad|iPod|CPU OS \d/, "iOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Linux|X11/, "Linux"],
];

function matchFirst(table, ua) {
  for (const [pattern, name] of table) if (pattern.test(ua)) return name;
  return "";
}

/**
 * One device row's three labels.
 *
 * Browser and OS come out of the stored User-Agent. The machine class does not —
 * a laptop and a tower send byte-identical strings — so it is read from `device`,
 * which the subscribing browser worked out about itself. Rows registered before
 * that column existed fall back to what the UA can still prove, which is mobile
 * versus tablet versus "some desktop-class machine".
 */
export function describeDevice(row) {
  const ua = String(row.ua || "");
  let kind = String(row.device || "").toLowerCase();

  if (!DEVICE_ICONS[kind]) {
    if (/iPad|Tablet/i.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) kind = "tablet";
    else if (/iPhone|iPod|Mobile/.test(ua)) kind = "mobile";
    else if (/Windows NT|Mac OS X|Macintosh|X11|CrOS/.test(ua)) kind = "desktop";
    else kind = "";
  }

  const unknown = t("unknown", "Unknown");
  return {
    // Deliberately the LAST fallback in the theme's icon set rather than a
    // question mark: an unidentified subscription is still a real device.
    icon: DEVICE_ICONS[kind] || "fa-brands fa-chromecast",
    browser: matchFirst(BROWSERS, ua) || unknown,
    os: matchFirst(SYSTEMS, ua) || unknown,
    kind: kind ? t(`device_${kind}`, kind.charAt(0).toUpperCase() + kind.slice(1)) : unknown,
  };
}

function deviceHTML(row, isThis) {
  const info = describeDevice(row);
  const when = timeAgo(row.created_at);
  const banned = !!row.banned;

  // A banned subscription loses its remove button, and the Worker refuses the
  // delete either way: revoking the row and re-subscribing the same browser
  // would otherwise walk straight out of the ban.
  return `
    <li class="np-device${isThis ? " is-this" : ""}${banned ? " is-banned" : ""}">
      <span class="np-device-icon"><i class="${info.icon}" aria-hidden="true"></i></span>
      <span class="np-device-main">
        <span class="np-device-title">${escapeHTML(info.browser)}<span class="np-sep"></span>${escapeHTML(
          info.os
        )}<span class="np-sep"></span>${escapeHTML(info.kind)}${
          isThis
            ? `<span class="np-device-tag">${escapeHTML(t("this_browser", "This browser"))}</span>`
            : ""
        }${
          banned
            ? `<span class="np-device-tag is-banned">${escapeHTML(t("banned", "Banned"))}</span>`
            : ""
        }</span>
        <span class="np-device-time">${escapeHTML(
          when ? `${t("subscribed", "Subscribed")} ${when}` : t("subscribed", "Subscribed")
        )}</span>
      </span>
      ${
        banned
          ? ""
          : `<button type="button" class="np-device-remove" data-device="${escapeHTML(row.id)}"
              aria-label="${escapeHTML(t("remove_device", "Remove this device"))}">
        <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
      </button>`
      }
    </li>`;
}

// ─── switches ────────────────────────────────────────────────
/**
 * @param {object} row
 *   key      the action name the click delegation dispatches on
 *   label    the line the reader reads
 *   hint     the smaller line under it, or ""
 *   on       whether the switch reads as on
 *   locked   always on, and says so — not a choice this panel offers
 *   disabled the choice exists but cannot be made from here right now
 */
function switchHTML({ key, label, hint, on, locked = false, disabled = false }) {
  const fixed = locked || disabled;
  return `
    <div class="np-row${locked ? " is-locked" : ""}${disabled ? " is-disabled" : ""}">
      <span class="np-row-main">
        <span class="np-row-label">${escapeHTML(label)}</span>
        ${hint ? `<span class="np-row-hint">${escapeHTML(hint)}</span>` : ""}
      </span>
      <button type="button" class="np-switch${on ? " is-on" : ""}" role="switch"
              data-switch="${escapeHTML(key)}"
              aria-checked="${on ? "true" : "false"}"
              aria-label="${escapeHTML(label)}"${fixed ? " disabled" : ""}>
        <span class="np-switch-knob"><i class="fa-solid fa-circle-notch fa-spin"></i></span>
      </button>
    </div>`;
}

/** Is THIS browser's own subscription the one an admin has banned? */
function thisDeviceBanned(state) {
  const tail = state.endpointTail || "";
  return !!tail && (state.devices || []).some((d) => d.tail === tail && d.banned);
}

/** Why the push switch cannot be turned on here, or "" when it can. */
function pushBlocker(state) {
  if (thisDeviceBanned(state)) {
    return t("push_device_banned", "Push from this browser has been turned off by the blog owner.");
  }
  if (state.pushState === "denied") {
    return t("push_denied", "Blocked in your browser's settings.");
  }
  if (state.pushState === "insecure") {
    return t("push_insecure", "Push needs a secure connection (https, or localhost).");
  }
  if (state.pushState === "unsupported") {
    return t("push_unsupported", "This browser cannot receive push.");
  }
  if (state.needsInstall) {
    return t("push_ios", "On iPhone, add this site to your Home Screen first.");
  }
  return "";
}

// ─── the banned account ──────────────────────────────────────
/**
 * What a banned reader sees instead of the settings.
 *
 * The page underneath is still rendered — blurred, clipped, and `inert`, so it
 * reads as a card that has been taken away rather than a feature that was never
 * there. Nothing in it can be focused or pressed, and the Worker refuses every
 * write from this identity anyway; the only live control is Log out, which sits
 * on top of the veil rather than under it.
 */
function bannedHTML() {
  return `
    <div class="np-banned">
      <i class="fa-solid fa-ban" aria-hidden="true"></i>
      <p class="np-banned-title">${escapeHTML(
        t("account_banned", "Your account has been blocked")
      )}</p>
      <p class="np-banned-note">${escapeHTML(
        t(
          "account_banned_note",
          "You can stay signed in and keep commenting on posts — only the ability to subscribe to this blog has been withdrawn. If the owner has also blocked you on GitHub, commenting stops too."
        )
      )}</p>
      <button type="button" class="np-quiet np-logout">
        <i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>
        <span class="np-btn-label">${escapeHTML(t("logout", "Log out from this browser"))}</span>
      </button>
    </div>`;
}

// ─── the management page ─────────────────────────────────────
function renderManage(panel, state) {
  const host = panel.querySelector(".np-manage");
  if (!host) return;

  const all = state.topics || [];
  const chosen = state.selected || [];
  // An empty selection is stored as "subscribed to everything", so with nothing
  // chosen every topic reads as on — which matches what actually happens.
  const has = (topic) => chosen.length === 0 || chosen.indexOf(topic) !== -1;

  const blocked = pushBlocker(state);
  const rows = [
    switchHTML({
      key: "inbox",
      label: t("opt_inbox", "Receive messages inside the blog"),
      hint: t("always_on", "Always on"),
      on: true,
      locked: true,
    }),
    switchHTML({
      key: "push",
      label: t("opt_push", "Receive push notifications from this browser"),
      hint: blocked || t("opt_push_hint", "Registers this browser as a push device."),
      // A banned browser reads as OFF whatever the database still holds for it,
      // because off is what it now behaves like.
      on: !!state.pushHere && !thisDeviceBanned(state),
      disabled: !!blocked,
    }),
  ];

  if (all.indexOf("announcements") !== -1) {
    rows.push(
      switchHTML({
        key: "announcements",
        label: t("opt_announcements", "Receive blog announcements"),
        hint: t("always_on", "Always on"),
        on: true,
        locked: true,
      })
    );
  }
  if (all.indexOf("notes") !== -1) {
    rows.push(
      switchHTML({
        key: "notes",
        label: t("opt_notes", "Receive new instant notes"),
        hint: "",
        on: has("notes"),
      })
    );
  }
  if (all.indexOf("posts") !== -1) {
    rows.push(
      switchHTML({
        key: "posts",
        label: t("opt_posts", "Receive new blog posts"),
        hint: "",
        on: has("posts"),
      })
    );
  }

  const devices = state.devices || [];
  const tail = state.endpointTail || "";
  const list = devices.length
    ? `<ul class="np-devices">${devices
        .map((d) => deviceHTML(d, !!tail && d.tail === tail))
        .join("")}</ul>`
    : `<p class="np-blank">${escapeHTML(
        t("no_devices", "No browser is registered for push yet.")
      )}</p>`;

  // Said once, under the list, and only when there is something to say. A banned
  // device is the one moderation state the reader is told about, so it has to
  // come with the reason and with what to do about it.
  const bannedNote = devices.some((d) => d.banned)
    ? `<p class="np-alert">
         <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
         <span>${escapeHTML(
           t(
             "device_banned_note",
             "One of the browsers above has been blocked from receiving notifications by the blog owner, and cannot be removed. This usually follows abuse of the subscription. Please use the blog considerately; if you believe this is a mistake, get in touch through the comments."
           )
         )}</span>
       </p>`
    : "";

  host.innerHTML = `
    <section class="np-section">
      <h3 class="np-section-title">${escapeHTML(t("section_delivery", "What you receive"))}</h3>
      ${rows.join("")}
    </section>

    <section class="np-section">
      <h3 class="np-section-title">
        ${escapeHTML(t("section_devices", "Registered devices"))}
        <span class="np-count">${devices.length}</span>
      </h3>
      ${list}
      ${bannedNote}
    </section>

    <section class="np-section np-danger">
      <p class="np-note">${escapeHTML(
        t(
          "logout_note",
          "After logging out of this browser you can no longer comment on posts, react to photos in Masonry, or receive notifications and push here. The next time you sign in the blog tries to restore everything automatically; if that fails, press Follow again to get push back."
        )
      )}</p>
      <button type="button" class="np-quiet np-logout">
        <i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>
        <span class="np-btn-label">${escapeHTML(t("logout", "Log out from this browser"))}</span>
      </button>

      <p class="np-note">${escapeHTML(
        t(
          "unfollow_note",
          "You will stop following this blog and will no longer receive push notifications on any browser. Your inbox is cleared and cannot be recovered. You stay signed in — to sign out, use the comments tab under any post."
        )
      )}</p>
      <button type="button" class="np-quiet np-unfollow">
        <i class="fa-solid fa-bell-slash" aria-hidden="true"></i>
        <span class="np-btn-label">${escapeHTML(t("unfollow_blog", "Unfollow the blog"))}</span>
      </button>
    </section>

    <button type="button" class="np-action np-to-inbox">
      <i class="fa-solid fa-chevron-up" aria-hidden="true"></i>
      <span class="np-btn-label">${escapeHTML(t("back_to_inbox", "Back to notifications"))}</span>
    </button>`;

  if (!state.banned) return;

  // Everything written above becomes the backdrop: wrapped, clipped, blurred and
  // taken out of the tab order in one move.
  const veiled = document.createElement("div");
  veiled.className = "np-veiled";
  veiled.setAttribute("inert", "");
  veiled.setAttribute("aria-hidden", "true");
  while (host.firstChild) veiled.appendChild(host.firstChild);
  host.appendChild(veiled);
  host.insertAdjacentHTML("beforeend", bannedHTML());
}

// ─── render ──────────────────────────────────────────────────
/**
 * Paint the whole panel from one state object.
 *
 * @param {object} state
 *   phase        "signed-out" | "not-following" | "following" | "loading"
 *   items        inbox rows
 *   unread       count
 *   topics       all configured topic names
 *   selected     the reader's chosen topics ([] = all)
 *   devices      the reader's registered push devices
 *   endpointTail the tail of THIS browser's endpoint, "" when it has none
 *   pushState    "granted" | "denied" | "unsupported" | "insecure" | "off"
 *   pushHere     this browser is one of the registered devices
 *   needsInstall iOS, not installed to the Home Screen
 *   busy         an action is in flight
 */
export function render(state) {
  const panel = getPanel();
  if (!panel) return;

  const body = panel.querySelector(".np-body");
  const foot = panel.querySelector(".np-foot");
  if (!body || !foot) return;

  wireChrome(panel);
  const following = state.phase === "following";

  panel.classList.toggle("is-busy", !!state.busy);
  isBanned = !!state.banned;
  panel.classList.toggle("is-banned", isBanned);
  setBadge(state.unread || 0);
  canMarkRead = following && state.unread > 0 && !isBanned;

  // Settings belong to a follower. Anyone else who somehow lands on that page —
  // a session that expired while it was open — is put back on the inbox. A
  // blocked identity is pushed the other way and held there: the inbox is the
  // one thing they have no business acting on.
  if (isBanned) setPage("manage");
  else if (!following && currentPage === "manage") setPage("inbox");
  else syncHead(panel);

  // ── inbox body ──
  if (state.phase === "loading") {
    body.innerHTML = `<div class="np-empty"><i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i></div>`;
  } else if (state.phase === "error") {
    body.innerHTML = `
      <div class="np-empty">
        <i class="fa-solid fa-plug-circle-xmark" aria-hidden="true"></i>
        <p>${escapeHTML(
          t("unreachable", "Couldn't reach the notification service. Your subscription is unchanged.")
        )}</p>
      </div>`;
  } else if (state.phase === "signed-out") {
    body.innerHTML = `
      <div class="np-empty">
        <i class="fa-regular fa-bell" aria-hidden="true"></i>
        <p>${escapeHTML(t("signed_out", "Sign in with GitHub to follow this blog."))}</p>
      </div>`;
  } else if (!state.items || state.items.length === 0) {
    body.innerHTML = `
      <div class="np-empty">
        <i class="fa-regular fa-bell-slash" aria-hidden="true"></i>
        <p>${escapeHTML(
          following
            ? t("empty_following", "Nothing yet. New posts will show up here.")
            : t("empty", "Follow the blog to get notified about new posts.")
        )}</p>
      </div>`;
  } else {
    body.innerHTML = `<div class="np-list">${state.items.map(itemHTML).join("")}</div>`;
  }

  // ── inbox foot ──
  const parts = [];

  if (state.phase === "error") {
    parts.push(
      `<button type="button" class="np-action np-retry"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> <span class="np-btn-label">${escapeHTML(
        t("retry", "Try again")
      )}</span></button>`
    );
  } else if (state.phase === "signed-out") {
    parts.push(
      `<button type="button" class="np-action np-login"><i class="fa-brands fa-github" aria-hidden="true"></i> <span class="np-btn-label">${escapeHTML(
        t("sign_in", "Sign in with GitHub")
      )}</span></button>`
    );
  } else if (state.phase === "not-following") {
    parts.push(
      `<button type="button" class="np-action np-follow"><i class="fa-regular fa-bell" aria-hidden="true"></i> <span class="np-btn-label">${escapeHTML(
        t("follow", "Follow this blog")
      )}</span></button>`
    );
  } else if (following) {
    // One line, only when the buzz is genuinely unavailable. "Following" with a
    // blocked permission is the one state where the bell alone would lie, and it
    // is worth saying here rather than only behind the settings page.
    const blocked = pushBlocker(state);
    if (blocked) {
      parts.push(
        `<p class="np-note">${escapeHTML(blocked)} ${escapeHTML(
          t("still_inbox", "New items still appear here.")
        )}</p>`
      );
    }
    parts.push(
      `<button type="button" class="np-action np-to-manage"><i class="fa-solid fa-sliders" aria-hidden="true"></i> <span class="np-btn-label">${escapeHTML(
        t("manage", "Manage subscription")
      )}</span></button>`
    );
  }

  foot.innerHTML = parts.join("");

  // ── management page ──
  // Also for a blocked identity that is no longer a follower: the veil is the
  // only page they get, and an empty one would say nothing.
  if (following || isBanned) renderManage(panel, state);

  fitViewport(isOpen());
}
