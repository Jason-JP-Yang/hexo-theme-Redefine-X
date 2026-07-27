/**
 * Instant Notes — emoji & colour selectors.
 *
 * Replaces the old raw inputs (text emoji field, native <input type=color>,
 * "default" checkbox) with two sleek trigger buttons that open frosted-glass
 * popups anchored in the banner container:
 *
 *   • Emoji picker — the vendored emoji-mart build (/libs/emoji-mart), Noto
 *     animated on hover, themed to the blog, with a "Default — no emoji" preset
 *     header so the bubble can carry no emoji at all.
 *   • Colour picker — fully custom: SV area + hue slider + hex input + preset
 *     swatches, including a "Default" preset (theme-styled bubble).
 *
 * Selection state lives on the host element (compose wrap / edited bubble) as
 * `host._selEmoji` ("" = none) and `host._selColor` ("default" or "#rrggbb").
 * Popups share one open/close animation language with the bubbles (fade + blur
 * + glide) and self-close on outside click, Escape, or window resize.
 */
import { GLIDE, FADE_BLUR, prefersReducedMotion } from "./instant-notes-utils.js";
import { setNotoEmoji, clearNotoEmoji } from "./instant-notes-bubble.js";

const EMOJI_MART_BASE = "/libs/emoji-mart";
const POP_MS = 240;

const PRESET_COLORS = [
  "#6c63ff", "#5a9cf8", "#43b581", "#f5a623", "#f47067",
  "#e91e63", "#9b59b6", "#00bcd4", "#8d6e63", "#607d8b", "#2d2d3a",
];

// ─── Popup shell (frosted glass, banner-anchored) ─────────────────────────────
export function closePickerPopup(panel) {
  const pop = panel._pickerPop;
  if (!pop) return;
  panel._pickerPop = null;
  document.removeEventListener("click", pop._onDoc, true);
  document.removeEventListener("keydown", pop._onKey, true);
  window.removeEventListener("resize", pop._onResize);
  if (prefersReducedMotion()) { pop.remove(); return; }
  pop.style.transition =
    `opacity ${POP_MS}ms ease, transform ${POP_MS}ms ${GLIDE}, filter ${POP_MS}ms ease`;
  pop.style.opacity = "0";
  pop.style.transform = "translateY(8px) scale(0.96)";
  pop.style.filter = FADE_BLUR;
  setTimeout(() => pop.remove(), POP_MS + 40);
}

function openPopup(panel, anchor, cls) {
  closePickerPopup(panel);
  const container =
    document.querySelector(".home-banner-container") || document.body;
  const pop = document.createElement("div");
  pop.className = `ni-popup ${cls}`;
  container.appendChild(pop);
  panel._pickerPop = pop;
  pop._for = anchor;

  // Position above the anchor (below as fallback), clamped into the viewport.
  const place = () => {
    const cRect = container.getBoundingClientRect();
    const aRect = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const margin = 12;
    let left = aRect.left - cRect.left + aRect.width / 2 - w / 2;
    const minL = margin - cRect.left;
    const maxL = window.innerWidth - margin - cRect.left - w;
    left = Math.min(Math.max(left, minL), Math.max(minL, maxL));
    let top = aRect.top - cRect.top - h - 10;
    if (aRect.top - h - 10 < 10) top = aRect.bottom - cRect.top + 10;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  };
  pop._place = place;

  pop._onDoc = (e) => {
    if (pop.contains(e.target) || anchor.contains(e.target)) return;
    closePickerPopup(panel);
  };
  // Capture phase so the first Escape closes the popup WITHOUT also collapsing
  // the expanded panel underneath.
  pop._onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePickerPopup(panel);
    }
  };
  pop._onResize = () => closePickerPopup(panel);
  setTimeout(() => {
    document.addEventListener("click", pop._onDoc, true);
    document.addEventListener("keydown", pop._onKey, true);
  }, 0);
  window.addEventListener("resize", pop._onResize);
  return pop;
}

// Same motion language as the bubbles: fade + blur + upward glide.
function revealPopup(pop) {
  pop._place();
  if (prefersReducedMotion()) return;
  pop.style.opacity = "0";
  pop.style.transform = "translateY(10px) scale(0.94)";
  pop.style.filter = FADE_BLUR;
  void pop.offsetWidth;
  pop.style.transition =
    `opacity ${POP_MS}ms ease, transform ${POP_MS}ms ${GLIDE}, filter ${POP_MS}ms ease`;
  pop.style.opacity = "1";
  pop.style.transform = "none";
  pop.style.filter = "none";
}

// ─── emoji-mart loader (vendored build + data) ────────────────────────────────
let emojiMartReady = null;
function loadEmojiMart() {
  if (emojiMartReady) return emojiMartReady;
  emojiMartReady = new Promise((resolve, reject) => {
    if (window.EmojiMart) return resolve();
    const s = document.createElement("script");
    s.src = `${EMOJI_MART_BASE}/browser.js`;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("emoji-mart script failed"));
    document.head.appendChild(s);
  }).then(() =>
    fetch(`${EMOJI_MART_BASE}/data.json`)
      .then((r) => r.json())
      .then((data) => ({ EM: window.EmojiMart, data })),
  );
  return emojiMartReady;
}

// Eager preload — called at instant-notes init for EVERYONE (admin or not), so
// the picker assets are already cached by the time the selector is opened.
export function preloadEmojiMart() {
  return loadEmojiMart().catch(() => {});
}

// Restyle the picker's shadow DOM to the blog. Document-level @font-face rules
// apply inside shadow trees, so the Google-hosted "Noto Color Emoji" webfont is
// available here too.
function injectPickerStyle(el) {
  const css = `
    :host { box-shadow: none; border-radius: 14px; }
    #root {
      background: transparent;
      --font-family: 'Geist Variable', 'Noto Sans SC', 'Noto Color Emoji',
        -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif;
    }
    /* Every native glyph in the grid/preview renders as Noto Color Emoji —
       never the platform emoji font. The INNER span carries an inline
       font-family (platform fonts first), so this must hit it with !important. */
    .emoji-mart-emoji, .emoji-mart-emoji span {
      font-family: 'Noto Color Emoji', 'EmojiMart', 'Segoe UI Emoji', sans-serif !important;
    }
    /* Category headers are frosted by the picker itself now (tint-less blur with
       a masked bottom edge), so they read as the SAME glass as this popup — no
       override here, any background-color would put the solid bar right back. */
    .scroll::-webkit-scrollbar { width: 6px; }
    .scroll::-webkit-scrollbar-thumb {
      background: rgba(127, 127, 127, 0.4);
      border-radius: 3px;
    }
    .scroll { scrollbar-width: thin; }
  `;
  const add = () => {
    if (!el.shadowRoot) return;
    const st = document.createElement("style");
    st.textContent = css;
    el.shadowRoot.appendChild(st);
  };
  if (el.shadowRoot) add();
  else setTimeout(add, 0);
}

// ─── Emoji picker popup ────────────────────────────────────────────────────────
export async function openEmojiPicker(panel, host, anchor) {
  // Clicking the trigger of the already-open popup toggles it closed.
  if (panel._pickerPop && panel._pickerPop._for === anchor) {
    closePickerPopup(panel);
    return;
  }
  const pop = openPopup(panel, anchor, "ni-popup-emoji");

  const slot = document.createElement("div");
  slot.className = "ni-pop-emoji-slot";
  slot.innerHTML =
    '<div class="ni-pop-loading"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
  pop.appendChild(slot);
  revealPopup(pop);

  try {
    const { EM, data } = await loadEmojiMart();
    if (panel._pickerPop !== pop) return; // closed while loading
    const isDark = document.documentElement.classList.contains("dark");
    const narrow = window.innerWidth < 520;
    const picker = new EM.Picker({
      data,
      set: "native",
      animated: true,
      // Title-less "Default — no emoji" row INSIDE the picker, above the
      // frequently-used category (fork feature) — no external chrome needed.
      noneOption: true,
      theme: isDark ? "dark" : "light",
      skinTonePosition: "search",
      previewPosition: narrow ? "none" : "bottom",
      perLine: narrow ? 7 : 9,
      emojiButtonSize: narrow ? 32 : 36,
      emojiSize: narrow ? 22 : 24,
      onEmojiSelect: (emoji) => {
        setSelEmoji(host, emoji.native || "");
        closePickerPopup(panel);
      },
    });
    picker.style.height = narrow ? "300px" : "340px";
    injectPickerStyle(picker);
    slot.innerHTML = "";
    slot.appendChild(picker);
    pop._place(); // re-clamp with the real picker size
  } catch (e) {
    slot.innerHTML = '<div class="ni-pop-loading">Failed to load</div>';
    console.warn("[InstantNotes] emoji-mart load failed:", e);
  }
}

// ─── Colour picker popup (custom) ──────────────────────────────────────────────
function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return { h: 248, s: 0.62, v: 1 };
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToHex(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

export function openColorPicker(panel, host, anchor) {
  if (panel._pickerPop && panel._pickerPop._for === anchor) {
    closePickerPopup(panel);
    return;
  }
  const pop = openPopup(panel, anchor, "ni-popup-color");

  const startHex =
    host._selColor && host._selColor !== "default" ? host._selColor : "#6c63ff";
  let hsv = hexToHsv(startHex);

  pop.innerHTML =
    '<div class="ni-cp-sv"><div class="ni-cp-thumb ni-cp-sv-thumb"></div></div>' +
    '<div class="ni-cp-hue"><div class="ni-cp-thumb ni-cp-hue-thumb"></div></div>' +
    '<div class="ni-cp-row">' +
    '  <span class="ni-cp-preview"></span>' +
    '  <input class="ni-cp-hex" type="text" maxlength="7" spellcheck="false" aria-label="Hex colour" />' +
    '  <button type="button" class="ni-cp-apply">Apply</button>' +
    "</div>" +
    '<div class="ni-cp-presets"></div>';

  const sv = pop.querySelector(".ni-cp-sv");
  const svThumb = pop.querySelector(".ni-cp-sv-thumb");
  const hue = pop.querySelector(".ni-cp-hue");
  const hueThumb = pop.querySelector(".ni-cp-hue-thumb");
  const preview = pop.querySelector(".ni-cp-preview");
  const hexInput = pop.querySelector(".ni-cp-hex");
  const presets = pop.querySelector(".ni-cp-presets");

  const sync = (applyToHost) => {
    const hex = hsvToHex(hsv.h, hsv.s, hsv.v);
    sv.style.background =
      `linear-gradient(to top, #000, transparent), ` +
      `linear-gradient(to right, #fff, transparent), hsl(${Math.round(hsv.h)}, 100%, 50%)`;
    svThumb.style.left = `${hsv.s * 100}%`;
    svThumb.style.top = `${(1 - hsv.v) * 100}%`;
    svThumb.style.background = hex;
    hueThumb.style.left = `${(hsv.h / 360) * 100}%`;
    hueThumb.style.background = `hsl(${Math.round(hsv.h)}, 100%, 50%)`;
    preview.style.background = hex;
    if (document.activeElement !== hexInput) hexInput.value = hex;
    // Live-apply: the trigger dot follows every adjustment instantly.
    if (applyToHost) setSelColor(host, hex);
  };

  // Pointer-drag on the SV area / hue bar (pointer capture → smooth drags that
  // survive leaving the box; works for touch + mouse alike).
  const drag = (zone, onMove) => {
    zone.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      zone.setPointerCapture(e.pointerId);
      onMove(e);
      const move = (ev) => onMove(ev);
      const up = () => {
        zone.removeEventListener("pointermove", move);
        zone.removeEventListener("pointerup", up);
        zone.removeEventListener("pointercancel", up);
      };
      zone.addEventListener("pointermove", move);
      zone.addEventListener("pointerup", up);
      zone.addEventListener("pointercancel", up);
    });
  };
  drag(sv, (e) => {
    const r = sv.getBoundingClientRect();
    hsv.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    hsv.v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    sync(true);
  });
  drag(hue, (e) => {
    const r = hue.getBoundingClientRect();
    hsv.h = Math.min(360, Math.max(0, ((e.clientX - r.left) / r.width) * 360));
    sync(true);
  });

  // Direct hex input (live once a full #rrggbb is typed).
  hexInput.addEventListener("input", () => {
    const v = hexInput.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(v)) {
      hsv = hexToHsv(v.startsWith("#") ? v : `#${v}`);
      sync(true);
    }
  });
  hexInput.addEventListener("click", (e) => e.stopPropagation());

  pop.querySelector(".ni-cp-apply").addEventListener("click", (e) => {
    e.stopPropagation();
    setSelColor(host, hsvToHex(hsv.h, hsv.s, hsv.v));
    closePickerPopup(panel);
  });

  // Presets: "Default" chip first (theme-styled bubble), then curated colours.
  const defBtn = document.createElement("button");
  defBtn.type = "button";
  defBtn.className = "ni-cp-default";
  defBtn.title = "Default (theme bubble)";
  defBtn.innerHTML = '<i class="fa-solid fa-ban"></i>';
  defBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setSelColor(host, "default");
    closePickerPopup(panel);
  });
  presets.appendChild(defBtn);
  PRESET_COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.style.background = c;
    b.title = c;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      hsv = hexToHsv(c);
      sync(true);
      setSelColor(host, c);
      closePickerPopup(panel);
    });
    presets.appendChild(b);
  });

  sync(false);
  revealPopup(pop);
}

// ─── Trigger wiring + state ────────────────────────────────────────────────────
export function wireSelector(panel, rootEl, host, initial) {
  host._selEmoji = initial.emoji || "";
  host._selColor = initial.color || "default";
  const eBtn = rootEl.querySelector(".ni-emoji-btn");
  const cBtn = rootEl.querySelector(".ni-color-btn");
  host._selEmojiBtn = eBtn;
  host._selColorBtn = cBtn;
  if (eBtn) {
    eBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEmojiPicker(panel, host, eBtn);
    });
  }
  if (cBtn) {
    cBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openColorPicker(panel, host, cBtn);
    });
  }
  refreshSelectorButtons(host);
}

export function refreshSelectorButtons(host) {
  const eBtn = host._selEmojiBtn;
  const cBtn = host._selColorBtn;
  if (eBtn) {
    if (host._selEmoji) {
      eBtn.classList.add("has-emoji");
      // The chosen emoji animates right on the trigger (Noto WebP w/ fallback).
      setNotoEmoji(eBtn, host._selEmoji);
    } else {
      eBtn.classList.remove("has-emoji");
      // Release the animation before the icon replaces the glyph, so nothing
      // keeps a live overlay pointed at a button that no longer shows an emoji.
      clearNotoEmoji(eBtn);
      eBtn.innerHTML = '<i class="fa-solid fa-face-smile"></i>';
    }
  }
  if (cBtn) {
    cBtn.innerHTML = '<span class="ni-color-dot"></span>';
    const dot = cBtn.firstChild;
    if (host._selColor && host._selColor !== "default") {
      cBtn.classList.remove("is-default");
      dot.style.background = host._selColor;
    } else {
      cBtn.classList.add("is-default"); // CSS shows the hue-ring "auto" dot
    }
  }
}

function setSelEmoji(host, v) {
  host._selEmoji = v;
  refreshSelectorButtons(host);
}
function setSelColor(host, v) {
  host._selColor = v;
  refreshSelectorButtons(host);
}
