/**
 * Blog Management — the admin console at /blog-management/.
 *
 * Four sections, each painted independently so a slow list never holds up the
 * others:
 *
 *   A · Posts      every article and album the site has, whatever state it is
 *                  in, with what can be done to each. Built entirely from the
 *                  inventory sealed alongside this page (scripts/lib/post-
 *                  inventory.js) — the Worker is asked ONE question, which is
 *                  the only one a build cannot answer: who may read what.
 *   B · Announce   compose and send one announcement, with an allowlist or a
 *                  blocklist of GitHub identities, and a full server receipt.
 *   C · Notifications  what the database still holds — edit the wording, or
 *                  delete a row and every inbox reference to it.
 *   D · Followers  the global per-topic blocklists, then every follower with the
 *                  devices hanging off them, each mutable or bannable.
 *
 * Reached only through plugins/admin-gate.js, which has already established two
 * things by the time this runs: the Worker released the admin key, and this
 * page's markup decrypted under it. Every route called from here is checked by
 * the Worker against the isAdmin claim in the session token as well.
 */

import {
  setBusy,
  confirmStep,
  disarmConfirm,
  timeAgo,
  escapeHTML,
  describeDevice,
} from "./notifications-inbox.js";
import { Picker, avatarOf } from "../tools/chipPicker.js";
import { siteRoot } from "../tools/vaultCrypto.js";
import { enter, exit, pop } from "./editor/motion.js";

// The morph used for inline editing: content fades out, the box resizes, content
// fades back. Same shape and the same feel as editing an instant-note bubble.
const FADE_MS = 130;
const MORPH_MS = 280;
const MORPH_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const FADE_BLUR = "blur(3px)";

const TOPICS = ["posts", "notes", "announcements"];

const TYPE_ICONS = {
  announcement: "fa-bullhorn",
  post: "fa-file-lines",
  note: "fa-comment-dots",
};

// What a list shows while its first page is in flight. Switching a filter or
// opening the page must not look like an empty database.
const SPINNER_ROW =
  '<li class="bm-blank"><i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i></li>';

const MODERATION_DOCS =
  "https://docs.github.com/en/communities/maintaining-your-safety-on-github/blocking-a-user-from-your-personal-account";

/**
 * Tell the scroll scheduler the page just changed height.
 *
 * Every paint here can add or remove screens of content without a scroll or a
 * resize, and the scheduler's cached `scrollHeight` is what the side-tools and
 * the progress percentage are computed from. This is the theme's own batched
 * signal for exactly that.
 */
function contentChanged() {
  try {
    window.dispatchEvent(new CustomEvent("redefine:content-resized"));
  } catch {}
}

// ─── strings ─────────────────────────────────────────────────
function t(key, fallback) {
  const strings = (window.theme && window.theme.management_i18n) || {};
  return strings[key] || fallback;
}

/** Escaped translation — every call site below writes into innerHTML. */
function e(key, fallback) {
  return escapeHTML(t(key, fallback));
}

// ─── state ───────────────────────────────────────────────────
let root = null;
let base = "";
let reduced = false;

const state = {
  compose: { mode: "all" },
  notifications: { type: "", items: [], cursor: 0, more: false, error: false, loading: false },
  followers: { items: [], cursor: 0, more: false, orphans: [], totals: null, error: false, loading: false },
  // `items` arrives sealed with the page and is never fetched; only `audiences`
  // is asked for, because only the Worker knows it. `queue` is what the next
  // unpublish commit will carry — one commit for the whole selection.
  posts: { items: [], audiences: {}, filter: "", loading: false, queue: [], bar: null, busy: false },
  blocklists: { posts: [], notes: [], announcements: [] },
};

// Every chip picker on the page, by key: "audience" for the composer, then one
// per topic for the global blocklists.
const pickers = new Map();

// ─── backend ─────────────────────────────────────────────────
async function token() {
  if (!window.blogAuth) return null;
  try {
    return await window.blogAuth.getSessionToken();
  } catch {
    return null;
  }
}

/**
 * One authenticated admin call.
 *
 * Returns the status alongside the body rather than null-on-failure: this page
 * has to tell "you are not an admin" (403) apart from "the Worker did not
 * answer", and those look identical once the result is a bare null.
 */
async function api(path, options = {}, retry = true) {
  const auth = await token();
  if (!auth) return { ok: false, status: 401, data: null };

  const init = {
    method: options.method || "GET",
    headers: { Authorization: `Bearer ${auth}` },
  };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let res;
  try {
    res = await fetch(base + path, init);
  } catch {
    return { ok: false, status: 0, data: null };
  }

  // A session token lives two hours and is cached per tab, so a tab left open
  // across that boundary arrives holding one the Worker will refuse. One forced
  // re-mint fixes it silently; a second 403 is a real answer.
  if ((res.status === 401 || res.status === 403) && retry && window.blogAuth) {
    await window.blogAuth.getSession(true);
    return api(path, options, false);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { ok: res.ok, status: res.status, data };
}

// ─── the edit morph ──────────────────────────────────────────
/**
 * Swap the contents of a box without it jumping.
 *
 * The height is measured off the INNER element, never the host: a host that has
 * been given an explicit height reports that height, so measuring it would make
 * every box exactly as tall as it already was and the animation a no-op.
 *
 * @param {Element} host    the box whose height animates
 * @param {Function} mutate replaces the contents; must return the NEW inner
 */
function morph(host, inner, mutate) {
  if (reduced) {
    mutate();
    return;
  }

  const from = inner.getBoundingClientRect().height;

  inner.style.transition = `opacity ${FADE_MS}ms ease, filter ${FADE_MS}ms ease`;
  inner.style.opacity = "0";
  inner.style.filter = FADE_BLUR;

  setTimeout(() => {
    if (!host.isConnected) return;
    const next = mutate() || host.firstElementChild;
    if (!next) return;

    next.style.transition = "none";
    next.style.opacity = "0";
    next.style.filter = FADE_BLUR;
    const to = next.getBoundingClientRect().height;

    host.style.overflow = "hidden";
    host.style.height = `${from}px`;
    void host.offsetHeight;
    host.style.transition = `height ${MORPH_MS}ms ${MORPH_EASE}`;
    host.style.height = `${to}px`;

    next.style.transition = `opacity ${MORPH_MS * 0.7}ms ease, filter ${MORPH_MS * 0.7}ms ease`;
    next.style.opacity = "1";
    next.style.filter = "none";

    const done = (event) => {
      if (event.propertyName !== "height") return;
      host.removeEventListener("transitionend", done);
      host.style.transition = "";
      host.style.height = "";
      host.style.overflow = "";
      next.style.transition = "";
      next.style.filter = "";
      contentChanged();
    };
    host.addEventListener("transitionend", done);
  }, FADE_MS);
}

// ─── chip picker ─────────────────────────────────────────────
// The class itself lives in tools/chipPicker.js so the encrypted-post page can
// put the same control above an article. Only the two dependencies it refuses
// to assume — the identity lookup and the translator — are supplied here.
async function lookupIdentity(raw) {
  const result = await api("/api/admin/lookup", { method: "POST", body: { ids: [raw] } });
  return { ok: result.ok, matched: (result.data && result.data.matched) || [] };
}

function makePicker(key, host, options) {
  return new Picker(key, host, { ...options, lookup: lookupIdentity, t });
}

// ─── A · compose ─────────────────────────────────────────────
function renderCompose(section) {
  section.innerHTML = `
    <h2 class="bm-section-title">
      <i class="fa-solid fa-bullhorn" aria-hidden="true"></i>${e("announce", "Send an announcement")}
    </h2>

    <div class="bm-card bm-compose">
      <div class="bm-compose-audience">
        <div class="bm-seg" role="group" aria-label="${e("audience", "Audience")}">
          <button type="button" data-mode="all" class="is-on">${e("aud_all", "Everyone")}</button>
          <button type="button" data-mode="users">${e("aud_only", "Only these")}</button>
          <button type="button" data-mode="except">${e("aud_except", "Everyone except")}</button>
        </div>
        <div class="bm-picker-host" data-picker="audience" hidden></div>
        <p class="bm-hint bm-audience-hint">${e("aud_all_hint", "Every follower receives this.")}</p>
      </div>

      <div class="bm-compose-fields">
        <input class="bm-field bm-c-title" type="text" maxlength="120"
               placeholder="${e("f_title", "Title")}">
        <textarea class="bm-field bm-c-body" maxlength="500" rows="3"
                  placeholder="${e("f_body", "What happened, in a sentence or two")}"></textarea>
        <input class="bm-field bm-c-url" type="url"
               placeholder="${e("f_url", "Link — where pressing the notification goes")}">
      </div>

      <footer class="bm-compose-foot">
        <span class="bm-counter"><span class="bm-c-count">0</span>/500</span>
        <button type="button" class="bm-primary bm-send" disabled>
          <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
          <span class="np-btn-label">${e("post", "Post announcement")}</span>
        </button>
      </footer>
    </div>

    <div class="bm-receipt" hidden></div>`;

  const host = section.querySelector('[data-picker="audience"]');
  pickers.set(
    "audience",
    makePicker("audience", host, {
      placeholder: t("aud_placeholder", "GitHub login or numeric id, then Enter"),
      onCommit: () => syncCompose(),
    })
  );

  section.querySelectorAll(".bm-field").forEach((field) => {
    field.addEventListener("input", syncCompose);
  });
  syncCompose();
}

function composeMode(mode) {
  state.compose.mode = mode;
  const section = root.querySelector('[data-part="announce"]');
  section.querySelectorAll(".bm-seg button").forEach((b) => {
    b.classList.toggle("is-on", b.dataset.mode === mode);
  });
  section.querySelector('[data-picker="audience"]').hidden = mode === "all";
  section.querySelector(".bm-audience-hint").textContent =
    mode === "all"
      ? t("aud_all_hint", "Every follower receives this.")
      : mode === "users"
        ? t("aud_only_hint", "Only the readers listed here receive this.")
        : t("aud_except_hint", "Every follower except the readers listed here.");
  syncCompose();
}

/** The Post button is enabled only when a send would actually be well formed. */
function syncCompose() {
  const section = root.querySelector('[data-part="announce"]');
  if (!section) return;
  const title = section.querySelector(".bm-c-title");
  const body = section.querySelector(".bm-c-body");
  const url = section.querySelector(".bm-c-url");
  const post = section.querySelector(".bm-send");
  const picker = pickers.get("audience");
  if (!title || !post) return;

  section.querySelector(".bm-c-count").textContent = String(body.value.length);

  const mode = state.compose.mode;
  const needsList = mode !== "all";
  const audienceReady =
    !needsList || (picker && picker.settled && picker.ids.length > 0);

  post.disabled = !title.value.trim() || !url.value.trim() || !audienceReady;
}

/** `announce:2026-08-29-a-title-k3f9` — readable in the list, unique per send. */
function announcementId(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const day = new Date().toISOString().slice(0, 10);
  return `announce:${day}-${slug || "untitled"}-${Date.now().toString(36).slice(-4)}`;
}

async function send(trigger) {
  const section = root.querySelector('[data-part="announce"]');
  const title = section.querySelector(".bm-c-title").value.trim();
  const body = section.querySelector(".bm-c-body").value.trim();
  const url = section.querySelector(".bm-c-url").value.trim();
  const mode = state.compose.mode;
  const picker = pickers.get("audience");

  setBusy(trigger, true);

  const audience =
    mode === "all" ? { kind: "all" } : { kind: mode, users: picker ? picker.ids : [] };

  const result = await api("/api/admin/notifications", {
    method: "POST",
    body: {
      id: announcementId(title),
      type: "announcement",
      topic: "announcements",
      title,
      body,
      url,
      tag: "announcements",
      audience,
    },
  });

  setBusy(trigger, false);
  renderReceipt(section.querySelector(".bm-receipt"), result, { mode, audience });

  if (result.ok) {
    section.querySelector(".bm-c-title").value = "";
    section.querySelector(".bm-c-body").value = "";
    section.querySelector(".bm-c-url").value = "";
    if (picker) picker.clear();
    syncCompose();
    setFilter("");
  }
}

function renderReceipt(host, result, { mode, audience }) {
  host.hidden = false;

  if (!result.ok) {
    const detail =
      (result.data && (result.data.error || result.data.message)) ||
      (result.status ? `HTTP ${result.status}` : t("offline", "The Worker did not answer."));
    host.className = "bm-receipt is-bad";
    host.innerHTML = `<div class="bm-receipt-head">
        <i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>
        <span>${e("send_failed", "Not sent")}</span></div>
      <p class="bm-receipt-note">${escapeHTML(detail)}</p>`;
    return;
  }

  const data = result.data || {};
  const one = (data.counts || [])[0] || {};
  const matched = (data.audience && data.audience.matched) || [];
  const unknown = (data.audience && data.audience.unknown) || [];

  const rows = [
    [t("r_id", "Id"), data.ingested && data.ingested[0]],
    [t("r_recipients", "Inboxes written"), one.recipients],
    [t("r_devices", "Push devices"), one.devices],
    [t("r_messages", "Queue messages"), one.messages],
    [
      t("r_audience", "Audience"),
      mode === "all"
        ? t("aud_all", "Everyone")
        : `${mode === "users" ? t("aud_only", "Only these") : t("aud_except", "Everyone except")} · ${
            (audience.users || []).length
          }`,
    ],
  ];
  if (matched.length) {
    rows.push([
      t("r_matched", "Matched"),
      matched.map((m) => `${m.login} #${m.id}`).join(", "),
    ]);
  }
  if (unknown.length) rows.push([t("r_ignored", "Ignored"), unknown.join(", ")]);
  if ((data.skipped || []).length) rows.push([t("r_skipped", "Already sent"), data.skipped.join(", ")]);
  if (data.absorbed) rows.push([t("r_absorbed", "Absorbed"), t("r_absorbed_v", "recorded, not delivered")]);

  host.className = "bm-receipt is-good";
  host.innerHTML = `<div class="bm-receipt-head">
      <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
      <span>${e("send_ok", "Sent")}</span></div>
    <dl class="bm-receipt-grid">${rows
      .map(
        ([k, v]) =>
          `<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v == null || v === "" ? "—" : v)}</dd>`
      )
      .join("")}</dl>`;
}

// ─── B · notifications ───────────────────────────────────────
function renderNotificationsShell(section) {
  const filters = [
    ["", t("f_all", "All")],
    ["announcement", t("f_announcements", "Announcements")],
    ["post", t("f_posts", "Posts")],
    ["note", t("f_notes", "Notes")],
  ];

  section.innerHTML = `
    <h2 class="bm-section-title">
      <i class="fa-solid fa-list-ul" aria-hidden="true"></i>${e("notifications", "Notification list")}
      <span class="bm-count bm-notif-count"></span>
    </h2>
    <div class="bm-seg bm-notif-filter" role="group">
      ${filters
        .map(
          ([value, label]) =>
            `<button type="button" data-type="${escapeHTML(value)}"${
              value === state.notifications.type ? ' class="is-on"' : ""
            }>${escapeHTML(label)}</button>`
        )
        .join("")}
    </div>
    <ul class="bm-notifs"></ul>
    <div class="bm-foot"></div>`;
}

function notifInnerHTML(row) {
  let audience = "";
  try {
    const parsed = JSON.parse(row.audience_json || "{}");
    audience =
      parsed.kind === "users"
        ? `${t("aud_only", "Only these")} ${(parsed.users || []).length}`
        : parsed.kind === "except"
          ? `${t("aud_except", "Everyone except")} ${(parsed.users || []).length}`
          : parsed.kind === "all"
            ? t("aud_all", "Everyone")
            : t("aud_topic", "By topic");
  } catch {}

  const meta = [
    row.id,
    row.type,
    row.topic,
    row.source,
    `${row.recipients} ${t("m_inboxes", "inboxes")}`,
    `${row.devices} ${t("m_devices", "devices")}`,
    audience,
    timeAgo(row.published_at),
  ].filter(Boolean);

  return `
      <div class="bm-notif-inner">
        <span class="bm-notif-icon">
          <i class="fa-solid ${TYPE_ICONS[row.type] || "fa-bell"}" aria-hidden="true"></i>
        </span>
        <div class="bm-notif-main">
          <div class="bm-notif-title">${escapeHTML(row.title)}</div>
          ${row.body ? `<p class="bm-notif-body">${escapeHTML(row.body)}</p>` : ""}
          <a class="bm-notif-url" href="${escapeHTML(row.url)}" target="_blank" rel="noopener">
            ${escapeHTML(row.url)}</a>
          <div class="bm-notif-meta">${meta
            .map((part) => `<span>${escapeHTML(part)}</span>`)
            .join('<span class="bm-sep"></span>')}</div>
        </div>
        <div class="bm-notif-actions">
          <button type="button" class="bm-icon bm-edit" aria-label="${e("edit", "Edit")}">
            <i class="fa-solid fa-pen" aria-hidden="true"></i></button>
          <button type="button" class="bm-icon bm-del" aria-label="${e("delete", "Delete")}">
            <i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
        </div>
      </div>`;
}

/** The row's own <li>, which only the initial paint builds. */
function notificationHTML(row) {
  return `<li class="bm-notif" data-id="${escapeHTML(row.id)}">${notifInnerHTML(row)}</li>`;
}

function editorHTML(row) {
  return `
    <div class="bm-notif-inner is-editing">
      <div class="bm-notif-main">
        <input class="bm-field bm-e-title" type="text" maxlength="120"
               value="${escapeHTML(row.title)}">
        <textarea class="bm-field bm-e-body" maxlength="500" rows="3">${escapeHTML(row.body || "")}</textarea>
        <input class="bm-field bm-e-url" type="url" value="${escapeHTML(row.url)}">
        <p class="bm-hint">${e("edit_hint", "Editing changes the inbox copy only. Nothing is pushed again.")}</p>
      </div>
      <div class="bm-notif-actions">
        <button type="button" class="bm-icon bm-save" aria-label="${e("save", "Save")}">
          <i class="fa-solid fa-check" aria-hidden="true"></i></button>
        <button type="button" class="bm-icon bm-cancel" aria-label="${e("cancel", "Cancel")}">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
    </div>`;
}

function paintNotifications() {
  const section = root.querySelector('[data-part="notifications"]');
  const list = section.querySelector(".bm-notifs");
  const foot = section.querySelector(".bm-foot");
  const box = state.notifications;

  section.querySelector(".bm-notif-count").textContent = box.items.length
    ? String(box.items.length)
    : "";

  section.classList.toggle("is-loading", box.loading);

  if (box.loading && !box.items.length) {
    list.innerHTML = SPINNER_ROW;
  } else if (box.error) {
    list.innerHTML = `<li class="bm-blank">${e("unreachable", "Couldn't reach the notification service.")}</li>`;
  } else if (!box.items.length) {
    list.innerHTML = `<li class="bm-blank">${e("no_notifications", "Nothing in the database for this filter.")}</li>`;
  } else {
    list.innerHTML = box.items.map(notificationHTML).join("");
  }

  foot.innerHTML = box.more
    ? `<button type="button" class="bm-quiet bm-more" data-more="notifications">
         <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
         <span class="np-btn-label">${e("load_more", "Load more")}</span></button>`
    : "";

  contentChanged();
}

/** Switch the type filter and reload under it. */
function setFilter(type) {
  state.notifications.type = type;
  root.querySelectorAll(".bm-notif-filter button").forEach((b) => {
    b.classList.toggle("is-on", b.dataset.type === type);
  });
  loadNotifications({ reset: true });
}

async function loadNotifications({ reset = false, trigger = null } = {}) {
  const box = state.notifications;
  if (reset) {
    box.items = [];
    box.cursor = 0;
    box.more = false;
  }
  if (trigger) setBusy(trigger, true);
  box.loading = true;
  paintNotifications();

  const query = `?type=${encodeURIComponent(box.type)}&cursor=${box.cursor}`;
  const result = await api(`/api/admin/notifications${query}`);

  box.loading = false;
  box.error = !result.ok;
  if (result.ok && result.data) {
    box.items = box.items.concat(result.data.items || []);
    box.more = result.data.cursor != null;
    box.cursor = result.data.cursor || box.cursor;
  }
  paintNotifications();
}

function startEdit(item) {
  const row = state.notifications.items.find((n) => n.id === item.dataset.id);
  if (!row || item.querySelector(".is-editing")) return;

  morph(item, item.firstElementChild, () => {
    item.innerHTML = editorHTML(row);
    const field = item.querySelector(".bm-e-title");
    if (field) field.focus();
    return item.firstElementChild;
  });
}

function cancelEdit(item) {
  const row = state.notifications.items.find((n) => n.id === item.dataset.id);
  if (!row) return;
  morph(item, item.firstElementChild, () => {
    item.innerHTML = notifInnerHTML(row);
    return item.firstElementChild;
  });
}

async function saveEdit(item, trigger) {
  const id = item.dataset.id;
  const row = state.notifications.items.find((n) => n.id === id);
  if (!row) return;

  const title = item.querySelector(".bm-e-title").value.trim();
  const body = item.querySelector(".bm-e-body").value.trim();
  const url = item.querySelector(".bm-e-url").value.trim();
  if (!title) return;

  setBusy(trigger, true);
  const result = await api(`/api/admin/notifications/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: { title, body, url },
  });
  setBusy(trigger, false);

  if (!result.ok) {
    item.classList.add("is-bad");
    setTimeout(() => item.classList.remove("is-bad"), 1200);
    return;
  }

  row.title = title;
  row.body = body;
  if (url) row.url = url;
  cancelEdit(item);
}

async function deleteNotification(item, trigger) {
  const id = item.dataset.id;
  setBusy(trigger, true);
  const result = await api(`/api/admin/notifications/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  setBusy(trigger, false);
  if (!result.ok) return;

  state.notifications.items = state.notifications.items.filter((n) => n.id !== id);
  collapseAway(item, paintNotifications);
}

/** Shrink a row to nothing before it leaves, so the list never jumps. */
function collapseAway(item, after) {
  if (reduced) {
    after();
    return;
  }
  const height = item.getBoundingClientRect().height;
  item.style.overflow = "hidden";
  item.style.height = `${height}px`;
  void item.offsetHeight;
  item.style.transition = `height ${MORPH_MS}ms ${MORPH_EASE}, opacity ${FADE_MS}ms ease`;
  item.style.opacity = "0";
  item.style.height = "0px";
  setTimeout(after, MORPH_MS);
}

// ─── A · posts ───────────────────────────────────────────────
//
// Every article and album the site has, in one list, whatever state it is in.
//
// ── What a row knows ────────────────────────────────────────────────────────
//
// All of it, before the page opened. Titles, dates, taxonomy, excerpts, which
// file each one lives in and what state it is in were settled by the build and
// sealed into this page (scripts/lib/post-inventory.js). The console used to
// ask the Worker for a registry that holds no metadata and then fetch and
// decrypt one card per encrypted post to find out what it was called; none of
// that happens any more. ONE request is made, for the audiences, because who
// may read what is the only thing a build cannot know.
//
// ── The states, and which controls each one earns ───────────────────────────
//
//   published + public       Edit · Unpublish
//   published + encrypted    Edit · Unpublish · who may read it
//   published + a draft      the draft's own badge; Edit opens the DRAFT
//   unpublished (draft only) Edit · nothing to unpublish, and no audience —
//                            a draft is the author's unfinished copy and has
//                            exactly one reader, which is why the Worker
//                            refuses to grant one however it is asked.
//   album                    who may read it, when it is encrypted. Its flag
//                            lives in masonry.yml, so there is no file here to
//                            edit and nothing to unpublish.

const POST_FILTERS = ["", "encrypted", "draft", "unpublished", "pinned"];

/** Where the composer lives. Not a section of its own: writing a post is the
 *  thing this list is for, so the button belongs at the top of the list. */
function writeHref() {
  return siteRoot() + "/blog-management/write/";
}

function renderPostsShell(section) {
  const filters = [
    ["", t("p_all", "All")],
    ["encrypted", t("p_encrypted", "Encrypted")],
    ["draft", t("p_drafts", "Drafts")],
    ["unpublished", t("p_unpublished", "Unpublished")],
    ["pinned", t("p_sticky", "Sticky")],
  ];

  section.innerHTML = `
    <h2 class="bm-section-title">
      <i class="fa-solid fa-newspaper" aria-hidden="true"></i>${e("p_title", "Posts management")}
      <span class="bm-count bm-post-count"></span>
    </h2>
    <p class="bm-lede">${e(
      "p_lede",
      "Every article and album on the site, and what can be done with each. Nothing here is fetched — it was sealed into this page by the build."
    )}</p>

    <div class="bm-post-bar">
      <div class="bm-seg bm-post-filter" role="group">
        ${filters
          .map(
            ([value, label]) =>
              `<button type="button" data-filter="${escapeHTML(value)}"${
                value === state.posts.filter ? ' class="is-on"' : ""
              }>${escapeHTML(label)}</button>`
          )
          .join("")}
      </div>
      <a class="bm-write" href="${escapeHTML(writeHref())}">
        <i class="fa-solid fa-feather-pointed" aria-hidden="true"></i>
        <span>${e("p_new", "New post")}</span>
      </a>
    </div>

    <ul class="bm-post-list"></ul>`;
}

/**
 * Which chips a row wears — the same icons, the same words and the same order
 * the home tile's badge stack uses (layout/components/vault-badge), so the two
 * surfaces are one vocabulary rather than two that happen to overlap. A row can
 * say more than a tile can: a published encrypted post with a draft in front of
 * it wears both, where the tile shows only the version being read.
 */
function postFlags(row) {
  const flags = [];
  if (row.sticky) flags.push(["sticky", "fa-thumbtack", t("p_sticky", "Sticky")]);
  if (row.kind === "album") flags.push(["album", "fa-images", t("p_album", "Album")]);
  if (row.encrypted) flags.push(["encrypted", "fa-lock-keyhole", t("v_badge", "Encrypted")]);
  if (row.draft) flags.push(["draft", "fa-pen-nib", t("p_draft", "Draft")]);
  if (!row.published) flags.push(["unpublished", "fa-eye-slash", t("p_unpublished_tag", "Unpublished")]);
  return flags;
}

function matchesFilter(row, filter) {
  if (!filter) return true;
  if (filter === "encrypted") return !!row.encrypted;
  if (filter === "draft") return !!row.draft;
  if (filter === "unpublished") return !row.published;
  if (filter === "pinned") return !!row.sticky;
  return true;
}

/**
 * Can this row's audience be set?
 *
 * Only a genuinely PUBLISHED encrypted item. A draft is not published, so there
 * is nobody to grant it to; an article whose published version is public is
 * readable by everyone already. An encrypted post that also has a draft keeps
 * its control — the grant is on the published version, which is what readers
 * still see, and the draft standing in front of it changes nothing about that.
 */
function canGrant(row) {
  return !!(row.published && row.encrypted && row.vaultId);
}

/** The draft's page when there is one — editing anything else forks a second
 *  draft of the same article, and the reader is already being shown this one. */
function editHref(row) {
  const target = row.draft ? row.draft.href : row.href;
  return target + (target.indexOf("#") < 0 ? "#edit" : "");
}

function postRowHTML(row) {
  const when = row.date ? new Date(row.date) : null;
  const readers = (state.posts.audiences[row.vaultId] || []).length;
  const grant = canGrant(row);
  const meta = [];

  if (when) {
    meta.push(
      `<span><i class="fa-solid fa-calendars"></i>${when.toISOString().slice(0, 10)}</span>`
    );
  }
  if ((row.categories || []).length) {
    meta.push(
      `<span><i class="fa-solid fa-folders"></i>${escapeHTML(row.categories.join(" / "))}</span>`
    );
  }
  if ((row.tags || []).length) {
    meta.push(`<span><i class="fa-solid fa-tags"></i>${escapeHTML(row.tags.join(", "))}</span>`);
  }
  if (row.slug) {
    meta.push(`<span class="bm-post-slug"><i class="fa-solid fa-link"></i>${escapeHTML(row.slug)}</span>`);
  }

  // The bubbles, top right — the same object the bento home uses for a count on
  // a card: a pill, an icon, a number. The readers bubble is one of them rather
  // than a control of its own, so a row's status reads as one line of chips.
  const bubbles = postFlags(row)
    .map(
      ([kind, icon, label]) =>
        `<span class="bm-bubble is-${kind}"><i class="fa-regular ${icon}" aria-hidden="true"></i>${escapeHTML(
          label
        )}</span>`
    )
    .join("");

  // The count is the one thing on a row that is NOT sealed with the page, so
  // until the Worker answers it shows the console's own spinner rather than a
  // zero that would read as "nobody can open this".
  const readerBubble = grant
    ? `<span class="bm-bubble is-readers" data-empty="${readers ? "0" : "1"}">
         <i class="fa-regular fa-user-lock" aria-hidden="true"></i>
         ${
           state.posts.loading
             ? `<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>`
             : `<strong>${readers}</strong>${escapeHTML(
                 t(readers === 1 ? "v_reader" : "v_readers", "readers")
               )}`
         }</span>`
    : "";

  // An album's `vault:` flag lives in masonry.yml, so there is no markdown file
  // here to open and nothing to take down.
  const queued = state.posts.queue.includes(row.key);
  const actions =
    row.kind === "album"
      ? ""
      : `<a class="bm-quiet bm-post-edit" href="${escapeHTML(editHref(row))}">
           <i class="fa-solid fa-pen" aria-hidden="true"></i>
           <span class="np-btn-label">${e("edit", "Edit")}</span></a>
         ${
           row.published
             ? `<button type="button" class="bm-quiet bm-danger bm-post-unpublish${queued ? " is-on" : ""}">
                  <i class="fa-solid ${queued ? "fa-check" : "fa-eye-slash"}" aria-hidden="true"></i>
                  <span class="np-btn-label">${
                    queued ? e("p_unpub_queued", "Queued") : e("p_unpublish", "Unpublish")
                  }</span></button>`
             : ""
         }`;

  return `
    <li class="bm-post${row.encrypted ? " is-encrypted" : ""}${row.draft ? " is-draft" : ""}${
      queued ? " is-queued" : ""
    }" data-key="${escapeHTML(row.key)}">
      <div class="bm-post-main">
        <div class="bm-post-title">
          <i class="fa-solid ${
            row.kind === "album" ? "fa-images" : row.encrypted ? "fa-lock-keyhole" : "fa-file-lines"
          }" aria-hidden="true"></i>
          <a href="${escapeHTML(row.href)}" target="_blank" rel="noopener">${escapeHTML(
            row.title || t("p_untitled", "Untitled")
          )}</a>
        </div>
        <div class="bm-post-meta">${meta.join("")}</div>
        ${row.excerpt ? `<p class="bm-post-excerpt">${escapeHTML(row.excerpt)}</p>` : ""}
      </div>

      <div class="bm-post-side">
        <div class="bm-bubbles">${bubbles}${readerBubble}</div>
        <div class="bm-post-actions">${actions}</div>
      </div>

      ${
        grant
          ? `<div class="bm-post-audience">
               <label class="bm-blocklist-label">
                 ${e("v_audience", "Who can read this")}
                 <span class="bm-save-state" data-save="vault:${escapeHTML(row.vaultId)}"></span>
               </label>
               <div class="bm-picker-host" data-picker="vault:${escapeHTML(row.vaultId)}"></div>
             </div>`
          : ""
      }
    </li>`;
}

function paintPosts() {
  const section = root.querySelector('[data-part="posts"]');
  if (!section) return;
  const list = section.querySelector(".bm-post-list");
  const box = state.posts;
  const shown = box.items.filter((row) => matchesFilter(row, box.filter));

  section.querySelector(".bm-post-count").textContent = shown.length || "";

  if (!shown.length) {
    list.innerHTML = `<li class="bm-blank">${e("p_empty", "Nothing matches this filter.")}</li>`;
  } else {
    list.innerHTML = shown.map(postRowHTML).join("");
  }

  // One picker per grantable row, rebuilt with the list because the rows they
  // hang off are replaced wholesale. Unlike the blocklists these do NOT
  // autosave on every keystroke: a half-typed audience must not silently take
  // someone's access away.
  for (const row of shown) {
    if (!canGrant(row)) continue;
    const key = `vault:${row.vaultId}`;
    const host = section.querySelector(`[data-picker="${CSS.escape(key)}"]`);
    if (!host) continue;
    const picker = makePicker(key, host, {
      placeholder: t("aud_placeholder", "GitHub login or numeric id, then Enter"),
      onCommit: (p) => saveAudience(row.vaultId, p),
    });
    picker.set(box.audiences[row.vaultId] || []);
    pickers.set(key, picker);
  }

  contentChanged();
}

function setPostFilter(value) {
  state.posts.filter = POST_FILTERS.includes(value) ? value : "";
  root.querySelectorAll(".bm-post-filter button").forEach((b) => {
    b.classList.toggle("is-on", b.dataset.filter === state.posts.filter);
  });
  paintPosts();
}

/** The one question the build could not answer. */
async function loadAudiences() {
  state.posts.loading = true;
  const result = await api("/api/admin/vault");
  state.posts.loading = false;
  if (result.ok && result.data) state.posts.audiences = result.data.audiences || {};
  paintPosts();
}

async function saveAudience(postId, picker) {
  const flag = root.querySelector(`[data-save="${CSS.escape("vault:" + postId)}"]`);
  if (!picker.settled) {
    if (flag) flag.innerHTML = "";
    return;
  }
  if (flag) flag.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>`;

  // Full chips, not bare ids: the login travels with the grant so the panel can
  // render a name rather than a number the next time it loads.
  const audience = picker.entries;
  const result = await api(`/api/admin/vault/${encodeURIComponent(postId)}/audience`, {
    method: "PUT",
    body: { audience },
  });

  if (flag) {
    flag.innerHTML = result.ok
      ? `<i class="fa-solid fa-check" aria-hidden="true"></i>`
      : `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>`;
    if (result.ok) setTimeout(() => (flag.innerHTML = ""), 1800);
  }
  if (!result.ok) return;

  state.posts.audiences[postId] = audience;
  const host = root.querySelector(`[data-picker="${CSS.escape("vault:" + postId)}"]`);
  const bubble = host && host.closest(".bm-post").querySelector(".bm-bubble.is-readers");
  if (bubble) {
    bubble.querySelector("strong").textContent = audience.length;
    bubble.dataset.empty = audience.length ? "0" : "1";
  }
}

/* ─── unpublishing ───────────────────────────────────────────
 *
 * Taking an article down is a COMMIT and a BUILD, not a button that finishes
 * when it stops spinning, so it is run the way the editor runs a publish and
 * wears the editor's own document bar: the same box, the same pin line, the same
 * stage rail, the same backend chip. A second design for the same act would be a
 * second thing to learn about one thing.
 *
 * Pressing Unpublish QUEUES a row rather than acting on it. Five articles
 * withdrawn one at a time are five commits and five builds of the same site;
 * queued they are one of each, and the bar is where that one is armed, aimed at
 * a repository, and let go. There is no second confirmation because the bar is
 * the confirmation — the selection is visible, reversible, and nothing has been
 * written until Save & publish.
 */

const UNPUB_STAGES = [
  ["committed", "fa-code-commit", "Committed"],
  ["building", "fa-hammer", "Building"],
  ["pushed", "fa-upload", "Artifact pushed"],
  ["deployed", "fa-globe", "Deployed"],
];

const BACKEND_ICON = { gitea: "fa-solid fa-server", github: "fa-brands fa-github" };

// How long the deploy that follows the artifact push is given before the page is
// reloaded. Vercel is downstream of a push nothing here can see, so the last
// stage is optimistic by design — the same 20s the editor allows.
const DEPLOY_MS = 20000;
const POLL_MS = 6000;

let repoMod = null;
let credMod = null;
let buildTimer = null;

function loadRepo() {
  if (!repoMod) repoMod = import("./editor/repo.js");
  return repoMod;
}

/**
 * The repository tokens are held only while the bar is armed. Every event that
 * takes them away — signing out, navigating off, closing the tab — is enumerated
 * in editor/credentials.js; this is the console's claim on them.
 */
async function holdCredentials(on) {
  if (!credMod) credMod = import("./editor/credentials.js");
  const mod = await credMod;
  if (on) mod.hold();
  else mod.release();
}

function rowEl(key) {
  return root.querySelector(`.bm-post[data-key="${CSS.escape(key)}"]`);
}

function queuedRows() {
  const keys = new Set(state.posts.queue);
  return state.posts.items.filter((row) => keys.has(row.key));
}

/** Queue or unqueue one row. Nothing is written and nothing is asked. */
function toggleUnpublish(item) {
  const box = state.posts;
  if (box.busy) return;

  const key = item.dataset.key;
  const at = box.queue.indexOf(key);
  if (at < 0) box.queue.push(key);
  else box.queue.splice(at, 1);

  paintPosts();
  if (box.queue.length) openBar();
  else closeBar();
}

function stageRail() {
  return UNPUB_STAGES.map(
    ([key, icon, label]) =>
      `<span class="ed-stage" data-key="${key}" data-state="wait">
         <i class="fa-solid ${icon}" aria-hidden="true"></i>${escapeHTML(t("p_s_" + key, label))}
       </span>`
  ).join("");
}

function markStage(key, value) {
  const bar = state.posts.bar;
  const node = bar && bar.querySelector(`.ed-stage[data-key="${key}"]`);
  if (!node || node.dataset.state === value) return;
  node.dataset.state = value;
  pop(node);
}

function barNotice(kind, text) {
  const bar = state.posts.bar;
  if (!bar) return;
  const note = bar.querySelector(".ed-notice");
  if (!text) {
    note.hidden = true;
    return;
  }
  const icon =
    kind === "error"
      ? "fa-circle-exclamation"
      : kind === "warn"
        ? "fa-triangle-exclamation"
        : "fa-circle-info";
  note.hidden = false;
  note.dataset.kind = kind;
  note.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${escapeHTML(text)}</span>`;
  pop(note);
}

/**
 * The bar itself — above Posts Management, because what it is about to do is to
 * the whole list rather than to one row of it. No file name: a batch has no one
 * path, and what the author needs to see is how far the build has got.
 */
function openBar() {
  const box = state.posts;
  const opening = !box.bar;

  if (opening) {
    const bar = document.createElement("div");
    bar.className = "ed-docbar bm-unpub";
    bar.innerHTML = `
      <div class="ed-docbar-id">
        <i class="fa-solid fa-eye-slash" aria-hidden="true"></i>
        <span class="bm-unpub-count"></span>
      </div>
      <div class="ed-docbar-actions">
        <button type="button" class="ed-act ed-backend bm-unpub-backend" hidden></button>
        <span class="ed-dot" data-state="dirty"></span>
        <button type="button" class="ed-act ed-act-primary bm-unpub-go">
          <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
          <span>${e("p_unpub_go", "Save & publish")}</span>
        </button>
        <button type="button" class="ed-act ed-close bm-unpub-x" title="${escapeHTML(t("p_unpub_cancel", "Cancel"))}">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>
      <div class="ed-progress">${stageRail()}</div>
      <div class="ed-notice" hidden></div>`;

    root.insertBefore(bar, root.querySelector(".bm-console"));
    box.bar = bar;
    holdCredentials(true);
    bar.querySelector(".bm-unpub-x").addEventListener("click", () => closeBar());
    bar.querySelector(".bm-unpub-go").addEventListener("click", () => runUnpublish());
    bar.querySelector(".bm-unpub-backend").addEventListener("click", () => switchBackend());
  }

  const n = box.queue.length;
  box.bar.querySelector(".bm-unpub-count").textContent =
    `${n} ${t(n === 1 ? "p_unpub_one" : "p_unpub_many", n === 1 ? "post to withdraw" : "posts to withdraw")}`;

  // Counted and labelled BEFORE it travels. `enter` measures the bar it is
  // handed, and a bar that gains its line of text afterwards finishes its
  // travel at a height it then has to correct in a single frame.
  if (opening) {
    enter(box.bar);
    paintBackend();
  }
  contentChanged();
}

async function closeBar() {
  const box = state.posts;
  clearInterval(buildTimer);
  box.queue = [];
  box.busy = false;
  root.classList.remove("is-unpublishing");

  const bar = box.bar;
  box.bar = null;
  paintPosts();

  if (!bar) return;
  holdCredentials(false);
  await exit(bar);
  bar.remove();
  contentChanged();
}

/**
 * Which repository the commit goes to. Only worth showing when there is a
 * choice: with one backend configured the chip stays hidden rather than
 * labelling the obvious. The ticket is resolved once per session and cached by
 * repo.open, so opening this bar costs at most one request.
 */
async function paintBackend() {
  const bar = state.posts.bar;
  if (!bar) return;
  const chip = bar.querySelector(".bm-unpub-backend");

  let repo;
  try {
    repo = await loadRepo();
    await repo.open(false);
  } catch (err) {
    chip.hidden = true;
    return;
  }

  const rows = repo.backends();
  const id = repo.activeId();
  if (!id || rows.length < 2) {
    chip.hidden = true;
    return;
  }

  const now = rows.find((row) => row.id === id);
  const other = rows.find((row) => row.id !== id);
  chip.hidden = false;
  chip.dataset.backend = id;
  chip.innerHTML =
    `<i class="${BACKEND_ICON[id] || BACKEND_ICON.gitea}" aria-hidden="true"></i>` +
    `<span>${escapeHTML((now && now.label) || id)}</span>`;
  chip.title = other ? `${t("p_backend", "Build on")} ${other.label || other.id}` : "";
}

async function switchBackend() {
  const bar = state.posts.bar;
  if (!bar || state.posts.busy) return;
  const chip = bar.querySelector(".bm-unpub-backend");

  const repo = await loadRepo();
  const other = repo.backends().find((row) => row.id !== repo.activeId());
  if (!other) return;

  chip.disabled = true;
  try {
    await repo.use(other.id);
    await paintBackend();
  } catch (err) {
    barNotice("error", t("unreachable", "Couldn't reach the backend."));
  } finally {
    chip.disabled = false;
  }
}

/**
 * One commit for the whole selection: every article's markdown becomes a draft —
 * encrypted, readable by nobody else — and every published file is deleted, so
 * there is no window in which one of them is both live and withdrawn or in which
 * neither copy exists. The build that follows is what rebuilds the site without
 * them.
 */
async function runUnpublish() {
  const box = state.posts;
  if (box.busy || !box.queue.length) return;

  const rows = queuedRows();
  if (!rows.length) return void closeBar();

  const bar = box.bar;
  const go = bar.querySelector(".bm-unpub-go");
  box.busy = true;
  root.classList.add("is-unpublishing");
  setBusy(go, true);
  bar.querySelector(".ed-dot").dataset.state = "busy";
  barNotice(null, "");
  for (const row of rows) rowEl(row.key)?.classList.add("is-working");

  try {
    const [repo, session] = await Promise.all([loadRepo(), import("./editor/session.js")]);
    await repo.open(true);
    const result = await session.unpublishAll(rows);
    if (!result) throw new Error(t("p_unpub_empty", "There was nothing to commit."));

    markStage("committed", "done");
    barNotice("info", `${t("p_unpub_done", "Committed")} ${result.short || ""}`.trim());

    // Repainted from local state: each article is a draft now, and what changed
    // about it is known here without asking anything again.
    for (const row of rows) {
      row.published = false;
      row.encrypted = false;
      row.draft = row.draft || { id: "", slug: row.slug || "", href: row.href, source: row.source };
      row.vaultId = "";
    }
    box.queue = [];
    paintPosts();
    watchBuild(result.sha);
  } catch (err) {
    markStage("committed", "fail");
    barNotice("error", (err && err.message) || t("offline", "The Worker did not answer."));
    box.busy = false;
    root.classList.remove("is-unpublishing");
    setBusy(go, false);
    bar.querySelector(".ed-dot").dataset.state = "dirty";
    for (const row of rows) rowEl(row.key)?.classList.remove("is-working");
  }
}

/**
 * Where the build for the commit just made has got to — the commit status the
 * Actions run writes for that sha, polled exactly as the editor polls it. When
 * it lands the console is showing a list that no longer describes the site, so
 * the answer is the front page rather than a repaint of a stale page.
 */
function watchBuild(sha) {
  clearInterval(buildTimer);
  markStage("building", "live");

  let ticks = 0;
  buildTimer = setInterval(async () => {
    if ((ticks += 1) > 100) return clearInterval(buildTimer);

    const repo = await loadRepo();
    const status = await repo.commitStatus(sha);
    if (!status || !status.count) return;
    if (status.state === "pending") return void markStage("building", "live");

    if (status.state === "success") {
      clearInterval(buildTimer);
      markStage("building", "done");
      markStage("pushed", "done");
      markStage("deployed", "live");
      setTimeout(() => {
        markStage("deployed", "done");
        barNotice("info", t("p_unpub_land", "Done. Loading the site as readers see it…"));
        setTimeout(() => location.replace(siteRoot() + "/"), 1200);
      }, DEPLOY_MS);
    } else if (status.state === "failure" || status.state === "error") {
      clearInterval(buildTimer);
      markStage("building", "fail");
      barNotice("error", t("p_unpub_failed", "The build failed. The commit landed; nothing published has changed."));
      state.posts.busy = false;
      root.classList.remove("is-unpublishing");
    }
  }, POLL_MS);
}

function notePostError(message) {
  const section = root.querySelector('[data-part="posts"]');
  if (!section) return;
  let note = section.querySelector(".bm-post-error");
  if (!note) {
    note = document.createElement("p");
    note.className = "bm-post-error";
    section.appendChild(note);
  }
  note.textContent = message || t("offline", "The Worker did not answer.");
  contentChanged();
}

// ─── D · followers ───────────────────────────────────────────
function renderFollowersShell(section) {
  section.innerHTML = `
    <h2 class="bm-section-title">
      <i class="fa-solid fa-users" aria-hidden="true"></i>${e("followers", "Followers")}
      <span class="bm-count bm-follower-count"></span>
    </h2>

    <div class="bm-card bm-blocklists">
      <h3 class="bm-sub-title">${e("blocklists", "Global blocklists")}</h3>
      <p class="bm-hint">${e(
        "blocklists_hint",
        "Anyone listed here is skipped for that kind of notification, silently and everywhere. Saved as soon as an entry resolves."
      )}</p>
      ${TOPICS.map(
        (topic) => `
        <div class="bm-blocklist">
          <label class="bm-blocklist-label">
            ${escapeHTML(t(`topic_${topic}`, topic))}
            <span class="bm-save-state" data-save="${topic}"></span>
          </label>
          <div class="bm-picker-host" data-picker="${topic}"></div>
        </div>`
      ).join("")}
    </div>

    <p class="bm-notice">
      <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
      <span>${e(
        "moderation_notice",
        "Muting or banning here can only affect notifications and access to encrypted posts. It does not stop anyone commenting on the blog — comments are GitHub Discussions, so blocking a commenter is done in your GitHub account settings under Moderation."
      )}
      <a href="${MODERATION_DOCS}" target="_blank" rel="noopener">${e("moderation_docs", "GitHub docs")}</a></span>
    </p>

    <ul class="bm-followers"></ul>
    <div class="bm-foot"></div>
    <div class="bm-orphans"></div>`;

  TOPICS.forEach((topic) => {
    const host = section.querySelector(`[data-picker="${topic}"]`);
    pickers.set(
      topic,
      makePicker(topic, host, {
        placeholder: t("aud_placeholder", "GitHub login or numeric id, then Enter"),
        onCommit: (picker) => saveBlocklist(topic, picker),
      })
    );
  });
}

/** "只要验证通过就自动保存" — a settled field writes itself, with no Save button. */
async function saveBlocklist(topic, picker) {
  const flag = root.querySelector(`[data-save="${topic}"]`);
  if (!picker.settled) {
    if (flag) flag.innerHTML = "";
    return;
  }
  if (flag) flag.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>`;

  const result = await api("/api/admin/blocklists", {
    method: "PUT",
    body: { topic, users: picker.ids },
  });

  if (flag) {
    flag.innerHTML = result.ok
      ? `<i class="fa-solid fa-check" aria-hidden="true"></i>`
      : `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>`;
    if (result.ok) setTimeout(() => (flag.innerHTML = ""), 1800);
  }
  if (result.ok) state.blocklists[topic] = picker.ids;
}

function stateTag(value) {
  if (value === "banned") return `<span class="bm-tag is-banned">${e("banned", "Banned")}</span>`;
  if (value === "muted") return `<span class="bm-tag is-muted">${e("muted", "Muted")}</span>`;
  return "";
}

function moderationButtons(scope, id, value, isAdmin) {
  if (isAdmin) return `<span class="bm-tag is-admin">${e("admin", "Admin")}</span>`;
  const muted = value === "muted";
  const banned = value === "banned";
  return `
    <button type="button" class="bm-quiet bm-mod${muted ? " is-on" : ""}"
            data-scope="${scope}" data-target="${escapeHTML(id)}" data-next="${muted ? "" : "muted"}">
      <i class="fa-solid ${muted ? "fa-volume-high" : "fa-volume-xmark"}" aria-hidden="true"></i>
      <span class="np-btn-label">${muted ? e("unmute", "Unmute") : e("mute", "Mute")}</span>
    </button>
    <button type="button" class="bm-quiet bm-mod${banned ? " is-on" : ""}"
            data-scope="${scope}" data-target="${escapeHTML(id)}" data-next="${banned ? "" : "banned"}">
      <i class="fa-solid ${banned ? "fa-lock-open" : "fa-ban"}" aria-hidden="true"></i>
      <span class="np-btn-label">${banned ? e("unban", "Unblock") : e("ban", "Ban")}</span>
    </button>`;
}

function deviceHTML(row, ownerIsAdmin) {
  const info = describeDevice(row);
  return `
    <li class="bm-device" data-device="${escapeHTML(row.id)}">
      <span class="bm-device-icon"><i class="${info.icon}" aria-hidden="true"></i></span>
      <div class="bm-device-main">
        <div class="bm-device-title">${escapeHTML(info.browser)}<span class="bm-sep"></span>${escapeHTML(
          info.os
        )}<span class="bm-sep"></span>${escapeHTML(info.kind)}${stateTag(row.state)}</div>
        <div class="bm-device-meta">${escapeHTML(
          `${t("subscribed", "Subscribed")} ${timeAgo(row.created_at)}`
        )}<span class="bm-sep"></span>…${escapeHTML(row.tail || "")}</div>
      </div>
      <div class="bm-device-actions">${moderationButtons("device", row.id, row.state, ownerIsAdmin)}</div>
    </li>`;
}

function followerHTML(row) {
  const blocked = String(row.blocked || "")
    .split(",")
    .filter(Boolean)
    .map((topic) => t(`topic_${topic}`, topic));

  const meta = [
    `#${row.id}`,
    `${t("subscribed", "Subscribed")} ${timeAgo(row.created_at)}`,
    `${row.devices.length} ${t("m_devices", "devices")}`,
    `${row.unread} ${t("m_unread", "unread")}`,
    blocked.length ? `${t("m_blocked", "Blocked")}: ${blocked.join(", ")}` : "",
  ].filter(Boolean);

  return `
    <li class="bm-follower${row.state ? ` is-${row.state}` : ""}" data-follower="${escapeHTML(row.id)}">
      <div class="bm-follower-head">
        <img class="bm-avatar" src="${avatarOf(row.id)}" alt="" loading="lazy">
        <div class="bm-follower-main">
          <div class="bm-follower-name">
            ${escapeHTML(row.name || row.login)}
            <a class="bm-login" href="https://github.com/${encodeURIComponent(row.login)}"
               target="_blank" rel="noopener">@${escapeHTML(row.login)}</a>
            ${stateTag(row.state)}
          </div>
          <div class="bm-follower-meta">${meta
            .map((part) => `<span>${escapeHTML(part)}</span>`)
            .join('<span class="bm-sep"></span>')}</div>
        </div>
        <div class="bm-follower-actions">
          ${moderationButtons("follower", row.id, row.state, row.is_admin)}
        </div>
      </div>
      ${
        row.devices.length
          ? `<ul class="bm-devices">${row.devices
              .map((d) => deviceHTML(d, row.is_admin))
              .join("")}</ul>`
          : `<p class="bm-blank bm-no-devices">${e("no_devices", "No push device registered.")}</p>`
      }
    </li>`;
}

function paintFollowers() {
  const section = root.querySelector('[data-part="followers"]');
  const list = section.querySelector(".bm-followers");
  const foot = section.querySelector(".bm-foot");
  const box = state.followers;

  if (box.totals) {
    section.querySelector(".bm-follower-count").textContent =
      `${box.totals.followers} · ${box.totals.devices} ${t("m_devices", "devices")}`;
  }

  section.classList.toggle("is-loading", box.loading);

  if (box.loading && !box.items.length) {
    list.innerHTML = SPINNER_ROW;
  } else if (box.error) {
    list.innerHTML = `<li class="bm-blank">${e("unreachable", "Couldn't reach the notification service.")}</li>`;
  } else if (!box.items.length) {
    list.innerHTML = `<li class="bm-blank">${e("no_followers", "Nobody follows the blog yet.")}</li>`;
  } else {
    list.innerHTML = box.items.map(followerHTML).join("");
  }

  foot.innerHTML = box.more
    ? `<button type="button" class="bm-quiet bm-more" data-more="followers">
         <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
         <span class="np-btn-label">${e("load_more", "Load more")}</span></button>`
    : "";

  const orphans = section.querySelector(".bm-orphans");
  orphans.innerHTML = box.orphans.length
    ? `<h3 class="bm-sub-title">${e("orphans", "Unowned devices")}
         <span class="bm-count">${box.orphans.length}</span></h3>
       <p class="bm-hint">${e(
         "orphans_hint",
         "Subscriptions whose owner unfollowed. Only banned ones are kept — the daily sweep removes the rest."
       )}</p>
       <ul class="bm-devices">${box.orphans.map((d) => deviceHTML(d, false)).join("")}</ul>`
    : "";

  contentChanged();
}

async function loadFollowers({ reset = false, trigger = null } = {}) {
  const box = state.followers;
  if (reset) {
    box.items = [];
    box.cursor = 0;
    box.more = false;
  }
  if (trigger) setBusy(trigger, true);
  box.loading = true;
  paintFollowers();

  const result = await api(`/api/admin/followers?cursor=${box.cursor}`);
  box.loading = false;
  box.error = !result.ok;

  if (result.ok && result.data) {
    const data = result.data;
    box.items = box.items.concat(data.items || []);
    box.more = data.cursor != null;
    box.cursor = data.cursor || box.cursor;
    if (data.orphans) box.orphans = data.orphans;
    if (data.totals) box.totals = data.totals;
    if (data.blocklists) {
      state.blocklists = data.blocklists;
      TOPICS.forEach((topic) => {
        const picker = pickers.get(topic);
        if (picker) picker.set(data.blocklists[topic] || []);
      });
    }
  }
  paintFollowers();
}

/** One state change, on a follower or on a single device. */
async function moderate(button) {
  const scope = button.dataset.scope;
  const target = button.dataset.target;
  const next = button.dataset.next;

  setBusy(button, true);
  const result = await api("/api/admin/moderation", {
    method: "PUT",
    body:
      scope === "device"
        ? { device_id: Number(target), state: next }
        : { github_id: Number(target), state: next },
  });
  setBusy(button, false);
  if (!result.ok) return;

  // Repaint from local state rather than refetching the page: the answer is
  // already known, and re-reading twenty followers to change one word would be
  // a round trip the admin watches for no reason.
  const box = state.followers;
  if (scope === "follower") {
    const row = box.items.find((f) => String(f.id) === String(target));
    if (row) row.state = next;
  } else {
    for (const follower of box.items) {
      const device = follower.devices.find((d) => String(d.id) === String(target));
      if (device) device.state = next;
    }
    const orphan = box.orphans.find((d) => String(d.id) === String(target));
    if (orphan) orphan.state = next;
  }
  paintFollowers();
}

// ─── boot ────────────────────────────────────────────────────
function wire() {
  root.addEventListener("click", (event) => {
    const target = event.target;

    const mode = target.closest(".bm-seg [data-mode]");
    if (mode) return void composeMode(mode.dataset.mode);

    const filter = target.closest(".bm-notif-filter [data-type]");
    if (filter) return void setFilter(filter.dataset.type);

    const postFilter = target.closest(".bm-post-filter [data-filter]");
    if (postFilter) return void setPostFilter(postFilter.dataset.filter);

    const send_ = target.closest(".bm-send");
    if (send_) return void send(send_);

    const more = target.closest(".bm-more");
    if (more) {
      if (more.dataset.more === "followers") loadFollowers({ trigger: more });
      else loadNotifications({ trigger: more });
      return;
    }

    const edit = target.closest(".bm-edit");
    if (edit) return void startEdit(edit.closest(".bm-notif"));

    const cancel = target.closest(".bm-cancel");
    if (cancel) return void cancelEdit(cancel.closest(".bm-notif"));

    const save = target.closest(".bm-save");
    if (save) return void saveEdit(save.closest(".bm-notif"), save);

    // Everything below is irreversible, so each takes two presses — the same
    // arming the notification panel uses, and the same red confirm state.
    const del = target.closest(".bm-del");
    if (del) {
      const item = del.closest(".bm-notif");
      if (confirmStep(del, `del:${item.dataset.id}`, "")) deleteNotification(item, del);
      return;
    }

    const mod = target.closest(".bm-mod");
    if (mod) {
      const key = `mod:${mod.dataset.scope}:${mod.dataset.target}:${mod.dataset.next}`;
      if (confirmStep(mod, key, t("confirm", "Press again"))) moderate(mod);
      return;
    }

    // Not armed and not confirmed: this only adds the row to the bar's
    // selection, and the bar is where it becomes a commit.
    const unpublish = target.closest(".bm-post-unpublish");
    if (unpublish) return void toggleUnpublish(unpublish.closest(".bm-post"));

    disarmConfirm();
  });
}

/**
 * Paint everything, then fetch only what the build could not settle.
 *
 * Posts is on screen before a single request is made — it was sealed into this
 * page — and the three Worker-backed sections fill in independently, so a slow
 * follower list never holds up the rest. There is no gate here: the page only
 * exists at all because plugins/admin-gate.js already had the key and the blob
 * opened under it.
 */
function boot() {
  const sections = {
    posts: root.querySelector('[data-part="posts"]'),
    announce: root.querySelector('[data-part="announce"]'),
    notifications: root.querySelector('[data-part="notifications"]'),
    followers: root.querySelector('[data-part="followers"]'),
  };

  if (sections.posts) {
    renderPostsShell(sections.posts);
    paintPosts();
  }
  renderCompose(sections.announce);
  renderNotificationsShell(sections.notifications);
  renderFollowersShell(sections.followers);

  if (sections.posts) loadAudiences();
  loadNotifications({ reset: true });
  loadFollowers({ reset: true });
}

/**
 * @param {{items: Array}} inventory  sealed with the page by the build
 */
export function initBlogManagement(inventory) {
  const el = document.getElementById("blog-management");
  if (!el) return;

  root = el;
  pickers.clear();
  state.compose.mode = "all";
  state.notifications.type = "";
  state.notifications.loading = false;
  state.followers.loading = false;
  state.posts.items = (inventory && inventory.items) || [];
  state.posts.audiences = {};
  state.posts.filter = "";
  state.posts.queue = [];
  state.posts.bar = null;
  state.posts.busy = false;
  clearInterval(buildTimer);
  reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const backend = (window.theme && window.theme.backend) || {};
  base = window.blogAuth
    ? window.blogAuth.resolveApiBase()
    : String(backend.api_url || "").replace(/\/+$/, "");

  // The page lives INSIDE #swup, so this element is new markup on every visit —
  // the listener goes with it and nothing has to be torn down.
  wire();
  boot();
}
