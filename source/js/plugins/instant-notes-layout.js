/**
 * Instant Notes – layout engine.
 *
 * COMPACT view: measures + packs bubbles into a gravity-clustered multi-lane strip
 * anchored at the avatar. Switches to centred compact mode when content is sparse.
 *
 * EXPAND view: animates the panel to a fixed overlay and re-flows bubbles into a
 * bottom-aligned chat column with a scrollable field above the pinned newest slot.
 *
 * Admin hooks: expandPanel and collapsePanel call admin functions (reconcile,
 * ensureInput, teardown) via panel._adminHooks — set by the entry module at init
 * time — so this file has no import dependency on the admin module.
 */
import {
  PAD, GAP_X, GAP_Y, LABEL_PAD, TAIL, AVATAR_OVERLAP, EMOJI_TOP_MIN,
  MIN_READABLE_W, MAX_BUBBLE_CAP, MAX_BUBBLE_FRAC, MAX_LANES, MAX_JITTER,
  EMOJI_RIGHT_EXTRA, COMPACT_RATIO, WRAP_QUERY,
  BAND_GAP, EXPAND_GAP_TOP, EXPAND_GAP_SIDE,
  LIST_GAP_Y, LIST_MAX_W, STATUS_LEFT_RESERVE, EMOJI_TOP_EXTRA, EMOJI_W_PAD,
  EXPAND_FILL_RATIO, FRAME_MS, GLIDE, FADE_OUT_MS,
  clamp, prefersReducedMotion,
} from "./instant-notes-utils.js";
import {
  createBubble, wrapCard, clearWrap, bubbleHasEmoji,
  fadeOutBubbles, placeBubble, placeBubbleAnimated, fadeInBubbles,
} from "./instant-notes-bubble.js";

// ════════════════════════════════════════════════════════════
//  COMPACT LAYOUT
// ════════════════════════════════════════════════════════════

// ─── Create DOM elements and run the first layout ─────────
export function buildDOM(notes, panel) {
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
  // revealNotes() runs the staggered pop.
  plan.placed.forEach(({ i, left, top }) => {
    const el = bubbleEls[i];
    el.style.transition = "none";
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });
  panel._plan = plan;
}

// ─── Wrap (mobile) mode detection ─────────────────────────
// In tablet/mobile the panel becomes its own full-width row (order:-1) above
// the scroll+social row. Compact centring must be disabled there.
export function isWrapMode(panel) {
  try {
    if (window.matchMedia(WRAP_QUERY).matches) return true;
  } catch (e) {}
  return getComputedStyle(panel).order === "-1";
}

// ─── computeLayout: measure + pack (no opacity/animation side effects) ────────
// Returns { W, H, sizes, placed:[{i,left,top}], dropped:[i], isCompact, compactWidth }
// or null.
export function computeLayout(panel) {
  const field = panel.querySelector("#instant-notes-field");
  const bubbleEls = panel._bubbleEls;
  const hasEmojiArr = panel._hasEmoji;
  if (!field || !bubbleEls || bubbleEls.length === 0) return null;

  // Measure against the FULL strip width (drop any compact override first).
  panel.classList.remove("is-compact");
  panel.style.width = "";
  panel.style.left = "";
  panel.style.marginLeft = "";

  const avatarEl = panel.querySelector("#instant-notes-avatar");
  const origPanelTransform = panel.style.transform;
  const origAvatarTransform = avatarEl ? avatarEl.style.transform : "";
  panel.style.transform = "none";
  if (avatarEl) avatarEl.style.transform = "scale(1)";

  // Neutralise each bubble for measurement (visible, unscaled, unwrapped).
  // NOTE: never touch `opacity` here — a revealed bubble's visible state lives in
  // its inline `opacity:1`; clearing it would drop it back to the base CSS
  // `opacity:0` and make bubbles vanish on resize.
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
  // No compact mode while wrapped (mobile): the panel stays a full-width row.
  const isCompact = !isWrapMode(panel) && compactWidth <= COMPACT_RATIO * W;

  return { W, H: best.H, sizes, placed, dropped: best.dropped, isCompact, compactWidth };
}

// ─── applyFrame: panel height + compact mode + show/hide bubbles ──────────────
export function applyFrame(panel, plan) {
  panel.style.height = `${Math.round(plan.H)}px`;

  const droppedSet = new Set(plan.dropped);
  panel._bubbleEls.forEach((b, i) => {
    b.style.display = droppedSet.has(i) ? "none" : "";
  });

  if (plan.isCompact) {
    panel.classList.add("is-compact");
    panel.style.width = `${plan.compactWidth}px`;
    const left = computeCompactLeft(panel, plan.compactWidth);
    panel.style.left = `${left}px`;
    panel.style.marginLeft = "0";
  } else {
    panel.classList.remove("is-compact");
    panel.style.width = "";
    panel.style.left = "";
    panel.style.marginLeft = "";
  }
  panel._dynamicH = panel.getBoundingClientRect().height;
}

// Compute the compact panel's left offset (relative to .home-banner-bottom),
// centred in the band between the scroll arrow (left) and social pill (right).
function computeCompactLeft(panel, w) {
  const bar = panel.closest(".home-banner-bottom");
  if (!bar) return Math.round((panel.parentElement?.clientWidth - w) / 2) || 0;
  const barRect = bar.getBoundingClientRect();
  const arrow = bar.querySelector(".home-banner-scroll-to-main");
  const social = bar.querySelector(".social-contacts");

  let leftBound = PAD;
  let rightBound = barRect.width - PAD;
  if (arrow && getComputedStyle(arrow).display !== "none") {
    leftBound = arrow.getBoundingClientRect().right - barRect.left + BAND_GAP;
  }
  if (social && getComputedStyle(social).display !== "none") {
    rightBound = social.getBoundingClientRect().left - barRect.left - BAND_GAP;
  }

  if (rightBound - leftBound < w) {
    return Math.round((barRect.width - w) / 2);
  }
  const bandCenter = (leftBound + rightBound) / 2;
  let left = Math.round(bandCenter - w / 2);
  if (left < leftBound) left = Math.round(leftBound);
  if (left + w > rightBound) left = Math.round(rightBound - w);
  return left;
}

// ─── Title/subtitle up-shift (keeps the heading above the panel) ──────────────
export function updateTitleShift(panel) {
  const banner = document.querySelector(".home-banner-container");
  if (!banner || !panel._dynamicH) return;
  const BASELINE_BAR_H = 56;
  const shift = clamp(Math.round(Math.max(0, panel._dynamicH - BASELINE_BAR_H) * 0.5), 0, 120);
  banner.style.setProperty("--notes-shift", `${shift}px`);
  banner.classList.add("has-notes");
}

// ─── Reveal animation ──────────────────────────────────────
// Order: (1) title/subtitle glide UP → (2) panel fades in → (3) avatar pop →
// (4) staggered bubble pops.
export function revealNotes(panel) {
  updateTitleShift(panel);

  const reduced = prefersReducedMotion();
  const PANEL_DELAY = reduced ? 0 : 280;

  setTimeout(() => panel.classList.add("notes-visible"), PANEL_DELAY);

  const avatar = panel.querySelector("#instant-notes-avatar");
  setTimeout(() => avatar?.classList.add("avatar-visible"), PANEL_DELAY + 260);

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
    }, PANEL_DELAY + 400 + i * 140);
  });

  setTimeout(() => {
    ensureMoreButton(panel);
    evaluateMoreButton(panel);
  }, PANEL_DELAY + 400);
}

// ─── Debounced resize ─────────────────────────────────────────────────────────
export function wireResize(panel) {
  if (panel.dataset.resizeWired) return;
  panel.dataset.resizeWired = "1";
  let t = null;
  const handler = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (panel._animating) return;
      if (panel._expanded) relayoutExpanded(panel, false);
      else relayoutCompact(panel);
    }, 150);
  };
  window.addEventListener("resize", handler, { passive: true });
  panel._resizeHandler = handler;
}

// Re-run the compact layout, cross-fading bubbles to their new spots.
export function relayoutCompact(panel) {
  if (!panel._bubbleEls || panel._bubbleEls.length === 0 || panel._expanded) return;
  const revealed = panel._bubbleEls.filter(
    (b) => b.style.display !== "none" && !b.classList.contains("is-entering"),
  );
  fadeOutBubbles(revealed);

  const run = () => {
    const plan = computeLayout(panel);
    if (!plan) return;
    applyFrame(panel, plan);
    panel._plan = plan;
    const placed = [];
    plan.placed.forEach(({ i, left, top }) => {
      const el = panel._bubbleEls[i];
      if (el.classList.contains("is-entering")) {
        el.style.transition = "none";
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        return;
      }
      placeBubble(el, left, top);
      placed.push(el);
    });
    fadeInBubbles(placed);
    updateTitleShift(panel);
    evaluateMoreButton(panel);
  };

  if (prefersReducedMotion()) run();
  else setTimeout(run, FADE_OUT_MS);
}

// ════════════════════════════════════════════════════════════
//  MORE / LESS BUTTON
// ════════════════════════════════════════════════════════════
export function ensureMoreButton(panel) {
  if (panel._moreBtn) return panel._moreBtn;
  if (getComputedStyle(panel).position === "static") panel.style.position = "relative";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "instant-notes-more-btn is-hidden";
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML =
    '<i class="fa-solid fa-angle-up"></i><span class="more-label">More</span>';
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleExpand(panel);
  });
  panel.appendChild(btn);
  panel._moreBtn = btn;
  return btn;
}

function countVisibleBubbles(panel) {
  if (!panel._bubbleEls) return 0;
  return panel._bubbleEls.filter((b) => b.style.display !== "none").length;
}

export function evaluateMoreButton(panel) {
  const isAdmin = !!panel._isAdmin;
  const plan = panel._plan;
  const overflow = plan ? plan.dropped.length > 0 : false;
  const total = panel._bubbleEls ? panel._bubbleEls.length : 0;
  const hasMore = total > countVisibleBubbles(panel);
  const show = isAdmin || overflow || hasMore;

  if (!show && !panel._expanded) {
    if (panel._moreBtn) panel._moreBtn.classList.add("is-hidden");
    return;
  }
  const btn = ensureMoreButton(panel);
  btn.classList.remove("is-hidden");
}

function setMoreButtonState(panel, expanded) {
  const btn = panel._moreBtn;
  if (!btn) return;
  btn.classList.toggle("is-expanded", expanded);
  btn.setAttribute("aria-expanded", expanded ? "true" : "false");
  btn.innerHTML = expanded
    ? '<i class="fa-solid fa-angle-down"></i><span class="more-label">Less</span>'
    : '<i class="fa-solid fa-angle-up"></i><span class="more-label">More</span>';
}

// ════════════════════════════════════════════════════════════
//  EXPAND / COLLAPSE
// ════════════════════════════════════════════════════════════
function toggleExpand(panel) {
  if (panel._animating) return;
  if (panel._expanded) collapsePanel(panel);
  else expandPanel(panel);
}

async function expandPanel(panel) {
  if (panel._expanded || panel._animating) return;
  panel._animating = true;
  panel._expanded = true;
  setMoreButtonState(panel, true);

  // Admin: pull the full history (active + expired) then add the input bubble.
  // Admin functions are injected via panel._adminHooks at init time to avoid a
  // circular import between this module and the admin module.
  if (panel._isAdmin && panel._adminHooks) {
    panel.classList.add("is-admin-expanded");
    try {
      const all = await panel._adminHooks.fetchAll();
      panel._adminHooks.reconcile(Array.isArray(all) ? all : []);
    } catch (e) {
      console.warn("[InstantNotes] admin fetch failed:", e);
    }
    panel._adminHooks.ensureInput();
  }

  const banner = document.querySelector(".home-banner-container");
  if (banner) banner.classList.add("notes-expanded");
  fadeOutBubbles(panel._bubbleEls.filter((b) => b.style.display !== "none"));

  enterFixed(panel);

  const slot = normalSlot(panel);
  const measured = measureExpandedList(panel, slot.width);
  const finalH = adaptiveExpandHeight(panel, measured);
  const bottom = (panel._placeholder || panel).getBoundingClientRect().bottom;
  animateFrame(panel, { left: slot.left, top: bottom - finalH, width: slot.width, height: finalH }, true);

  positionExpandedList(panel, measured, finalH);
  wireCloseListeners(panel);
  const done = () => {
    fadeInBubbles(measured.order);
    scrollListToBottom(panel);
    panel._animating = false;
  };
  if (prefersReducedMotion()) done();
  else setTimeout(done, FRAME_MS + 30);
}

// maxAvail = normal-bottom → just below the navbar. Use the content's natural
// height, but fill to max once it needs ≥ 80% of the available space.
function adaptiveExpandHeight(panel, measured) {
  const bottom = (panel._placeholder || panel).getBoundingClientRect().bottom;
  const maxAvail = Math.max(160, bottom - (getNavbarBottom() + EXPAND_GAP_TOP));
  const contentNeeded = measured.topPad + measured.stackH + measured.avatarReserve;
  let h = contentNeeded >= EXPAND_FILL_RATIO * maxAvail ? maxAvail : contentNeeded;
  return clamp(h, Math.min(maxAvail, 140), maxAvail);
}

function collapsePanel(panel) {
  if (!panel._expanded || panel._animating) return;
  panel._animating = true;
  panel._expanded = false;
  setMoreButtonState(panel, false);
  unwireCloseListeners(panel);

  const banner = document.querySelector(".home-banner-container");
  if (banner) banner.classList.remove("notes-expanded");

  const reduced = prefersReducedMotion();

  fadeOutBubbles(expandedOrder(panel).filter(Boolean));

  collapseFixed(panel, reduced, () => {
    if (panel.classList.contains("is-admin-expanded")) {
      // Admin teardown (remove input bubble, expired notes, decorations) is
      // handled by the injected hook to keep admin logic out of this module.
      panel._adminHooks?.teardown();
    } else {
      resetFieldExpansion(panel);
    }
    panel.classList.remove("is-expanded");
    ensureBubblesInField(panel);

    const plan = computeLayout(panel);
    if (plan) {
      applyFrame(panel, plan);
      panel._plan = plan;
      const placed = [];
      plan.placed.forEach(({ i, left, top }) => {
        const el = panel._bubbleEls[i];
        el.classList.remove("in-list");
        el.style.width = "";
        placeBubble(el, left, top);
        placed.push(el);
      });
      fadeInBubbles(placed);
    } else {
      panel.style.height = "";
      panel._plan = null;
    }

    updateTitleShift(panel);
    evaluateMoreButton(panel);
    panel._animating = false;
  });
}

// ─── Fixed-positioning FLIP (flex/absolute ↔ fixed overlay) ──────────────────
function enterFixed(panel) {
  const rect = panel.getBoundingClientRect();
  const ph = document.createElement("div");
  ph.className = "instant-notes-placeholder";
  ph.style.width = `${rect.width}px`;
  ph.style.height = `${rect.height}px`;
  ph.style.flex = "0 0 auto";
  if (isWrapMode(panel)) ph.style.order = "-1";
  panel.parentElement.insertBefore(ph, panel);
  panel._placeholder = ph;

  panel.classList.remove("is-compact");
  panel.classList.add("is-expanded");
  panel.style.position = "fixed";
  panel.style.margin = "0";
  panel.style.transition = "none";
  panel.style.zIndex = "40";

  // A banner ancestor with `transform: translateY(0)` is the fixed containing
  // block, not the viewport — probe its viewport origin and offset every
  // placement by it so the panel renders at the correct position.
  panel.style.left = "0px";
  panel.style.top = "0px";
  const cb = panel.getBoundingClientRect();
  panel._cbOffset = { left: cb.left, top: cb.top };

  panel.style.left = `${rect.left - cb.left}px`;
  panel.style.top = `${rect.top - cb.top}px`;
  panel.style.width = `${rect.width}px`;
  panel.style.height = `${rect.height}px`;
  void panel.offsetWidth;
}

// The panel's NORMAL horizontal slot (viewport coords) — never full-bleed.
//   Desktop: middle slot between scroll-arrow and social pill.
//   Mobile/wrap: bar's CONTENT box (inset by padding) so bar padding stays as margin.
function normalSlot(panel) {
  const bar = panel.closest(".home-banner-bottom");
  if (!bar) {
    const r = (panel._placeholder || panel).getBoundingClientRect();
    return { left: r.left, width: r.width };
  }
  const barRect = bar.getBoundingClientRect();
  const cs = getComputedStyle(bar);
  let left = barRect.left + (parseFloat(cs.paddingLeft) || 0);
  let right = barRect.right - (parseFloat(cs.paddingRight) || 0);
  if (!isWrapMode(panel)) {
    const arrow = bar.querySelector(".home-banner-scroll-to-main");
    const social = bar.querySelector(".social-contacts");
    if (arrow && getComputedStyle(arrow).display !== "none")
      left = arrow.getBoundingClientRect().right + EXPAND_GAP_SIDE;
    if (social && getComputedStyle(social).display !== "none")
      right = social.getBoundingClientRect().left - EXPAND_GAP_SIDE;
  }
  return { left, width: Math.max(220, right - left) };
}

// Derive the fixed containing-block origin WITHOUT moving the panel.
function currentCbOffset(panel) {
  const r = panel.getBoundingClientRect();
  return {
    left: r.left - (parseFloat(panel.style.left) || 0),
    top: r.top - (parseFloat(panel.style.top) || 0),
  };
}

// Apply a fixed-frame rect to the panel (optionally animated).
// dur/delay allow callers to sync the panel resize with card-level expansion.
export function animateFrame(panel, t, animate, dur = FRAME_MS, delay = 0) {
  const off = panel._cbOffset || { left: 0, top: 0 };
  const reduced = prefersReducedMotion();
  const d = delay ? ` ${delay}ms` : "";
  panel.style.transition = animate && !reduced
    ? `left ${dur}ms ${GLIDE}${d}, top ${dur}ms ${GLIDE}${d}, width ${dur}ms ${GLIDE}${d}, height ${dur}ms ${GLIDE}${d}`
    : "none";
  panel.style.left = `${Math.round(t.left - off.left)}px`;
  panel.style.top = `${Math.round(t.top - off.top)}px`;
  panel.style.width = `${Math.round(t.width)}px`;
  panel.style.height = `${Math.round(t.height)}px`;
  panel._expandedRect = { left: t.left, top: t.top, width: t.width, height: t.height };
}

function collapseFixed(panel, reduced, done) {
  const ph = panel._placeholder;
  const off = panel._cbOffset || { left: 0, top: 0 };
  const target = ph ? ph.getBoundingClientRect() : panel.getBoundingClientRect();
  panel.style.transition = reduced
    ? "none"
    : `left ${FRAME_MS}ms ${GLIDE}, top ${FRAME_MS}ms ${GLIDE}, width ${FRAME_MS}ms ${GLIDE}, height ${FRAME_MS}ms ${GLIDE}`;
  panel.style.left = `${target.left - off.left}px`;
  panel.style.top = `${target.top - off.top}px`;
  panel.style.width = `${target.width}px`;
  panel.style.height = `${target.height}px`;

  const finish = () => {
    panel.style.transition = "";
    panel.style.position = "";
    panel.style.margin = "";
    panel.style.left = "";
    panel.style.top = "";
    panel.style.width = "";
    panel.style.height = "";
    panel.style.zIndex = "";
    if (ph && ph.parentElement) ph.parentElement.removeChild(ph);
    panel._placeholder = null;
    panel._expandedRect = null;
    panel._cbOffset = null;
    done && done();
  };

  if (reduced) { finish(); return; }
  let called = false;
  const onEnd = (e) => {
    if (e.target !== panel || e.propertyName !== "height") return;
    if (called) return;
    called = true;
    panel.removeEventListener("transitionend", onEnd);
    finish();
  };
  panel.addEventListener("transitionend", onEnd);
  setTimeout(() => {
    if (!called) { called = true; panel.removeEventListener("transitionend", onEnd); finish(); }
  }, FRAME_MS + 120);
}

function getNavbarBottom() {
  const nav =
    document.querySelector(".navbar-content") ||
    document.querySelector(".navbar-container");
  if (nav) {
    const r = nav.getBoundingClientRect();
    if (r.height > 0) return r.bottom;
  }
  return 70; // $navbar-height fallback
}

// ════════════════════════════════════════════════════════════
//  EXPANDED CHAT-LIST LAYOUT
// ════════════════════════════════════════════════════════════
// Left-aligned column: newest at bottom (avatar's top-right), older stacked up.
// Scrolls to the bottom when it overflows.

// Avatar geometry relative to the panel.
function avatarMetrics(panel) {
  const avatarEl = panel.querySelector("#instant-notes-avatar");
  let avW = 56, avH = 56, avL = 14;
  if (avatarEl) {
    const ar = avatarEl.getBoundingClientRect();
    avW = ar.width;
    avH = ar.height;
    avL = avatarEl.offsetLeft || avL;
  }
  let avBottomGap = 12;
  try { if (window.matchMedia("(max-width: 520px)").matches) avBottomGap = 10; } catch (e) {}
  return { avL, avW, avH, avBottomGap, avR: avL + avW };
}

// Measure the list at a given (normal) width. Sets each bubble's list width
// and reads its reflowed height — does NOT position or change opacity.
export function measureExpandedList(panel, slotWidth) {
  const field = panel.querySelector("#instant-notes-field");
  const am = avatarMetrics(panel);

  const topPad = LABEL_PAD + PAD;
  const avatarReserve = am.avBottomGap + am.avH - AVATAR_OVERLAP;
  const rightGutter = panel._isAdmin ? 76 : PAD;
  // Admin bubbles wear an active/expired badge to their LEFT. Reserve a left
  // gutter so the badge stays on-panel on narrow viewports.
  const leftGutter = panel._isAdmin ? STATUS_LEFT_RESERVE : PAD;
  const leftEdge = clamp(
    Math.round(am.avR - AVATAR_OVERLAP),
    leftGutter,
    slotWidth - MIN_READABLE_W - rightGutter,
  );
  const maxW = Math.max(MIN_READABLE_W, Math.min(LIST_MAX_W, slotWidth - leftEdge - rightGutter));

  const order = expandedOrder(panel);
  const widths = order.map((el) =>
    Math.round(bubbleHasEmoji(el) ? Math.max(MIN_READABLE_W, maxW - EMOJI_W_PAD) : maxW),
  );
  order.forEach((el, i) => {
    el.style.transition = "none";
    el.style.display = "";
    el.classList.add("in-list");
    if (el.classList.contains("instant-notes-input-bubble")) el.style.width = `${widths[i]}px`;
    else wrapCard(el, widths[i]);
  });
  if (field) void field.offsetWidth;
  const heights = order.map((el) => el.getBoundingClientRect().height);

  let stackH = 0;
  heights.forEach((h, i) => {
    stackH += h;
    if (i > 0) stackH += LIST_GAP_Y;
    if (bubbleHasEmoji(order[i])) stackH += EMOJI_TOP_EXTRA;
  });

  return { order, heights, widths, leftEdge, topPad, avatarReserve, stackH };
}

// Position the measured list inside a panel of height innerH. The BOTTOM slot
// (newest / admin input) is PINNED as a panel child above the avatar (so it
// never scrolls); the OLDER bubbles live in the field scroll region above it.
// animDur/animDelay are forwarded to placeBubbleAnimated for sync with card expansion.
export function positionExpandedList(panel, m, innerH, smooth, animDur = FRAME_MS, animDelay = 0) {
  const field = panel.querySelector("#instant-notes-field");
  if (!field) return;
  const place = smooth
    ? (el, l, t, w) => placeBubbleAnimated(el, l, t, w, animDur, animDelay)
    : placeBubble;
  const order = m.order;
  const am = avatarMetrics(panel);
  const avatarTop = innerH - am.avBottomGap - am.avH;

  // ── Pinned bottom slot (newest note, or admin input) ──────────────────────
  const pinnedEl = order[0];
  const pinnedBottom = avatarTop - 2;
  const pinnedTop = Math.round(pinnedBottom - m.heights[0]);
  if (pinnedEl.parentElement !== panel) panel.appendChild(pinnedEl);
  pinnedEl.classList.add("is-pinned");
  pinnedEl.style.zIndex = "16";
  place(pinnedEl, m.leftEdge, pinnedTop, m.widths[0]);

  // ── Scroll region (older bubbles) above the pinned slot ───────────────────
  const older = order.slice(1);
  const olderH = m.heights.slice(1);
  const olderW = m.widths.slice(1);

  const fieldTop = LABEL_PAD;
  const pinnedClear = bubbleHasEmoji(pinnedEl) ? EMOJI_TOP_EXTRA : 0;
  const fieldBottom = Math.max(PAD, Math.round(innerH - (pinnedTop - pinnedClear) + LIST_GAP_Y));
  field.style.top = `${fieldTop}px`;
  field.style.bottom = `${fieldBottom}px`;
  const viewportH = Math.max(40, innerH - fieldTop - fieldBottom);

  older.forEach((el) => {
    el.classList.remove("is-pinned");
    el.style.zIndex = "";
    if (el.parentElement !== field) field.appendChild(el);
  });

  let stackH = 0;
  olderH.forEach((h, i) => {
    stackH += h;
    if (i > 0) stackH += LIST_GAP_Y;
    if (bubbleHasEmoji(older[i])) stackH += EMOJI_TOP_EXTRA;
  });
  const fits = stackH <= viewportH - PAD * 2;
  const contentH = fits ? viewportH : Math.ceil(stackH + PAD * 2);

  let spacer = field.querySelector(".instant-notes-scroll-spacer");
  if (!spacer) {
    spacer = document.createElement("div");
    spacer.className = "instant-notes-scroll-spacer";
    field.appendChild(spacer);
  }
  spacer.style.height = `${contentH}px`;
  // Admin: keep overflow auto (paired with `scrollbar-gutter: stable` in CSS) so
  // an inline-edit that overflows mid-animation never shifts content width.
  field.style.overflowY = (panel._isAdmin || !fits) ? "auto" : "hidden";
  field.classList.toggle("has-scroll", !fits);

  // Older bubbles bottom-aligned (most recent just under the pinned slot).
  let cursorBottom = contentH - PAD;
  older.forEach((el, i) => {
    const top = Math.round(cursorBottom - olderH[i]);
    cursorBottom = top - LIST_GAP_Y - (bubbleHasEmoji(el) ? EMOJI_TOP_EXTRA : 0);
    el.style.display = "";
    place(el, m.leftEdge, top, olderW[i]);
    el.dataset.fresh = "";
  });

  // Hide any bubble not part of the expanded order (safety).
  panel._bubbleEls.forEach((el) => {
    if (!order.includes(el)) el.style.display = "none";
  });

  panel._listContentH = contentH;
  panel._listFits = fits;
  wireFieldScroll(panel);
  updateScrollFade(panel);
}

// Move every bubble back into the field (used on collapse before compact layout).
export function ensureBubblesInField(panel) {
  const field = panel.querySelector("#instant-notes-field");
  if (!field) return;
  (panel._bubbleEls || []).forEach((el) => {
    el.classList.remove("is-pinned");
    el.style.zIndex = "";
    if (el.parentElement !== field) field.appendChild(el);
  });
}

// Re-fit the expanded panel (resize, or after an admin write). Cross-fades.
export function relayoutExpanded(panel, animateFrameFlag) {
  fadeOutBubbles(expandedOrder(panel).filter(Boolean));
  const run = () => {
    panel._cbOffset = currentCbOffset(panel);
    const slot = normalSlot(panel);
    const measured = measureExpandedList(panel, slot.width);
    const finalH = adaptiveExpandHeight(panel, measured);
    const bottom = (panel._placeholder || panel).getBoundingClientRect().bottom;
    animateFrame(panel, { left: slot.left, top: bottom - finalH, width: slot.width, height: finalH }, !!animateFrameFlag);
    positionExpandedList(panel, measured, finalH);
    fadeInBubbles(measured.order);
    scrollListToBottom(panel);
  };
  if (prefersReducedMotion()) run();
  else setTimeout(run, FADE_OUT_MS);
}

// Re-fit the expanded list WITHOUT a cross-fade: bubbles GLIDE to their new
// positions. Used for admin inline-edit start/cancel, preserving scroll position.
// animDur/animDelay are forwarded so callers can sync neighbour motion with card expansion.
export function relayoutExpandedReflow(panel, animDur = FRAME_MS, animDelay = 0) {
  if (!panel._expanded) return;
  const field = panel.querySelector("#instant-notes-field");
  const oldContentH = panel._listContentH || 0;
  const prevScroll = field ? field.scrollTop : 0;

  panel._cbOffset = currentCbOffset(panel);
  const slot = normalSlot(panel);
  const measured = measureExpandedList(panel, slot.width);
  const finalH = adaptiveExpandHeight(panel, measured);
  const bottom = (panel._placeholder || panel).getBoundingClientRect().bottom;
  // Snap the panel frame instantly (not animated) to avoid continuous viewport-height
  // changes that drift the scroll range while neighbour bubbles animate via FLIP.
  animateFrame(panel, { left: slot.left, top: bottom - finalH, width: slot.width, height: finalH }, false);
  positionExpandedList(panel, measured, finalH, true, animDur, animDelay);

  if (field) {
    // Content is bottom-aligned in the spacer: when it grows by Δ everything
    // shifts down by Δ in scroll coords, so scroll down by Δ to hold the view.
    const newContentH = panel._listContentH || 0;
    field.scrollTop = Math.max(0, prevScroll + (newContentH - oldContentH));
    updateScrollFade(panel);
  }
}

// Build the bottom→top element order for the expanded list.
export function expandedOrder(panel) {
  const bubbles = (panel._bubbleEls || []).slice();
  if (panel._isAdmin && panel._inputBubble) {
    return [panel._inputBubble].concat(bubbles);
  }
  return bubbles;
}

function scrollListToBottom(panel) {
  const field = panel.querySelector("#instant-notes-field");
  if (!field) return;
  field.scrollTop = field.scrollHeight;
  updateScrollFade(panel);
}

// The expanded field carries a top fade (under the label) and — when it
// overflows — a BOTTOM fade hinting "more above". Toggle `at-bottom` (CSS then
// drops the bottom fade) whenever scroll reaches the end.
function updateScrollFade(panel) {
  const field = panel.querySelector("#instant-notes-field");
  if (!field) return;
  if (!field.classList.contains("has-scroll")) {
    field.classList.remove("at-bottom");
    return;
  }
  const atBottom = field.scrollHeight - field.scrollTop - field.clientHeight <= 1;
  field.classList.toggle("at-bottom", atBottom);
}

function wireFieldScroll(panel) {
  const field = panel.querySelector("#instant-notes-field");
  if (!field || field._scrollFadeWired) return;
  field._scrollFadeWired = true;
  field.addEventListener("scroll", () => updateScrollFade(panel), { passive: true });
}

// ─── Close affordances (Less / Esc / outside click) ──────────────────────────
function wireCloseListeners(panel) {
  if (panel._closeWired) return;
  panel._closeWired = true;
  panel._onKey = (e) => { if (e.key === "Escape") collapsePanel(panel); };
  panel._onDocClick = (e) => {
    if (!panel._expanded) return;
    if (panel.contains(e.target)) return;
    if (panel._moreBtn && panel._moreBtn.contains(e.target)) return;
    collapsePanel(panel);
  };
  document.addEventListener("keydown", panel._onKey);
  setTimeout(() => document.addEventListener("click", panel._onDocClick), 0);
}
function unwireCloseListeners(panel) {
  if (!panel._closeWired) return;
  panel._closeWired = false;
  document.removeEventListener("keydown", panel._onKey);
  document.removeEventListener("click", panel._onDocClick);
}

// ─── Field expansion state cleanup ───────────────────────────────────────────
// Clears the expanded scroll-list state from the field (spacer + inline styles).
// Also used by teardownAdminExpanded in the admin module via import.
export function resetFieldExpansion(panel) {
  const field = panel.querySelector("#instant-notes-field");
  if (!field) return;
  const spacer = field.querySelector(".instant-notes-scroll-spacer");
  if (spacer) spacer.remove();
  field.classList.remove("has-scroll");
  field.classList.remove("at-bottom");
  field.style.overflowY = "";
  field.style.top = "";
  field.style.bottom = "";
}
