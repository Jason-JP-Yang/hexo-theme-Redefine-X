/**
 * Blog Management — the admin console at /blog-management/.
 *
 * Three sections, each fetched and painted independently so a slow list never
 * holds up the other two:
 *
 *   A · Announce   compose and send one announcement, with an allowlist or a
 *                  blocklist of GitHub identities, and a full server receipt.
 *   B · Notifications  what the database still holds — edit the wording, or
 *                  delete a row and every inbox reference to it.
 *   C · Followers  the global per-topic blocklists, then every follower with the
 *                  devices hanging off them, each mutable or bannable.
 *
 * Loaded on demand: notifications.js dynamic-imports this file only when the
 * page it belongs to is on screen, so no reader ever downloads it.
 *
 * Nothing here is a security boundary. The page renders for anyone who reaches
 * the URL and every route it calls is checked by the Worker against the isAdmin
 * claim in the session token; the gate below is a courtesy, not a lock.
 */

import {
  setBusy,
  confirmStep,
  disarmConfirm,
  timeAgo,
  escapeHTML,
  describeDevice,
} from "./notifications-inbox.js";

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
/**
 * The multi-identity field used by the composer and by all three blocklists.
 *
 * Each committed token is checked against the Worker the moment it is entered,
 * and carries its own state: resolving, resolved (rendered as the GitHub name
 * and numeric id), or unknown. A field holding an unknown chip blocks its own
 * submit — but the Worker never refuses a send over one, it simply skips the id
 * it could not match, so a chip that goes stale between typing and sending
 * costs that recipient and nobody else.
 */
class Picker {
  constructor(key, host, { onCommit, placeholder }) {
    this.key = key;
    this.host = host;
    this.onCommit = onCommit || (() => {});
    this.chips = [];
    this.busy = 0;

    host.className = "bm-picker";
    host.innerHTML = `<div class="bm-chips"><input class="bm-chip-input" type="text"
      spellcheck="false" autocomplete="off" placeholder="${escapeHTML(placeholder)}"></div>`;
    this.list = host.querySelector(".bm-chips");
    this.input = host.querySelector(".bm-chip-input");

    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "," || event.key === " ") {
        event.preventDefault();
        this.commit();
      } else if (event.key === "Backspace" && !this.input.value && this.chips.length) {
        this.remove(this.chips[this.chips.length - 1].raw);
      }
    });
    this.input.addEventListener("blur", () => this.commit());
    this.input.addEventListener("paste", (event) => {
      const text = (event.clipboardData || window.clipboardData).getData("text");
      if (!/[\s,]/.test(text)) return;
      event.preventDefault();
      text.split(/[\s,]+/).forEach((part) => this.add(part));
    });
    host.addEventListener("click", (event) => {
      const remove = event.target.closest(".bm-chip-x");
      if (remove) {
        this.remove(remove.dataset.raw);
        return;
      }
      if (!event.target.closest(".bm-chip")) this.input.focus();
    });
  }

  /** Resolved ids only — what an audience or a blocklist is actually made of. */
  get ids() {
    return this.chips.filter((c) => c.status === "ok").map((c) => c.id);
  }

  get settled() {
    return this.busy === 0 && this.chips.every((c) => c.status === "ok");
  }

  set(entries) {
    this.chips = (entries || []).map((row) => ({
      raw: String(row.login || row.id),
      id: row.id,
      login: row.login || "",
      name: row.name || "",
      status: "ok",
    }));
    this.paint();
  }

  clear() {
    this.chips = [];
    this.paint();
  }

  commit() {
    const value = this.input.value.trim();
    this.input.value = "";
    if (value) this.add(value);
  }

  add(raw) {
    const value = String(raw).replace(/^@/, "").trim();
    if (!value) return;
    if (this.chips.some((c) => c.raw.toLowerCase() === value.toLowerCase())) return;

    this.chips.push({ raw: value, id: null, login: "", name: "", status: "checking" });
    this.paint();
    this.resolve(value);
  }

  remove(raw) {
    const before = this.chips.length;
    this.chips = this.chips.filter((c) => c.raw !== raw);
    if (this.chips.length === before) return;
    this.paint();
    this.onCommit(this);
  }

  async resolve(raw) {
    this.busy++;
    const result = await api("/api/admin/lookup", { method: "POST", body: { ids: [raw] } });
    this.busy--;

    const chip = this.chips.find((c) => c.raw === raw);
    if (!chip) return;

    const match = result.ok && result.data && (result.data.matched || [])[0];
    if (match) {
      chip.id = match.id;
      chip.login = match.login;
      chip.name = match.name || "";
      chip.status = "ok";
    } else {
      chip.status = result.ok ? "unknown" : "error";
    }
    this.paint();
    this.onCommit(this);
  }

  paint() {
    this.list.querySelectorAll(".bm-chip").forEach((el) => el.remove());
    const html = this.chips.map((chip) => chipHTML(chip)).join("");
    this.input.insertAdjacentHTML("beforebegin", html);
    this.host.classList.toggle("has-unknown", this.chips.some((c) => c.status !== "ok"));
  }
}

function chipHTML(chip) {
  if (chip.status === "checking") {
    return `<span class="bm-chip is-checking">
      <i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>
      <span class="bm-chip-name">${escapeHTML(chip.raw)}</span></span>`;
  }
  if (chip.status !== "ok") {
    const why = chip.status === "error" ? t("chip_error", "Lookup failed") : t("chip_unknown", "Not a known reader");
    return `<span class="bm-chip is-unknown" title="${escapeHTML(why)}">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span class="bm-chip-name">${escapeHTML(chip.raw)}</span>
      <button type="button" class="bm-chip-x" data-raw="${escapeHTML(chip.raw)}"
              aria-label="${e("remove", "Remove")}">
        <i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`;
  }
  return `<span class="bm-chip is-ok">
    <img class="bm-chip-avatar" src="${avatarOf(chip.id)}" alt="" loading="lazy">
    <span class="bm-chip-name">${escapeHTML(chip.name || chip.login)}</span>
    <span class="bm-chip-id">#${escapeHTML(chip.id)}</span>
    <button type="button" class="bm-chip-x" data-raw="${escapeHTML(chip.raw)}"
            aria-label="${e("remove", "Remove")}">
      <i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`;
}

/** Derived, never stored: a GitHub avatar is addressable by numeric id alone. */
function avatarOf(id) {
  return `https://avatars.githubusercontent.com/u/${encodeURIComponent(id)}?s=64&v=4`;
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
        <button type="button" class="bm-primary bm-post" disabled>
          <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
          <span class="np-btn-label">${e("post", "Post announcement")}</span>
        </button>
      </footer>
    </div>

    <div class="bm-receipt" hidden></div>`;

  const host = section.querySelector('[data-picker="audience"]');
  pickers.set(
    "audience",
    new Picker("audience", host, {
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
  const post = section.querySelector(".bm-post");
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

// ─── C · followers ───────────────────────────────────────────
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
        "Muting or banning here only affects notifications. It does not stop anyone commenting on the blog — comments are GitHub Discussions, so blocking a commenter is done in your GitHub account settings under Moderation."
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
      new Picker(topic, host, {
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

// ─── gate + boot ─────────────────────────────────────────────
function showGate(kind) {
  const gate = root.querySelector(".bm-gate");
  const panel = root.querySelector(".bm-console");
  root.dataset.phase = kind;

  if (kind === "ready") {
    gate.hidden = true;
    panel.hidden = false;
    contentChanged();
    return;
  }

  gate.hidden = false;
  panel.hidden = true;

  const copy = {
    loading: ["fa-circle-notch fa-spin", t("checking", "Checking your session…")],
    denied: ["fa-lock", t("denied", "This page is for the blog's administrator.")],
    error: ["fa-plug-circle-xmark", t("unreachable", "Couldn't reach the notification service.")],
  }[kind];

  gate.innerHTML = `<i class="fa-solid ${copy[0]}" aria-hidden="true"></i>
    <p class="bm-gate-text">${escapeHTML(copy[1])}</p>
    ${
      kind === "loading"
        ? ""
        : `<button type="button" class="bm-quiet bm-retry">
             <i class="fa-solid fa-rotate-right" aria-hidden="true"></i>
             <span class="np-btn-label">${e("retry", "Try again")}</span></button>`
    }`;
}

function wire() {
  root.addEventListener("click", (event) => {
    const target = event.target;

    const retry = target.closest(".bm-retry");
    if (retry) {
      setBusy(retry, true);
      boot(true);
      return;
    }

    const mode = target.closest(".bm-seg [data-mode]");
    if (mode) return void composeMode(mode.dataset.mode);

    const filter = target.closest(".bm-notif-filter [data-type]");
    if (filter) return void setFilter(filter.dataset.type);

    const post = target.closest(".bm-post");
    if (post) return void send(post);

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

    disarmConfirm();
  });
}

async function boot(force = false) {
  showGate("loading");

  // One cheap admin route decides the gate. Everything else follows only once
  // it has said yes, so a non-admin never fires three requests to be refused
  // three times.
  if (force && window.blogAuth) await window.blogAuth.getSession(true);
  const probe = await api("/api/admin/notifications?cursor=0&type=");

  if (probe.status === 401 || probe.status === 403) return void showGate("denied");
  if (!probe.ok) return void showGate("error");

  showGate("ready");

  const sections = {
    announce: root.querySelector('[data-part="announce"]'),
    notifications: root.querySelector('[data-part="notifications"]'),
    followers: root.querySelector('[data-part="followers"]'),
  };

  renderCompose(sections.announce);
  renderNotificationsShell(sections.notifications);
  renderFollowersShell(sections.followers);

  const box = state.notifications;
  box.items = probe.data.items || [];
  box.more = probe.data.cursor != null;
  box.cursor = probe.data.cursor || 0;
  paintNotifications();

  loadFollowers({ reset: true });
}

export function initBlogManagement() {
  const el = document.getElementById("blog-management");
  if (!el) return;

  root = el;
  pickers.clear();
  state.compose.mode = "all";
  state.notifications.type = "";
  state.notifications.loading = false;
  state.followers.loading = false;
  reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const notifications = (window.theme && window.theme.notifications) || {};
  base = window.blogAuth
    ? window.blogAuth.resolveApiBase(notifications.api_url)
    : String(notifications.api_url || "").replace(/\/+$/, "");
  if (!base) return void showGate("error");

  // The page lives INSIDE #swup, so this element is new markup on every visit —
  // the listener goes with it and nothing has to be torn down.
  wire();
  boot();
}
