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
  repositionExpandedListInstant, expandedOrder,
  layoutCompactCompose, rebuildCompactWithFade,
} from "./instant-notes-layout.js";
import { createBubble, isNoteActive, clearWrap } from "./instant-notes-bubble.js";
import {
  GLIDE, PAD, EMOJI_TOP_EXTRA, FRAME_MS, FADE_OUT_MS, FADE_IN_MS, FADE_BLUR,
  clamp, prefersReducedMotion,
} from "./instant-notes-utils.js";

// Cache fetched public notes briefly so rapid swup navigations skip the worker.
let _notesCache = null;
const NOTES_TTL = 60000;

// ─── Textarea auto-resize ─────────────────────────────────────────────────────
function autoResizeTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + "px";
}

// Block manual line breaks: the backend stores/renders notes as single-line text,
// so the only wrapping that may ever happen is passive (width-constrained) reflow —
// never a user-inserted newline. Enter is swallowed outright; a paste containing
// line breaks is sanitised (newlines → spaces) instead of inserted verbatim. (Problem 1.)
function wireNoNewlines(textarea) {
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault();
  });
  textarea.addEventListener("paste", (e) => {
    e.preventDefault();
    const raw = (e.clipboardData || window.clipboardData).getData("text");
    const clean = raw.replace(/[\r\n]+/g, " ");
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const max = textarea.maxLength > 0 ? textarea.maxLength : Infinity;
    let next = textarea.value.slice(0, start) + clean + textarea.value.slice(end);
    if (next.length > max) next = next.slice(0, max);
    textarea.value = next;
    const pos = Math.min(start + clean.length, max);
    textarea.setSelectionRange(pos, pos);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// Wire the textarea to resize itself on input and smoothly reflow neighbours.
// el is the bubble wrapper that contains the textarea (used for _heightAnimating guard).
function wireTextareaAutoResize(panel, textarea, el) {
  wireNoNewlines(textarea);
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
    reconcile:        (notes) => reconcileAdminNotes(panel, notes),
    ensureInput:      ()      => ensureInputBubble(panel),
    teardown:         ()      => teardownAdminExpanded(panel),
    teardownToCompose:()      => teardownToCompose(panel),
    fetchAll:         ()      => adminFetch(panel, "GET", "/api/admin/notes"),
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
    // Resolve admin status (controls the More button + admin tools). An admin with
    // no active notes sees the compose card sitting on the avatar (not an empty
    // panel) so they can post straight away. (Problem 1.)
    refreshAdminState(panel).then(() => {
      if (panel._isAdmin && list.length === 0) {
        waitForPreloader().then(() =>
          setTimeout(() => layoutCompactCompose(panel, { reveal: true }), 400),
        );
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
        el._emojiDelta = 0;
        el._editUp = false;
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
    const list = Array.isArray(all) ? all : [];
    if (panel._composeCompact && !panel._expanded) {
      // Compose-only compact state: fade the compose card out, then fade the new
      // bubble in. No global reflow. (Problem 1.1.)
      animateComposePost(panel, list);
    } else if (panel._expanded && !prefersReducedMotion()) {
      // Seamless insert: the new bubble pops up from the bottom of the list while
      // the existing bubbles glide up — no global cross-fade reflow. (Problem 2.1.)
      animatePostNote(panel, list);
    } else {
      reconcileAdminNotes(panel, list);
      relayoutExpanded(panel, true);
    }
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

// Each editing bubble's height change vs. its base list height. SIGNED: a save
// that shrinks the card below its original height yields a negative delta so the
// neighbours below pull back UP (gaps stay constant throughout — see
// animateEditClose). During an open edit the form is always taller, so it is
// positive there.
function editDelta(el) {
  return el._editDelta || 0;
}

// Change in the space RESERVED ABOVE a bubble for its emoji badge (which pokes up
// past the card top). SIGNED: a save that ADDS an emoji yields +EMOJI_TOP_EXTRA
// (room opens above), removing one yields −EMOJI_TOP_EXTRA. Unlike editDelta
// (card grows DOWN, so it only moves bubbles below) this space is ABOVE the card,
// so it slides the bubble ITSELF down as well as everything below it. (Problem 2.)
function emojiDelta(el) {
  return el._emojiDelta || 0;
}

// ── Single source of truth for inline-edit reflow ─────────────────────────────
// Position EVERY field bubble at its clean base `top` (kept transform-free) plus
// the contributions of all edits at/above it, and size the scroll spacer to the
// total. Each edit contributes its card-height growth (editDelta — to bubbles
// strictly BELOW) and its emoji top-space change (emojiDelta — to ITSELF and
// everything below). Because it is recomputed from the WHOLE `panel._editing`
// set on every call, any number of concurrent edits compose correctly (deltas
// add, no transform stomping) and dropping one simply removes it from the sum.
function layoutEditing(panel, dur, delay) {
  const field = panel.querySelector("#instant-notes-field");
  if (!field) return;
  const editing = panel._editing || [];
  const d = delay ? ` ${delay}ms` : "";
  const trans = dur ? `transform ${dur}ms ${GLIDE}${d}` : "none";

  // Only DOWN (top-anchored) edits grow the scroll content — they unfold into new
  // space below. UP (bottom-anchored) edits grow into existing space above via pure
  // transforms, leaving the layout/scroll height untouched. (Problem 3.)
  let total = 0;
  editing.forEach((e) => { if (!e._editUp) total += editDelta(e) + emojiDelta(e); });

  fieldBubbles(panel).forEach((b) => {
    const bTop = parseFloat(b.style.top) || 0;
    let shift = 0;
    editing.forEach((e) => {
      const gd = editDelta(e);
      const ge = emojiDelta(e);
      const eTop = parseFloat(e.style.top) || 0;
      if (e._editUp) {
        // Bottom-anchored: card grows UP, emoji-space opens further UP.
        if (e === b) shift -= gd;                 // self rises by its card growth
        else if (bTop < eTop) shift -= gd + ge;   // bubbles above rise by both
      } else {
        // Top-anchored: card grows DOWN; emoji-space pushes self + below DOWN.
        if (e === b) shift += ge;
        else if (bTop > eTop) shift += gd + ge;
      }
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
// accounting for the shift contributed by any edits above it. Bottom-anchored
// (upward) edits unfold into the visible space above the bubble, so they need no
// scroll — that is the whole point of expanding them upward. (Problem 3.)
function ensureEditVisible(panel, el, cardH) {
  if (el._editUp) return;
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

// Absolutely-positioned, non-reflowing snapshot of a card's content. Pinned to an
// EXACT FRACTIONAL box width (`boxW`, from getBoundingClientRect — never the
// rounded offsetWidth) so it wraps byte-for-byte identically to the committed
// card, which shrink-wraps to that same width. Two traps this avoids:
//   • Rounded offsetWidth is ~1px short of the true sub-pixel content width, so a
//     fixed integer width forces the trailing time token ("9d") onto its own line
//     for the final frame, then `commit` un-wraps it — the cancel "jump".
//   • `width:max-content` (a previous attempt) is resolved by some engines
//     against the abspos clone's containing block — here the wrapper `el`, whose
//     width during the morph is the NARROW pinned/animating card — collapsing the
//     clone far below its content width and wrapping it severely (overlapping the
//     bubble below). A fixed fractional width depends on nothing external. (P1.)
function makeCardSnapshot(el, html, cls, style, boxW) {
  const clone = document.createElement("div");
  clone.className = cls;
  if (style) clone.setAttribute("style", style);
  clone.style.position = "absolute";
  clone.style.top = "0";
  clone.style.left = "0";
  clone.style.zIndex = "20";
  clone.style.pointerEvents = "none";
  clone.style.boxSizing = "border-box";
  clone.style.maxWidth = "none";
  clone.style.width = `${boxW}px`;
  clone.style.whiteSpace = "normal";
  clone.style.wordBreak = "normal";
  clone.style.overflowWrap = "break-word";
  clone.innerHTML = html || "";
  el.appendChild(clone);
  el._snapClone = clone;
  return clone;
}

// Off-screen probe: the border-box size a DISPLAY card (class `cls`, content
// `html`) takes at wrap width `wrapW`. Used to pre-compute the post-save card
// geometry BEFORE the morph animation so the close can target the exact final
// width/height. (Problem 3.)
function probeCardSize(cls, html, wrapW) {
  const probe = document.createElement("div");
  probe.className = cls;
  probe.style.cssText =
    `position:fixed;left:-9999px;top:0;max-width:${wrapW}px;visibility:hidden;` +
    "pointer-events:none;white-space:normal;word-break:normal;overflow-wrap:break-word;box-sizing:border-box;";
  probe.innerHTML = html;
  document.body.appendChild(probe);
  // Fractional (getBoundingClientRect), not rounded offsetWidth — the snapshot is
  // pinned to this exact width and must reproduce the committed wrap. (Problem 1.)
  const r = probe.getBoundingClientRect();
  const size = { w: r.width, h: r.height };
  document.body.removeChild(probe);
  return size;
}

function startInlineEdit(panel, el) {
  if (el._editing) return;
  el._editing = true;
  el.classList.add("is-editing");

  // Direction: the bottom-most TWO field bubbles unfold UPWARD (bottom edge fixed)
  // so the taller edit form clears the pinned slot / avatar below and needs no
  // extra scroll; every other bubble keeps the top-anchored downward unfold. (P3.)
  const fbs = fieldBubbles(panel)
    .slice()
    .sort((a, b) => (parseFloat(b.style.top) || 0) - (parseFloat(a.style.top) || 0));
  const rank = fbs.indexOf(el);
  el._editUp = rank > -1 && rank < 2;

  const note = el._note || {};
  const card = el.querySelector(".bubble-card");
  el._savedCardHTML = card.innerHTML;
  el._savedCardClass = card.className;
  el._savedCardStyle = card.getAttribute("style") || "";

  // ── 0: Capture current border-box geometry (FRACTIONAL — the snapshot pins to
  // _savedCardW exactly and must reproduce the live card's wrap). ──────────────
  const r0 = card.getBoundingClientRect();
  const w0 = r0.width;
  const h0 = r0.height;
  // listWidth = the full column width the edit form expands to (wrapCard's cap).
  const listWidth = card.style.maxWidth ? Math.round(parseFloat(card.style.maxWidth)) : w0;
  el._savedCardH = h0;
  el._savedCardW = w0;
  el._savedWrapW = listWidth;

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
  makeCardSnapshot(el, el._savedCardHTML, el._savedCardClass, el._savedCardStyle, el._savedCardW);

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

// ── Shared inline-edit CLOSE engine (cancel + save) ───────────────────────────
// Morphs the open edit card to a target content + size: cross-fades the form out
// and a shrink-to-fit snapshot of the TARGET content in, animates the card
// height/width, and slides neighbours via the declarative layout pass. The gap to
// every neighbour stays constant the whole way because the card height h(t) and
// each neighbour's shift s(t) animate on the same curve/duration from the same
// start, giving s(t) − h(t) ≡ −baseH (a constant) for any target size or sign.
//
//   • cancel → target = the saved original content/size, delta returns to 0.
//   • save   → target = the new note's content/size, delta is baked permanently
//              into the list so dropping the bubble from the editing set leaves
//              the neighbours exactly where they are (no cross-fade reflow).
function animateEditClose(panel, el, opts) {
  const card = el.querySelector(".bubble-card");
  const baseH = el._editBaseCardH || card.offsetHeight;
  const dur = opts.dur || CANCEL_DUR;

  if (el._editTimeout1) { clearTimeout(el._editTimeout1); el._editTimeout1 = null; }
  if (el._editTimeout2) { clearTimeout(el._editTimeout2); el._editTimeout2 = null; }
  if (el._snapClone) { el._snapClone.remove(); el._snapClone = null; }

  const commit = () => {
    if (el._snapClone) { el._snapClone.remove(); el._snapClone = null; }
    card.setAttribute("style", opts.cardStyle || "");
    card.className = opts.cls;
    card.innerHTML = opts.html;
    card.style.maxWidth = `${opts.wrapW}px`;
    card.style.whiteSpace = "normal";
    card.style.wordBreak = "normal";
    card.style.overflowWrap = "break-word";
    if (opts.bake) applyMorphMeta(panel, el, opts.note);
    el.style.transition = "";
    el.style.height = "";
    el._heightAnimating = false;
    el._editing = false;
    el.classList.remove("is-editing");

    const cardDelta = opts.bake ? (opts.targetH - baseH) : 0;
    const emojiD = opts.bake ? (opts.emojiDelta || 0) : 0;
    const up = !!el._editUp;
    if (panel && panel._editing) {
      const i = panel._editing.indexOf(el);
      if (i !== -1) panel._editing.splice(i, 1);
    }
    if (panel && panel._expanded && opts.bake && (cardDelta || emojiD)) {
      bakeEdit(panel, el, cardDelta, emojiD, up);
    }
    el._editDelta = 0;
    el._emojiDelta = 0;
    el._editUp = false;
    if (panel && panel._expanded) layoutEditing(panel, 0, 0);
  };

  // Sync path: teardown, collapsed panel, or reduced motion → jump to final state.
  if (!panel || !panel._expanded || prefersReducedMotion()) {
    commit();
    return;
  }

  el._editing = false;
  el.classList.remove("is-editing");
  el._heightAnimating = true;

  const editH = card.offsetHeight;
  const editW = card.offsetWidth;

  // Pin the card at its current edit size; overlay a snapshot of the TARGET
  // content (shrink-to-fit at wrapW ⇒ wraps exactly like the committed card).
  card.style.boxSizing = "border-box";
  card.style.position = "relative";
  card.style.width = `${editW}px`;
  card.style.height = `${editH}px`;
  card.style.overflow = "hidden";

  const snap = makeCardSnapshot(el, opts.html, opts.cls, opts.cardStyle, opts.targetW);
  snap.style.opacity = "0";

  const editDiv = card.querySelector(".ni-edit");
  if (editDiv) {
    editDiv.style.transition = "opacity 120ms ease";
    editDiv.style.opacity = "0";
  }

  // Fade the emoji badge in/out (added/removed by this save) as the space above
  // opens/closes, so it doesn't pop or float over the closing gap. (Problem 2.)
  if (opts.bake) transitionEmoji(el, opts.note);

  // Neighbours track the card-height change (editDelta) AND the emoji top-space
  // change (emojiDelta — slides this bubble itself down as well). (Problem 2.)
  el._editDelta = opts.targetH - baseH;
  el._emojiDelta = opts.emojiDelta || 0;

  void card.offsetWidth; // commit the pinned starting frame
  snap.style.transition = "opacity 160ms ease 60ms";
  snap.style.opacity = "1";
  card.style.transition = `height ${dur}ms ${GLIDE}, width ${dur}ms ${GLIDE}`;
  card.style.height = `${opts.targetH}px`;
  card.style.width = `${opts.targetW}px`;
  layoutEditing(panel, dur, 0);

  el._editTimeout2 = setTimeout(() => {
    el._editTimeout2 = null;
    commit();
  }, dur + 40);
}

// Permanently fold an edited bubble's footprint change into the list so dropping
// it from the editing set leaves everything visually unmoved (its transform,
// recomputed without it, drops by the same amount).
//
//   DOWN (top-anchored): the bubble slid down by its emoji-space (`emojiD`); every
//   bubble below absorbed emoji-space + card growth (`cardDelta + emojiD`); the
//   scroll spacer grows by the sum (new space unfolded below).
//   UP (bottom-anchored): the bubble rose by its card growth; every bubble ABOVE
//   rose by card growth + emoji-space. Layout height is unchanged (it grew into
//   existing space above); if that pushed a bubble past the field's top padding,
//   slide the whole field down + grow the spacer + hold scroll so nothing jumps.
function bakeEdit(panel, el, cardDelta, emojiD, up) {
  const field = panel.querySelector("#instant-notes-field");
  const elTop = parseFloat(el.style.top) || 0;
  const total = cardDelta + emojiD;
  if (up) {
    el.style.transition = "none";
    el.style.top = `${elTop - cardDelta}px`;
    fieldBubbles(panel).forEach((b) => {
      if (b === el) return;
      if ((parseFloat(b.style.top) || 0) < elTop) {
        b.style.transition = "none";
        b.style.top = `${(parseFloat(b.style.top) || 0) - total}px`;
      }
    });
    let minTop = Infinity;
    fieldBubbles(panel).forEach((b) => { minTop = Math.min(minTop, parseFloat(b.style.top) || 0); });
    if (minTop < PAD) {
      const down = PAD - minTop;
      fieldBubbles(panel).forEach((b) => {
        b.style.transition = "none";
        b.style.top = `${(parseFloat(b.style.top) || 0) + down}px`;
      });
      panel._listContentH = (panel._listContentH || 0) + down;
      if (field) field.scrollTop = (field.scrollTop || 0) + down;
    }
  } else {
    fieldBubbles(panel).forEach((b) => {
      if (b === el) {
        if (emojiD) { b.style.transition = "none"; b.style.top = `${elTop + emojiD}px`; }
        return;
      }
      if ((parseFloat(b.style.top) || 0) > elTop) {
        b.style.transition = "none";
        b.style.top = `${(parseFloat(b.style.top) || 0) + total}px`;
      }
    });
    panel._listContentH = (panel._listContentH || 0) + total;
  }
  const spacer = field && field.querySelector(".instant-notes-scroll-spacer");
  if (spacer) { spacer.style.transition = "none"; spacer.style.height = `${panel._listContentH}px`; }
}

// Fade the emoji badge in / out on a save morph so it appears/disappears in step
// with the space opening/closing above the bubble (driven by emojiDelta). Called
// at the START of the animated path; applyMorphMeta settles the final state.
function transitionEmoji(el, note) {
  const reduced = prefersReducedMotion();
  const color = note.color && note.color !== "default" ? note.color : null;
  const existing = el.querySelector(".instant-note-emoji");
  const want = !!note.emoji;
  if (want && !existing) {
    const emo = document.createElement("span");
    emo.className = "instant-note-emoji" + (color ? "" : " emoji-default");
    emo.style.background = color || "";
    emo.textContent = note.emoji;
    el.appendChild(emo);
    if (!reduced) {
      emo.style.opacity = "0";
      emo.style.transform = "scale(0.5)";
      void emo.offsetWidth;
      emo.style.transition = "opacity 200ms ease, transform 240ms cubic-bezier(0.34,1.56,0.64,1)";
      emo.style.opacity = "1";
      emo.style.transform = "scale(1)";
    }
  } else if (!want && existing) {
    if (reduced) { existing.remove(); return; }
    existing.style.transition = "opacity 160ms ease, transform 180ms ease";
    existing.style.opacity = "0";
    existing.style.transform = "scale(0.5)";
    setTimeout(() => existing.remove(), 200);
  } else if (want && existing) {
    existing.className = "instant-note-emoji" + (color ? "" : " emoji-default");
    existing.style.background = color || "";
    existing.textContent = note.emoji;
  }
}

// Sync an admin bubble's wrapper-level state (colour vars, emoji badge, status)
// to a new note after a save morph — the snapshot only carries the card body.
// Idempotent: the animated path already faded the badge via transitionEmoji, so
// this just settles the final emoji state (clearing the fade's inline leftovers);
// the sync/reduced path relies on it to add/remove the badge outright.
function applyMorphMeta(panel, el, note) {
  el._note = note;
  el._active = isNoteActive(note);
  const color = note.color && note.color !== "default" ? note.color : null;
  if (color) {
    el.style.setProperty("--bubble-bg", color);
    el.style.setProperty("--bubble-border", "rgba(255,255,255,0.18)");
  } else {
    el.style.removeProperty("--bubble-bg");
    el.style.removeProperty("--bubble-border");
  }
  const existing = el.querySelector(".instant-note-emoji");
  if (note.emoji) {
    const emo = existing || document.createElement("span");
    emo.className = "instant-note-emoji" + (color ? "" : " emoji-default");
    emo.style.background = color || "";
    emo.textContent = note.emoji;
    emo.style.transition = "";
    emo.style.opacity = "";
    emo.style.transform = "";
    if (!existing) el.appendChild(emo);
  } else if (existing) {
    existing.remove();
  }
  if (panel) decorateAdminBubble(panel, el);
}

function cancelInlineEdit(panel, el) {
  if (!el._editing) return;
  animateEditClose(panel, el, {
    html: el._savedCardHTML,
    cls: el._savedCardClass,
    cardStyle: el._savedCardStyle,
    wrapW: el._savedWrapW || el._savedCardW || 0,
    targetW: el._savedCardW || 0,
    targetH: el._savedCardH || 0,
    bake: false,
  });
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
    _notesCache = null;
  } catch (e) {
    console.warn("[InstantNotes] edit failed:", e);
    save.textContent = "Error";
    setTimeout(() => (save.textContent = "Save"), 1500);
    save.disabled = false;
    return;
  }

  // No full reflow / cross-fade: build the note's new display state locally,
  // pre-measure the post-save card, then morph the card from the edit form to
  // that exact size while neighbours glide and the change is baked in. (Problem 3.)
  const oldHasEmoji = !!(el._note && el._note.emoji);
  const note = Object.assign({}, el._note, { text, emoji, color });
  const fresh = createBubble(note, false).querySelector(".bubble-card");
  const wrapW = el._savedWrapW || card.offsetWidth;
  const size = probeCardSize(fresh.className, fresh.innerHTML, wrapW);
  // Gaining/losing the emoji badge changes the space reserved ABOVE the bubble. (Problem 2.)
  const emojiDelta = ((note.emoji ? 1 : 0) - (oldHasEmoji ? 1 : 0)) * EMOJI_TOP_EXTRA;

  animateEditClose(panel, el, {
    html: fresh.innerHTML,
    cls: fresh.className,
    cardStyle: fresh.getAttribute("style") || "",
    wrapW,
    targetW: size.w,
    targetH: size.h,
    emojiDelta,
    bake: true,
    note,
  });
}

async function deleteNote(panel, el) {
  const id = el.dataset.noteId;
  if (!id) return;
  if (!window.confirm("Delete this note?")) return;
  try {
    await adminFetch(panel, "DELETE", `/api/admin/notes/${id}`);
    const all = await adminFetch(panel, "GET", "/api/admin/notes");
    const list = Array.isArray(all) ? all : [];
    // Seamless removal: the target fades out, then the bubbles above it glide
    // down to fill the gap — no global cross-fade reflow. (Problem 2.2.)
    if (panel._expanded && !prefersReducedMotion()) animateDeleteNote(panel, el, list);
    else { reconcileAdminNotes(panel, list); relayoutExpanded(panel, true); }
    _notesCache = null;
  } catch (e) {
    console.warn("[InstantNotes] delete failed:", e);
    el.style.opacity = "1";
  }
}

// ── Seamless post / delete animations (no global cross-fade) ───────────────────
// Shared FLIP using the SAME glide formula (GLIDE curve, FRAME_MS) the expand and
// inline-edit animations use, so every bubble moves identically:
//   1. capture each surviving bubble's SCREEN rect (getBoundingClientRect),
//   2. mutate + re-flow the list INSTANTLY inside the unchanged panel frame
//      (repositionExpandedListInstant — keeping the frame fixed means no
//      coordinate-origin jump that would break a top/left-based FLIP),
//   3. invert (translate back to the old screen spot) and play (animate to none).

// Snapshot every expanded bubble's current viewport rect, keyed by element.
function captureBubbleRects(panel) {
  const rects = new Map();
  expandedOrder(panel).forEach((el) => { if (el) rects.set(el, el.getBoundingClientRect()); });
  return rects;
}

// Glide every still-present bubble from its pre-mutation screen rect (`before`) to
// where it now sits, on the shared GLIDE curve. Batched: one reflow commits all
// inverted starts, then all play together so they stay in perfect lockstep.
function flipBubbles(panel, before) {
  const moved = [];
  expandedOrder(panel).forEach((el) => {
    if (!el) return;
    const first = before.get(el);
    if (!first) return; // freshly added bubble — animated separately by popInBubble
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    moved.push(el);
  });
  if (!moved.length) return;
  void panel.offsetWidth; // single reflow commits every inverted start position
  moved.forEach((el) => {
    el.style.transition = `transform ${FRAME_MS}ms ${GLIDE}`;
    el.style.transform = "none";
  });
}

// Pop a freshly posted bubble up into its slot from just below, fading + scaling in
// on the same curve/timings as the surrounding glide. (Problem 2.1.)
function popInBubble(el) {
  el.style.transition = "none";
  el.style.transform = "translateY(18px) scale(0.92)";
  el.style.opacity = "0";
  el.style.filter = FADE_BLUR;
  void el.offsetWidth;
  el.style.transition =
    `transform ${FRAME_MS}ms ${GLIDE}, opacity ${FADE_IN_MS}ms ease, filter ${FADE_IN_MS}ms ease`;
  el.style.transform = "none";
  el.style.opacity = "1";
  el.style.filter = "none";
}

// New note: existing bubbles glide up keeping constant gaps, the new one pops in at
// the bottom of the older stack. (Problem 2.1.)
function animatePostNote(panel, notes) {
  const newId = notes.length ? String(notes[0].id) : null;
  const before = captureBubbleRects(panel);
  reconcileAdminNotes(panel, notes);
  const field = repositionExpandedListInstant(panel);
  // Reveal the newest note at the bottom before measuring final spots, so the glide
  // already accounts for any scroll-to-bottom.
  if (field) field.scrollTop = field.scrollHeight;
  flipBubbles(panel, before);
  const newEl = newId && (panel._bubbleEls || []).find((b) => b.dataset.noteId === newId);
  if (newEl) popInBubble(newEl);
}

// Compose-only compact post: the compose card fades out, then the new bubble fades
// in (compact layout rebuilt for the now-active notes) — a plain cross-fade, same as
// every other expand/reveal. No reflow. (Problem 1.1, 2.)
function animateComposePost(panel, notes) {
  const input = panel._inputBubble;
  const active = (notes || []).filter(isNoteActive).slice(0, 5);
  panel._inputBubble = null;
  panel._composeCompact = false;
  const finish = () => {
    if (input && input.parentElement) input.parentElement.removeChild(input);
    if (active.length === 0) { layoutCompactCompose(panel, { reveal: true }); return; }
    rebuildCompactWithFade(panel, active);
  };
  if (input && !prefersReducedMotion()) {
    input.style.transition =
      `opacity ${FADE_OUT_MS}ms ease, transform ${FADE_OUT_MS}ms ease, filter ${FADE_OUT_MS}ms ease`;
    input.style.opacity = "0";
    input.style.transform = "scale(0.9)";
    input.style.filter = FADE_BLUR;
    setTimeout(finish, FADE_OUT_MS);
  } else {
    finish();
  }
}

// Delete: the target fades out first, then it is removed and the bubbles above it
// glide down to fill the freed space. (Problem 2.2.)
function animateDeleteNote(panel, el, notes) {
  el.style.transition =
    `opacity ${FADE_OUT_MS}ms ease, filter ${FADE_OUT_MS}ms ease, transform ${FADE_OUT_MS}ms ease`;
  el.style.opacity = "0";
  el.style.filter = FADE_BLUR;
  el.style.transform = "scale(0.9)";
  setTimeout(() => {
    const before = captureBubbleRects(panel);
    reconcileAdminNotes(panel, notes);
    repositionExpandedListInstant(panel);
    flipBubbles(panel, before);
  }, FADE_OUT_MS);
}

// Collapse from expanded back to the compose-only compact state: drop every
// history bubble but KEEP the persistent input card (it stays as the compose card
// on the avatar). layoutCompactCompose then positions it. (Problem 1.3.)
function teardownToCompose(panel) {
  panel.classList.remove("is-admin-expanded");
  panel._editing = [];
  (panel._bubbleEls || []).forEach((el) => {
    if (el._editing) cancelInlineEdit(null, el);
    if (el.parentElement) el.parentElement.removeChild(el);
  });
  panel._bubbleEls = [];
  panel._hasEmoji = [];
  panel._notes = [];
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
