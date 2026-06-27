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
import { GLIDE, PAD, clamp, prefersReducedMotion } from "./instant-notes-utils.js";

// Cache fetched public notes briefly so rapid swup navigations skip the worker.
let _notesCache = null;
const NOTES_TTL = 60000;

// ─── Textarea auto-resize ─────────────────────────────────────────────────────
function autoResizeTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + "px";
}

// Wire the textarea to resize itself on input and smoothly reflow neighbours.
// el is the bubble wrapper that contains the textarea (used for _heightAnimating guard).
function wireTextareaAutoResize(panel, textarea, el) {
  textarea.addEventListener("input", () => {
    autoResizeTextarea(textarea);
    if (!panel || !panel._expanded || el._heightAnimating) return;
    if (isEditing(panel, el)) {
      // Inline-edit: card grows DOWN naturally; recompute the shared edit layout
      // so neighbours below slide to match (gaps constant) and the form stays in view.
      const card = el.querySelector(".bubble-card");
      el._editDelta = Math.max(0, card.offsetHeight - el._editBaseCardH);
      layoutEditing(panel, 140, 0);
      ensureEditVisible(panel, el, card.offsetHeight);
    } else if (!panel._editing || panel._editing.length === 0) {
      // Compose (pinned input) bubble: existing reflow path. Skipped while any
      // inline edit is open — that reflow measures the expanded edit cards and
      // would clobber the grow-down edit layout.
      relayoutExpandedReflow(panel);
    }
  });
}

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
      // If this bubble was in edit mode (e.g. save just completed), rebuild its
      // card so the edit form is replaced with fresh note content.
      if (el.querySelector(".bubble-card .ni-edit")) {
        if (el._editTimeout1) { clearTimeout(el._editTimeout1); el._editTimeout1 = null; }
        if (el._editTimeout2) { clearTimeout(el._editTimeout2); el._editTimeout2 = null; }
        if (el._snapClone) { el._snapClone.remove(); el._snapClone = null; }
        el.style.height = "";
        el.style.transition = "";
        el.style.transform = "";
        el._editDelta = 0;
        el._heightAnimating = false;
        el._editing = false;
        el.classList.remove("is-editing");
        const card = el.querySelector(".bubble-card");
        card.style.position = "";
        card.style.height = "";
        card.style.width = "";
        card.style.overflow = "";
        card.style.boxSizing = "";
        card.style.transition = "";
        const tmp = createBubble(note, false);
        const freshCard = tmp.querySelector(".bubble-card");
        card.className = freshCard.className;
        card.innerHTML = freshCard.innerHTML;
      }
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
  // Any open edit forms were just rebuilt; clear the shared edit set (the
  // following relayoutExpanded repositions every bubble from a clean base).
  panel._editing = [];

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
    '  <textarea class="ni-input" maxlength="200" placeholder="What\'s happening?"></textarea>' +
    '  <div class="ni-input-row">' +
    '    <input class="ni-emoji" type="text" maxlength="4" placeholder="🙂" />' +
    '    <input class="ni-color" type="color" value="#6c63ff" title="Bubble colour" />' +
    '    <label class="ni-color-default"><input class="ni-color-toggle" type="checkbox" checked />default</label>' +
    '    <button type="button" class="ni-post">Post</button>' +
    '  </div>' +
    "</div>";
  field.appendChild(wrap);
  panel._inputBubble = wrap;

  const inputTextarea = wrap.querySelector(".ni-input");
  autoResizeTextarea(inputTextarea);
  wireTextareaAutoResize(panel, inputTextarea, wrap);

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

// Inline-edit grow-down animation.
//
// The card keeps its TOP anchored and unfolds DOWNWARD; the field bubbles below
// it slide down in lockstep (same duration + curve) so the gaps between bubbles
// stay exactly constant. The panel frame never resizes — the field scrolls
// instead. Every size here is BORDER-BOX (Tailwind preflight sets
// box-sizing:border-box globally), so offsetWidth/offsetHeight are the source of
// truth and no padding/border math is needed.
const EXPAND_DUR = 260;
const CANCEL_DUR = 240;

// Is `el` currently in the inline-edit set?
function isEditing(panel, el) {
  return !!(panel._editing && panel._editing.indexOf(el) !== -1);
}

// All visible bubbles living in the scroll field (the pinned newest/input slot
// is a panel child, not a field child, so it is excluded).
function fieldBubbles(panel) {
  const field = panel.querySelector("#instant-notes-field");
  if (!field) return [];
  return (panel._bubbleEls || []).filter(
    (b) => b.parentElement === field && b.style.display !== "none",
  );
}

// Each editing bubble's downward growth (form height − base list height, ≥0).
function editDelta(el) {
  return Math.max(0, el._editDelta || 0);
}

// ── Single source of truth for inline-edit reflow ─────────────────────────────
// Position EVERY field bubble at its clean base `top` (kept transform-free) plus
// the summed growth of all bubbles being edited ABOVE it, and size the scroll
// spacer to the total growth. Because it is recomputed from the WHOLE
// `panel._editing` set on every call, any number of concurrent edits compose
// correctly (deltas add, no transform stomping) and cancelling one bubble simply
// drops it from the sum so the rest settle to the right place.
function layoutEditing(panel, dur, delay) {
  const field = panel.querySelector("#instant-notes-field");
  if (!field) return;
  const editing = panel._editing || [];
  const d = delay ? ` ${delay}ms` : "";
  const trans = dur ? `transform ${dur}ms ${GLIDE}${d}` : "none";

  let total = 0;
  editing.forEach((e) => { total += editDelta(e); });

  fieldBubbles(panel).forEach((b) => {
    const bTop = parseFloat(b.style.top) || 0;
    let shift = 0;
    editing.forEach((e) => {
      if (e !== b && (parseFloat(e.style.top) || 0) < bTop) shift += editDelta(e);
    });
    b.style.transition = trans;
    b.style.transform = shift ? `translateY(${shift}px)` : "none";
  });

  const spacer = field.querySelector(".instant-notes-scroll-spacer");
  if (spacer) {
    const base = panel._listContentH || parseFloat(spacer.style.height) || 0;
    spacer.style.transition = dur ? `height ${dur}ms ${GLIDE}${d}` : "none";
    spacer.style.height = `${base + total}px`;
  }
}

// How far `el` is pushed down by edits above it (matches layoutEditing).
function editShiftOf(panel, el) {
  const editing = panel._editing || [];
  const elTop = parseFloat(el.style.top) || 0;
  let shift = 0;
  editing.forEach((e) => {
    if (e !== el && (parseFloat(e.style.top) || 0) < elTop) shift += editDelta(e);
  });
  return shift;
}

// Smooth-scroll the field just enough to keep the editing card fully visible,
// accounting for the shift contributed by any edits above it.
function ensureEditVisible(panel, el, cardH) {
  const field = panel.querySelector("#instant-notes-field");
  if (!field) return;
  let total = 0;
  (panel._editing || []).forEach((e) => { total += editDelta(e); });
  const top = (parseFloat(el.style.top) || 0) + editShiftOf(panel, el);
  const viewH = field.clientHeight;
  const maxScroll = Math.max(0, (panel._listContentH || 0) + total - viewH);
  const desired = clamp(top + cardH + PAD - viewH, field.scrollTop, maxScroll);
  if (desired > field.scrollTop + 1) {
    field.scrollTo({ top: desired, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }
}

// Absolutely-positioned, non-reflowing snapshot of the original card. Pinned to a
// fixed BORDER-BOX width so the old text wraps identically and never re-flows
// while the live card animates its width/height underneath it.
function makeCardSnapshot(el, borderBoxW) {
  const clone = document.createElement("div");
  clone.className = el._savedCardClass;
  if (el._savedCardStyle) clone.setAttribute("style", el._savedCardStyle);
  clone.style.position = "absolute";
  clone.style.top = "0";
  clone.style.left = "0";
  clone.style.zIndex = "20";
  clone.style.pointerEvents = "none";
  clone.style.boxSizing = "border-box";
  clone.style.maxWidth = "none";
  clone.style.width = `${borderBoxW}px`;
  clone.innerHTML = el._savedCardHTML || "";
  el.appendChild(clone);
  el._snapClone = clone;
  return clone;
}

function startInlineEdit(panel, el) {
  if (el._editing) return;
  el._editing = true;
  el.classList.add("is-editing");
  const note = el._note || {};
  const card = el.querySelector(".bubble-card");
  el._savedCardHTML = card.innerHTML;
  el._savedCardClass = card.className;
  el._savedCardStyle = card.getAttribute("style") || "";

  // ── 0: Capture current border-box geometry ───────────────────────────────
  const w0 = card.offsetWidth;
  const h0 = card.offsetHeight;
  // listWidth = the full column width the edit form expands to (wrapCard's cap).
  const listWidth = card.style.maxWidth ? Math.round(parseFloat(card.style.maxWidth)) : w0;
  el._savedCardH = h0;
  el._savedCardW = w0;

  // ── 1: Build the edit-form markup ────────────────────────────────────────
  const isDefault = !note.color || note.color === "default";
  const editInner =
    '<textarea class="ni-input" maxlength="200" placeholder="Edit note…"></textarea>' +
    '<div class="ni-input-row">' +
    '  <input class="ni-emoji" type="text" maxlength="4" />' +
    `  <input class="ni-color" type="color" value="${isDefault ? "#6c63ff" : note.color}" />` +
    `  <label class="ni-color-default"><input class="ni-color-toggle" type="checkbox" ${isDefault ? "checked" : ""}/>default</label>` +
    "  <button type='button' class='ni-save'>Save</button>" +
    "  <button type='button' class='ni-cancel'>Cancel</button>" +
    "</div>";

  // ── 2: Off-screen probe — edit-form height at the final (listWidth) size ───
  const probe = document.createElement("div");
  probe.className = card.className;
  probe.style.cssText =
    `position:fixed;left:-9999px;top:0;width:${listWidth}px;` +
    "visibility:hidden;pointer-events:none;white-space:normal;box-sizing:border-box;";
  probe.innerHTML = `<div class="ni-edit">${editInner}</div>`;
  document.body.appendChild(probe);
  const probeTA = probe.querySelector(".ni-input");
  probeTA.value = note.text || "";
  autoResizeTextarea(probeTA);
  const h1 = probe.offsetHeight;
  document.body.removeChild(probe);

  // ── 3: Snapshot the old card, then swap the live card to the edit form ─────
  makeCardSnapshot(el, w0);

  card.style.boxSizing = "border-box";
  card.style.position = "relative";
  card.style.width = `${w0}px`;
  card.style.height = `${h0}px`;
  card.style.overflow = "hidden";
  card.innerHTML = `<div class="ni-edit" style="opacity:0">${editInner}</div>`;

  const editDiv = card.querySelector(".ni-edit");
  const textarea = editDiv.querySelector(".ni-input");
  textarea.value = note.text || "";
  editDiv.querySelector(".ni-emoji").value = note.emoji || "";
  editDiv.querySelector(".ni-save").addEventListener("click", (e) => { e.stopPropagation(); saveInlineEdit(panel, el); });
  editDiv.querySelector(".ni-cancel").addEventListener("click", (e) => { e.stopPropagation(); cancelInlineEdit(panel, el); });
  wireTextareaAutoResize(panel, textarea, el);

  // ── 4: Register this edit in the shared set ────────────────────────────────
  el._editBaseCardH = h0;
  el._editBaseCardW = w0;
  el._editDelta = h1 - h0;
  panel._editing = panel._editing || [];
  if (panel._editing.indexOf(el) === -1) panel._editing.push(el);

  el._heightAnimating = true;

  // ── 5a: Reduced motion — jump straight to the edit state ───────────────────
  if (prefersReducedMotion()) {
    layoutEditing(panel, 0, 0);
    card.style.transition = "none";
    card.style.height = "";
    card.style.width = `${listWidth}px`;
    card.style.overflow = "";
    card.style.position = "";
    card.style.boxSizing = "";
    if (el._snapClone) { el._snapClone.remove(); el._snapClone = null; }
    editDiv.style.opacity = "1";
    el._heightAnimating = false;
    autoResizeTextarea(textarea);
    textarea.focus({ preventScroll: true });
    return;
  }

  // ── 5b: Play — card unfolds DOWN, neighbours slide DOWN in perfect lockstep ─
  void card.offsetWidth; // commit the pinned starting frame
  const snap = el._snapClone;
  snap.style.transition = "opacity 150ms ease";
  snap.style.opacity = "0";
  editDiv.style.transition = "opacity 200ms ease 70ms";
  editDiv.style.opacity = "1";
  card.style.transition = `height ${EXPAND_DUR}ms ${GLIDE}, width ${EXPAND_DUR}ms ${GLIDE}`;
  card.style.height = `${h1}px`;
  card.style.width = `${listWidth}px`;
  layoutEditing(panel, EXPAND_DUR, 0);
  ensureEditVisible(panel, el, h1);

  el._editTimeout1 = setTimeout(() => {
    el._editTimeout1 = null;
    if (el._snapClone) { el._snapClone.remove(); el._snapClone = null; }
    // Release the height pin (natural height now) but KEEP the column width so
    // the form doesn't collapse to shrink-to-fit; clear the rest.
    card.style.transition = "";
    card.style.height = "";
    card.style.overflow = "";
    card.style.position = "";
    card.style.boxSizing = "";
    editDiv.style.transition = "";
    editDiv.style.opacity = "1";
    el._heightAnimating = false;
    autoResizeTextarea(textarea);
    textarea.focus({ preventScroll: true });
  }, EXPAND_DUR + 40);
}

function cancelInlineEdit(panel, el) {
  if (!el._editing) return;

  const hadPendingExpand = !!el._editTimeout1;
  if (el._editTimeout1) { clearTimeout(el._editTimeout1); el._editTimeout1 = null; }
  if (el._editTimeout2) { clearTimeout(el._editTimeout2); el._editTimeout2 = null; }
  if (el._snapClone) { el._snapClone.remove(); el._snapClone = null; }

  // Drop this bubble from the shared edit set so layoutEditing stops counting it.
  if (panel && panel._editing) {
    const i = panel._editing.indexOf(el);
    if (i !== -1) panel._editing.splice(i, 1);
  }
  el._editDelta = 0;

  const card = el.querySelector(".bubble-card");
  // Restores only THIS bubble's card; neighbour positions + spacer are owned by
  // layoutEditing (it already settled them to the remaining-edits composition).
  const restoreCard = () => {
    if (el._snapClone) { el._snapClone.remove(); el._snapClone = null; }
    if (el._savedCardHTML != null) card.innerHTML = el._savedCardHTML;
    card.style.transition = "";
    card.style.position = "";
    card.style.height = "";
    card.style.width = "";
    card.style.overflow = "";
    card.style.boxSizing = "";
    el.style.height = "";
    el.style.transition = "";
    el._heightAnimating = false;
    el._editing = false;
    el.classList.remove("is-editing");
  };

  // Sync path: teardown, panel collapsing, or the open animation never started.
  if (!panel || !panel._expanded || hadPendingExpand) {
    if (panel && panel._expanded) layoutEditing(panel, 0, 0); // settle the rest instantly
    restoreCard();
    return;
  }

  // ── Animated reverse: card folds UP to base size; layoutEditing slides the
  // neighbours back by exactly this bubble's delta. Same duration + curve as the
  // card height shrink ⇒ gaps stay constant throughout. ─────────────────────────
  el._editing = false;
  el.classList.remove("is-editing");
  el._heightAnimating = true;

  const editH = card.offsetHeight;
  const editW = card.offsetWidth;
  const savedCardH = el._savedCardH || editH;
  const savedCardW = el._savedCardW || editW;

  // Pin the card at its current edit size, overlay the original-content snapshot.
  card.style.boxSizing = "border-box";
  card.style.position = "relative";
  card.style.width = `${editW}px`;
  card.style.height = `${editH}px`;
  card.style.overflow = "hidden";

  const restoreClone = makeCardSnapshot(el, savedCardW);
  restoreClone.style.opacity = "0";

  const editDiv = card.querySelector(".ni-edit");
  if (editDiv) {
    editDiv.style.transition = "opacity 120ms ease";
    editDiv.style.opacity = "0";
  }

  void card.offsetWidth; // commit the pinned starting frame
  restoreClone.style.transition = "opacity 160ms ease 60ms";
  restoreClone.style.opacity = "1";
  card.style.transition = `height ${CANCEL_DUR}ms ${GLIDE}, width ${CANCEL_DUR}ms ${GLIDE}`;
  card.style.height = `${savedCardH}px`;
  card.style.width = `${savedCardW}px`;
  layoutEditing(panel, CANCEL_DUR, 0);

  el._editTimeout2 = setTimeout(() => {
    el._editTimeout2 = null;
    restoreCard();
  }, CANCEL_DUR + 40);
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
  panel._editing = [];
  const keep = [];
  (panel._bubbleEls || []).forEach((el) => {
    const actions = el.querySelector(".instant-note-admin-actions");
    if (actions) actions.remove();
    const badge = el.querySelector(".instant-note-status");
    if (badge) badge.remove();
    if (el._editing) cancelInlineEdit(null, el);
    el.style.transform = "";
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
