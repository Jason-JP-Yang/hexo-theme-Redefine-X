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
 */

const OPEN = "is-open";

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
 */
function timeAgo(iso) {
  const strings = window.lang_ago || {};
  const then = new Date(iso).getTime();
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

function escapeHTML(value) {
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

export function setOpen(open) {
  const panel = getPanel();
  if (!panel) return;
  const mask = document.getElementById("notifications-mask");

  panel.classList.toggle(OPEN, open);
  panel.setAttribute("aria-hidden", open ? "false" : "true");
  if (mask) mask.classList.toggle(OPEN, open);

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

// ─── topics ──────────────────────────────────────────────────
function topicsHTML(allTopics, selected) {
  // An empty selection is stored as "subscribed to everything", so with nothing
  // chosen every chip reads as on — which matches what actually happens.
  const none = selected.length === 0;
  return allTopics
    .map((topic) => {
      const on = none || selected.indexOf(topic) !== -1;
      return `<button type="button" class="np-topic${on ? " is-on" : ""}" data-topic="${escapeHTML(topic)}">${escapeHTML(
        t(`topic_${topic}`, topic)
      )}</button>`;
    })
    .join("");
}

// ─── render ──────────────────────────────────────────────────
/**
 * Paint the whole panel from one state object.
 *
 * @param {object} state
 *   phase       "signed-out" | "not-following" | "following" | "loading"
 *   items       inbox rows
 *   unread      count
 *   topics      all configured topic names
 *   selected    the reader's chosen topics ([] = all)
 *   pushState   "granted" | "denied" | "unsupported" | "off"
 *   needsInstall  iOS, not installed to the Home Screen
 *   busy        an action is in flight
 */
export function render(state) {
  const panel = getPanel();
  if (!panel) return;

  const body = panel.querySelector(".np-body");
  const foot = panel.querySelector(".np-foot");
  const markRead = panel.querySelector(".np-mark-read");
  if (!body || !foot) return;

  panel.classList.toggle("is-busy", !!state.busy);
  setBadge(state.unread || 0);
  if (markRead) markRead.hidden = !(state.phase === "following" && state.unread > 0);

  // ── body ──
  if (state.phase === "loading") {
    body.innerHTML = `<div class="np-empty"><i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i></div>`;
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
          state.phase === "following"
            ? t("empty_following", "Nothing yet. New posts will show up here.")
            : t("empty", "Follow the blog to get notified about new posts.")
        )}</p>
      </div>`;
  } else {
    body.innerHTML = `<div class="np-list">${state.items.map(itemHTML).join("")}</div>`;
  }

  // ── foot ──
  const parts = [];

  if (state.phase === "signed-out") {
    parts.push(
      `<button type="button" class="np-action np-login"><i class="fa-brands fa-github" aria-hidden="true"></i> ${escapeHTML(
        t("sign_in", "Sign in with GitHub")
      )}</button>`
    );
  } else if (state.phase === "not-following") {
    parts.push(
      `<button type="button" class="np-action np-follow"><i class="fa-regular fa-bell" aria-hidden="true"></i> ${escapeHTML(
        t("follow", "Follow this blog")
      )}</button>`
    );
  } else if (state.phase === "following") {
    if (state.topics && state.topics.length > 1) {
      parts.push(`<div class="np-topics">${topicsHTML(state.topics, state.selected || [])}</div>`);
    }

    // Say plainly what the reader will and will not receive. "Following" with a
    // blocked permission is the one state where the bell alone would lie.
    if (state.pushState === "denied") {
      parts.push(
        `<p class="np-note">${escapeHTML(
          t("push_denied", "Notifications are blocked in your browser — new items still appear here.")
        )}</p>`
      );
    } else if (state.pushState === "insecure") {
      parts.push(
        `<p class="np-note">${escapeHTML(
          t(
            "push_insecure",
            "Push needs a secure connection (https, or localhost) — new items still appear here."
          )
        )}</p>`
      );
    } else if (state.pushState === "unsupported") {
      parts.push(
        `<p class="np-note">${escapeHTML(
          t("push_unsupported", "This browser can't receive push — new items still appear here.")
        )}</p>`
      );
    } else if (state.needsInstall) {
      parts.push(
        `<p class="np-note">${escapeHTML(
          t("push_ios", "On iPhone, add this site to your Home Screen to receive push notifications.")
        )}</p>`
      );
    } else if (state.pushState === "off") {
      parts.push(
        `<button type="button" class="np-action np-enable-push"><i class="fa-regular fa-bell" aria-hidden="true"></i> ${escapeHTML(
          t("enable_push", "Enable push on this device")
        )}</button>`
      );
    }

    parts.push(
      `<button type="button" class="np-unfollow">${escapeHTML(t("unfollow", "Unfollow"))}</button>`
    );
  }

  foot.innerHTML = parts.join("");
}
