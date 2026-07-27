import {
  ACTIVE_WINDOW_MS, FADE_OUT_MS, FADE_BLUR, FRAME_MS, GLIDE, FADE_IN_MS,
  contrastTextColor, timeAgo, prefersReducedMotion,
} from "./instant-notes-utils.js";
import { attachNotoEmoji, detachNotoEmoji } from "./noto-anim.js";

// ─── Bubble state helpers ─────────────────────────────────────────────────────
export function isNoteActive(note) {
  if (!note || !note.created_at) return true;
  return Date.now() - new Date(note.created_at).getTime() < ACTIVE_WINDOW_MS;
}

export function bubbleHasEmoji(el) {
  return !!el.querySelector(".instant-note-emoji");
}

// Render an emoji: static Noto Color Emoji text IMMEDIATELY (site font stack —
// zero requests), upgraded to the animated Noto WebP only while it is in the
// viewport and only once decoded, via the shared site-wide runtime.
export function setNotoEmoji(el, native) {
  attachNotoEmoji(el, native);
}

// The host stops showing an emoji entirely — release the animation with it.
export function clearNotoEmoji(el) {
  detachNotoEmoji(el);
}

// ─── Bubble DOM creation ──────────────────────────────────────────────────────
export function createBubble(note, isNewest) {
  const color = note.color && note.color !== "default" ? note.color : null;
  const hasEmoji = !!note.emoji;

  const wrap = document.createElement("div");
  // `.is-entering` holds the pre-reveal hidden state until the pop runs.
  wrap.className =
    "instant-note-bubble is-entering" + (isNewest ? " bubble-newest" : "");
  if (note.id != null) wrap.dataset.noteId = String(note.id);
  wrap._note = note;
  wrap._active = isNoteActive(note);

  // Set --bubble-bg on the wrapper so the newest bubble's tail ::after picks it up.
  if (color) {
    wrap.style.setProperty("--bubble-bg", color);
    wrap.style.setProperty("--bubble-border", "rgba(255,255,255,0.18)");
  }

  const card = document.createElement("div");
  card.className =
    "bubble-card" +
    (color ? " bubble-custom" : " bubble-default") +
    (hasEmoji ? " has-emoji" : "");
  if (color) {
    card.style.backgroundColor = color;
    card.style.color = contrastTextColor(color);
  }

  const txt = document.createElement("span");
  txt.className = "instant-note-text";
  txt.textContent = (note.text || "").slice(0, 200);
  card.appendChild(txt);

  const tm = document.createElement("span");
  tm.className = "instant-note-time";
  tm.textContent = timeAgo(note.created_at);
  card.appendChild(tm);

  wrap.appendChild(card);

  if (hasEmoji) {
    const emo = document.createElement("span");
    emo.className = "instant-note-emoji" + (color ? "" : " emoji-default");
    if (color) emo.style.background = color;
    setNotoEmoji(emo, note.emoji);
    wrap.appendChild(emo);
  }

  return wrap;
}

// ─── Card width helpers ───────────────────────────────────────────────────────
// Breaks at word boundaries; only hard-breaks a single token wider than target.
export function wrapCard(el, maxW) {
  const card = el.querySelector(".bubble-card");
  if (!card) return;
  card.style.maxWidth = maxW + "px";
  card.style.whiteSpace = "normal";
  card.style.wordBreak = "normal";
  card.style.overflowWrap = "break-word";
}
export function clearWrap(el) {
  const card = el.querySelector(".bubble-card");
  if (!card) return;
  card.style.maxWidth = "";
  card.style.whiteSpace = "";
  card.style.wordBreak = "";
  card.style.overflowWrap = "";
  card.style.transition = "";
}

// ─── Bubble cross-fade animations ─────────────────────────────────────────────
// Any layout change (resize / expand / collapse / admin CRUD) fades bubbles OUT
// (transparent + blurred), repositions them INSTANTLY while invisible, then fades
// them IN at the new spot/shape. No positional or width transitions.
export function fadeOutBubbles(els) {
  const reduced = prefersReducedMotion();
  els.forEach((el) => {
    if (!el) return;
    el.style.transition = reduced ? "none" : `opacity ${FADE_OUT_MS}ms ease, filter ${FADE_OUT_MS}ms ease`;
    el.style.opacity = "0";
    el.style.filter = reduced ? "none" : FADE_BLUR;
  });
}

// Position a bubble instantly while it is invisible.
//   cardMaxW = number → wrap card / size input to that width (expanded list)
//   cardMaxW = undefined → leave the card width as computeLayout set it (compact)
export function placeBubble(el, left, top, cardMaxW) {
  el.style.transition = "none";
  el.style.transform = "none";
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  if (typeof cardMaxW === "number") {
    if (el.classList.contains("instant-notes-input-bubble")) el.style.width = `${Math.round(cardMaxW)}px`;
    else wrapCard(el, Math.round(cardMaxW));
  }
}

// Like placeBubble but GLIDES to the new spot instead of jumping while invisible.
// Used by admin inline-edit reflow so neighbours slide to make room.
// Uses FLIP (transform) instead of top/left transition so the layout position
// commits instantly — no layout-driven scroll-container jumps during animation.
export function placeBubbleAnimated(el, left, top, cardMaxW, dur = FRAME_MS, delay = 0) {
  const targetLeft = Math.round(left);
  const targetTop = Math.round(top);

  if (prefersReducedMotion()) {
    el.style.transition = "none";
    el.style.transform = "none";
    el.style.left = `${targetLeft}px`;
    el.style.top = `${targetTop}px`;
    if (typeof cardMaxW === "number") {
      if (el.classList.contains("instant-notes-input-bubble")) el.style.width = `${Math.round(cardMaxW)}px`;
      else wrapCard(el, Math.round(cardMaxW));
    }
    return;
  }

  const currentLeft = parseFloat(el.style.left) || 0;
  const currentTop = parseFloat(el.style.top) || 0;
  const deltaX = currentLeft - targetLeft;
  const deltaY = currentTop - targetTop;

  // Commit final layout position + card width instantly (no top/left animation).
  el.style.transition = "none";
  el.style.transform = "none";
  el.style.left = `${targetLeft}px`;
  el.style.top = `${targetTop}px`;
  if (typeof cardMaxW === "number") {
    if (el.classList.contains("instant-notes-input-bubble")) el.style.width = `${Math.round(cardMaxW)}px`;
    else wrapCard(el, Math.round(cardMaxW));
  }

  if (deltaX === 0 && deltaY === 0) return;

  // FLIP: invert to the old visual position, then animate transform → none.
  // transform doesn't affect layout so the scroll container stays stable.
  el.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
  void el.offsetHeight; // force reflow to commit the starting transform
  const d = delay ? ` ${delay}ms` : "";
  el.style.transition = `transform ${dur}ms ${GLIDE}${d}`;
  el.style.transform = "none";
}

export function fadeInBubbles(els) {
  const reduced = prefersReducedMotion();
  // Start from hidden+blurred, force reflow, then transition to visible+sharp.
  els.forEach((el) => {
    if (!el) return;
    el.style.transition = "none";
    el.style.opacity = "0";
    el.style.filter = reduced ? "none" : FADE_BLUR;
  });
  els.forEach((el) => el && void el.offsetWidth);
  els.forEach((el) => {
    if (!el) return;
    el.style.transition = reduced ? "none" : `opacity ${FADE_IN_MS}ms ease, filter ${FADE_IN_MS}ms ease`;
    el.style.opacity = "1";
    el.style.filter = "none";
  });
}
