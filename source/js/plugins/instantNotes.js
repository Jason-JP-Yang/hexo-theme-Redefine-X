/**
 * Instant Notes – entry point + admin module.
 *
 * This file owns:
 *   • initInstantNotes() — the exported entry point wired in main.js.
 *   • Data fetch + preloader wait.
 *   • Admin auth state (wireAuthChange, refreshAdminState, adminFetch).
 *   • Admin CRUD: reconcileAdminNotes, ensureInputBubble, per-bubble
 *     edit/delete (startInlineEdit, saveInlineEdit, cancelInlineEdit,
 *     deleteNote, decorateAdminBubble), teardownAdminExpanded.
 *
 * Circular-dependency note: the layout module (instant-notes-layout.js) calls
 * admin functions (reconcile, ensureInput, teardown) during expand/collapse.
 * To avoid a circular import, those calls go through panel._adminHooks — a
 * plain object of arrow functions bound to this module's functions and set on
 * the panel at init time.
 */
import {
  buildDOM, wireResize, revealNotes,
  ensureMoreButton, evaluateMoreButton,
  relayoutExpanded, relayoutExpandedReflow, resetFieldExpansion,
} from "./instant-notes-layout.js";
import { createBubble, isNoteActive, clearWrap } from "./instant-notes-bubble.js";

// Cache fetched public notes briefly so rapid swup navigations skip the worker.
let _notesCache = null;
const NOTES_TTL = 60000;

// ─── Entry point ──────────────────────────────────────────────────────────────
export default function initInstantNotes() {
  const panel = document.getElementById("instant-notes");
  if (!panel) return;

  const apiUrl = theme.home_banner?.instant_notes?.api_url;
  if (!apiUrl) return;
  panel._apiUrl = apiUrl;

  // Inject admin function references so the layout module can call them during
  // expand/collapse without importing this module (which would be circular).
  panel._adminHooks = {
    reconcile:   (notes) => reconcileAdminNotes(panel, notes),
    ensureInput: ()      => ensureInputBubble(panel),
    teardown:    ()      => teardownAdminExpanded(panel),
    fetchAll:    ()      => adminFetch(panel, "GET", "/api/admin/notes"),
  };

  wireResize(panel);
  wireAuthChange(panel);

  const fresh = _notesCache && Date.now() - _notesCache.ts < NOTES_TTL;
  const notesPromise = fresh
    ? Promise.resolve(_notesCache.data)
    : fetchNotes(apiUrl).then((d) => {
        _notesCache = { data: d, ts: Date.now() };
        return d;
      });

  notesPromise.then((notes) => {
    const list = (notes || []).slice(0, 5);
    if (list.length > 0) {
      buildDOM(list, panel);
      waitForPreloader().then(() => {
        setTimeout(() => revealNotes(panel), 500);
      });
    }
    // Resolve admin status (controls the More button + admin tools). For an
    // admin with no notes yet, still reveal the panel so they can post.
    refreshAdminState(panel).then(() => {
      if (panel._isAdmin && list.length === 0) {
        panel.classList.add("notes-visible");
        ensureMoreButton(panel);
        evaluateMoreButton(panel);
      }
    });
  });
}

// ─── Fetch ────────────────────────────────────────────────────────────────────
async function fetchNotes(apiUrl) {
  try {
    const r = await fetch(`${apiUrl}/api/notes`, { mode: "cors", cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    return Array.isArray(d) ? d : d.notes || [];
  } catch (e) {
    console.warn("[InstantNotes] fetch failed:", e);
    return [];
  }
}

// ─── Wait for preloader ────────────────────────────────────────────────────────
function waitForPreloader() {
  return new Promise((resolve) => {
    const el = document.querySelector(".preloader");
    if (!el || el.style.display === "none" || getComputedStyle(el).display === "none") {
      return resolve();
    }
    const iv = setInterval(() => {
      if (!el.isConnected || el.style.display === "none" || getComputedStyle(el).display === "none") {
        clearInterval(iv);
        resolve();
      }
    }, 150);
    setTimeout(() => { clearInterval(iv); resolve(); }, 8000);
  });
}

// ════════════════════════════════════════════════════════════
//  ADMIN AUTH STATE
// ════════════════════════════════════════════════════════════
function wireAuthChange(panel) {
  if (panel.dataset.authWired) return;
  panel.dataset.authWired = "1";
  window.addEventListener("blog:auth-change", () => {
    const p = document.getElementById("instant-notes");
    if (p) refreshAdminState(p);
  });
}

async function refreshAdminState(panel) {
  if (!window.blogAuth) {
    panel._isAdmin = false;
    evaluateMoreButton(panel);
    return;
  }
  try {
    const s = await window.blogAuth.getSession();
    panel._isAdmin = !!(s && s.isAdmin);
  } catch (e) {
    panel._isAdmin = false;
  }
  ensureMoreButton(panel);
  evaluateMoreButton(panel);
}

async function adminFetch(panel, method, path, body) {
  const token = await window.blogAuth.getSessionToken();
  if (!token) throw new Error("Not authorized");
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${panel._apiUrl}${path}`, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

// ════════════════════════════════════════════════════════════
//  ADMIN CRUD
// ════════════════════════════════════════════════════════════

// Merge the full admin note list (newest-first) into panel state, reusing
// existing bubbles by id so active bubbles glide instead of rebuilding.
function reconcileAdminNotes(panel, notes) {
  const field = panel.querySelector("#instant-notes-field");
  if (!field) return;
  const byId = new Map();
  (panel._bubbleEls || []).forEach((el) => {
    if (el.dataset.noteId) byId.set(el.dataset.noteId, el);
  });

  const newEls = [];
  notes.forEach((note) => {
    const id = note.id != null ? String(note.id) : null;
    let el = id ? byId.get(id) : null;
    if (el) {
      el._note = note;
      el._active = isNoteActive(note);
      byId.delete(id);
    } else {
      el = createBubble(note, false);
      el.style.position = "absolute";
      el.style.display = "none";
      el.dataset.fresh = "1";
      el.classList.remove("is-entering");
      field.appendChild(el);
    }
    newEls.push(el);
  });

  // Remove bubbles that no longer exist server-side.
  byId.forEach((el) => { if (el.parentElement) el.parentElement.removeChild(el); });

  panel._bubbleEls = newEls;
  panel._hasEmoji = notes.map((n) => !!n.emoji);
  panel._notes = notes;

  // The newest real note is no longer the tail-bearer in admin mode (the input
  // bubble is) — drop .bubble-newest so only the input shows the tail.
  newEls.forEach((el) => {
    el.classList.toggle("bubble-newest", false);
    decorateAdminBubble(panel, el);
  });
}

function ensureInputBubble(panel) {
  if (panel._inputBubble) return panel._inputBubble;
  const field = panel.querySelector("#instant-notes-field");
  if (!field) return null;

  const wrap = document.createElement("div");
  wrap.className = "instant-note-bubble instant-notes-input-bubble bubble-newest in-list";
  wrap.style.position = "absolute";
  wrap.style.opacity = "0";
  wrap.dataset.fresh = "1";
  wrap.innerHTML =
    '<div class="bubble-card bubble-default input-card">' +
    '  <textarea class="ni-input" maxlength="200" rows="1" placeholder="What\'s happening?"></textarea>' +
    '  <div class="ni-input-row">' +
    '    <input class="ni-emoji" type="text" maxlength="4" placeholder="🙂" />' +
    '    <input class="ni-color" type="color" value="#6c63ff" title="Bubble colour" />' +
    '    <label class="ni-color-default"><input class="ni-color-toggle" type="checkbox" checked />default</label>' +
    '    <button type="button" class="ni-post">Post</button>' +
    '  </div>' +
    "</div>";
  field.appendChild(wrap);
  panel._inputBubble = wrap;

  wrap.querySelector(".ni-post").addEventListener("click", () => submitNewNote(panel, wrap));
  // Stop outside-click handler from collapsing while interacting.
  wrap.addEventListener("click", (e) => e.stopPropagation());
  return wrap;
}

async function submitNewNote(panel, wrap) {
  const text = wrap.querySelector(".ni-input").value.trim();
  const emoji = wrap.querySelector(".ni-emoji").value.trim();
  const useDefault = wrap.querySelector(".ni-color-toggle").checked;
  const color = useDefault ? "default" : wrap.querySelector(".ni-color").value;
  if (!text) return;
  const post = wrap.querySelector(".ni-post");
  post.disabled = true;
  const prev = post.textContent;
  post.textContent = "…";
  try {
    await adminFetch(panel, "POST", "/api/admin/notes", { text, emoji, color });
    wrap.querySelector(".ni-input").value = "";
    wrap.querySelector(".ni-emoji").value = "";
    post.textContent = prev;
    const all = await adminFetch(panel, "GET", "/api/admin/notes");
    reconcileAdminNotes(panel, Array.isArray(all) ? all : []);
    relayoutExpanded(panel, true);
    _notesCache = null;
  } catch (e) {
    console.warn("[InstantNotes] post failed:", e);
    post.textContent = "Error";
    setTimeout(() => (post.textContent = prev), 1500);
  } finally {
    post.disabled = false;
  }
}

// Add status badge + edit/delete controls to an admin bubble (idempotent).
function decorateAdminBubble(panel, el) {
  if (el.querySelector(".instant-note-admin-actions")) {
    const badge = el.querySelector(".instant-note-status");
    if (badge) {
      badge.classList.toggle("is-expired", !el._active);
      badge.textContent = el._active ? "active" : "expired";
    }
    return;
  }
  const badge = document.createElement("span");
  badge.className = "instant-note-status" + (el._active ? "" : " is-expired");
  badge.textContent = el._active ? "active" : "expired";
  el.appendChild(badge);

  const actions = document.createElement("div");
  actions.className = "instant-note-admin-actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "ina-edit";
  edit.title = "Edit";
  edit.innerHTML = '<i class="fa-solid fa-pen"></i>';
  const del = document.createElement("button");
  del.type = "button";
  del.className = "ina-del";
  del.title = "Delete";
  del.innerHTML = '<i class="fa-solid fa-trash"></i>';
  actions.appendChild(edit);
  actions.appendChild(del);
  el.appendChild(actions);

  edit.addEventListener("click", (e) => { e.stopPropagation(); startInlineEdit(panel, el); });
  del.addEventListener("click", (e) => { e.stopPropagation(); deleteNote(panel, el); });
  el.addEventListener("click", (e) => e.stopPropagation());
}

function startInlineEdit(panel, el) {
  if (el._editing) return;
  el._editing = true;
  el.classList.add("is-editing");
  const note = el._note || {};
  const card = el.querySelector(".bubble-card");
  el._savedCardHTML = card.innerHTML;
  const isDefault = !note.color || note.color === "default";
  card.innerHTML =
    '<div class="ni-edit">' +
    '  <textarea class="ni-input" maxlength="200" rows="1"></textarea>' +
    '  <div class="ni-input-row">' +
    '    <input class="ni-emoji" type="text" maxlength="4" />' +
    `    <input class="ni-color" type="color" value="${isDefault ? "#6c63ff" : note.color}" />` +
    `    <label class="ni-color-default"><input class="ni-color-toggle" type="checkbox" ${isDefault ? "checked" : ""}/>default</label>` +
    '    <button type="button" class="ni-save">Save</button>' +
    '    <button type="button" class="ni-cancel">Cancel</button>' +
    "  </div>" +
    "</div>";
  card.querySelector(".ni-input").value = note.text || "";
  card.querySelector(".ni-emoji").value = note.emoji || "";
  card.querySelector(".ni-save").addEventListener("click", (e) => { e.stopPropagation(); saveInlineEdit(panel, el); });
  card.querySelector(".ni-cancel").addEventListener("click", (e) => { e.stopPropagation(); cancelInlineEdit(panel, el); });
  relayoutExpandedReflow(panel);
}

function cancelInlineEdit(panel, el) {
  if (!el._editing) return;
  el._editing = false;
  el.classList.remove("is-editing");
  const card = el.querySelector(".bubble-card");
  if (el._savedCardHTML != null) card.innerHTML = el._savedCardHTML;
  if (panel && panel._expanded) relayoutExpandedReflow(panel);
}

async function saveInlineEdit(panel, el) {
  const card = el.querySelector(".bubble-card");
  const text = card.querySelector(".ni-input").value.trim();
  const emoji = card.querySelector(".ni-emoji").value.trim();
  const useDefault = card.querySelector(".ni-color-toggle").checked;
  const color = useDefault ? "default" : card.querySelector(".ni-color").value;
  if (!text) return;
  const id = el.dataset.noteId;
  const save = card.querySelector(".ni-save");
  save.disabled = true;
  save.textContent = "…";
  try {
    await adminFetch(panel, "PUT", `/api/admin/notes/${id}`, { text, emoji, color });
    el._editing = false;
    el.classList.remove("is-editing");
    const all = await adminFetch(panel, "GET", "/api/admin/notes");
    reconcileAdminNotes(panel, Array.isArray(all) ? all : []);
    relayoutExpanded(panel, true);
    _notesCache = null;
  } catch (e) {
    console.warn("[InstantNotes] edit failed:", e);
    save.textContent = "Error";
    setTimeout(() => (save.textContent = "Save"), 1500);
  } finally {
    save.disabled = false;
  }
}

async function deleteNote(panel, el) {
  const id = el.dataset.noteId;
  if (!id) return;
  if (!window.confirm("Delete this note?")) return;
  try {
    await adminFetch(panel, "DELETE", `/api/admin/notes/${id}`);
    const all = await adminFetch(panel, "GET", "/api/admin/notes");
    reconcileAdminNotes(panel, Array.isArray(all) ? all : []);
    relayoutExpanded(panel, true);
    _notesCache = null;
  } catch (e) {
    console.warn("[InstantNotes] delete failed:", e);
    el.style.opacity = "1";
  }
}

// Remove admin-only artefacts when collapsing back to the compact view.
function teardownAdminExpanded(panel) {
  panel.classList.remove("is-admin-expanded");
  if (panel._inputBubble && panel._inputBubble.parentElement) {
    panel._inputBubble.parentElement.removeChild(panel._inputBubble);
  }
  panel._inputBubble = null;
  const keep = [];
  (panel._bubbleEls || []).forEach((el) => {
    const actions = el.querySelector(".instant-note-admin-actions");
    if (actions) actions.remove();
    const badge = el.querySelector(".instant-note-status");
    if (badge) badge.remove();
    if (el._editing) cancelInlineEdit(null, el);
    if (el._active) {
      keep.push(el);
    } else if (el.parentElement) {
      el.parentElement.removeChild(el);
    }
  });
  // Restore the tail on the newest active bubble.
  keep.forEach((el, i) => {
    el.classList.toggle("bubble-newest", i === 0);
    el.classList.remove("in-list");
    el.style.width = "";
    el.style.maxWidth = "";
    clearWrap(el);
  });
  panel._bubbleEls = keep;
  panel._hasEmoji = keep.map((el) => !!(el._note && el._note.emoji));
  panel._notes = keep.map((el) => el._note);
  resetFieldExpansion(panel);
}
