/**
 * Instant Notes – Instagram-Notes-style chat bubbles on the home banner.
 *
 * The panel (#instant-notes) is a flex item inside the banner bottom bar,
 * between the scroll arrow (left) and the social contacts (right). It is
 * therefore WIDE but SHORT.
 *
 *  • Avatar pinned bottom-left (CSS).
 *  • Newest bubble anchored at the avatar's top-right; it is the ONLY bubble
 *    with a speech tail, aimed at the avatar ("spoken by the user").
 *  • Older bubbles are tail-less floating bubbles packed left→right, clustered
 *    near the avatar (gravity) with a fresh random vertical scatter.
 *  • Fit chain when content overflows: word-wrap → vertical stagger → grow
 *    panel height (bounded) → drop the oldest that still cannot fit.
 *  • Sparse content → the panel shrinks to its width and floats at screen centre.
 *
 * The bubble's RESTING visual state lives in the base `.instant-note-bubble`
 * CSS rule (opacity 1, transform none, filter none). The pre-reveal HIDDEN
 * state lives in the `.is-entering` modifier only. Resize never reverts a laid
 * out bubble to the hidden state, so it can never get stuck blurred/shrunk.
 *
 * Timing: fetch starts immediately; reveal waits for preloader + 500 ms.
 */

// ─── Colour helpers ────────────────────────────────────────
function hexToRgb(hex) {
  hex = hex.replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(r, g, b) {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function contrastTextColor(bgHex) {
  const [r, g, b] = hexToRgb(bgHex);
  return luminance(r, g, b) > 0.38 ? "#1a1a1a" : "#ffffff";
}

// ─── Time formatting ───────────────────────────────────────
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h`;
}

// ─── Layout constants ──────────────────────────────────────
const PAD = 8;             // inner panel padding
const GAP_X = 6;           // horizontal gap between bubbles
const GAP_Y = 8;           // vertical gap between lanes
const LABEL_PAD = 28;      // reserve under the "Instant Notes" label
const TAIL = 12;           // newest bubble's speech-tail height
const AVATAR_OVERLAP = 10; // newest hugs the avatar's right edge by this much
const EMOJI_TOP_MIN = 18;  // keep emoji badge from clipping the panel top
const MIN_READABLE_W = 96; // never wrap a bubble narrower than this
const MAX_BUBBLE_CAP = 280;// absolute max bubble width (px)
const MAX_BUBBLE_FRAC = 0.46; // …or this fraction of the panel width
const MAX_LANES = 4;       // hard cap on stacked lanes
const MAX_JITTER = 8;      // bounded vertical jitter — organic but small gaps
const EMOJI_RIGHT_EXTRA = 14; // extra right gap after an emoji bubble
const COMPACT_RATIO = 0.80;   // shrink + center the panel below this content/strip ratio

// Re-randomise the scatter on every visit, but avoid re-hitting the worker on
// rapid swup navigations: cache the fetched notes briefly and re-run the layout.
let _notesCache = null; // { data, ts }
const NOTES_TTL = 60000;

// ─── Entry point ───────────────────────────────────────────
export default function initInstantNotes() {
  const panel = document.getElementById("instant-notes");
  if (!panel) return;

  const apiUrl = theme.home_banner?.instant_notes?.api_url;
  if (!apiUrl) return;

  const fresh = _notesCache && Date.now() - _notesCache.ts < NOTES_TTL;
  const notesPromise = fresh
    ? Promise.resolve(_notesCache.data)
    : fetchNotes(apiUrl).then((d) => {
        _notesCache = { data: d, ts: Date.now() };
        return d;
      });

  notesPromise.then((notes) => {
    if (!notes || notes.length === 0) return;
    buildDOM(notes.slice(0, 5), panel);
    waitForPreloader().then(() => {
      setTimeout(() => revealNotes(panel), 500);
    });
  });
}

// ─── Fetch ─────────────────────────────────────────────────
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

// ─── Wait for preloader ────────────────────────────────────
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

// ─── Create a single bubble DOM ────────────────────────────
function createBubble(note, isNewest) {
  const color = note.color && note.color !== "default" ? note.color : null;
  const hasEmoji = !!note.emoji;

  const wrap = document.createElement("div");
  // `.is-entering` holds the pre-reveal hidden state until the pop runs.
  wrap.className =
    "instant-note-bubble is-entering" + (isNewest ? " bubble-newest" : "");

  // Set --bubble-bg on the wrapper so the newest bubble's tail ::after picks it up
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
    emo.textContent = note.emoji;
    wrap.appendChild(emo);
  }

  return wrap;
}

// ─── Wrap a bubble's card to a readable width ──────────────
// Breaks at word boundaries; only hard-breaks a single token wider than target.
function wrapCard(el, maxW) {
  const card = el.querySelector(".bubble-card");
  if (!card) return;
  card.style.maxWidth = maxW + "px";
  card.style.whiteSpace = "normal";
  card.style.wordBreak = "normal";
  card.style.overflowWrap = "break-word";
}
function clearWrap(el) {
  const card = el.querySelector(".bubble-card");
  if (!card) return;
  card.style.maxWidth = "";
  card.style.whiteSpace = "";
  card.style.wordBreak = "";
  card.style.overflowWrap = "";
}

// ─── Build DOM (create elements once) & first layout ───────
function buildDOM(notes, panel) {
  const field = panel.querySelector("#instant-notes-field");
  if (!field) return;
  field.innerHTML = "";

  const bubbleEls = notes.map((n, i) => createBubble(n, i === 0));
  bubbleEls.forEach((b) => {
    b.style.position = "absolute";
    field.appendChild(b);
  });

  panel._notes = notes;
  panel._bubbleEls = bubbleEls;
  panel._hasEmoji = notes.map((n) => !!n.emoji);

  const plan = computeLayout(panel);
  if (!plan) return;
  applyFrame(panel, plan);
  // Position the bubbles silently; they stay hidden via `.is-entering` until
  // revealNotes() runs the staggered pop. Opacity/transform/filter come from
  // the class + animation, so we only set left/top here.
  plan.placed.forEach(({ i, left, top }) => {
    const el = bubbleEls[i];
    el.style.transition = "none";
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });
  panel._plan = plan;
}

// ─── computeLayout: measure + pack (no opacity/animation side effects) ─────
// Returns { W, H, sizes, placed:[{i,left,top}] (clamped), dropped:[i],
//           isCompact, compactWidth } or null.
function computeLayout(panel) {
  const field = panel.querySelector("#instant-notes-field");
  const bubbleEls = panel._bubbleEls;
  const hasEmojiArr = panel._hasEmoji;
  if (!field || !bubbleEls || bubbleEls.length === 0) return null;

  // Measure against the FULL strip width (drop any compact override first).
  panel.classList.remove("is-compact");
  panel.style.width = "";
  panel.style.marginLeft = "";

  const avatarEl = panel.querySelector("#instant-notes-avatar");
  const origPanelTransform = panel.style.transform;
  const origAvatarTransform = avatarEl ? avatarEl.style.transform : "";
  panel.style.transform = "none";
  if (avatarEl) avatarEl.style.transform = "scale(1)";

  // Neutralise each bubble for measurement (visible, unscaled, unwrapped).
  bubbleEls.forEach((b) => {
    b.style.transition = "none";
    b.style.display = "";
    b.style.transform = "none";
    b.style.filter = "none";
    clearWrap(b);
  });

  const panelRect = panel.getBoundingClientRect();
  const W = panelRect.width;
  let avL = 14, avW = 64, avH = 64, avBottomGap = 12;
  if (avatarEl) {
    const ar = avatarEl.getBoundingClientRect();
    avL = ar.left - panelRect.left;
    avW = ar.width;
    avH = ar.height;
    avBottomGap = panelRect.bottom - ar.bottom;
  }
  const avR = avL + avW;
  const aboveRightOffset = Math.round(avW * 0.55);
  const MAX_BUBBLE_W = Math.max(MIN_READABLE_W, Math.min(W * MAX_BUBBLE_FRAC, MAX_BUBBLE_CAP));

  const sizes = new Array(bubbleEls.length);
  const measureAll = () => {
    for (let i = 0; i < bubbleEls.length; i++) {
      const r = bubbleEls[i].getBoundingClientRect();
      sizes[i] = { w: r.width, h: r.height };
    }
  };

  measureAll();
  let wrappedAny = false;
  for (let i = 0; i < bubbleEls.length; i++) {
    if (sizes[i].w > MAX_BUBBLE_W) {
      wrapCard(bubbleEls[i], MAX_BUBBLE_W);
      wrappedAny = true;
    }
  }
  if (wrappedAny) measureAll();

  // Pack older bubbles into compact, equal-spaced lanes pulled down toward the
  // newest (gravity), with bounded jitter for an organic, disordered feel.
  const packAt = (H) => {
    const bandTop = LABEL_PAD + PAD;
    const bandBottom = H - PAD;
    const avT = H - avBottomGap - avH;

    const w0 = sizes[0].w, h0 = sizes[0].h;
    const newestLeft = clamp(avR - AVATAR_OVERLAP, PAD, Math.max(PAD, W - w0 - PAD));
    const newestTop = clamp(avT - h0 - 2, bandTop, Math.max(bandTop, bandBottom - h0));
    const newestRect = { left: newestLeft, top: newestTop, right: newestLeft + w0, bottom: newestTop + h0 };

    const placed = [{ i: 0, left: newestLeft, top: newestTop }];
    const dropped = [];
    if (sizes.length === 1) return { placed, dropped, H };

    let maxBH = 0;
    for (let i = 1; i < sizes.length; i++) maxBH = Math.max(maxBH, sizes[i].h);
    const laneH = maxBH + GAP_Y;
    const laneCount = clamp(Math.floor((bandBottom - bandTop) / laneH), 1, MAX_LANES);

    const blockBottom = bandTop + (laneCount - 1) * laneH + maxBH;
    const desiredBottom = newestRect.top - GAP_Y;
    const gravityShift = clamp(desiredBottom - blockBottom, 0, Math.max(0, bandBottom - blockBottom));

    const besideStartX = newestRect.right + GAP_X;
    const aboveStartX = newestLeft + aboveRightOffset;

    const lanes = [];
    for (let l = 0; l < laneCount; l++) {
      const top = bandTop + l * laneH + gravityShift;
      const aboveNewest = top + maxBH <= newestRect.top + 2;
      let leftStart = aboveNewest ? aboveStartX : besideStartX;
      leftStart += (l % 2) * 10;
      lanes.push({ top, cursor: leftStart });
    }

    for (let i = 1; i < sizes.length; i++) {
      const w = sizes[i].w, h = sizes[i].h;
      let best = -1, bestCur = Infinity;
      for (let l = 0; l < laneCount; l++) {
        if (lanes[l].cursor + w <= W - PAD && lanes[l].cursor < bestCur) {
          bestCur = lanes[l].cursor;
          best = l;
        }
      }
      if (best === -1) { dropped.push(i); continue; }
      const lane = lanes[best];
      const slack = Math.max(0, maxBH - h);
      const jitter = slack > 2 ? Math.floor(Math.random() * Math.min(slack, MAX_JITTER)) : 0;
      placed.push({ i, left: lane.cursor, top: lane.top + jitter });
      lane.cursor += w + GAP_X + (hasEmojiArr[i] ? EMOJI_RIGHT_EXTRA : 0);
    }
    return { placed, dropped, H };
  };

  // Height search: grow within bounds until everything fits.
  let maxBH0 = 0;
  for (let i = 1; i < sizes.length; i++) maxBH0 = Math.max(maxBH0, sizes[i].h);
  const laneH0 = (maxBH0 || sizes[0].h) + GAP_Y;
  const minForAvatar = avBottomGap + avH + LABEL_PAD;
  const baseH = Math.max(minForAvatar, LABEL_PAD + PAD * 2 + 2 * laneH0);
  const maxH = Math.max(baseH, Math.min(260, window.innerHeight * 0.32));
  const step = Math.max(24, laneH0);

  let best = null;
  for (let H = baseH; H <= maxH + 0.5; H += step) {
    const res = packAt(Math.min(H, maxH));
    if (!best || res.dropped.length < best.dropped.length) best = res;
    if (res.dropped.length === 0) break;
  }

  // Fit fallback: shrink still-dropped bubbles to readable min, retry once.
  if (best.dropped.length > 0 && !wrappedAny) {
    best.dropped.forEach((i) => wrapCard(bubbleEls[i], MIN_READABLE_W));
    measureAll();
    const retry = packAt(maxH);
    if (retry.dropped.length < best.dropped.length) best = retry;
  }

  // Restore transforms (positions/height applied by applyFrame + caller).
  panel.style.transform = origPanelTransform;
  if (avatarEl) avatarEl.style.transform = origAvatarTransform;

  // Clamp placements into the panel and resolve compact mode.
  const finalH = best.H;
  const placed = best.placed.map(({ i, left, top }) => {
    const { w, h } = sizes[i];
    const minTop = hasEmojiArr[i] ? EMOJI_TOP_MIN : PAD;
    const tail = i === 0 ? TAIL : 0;
    const L = clamp(left, PAD, Math.max(PAD, W - w - PAD));
    const T = clamp(top, minTop, Math.max(minTop, finalH - h - tail - PAD));
    return { i, left: Math.round(L), top: Math.round(T) };
  });

  let usedRight = 0;
  placed.forEach(({ i, left }) => {
    usedRight = Math.max(usedRight, left + sizes[i].w + (hasEmojiArr[i] ? EMOJI_RIGHT_EXTRA : 0));
  });
  const compactWidth = Math.ceil(usedRight + PAD);
  const isCompact = compactWidth <= COMPACT_RATIO * W;

  return { W, H: best.H, sizes, placed, dropped: best.dropped, isCompact, compactWidth };
}

// ─── applyFrame: panel height + compact mode + show/hide bubbles ───────────
function applyFrame(panel, plan) {
  panel.style.height = `${Math.round(plan.H)}px`;

  const droppedSet = new Set(plan.dropped);
  panel._bubbleEls.forEach((b, i) => {
    b.style.display = droppedSet.has(i) ? "none" : "";
  });

  if (plan.isCompact) {
    panel.classList.add("is-compact");
    panel.style.width = `${plan.compactWidth}px`;
    panel.style.marginLeft = `${-Math.round(plan.compactWidth / 2)}px`;
  } else {
    panel.classList.remove("is-compact");
    panel.style.width = "";
    panel.style.marginLeft = "";
  }
  panel._dynamicH = panel.getBoundingClientRect().height;
}

// ─── Small util ────────────────────────────────────────────
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ─── Reveal animation ──────────────────────────────────────
function revealNotes(panel) {
  // 1. Fade in the frosted-glass panel
  panel.classList.add("notes-visible");

  // 1b. Glide the banner title/subtitle upward so it stays centred above the
  //     revealed panel and isn't covered (smoothed by the .description CSS
  //     transition). Shift scales with the final panel height.
  const banner = document.querySelector(".home-banner-container");
  if (banner && panel._dynamicH) {
    const BASELINE_BAR_H = 56; // height of the plain button row (social pill)
    const shift = clamp(Math.round(Math.max(0, panel._dynamicH - BASELINE_BAR_H) * 0.5), 0, 120);
    banner.style.setProperty("--notes-shift", `${shift}px`);
    banner.classList.add("has-notes");
  }

  // 2. Avatar pop-in
  const avatar = panel.querySelector("#instant-notes-avatar");
  setTimeout(() => avatar?.classList.add("avatar-visible"), 280);

  // 3. Stagger-pop each visible bubble: newest first, then older ones. The pop
  //    animation overrides the `.is-entering` hidden state;
  const bubbles = Array.from(panel.querySelectorAll(".instant-note-bubble"))
    .filter((b) => b.style.display !== "none");
  bubbles.forEach((b, i) => {
    setTimeout(() => {
      b.classList.remove("is-entering");
      b.classList.add("bubble-pop");
      b.addEventListener(
        "animationend",
        () => {
          b.classList.remove("bubble-pop");
          b.style.opacity = "1";
          b.style.transform = "none";
          b.style.filter = "none";
        },
        { once: true },
      );
    }, 420 + i * 140);
  });
}
