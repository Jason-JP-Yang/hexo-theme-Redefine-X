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
  FRAME_MS, GLIDE, FADE_OUT_MS, MIN_PANEL_W,
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
  // Floor the compact width at MIN_PANEL_W so the panel keeps a consistent minimum
  // footprint (matched by the normal + expanded slots); never exceed the available
  // strip width W on very narrow viewports. (Problem 3.)
  const compactWidth = clamp(Math.ceil(usedRight + PAD), Math.min(MIN_PANEL_W, W), W);
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

// Admin + no active notes → show the compose card where the newest bubble would sit
// (just above the avatar) instead of an empty panel. It is the SAME input bubble
// used in expand, positioned at the pinned slot's viewport location, so More keeps
// it visually in place while history fades in above it. (Problem 1.)
export function layoutCompactCompose(panel, opts = {}) {
  const field = panel.querySelector("#instant-notes-field");
  const avatarEl = panel.querySelector("#instant-notes-avatar");
  if (!field || !panel._adminHooks) return;
  const input = panel._adminHooks.ensureInput();
  if (!input) return;
  if (!panel._bubbleEls) panel._bubbleEls = [];

  panel._composeCompact = true;
  panel.classList.add("notes-visible");
  panel.classList.remove("is-expanded", "is-admin-expanded", "notes-elevated");
  if (avatarEl) avatarEl.classList.add("avatar-visible");

  // Measure at the full strip width (drop any compact override + scroll state).
  panel.classList.remove("is-compact");
  panel.style.width = "";
  panel.style.left = "";
  panel.style.marginLeft = "";
  resetFieldExpansion(panel);

  // Make the compose card a measurable field child at its natural size.
  if (input.parentElement !== field) field.appendChild(input);
  input.classList.remove("is-pinned");
  input.style.zIndex = "16";
  input.style.position = "absolute";
  input.style.display = "";
  input.style.opacity = "1";
  input.style.filter = "none";
  input.style.transition = "none";
  input.style.transform = "none";
  input.style.width = "";

  void field.offsetWidth;
  const cardRect = input.getBoundingClientRect();
  const composeH = cardRect.height;
  let composeW = cardRect.width;

  const panelRect = panel.getBoundingClientRect();
  const W = panelRect.width;
  let avW = 64, avH = 64, avL = 14, avBottomGap = 12;
  if (avatarEl) {
    const ar = avatarEl.getBoundingClientRect();
    avW = ar.width; avH = ar.height;
    avL = ar.left - panelRect.left;
    avBottomGap = panelRect.bottom - ar.bottom;
  }
  const avR = avL + avW;
  const bandTop = LABEL_PAD + PAD;

  const composeLeft = clamp(
    Math.round(avR - AVATAR_OVERLAP), PAD, Math.max(PAD, W - PAD - MIN_READABLE_W),
  );
  const maxW = Math.max(MIN_READABLE_W, W - composeLeft - PAD);
  if (composeW > maxW) { input.style.width = `${Math.round(maxW)}px`; composeW = maxW; }

  // Frame: compose card stacked just above the avatar (newest-bubble slot).
  const H = Math.round(bandTop + composeH + 2 + avBottomGap + avH);
  const composeTop = bandTop;
  const composeRight = composeLeft + composeW;

  const compactWidth = clamp(Math.ceil(composeRight + PAD), Math.min(MIN_PANEL_W, W), W);
  const isCompact = !isWrapMode(panel) && compactWidth <= COMPACT_RATIO * W;
  applyFrame(panel, { W, H, sizes: [], placed: [], dropped: [], isCompact, compactWidth });
  panel._plan = null;

  input.style.left = `${composeLeft}px`;
  input.style.top = `${composeTop}px`;

  ensureMoreButton(panel);
  evaluateMoreButton(panel);
  updateTitleShift(panel);

  if (opts.reveal) fadeInBubbles([input]);
}

// Rebuild the COMPACT layout for a fresh set of active notes and fade them in (used
// right after a compose-mode post, once the compose card has faded out). Expand/
// collapse/reveal all share the SAME simple cross-fade — no pop/cascade animation. (P1.1, P2.)
export function rebuildCompactWithFade(panel, notes) {
  panel._composeCompact = false;
  buildDOM(notes, panel);
  fadeInBubbles((panel._bubbleEls || []).filter((b) => b.style.display !== "none"));
  ensureMoreButton(panel);
  evaluateMoreButton(panel);
  updateTitleShift(panel);
}

// ─── Debounced resize ─────────────────────────────────────────────────────────
export function wireResize(panel) {
  if (panel.dataset.resizeWired) return;
  panel.dataset.resizeWired = "1";
  panel._lastWinW = window.innerWidth;
  let t = null;
  const handler = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (panel._animating) return;
      // Reflow ONLY when the window WIDTH changes. Height-only resizes leave every
      // bubble exactly where it is (no scroll/position disruption). (Problem 2.)
      const w = window.innerWidth;
      if (w === panel._lastWinW) return;
      panel._lastWinW = w;
      if (panel._expanded) relayoutExpanded(panel, false);
      else if (panel._composeCompact) layoutCompactCompose(panel);
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
  btn.classList.remove("is-loading");
  btn.removeAttribute("aria-busy");
  btn.classList.toggle("is-expanded", expanded);
  btn.setAttribute("aria-expanded", expanded ? "true" : "false");
  btn.innerHTML = expanded
    ? '<i class="fa-solid fa-angle-down"></i><span class="more-label">Less</span>'
    : '<i class="fa-solid fa-angle-up"></i><span class="more-label">More</span>';
}

// Transitional state shown the instant More is pressed: the panel keeps the
// compact view while the (admin) history loads. JS swaps to "Less" only right
// before the expand transition begins, so the label never claims "Less" while the
// panel is still visually compact. (Problem 3.)
function setMoreButtonLoading(panel) {
  const btn = panel._moreBtn;
  if (!btn) return;
  btn.classList.add("is-loading");
  btn.setAttribute("aria-busy", "true");
  btn.setAttribute("aria-expanded", "true");
  btn.innerHTML =
    '<i class="fa-solid fa-circle-notch fa-spin"></i><span class="more-label">Loading…</span>';
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
  // Button shows "Loading…" (not "Less") and timestamps fade out the moment the
  // expand starts; the timestamps stay hidden until the collapse transition fully
  // ends. (Problems 1 + 3.)
  setMoreButtonLoading(panel);
  panel.classList.add("notes-time-hidden");

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
  const composeMode = !!panel._composeCompact;
  // Capture the compose card's COMPACT width NOW — before enterOverlay/measure
  // overwrite it with the expanded width. It is the START of the card's width
  // transition; captured any later it would already equal the end (→ no glide). (Problem 2.)
  const composeStartW = composeMode && panel._inputBubble
    ? panel._inputBubble.getBoundingClientRect().width : 0;
  // Active bubbles cross-fade out (reflow is allowed here). In compose mode there
  // are none — the compose card stays put and history fades in instead. (Problem 1.)
  if (!composeMode) {
    fadeOutBubbles((panel._bubbleEls || []).filter((b) => b.style.display !== "none"));
  }

  enterOverlay(panel);

  const geom = bannerExpandGeom(panel);
  const measured = measureExpandedList(panel, geom.width);
  const finalH = expandedHeight(measured, geom.maxHeight);
  const frame = { left: geom.left, top: geom.bottomInContainer - finalH, width: geom.width, height: finalH };
  // Loading is done — swap "Loading…" → "Less" exactly as the expand transition is armed. (Problem 3.)
  setMoreButtonState(panel, true);

  if (composeMode) {
    // ── Compose expand: the compose card rides with the (stationary) avatar via an
    // analytic transform (no reflow); history simply fades in once the frame has
    // grown — the SAME plain cross-fade every expand path uses. (Problem 1.2, 2.)
    panel._composeCompact = false;
    const input = panel._inputBubble;
    const compactH = panel._placeholder
      ? panel._placeholder.getBoundingClientRect().height : finalH;
    const r0w = composeStartW; // the card's compact width, captured before measurement

    positionExpandedList(panel, measured, finalH); // panel still compact-height here
    const history = measured.order.filter((el) => el !== input);
    history.forEach((el) => { el.style.transition = "none"; el.style.opacity = "0"; });

    if (input && !prefersReducedMotion()) {
      const w1 = input.offsetWidth; // list width set by positionExpandedList
      // Bottom edge is fixed and the avatar doesn't move vertically as the panel
      // grows upward; a transform that exactly cancels the height change keeps the
      // top-anchored compose card pinned beside the avatar. (Problem 1.2.)
      input.style.transition = "none";
      input.style.transform = `translateY(${-(finalH - compactH)}px)`;
      input.style.width = `${r0w}px`;
      void input.offsetWidth;
      animateFrame(panel, frame, true);
      panel.classList.add("notes-elevated");
      input.style.transition = `transform ${FRAME_MS}ms ${GLIDE}, width ${FRAME_MS}ms ${GLIDE}`;
      input.style.transform = "none";
      input.style.width = `${w1}px`;
    } else {
      animateFrame(panel, frame, true);
      panel.classList.add("notes-elevated");
      if (input) input.style.opacity = "1";
    }
    wireCloseListeners(panel);

    const done = () => {
      scrollListToBottom(panel);
      // Simple fade-in — no pop/cascade — same as every other expand path. (Problem 2.)
      fadeInBubbles(history);
      panel.classList.remove("notes-time-hidden");
      panel._animating = false;
    };
    if (prefersReducedMotion()) done();
    else setTimeout(done, FRAME_MS + 30);
    return;
  }

  animateFrame(panel, frame, true);
  // Arm the elevated glass AFTER the frame transition is set so background +
  // box-shadow animate together with the resize. (Problem 2.)
  panel.classList.add("notes-elevated");

  positionExpandedList(panel, measured, finalH);
  wireCloseListeners(panel);
  const done = () => {
    fadeInBubbles(measured.order);
    scrollListToBottom(panel);
    // Expand transition finished — fade the timestamps back in (they are visible in
    // the settled expanded state; only the transition itself hides them). (Problem 1.)
    panel.classList.remove("notes-time-hidden");
    panel._animating = false;
  };
  if (prefersReducedMotion()) done();
  else setTimeout(done, FRAME_MS + 30);
}

function collapsePanel(panel) {
  if (!panel._expanded || panel._animating) return;
  panel._animating = true;
  panel._expanded = false;
  setMoreButtonState(panel, false);
  // Fade the timestamps out as the collapse transition starts; they fade back in
  // once it fully ends (see the done callback below). (Problem 1.)
  panel.classList.add("notes-time-hidden");
  unwireCloseListeners(panel);

  const banner = document.querySelector(".home-banner-container");
  if (banner) banner.classList.remove("notes-expanded");

  const reduced = prefersReducedMotion();

  // If the compact view will be empty (admin, no active notes) collapse back to the
  // compose-only state: history simply fades out (same plain cross-fade as every
  // other collapse) and the compose card rides the shrinking frame, staying beside
  // the avatar. (Problem 1.3, 2.)
  const willBeEmpty = !!panel._isAdmin &&
    (panel._bubbleEls || []).filter((b) => b._active).length === 0;
  if (willBeEmpty) {
    const input = panel._inputBubble;
    const history = expandedOrder(panel).filter((el) => el && el !== input);
    const compactH = panel._placeholder ? panel._placeholder.getBoundingClientRect().height : 0;
    const fH = panel._expandedRect ? panel._expandedRect.height : panel.getBoundingClientRect().height;
    fadeOutBubbles(history);
    collapseOverlay(panel, reduced, () => {
      panel._adminHooks?.teardownToCompose();   // drop history, KEEP the input
      panel.classList.remove("is-expanded");
      layoutCompactCompose(panel);              // settle the compose-only compact state
      panel.classList.remove("notes-time-hidden");
      panel._animating = false;
    });
    if (input && !reduced) {
      // Cancel the frame-height change so the compose card stays beside the avatar;
      // narrow it to natural width up front so it never overflows the shrinking panel.
      input.style.width = "";
      input.style.transition = `transform ${FRAME_MS}ms ${GLIDE}`;
      void input.offsetWidth;
      input.style.transform = `translateY(${-(fH - compactH)}px)`;
    }
    return;
  }

  fadeOutBubbles(expandedOrder(panel).filter(Boolean));

  collapseOverlay(panel, reduced, () => {
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

    // Collapse transition is fully done and bubbles are re-placed + fading in —
    // now fade the timestamps back in. (Problem 1.)
    panel.classList.remove("notes-time-hidden");
    updateTitleShift(panel);
    evaluateMoreButton(panel);
    panel._animating = false;
  });
}

// ─── Banner-anchored overlay (flex slot ↔ absolute overlay in the banner) ─────
// The expanded panel is an ABSOLUTE child of `.home-banner-container` — a stable
// box (min-height:100svh) that scrolls WITH the page. All geometry is derived from
// that container's box and from scroll-invariant rect DIFFERENCES, never from live
// viewport quantities (window.innerHeight, the navbar's viewport rect, …). So
// scrolling, the mobile URL bar, the on-screen keyboard, or devtools resizing the
// viewport never move or reshape the panel: its size is a pure function of the
// banner box and its own content. (Banner-anchored expand rewrite.)
function enterOverlay(panel) {
  const rect = panel.getBoundingClientRect();
  const container = panel.closest(".home-banner-container");
  const cRect = container.getBoundingClientRect();

  // Placeholder holds the panel's flex slot in the bottom bar so the arrow/social
  // don't reflow while the panel is lifted out.
  const ph = document.createElement("div");
  ph.className = "instant-notes-placeholder";
  ph.style.width = `${rect.width}px`;
  ph.style.height = `${rect.height}px`;
  ph.style.flex = "0 0 auto";
  if (isWrapMode(panel)) ph.style.order = "-1";
  panel.parentElement.insertBefore(ph, panel);
  panel._placeholder = ph;
  panel._container = container;

  panel.classList.remove("is-compact");
  panel.classList.add("is-expanded");
  // Lift the panel out of the bar's flex row into the banner container, positioned
  // absolutely in the CONTAINER's own coordinate space (container is position:relative).
  container.appendChild(panel);
  panel.style.position = "absolute";
  panel.style.margin = "0";
  panel.style.transition = "none";
  panel.style.zIndex = "40";
  panel.style.left = `${rect.left - cRect.left}px`;
  panel.style.top = `${rect.top - cRect.top}px`;
  panel.style.width = `${rect.width}px`;
  panel.style.height = `${rect.height}px`;
  void panel.offsetWidth;
}

// Stable navbar height — the LAYOUT height (offsetHeight), not a viewport rect
// whose `.bottom` shifts as the page scrolls under a fixed navbar.
function navbarHeight() {
  const nav =
    document.querySelector(".navbar-content") ||
    document.querySelector(".navbar-container");
  if (nav && nav.offsetHeight > 0) return nav.offsetHeight;
  return 70; // $navbar-height fallback
}

// The expanded frame, expressed ENTIRELY in the banner container's coordinate
// space and from scroll-invariant rect DIFFERENCES:
//   • left / width      — the band between the scroll-arrow and the social pill
//                         (or, in wrap/mobile mode, the bottom bar's content box).
//   • bottomInContainer — the collapsed panel's bottom edge; the panel grows UP.
//   • maxHeight         — from that bottom up to just below the (fixed) navbar.
// Cached on the panel as _bannerGeom so every later reflow reuses the identical
// band + bottom anchor + cap, and only the content-driven height ever moves. (Problem 3.)
function bannerExpandGeom(panel) {
  const container = panel._container || panel.closest(".home-banner-container");
  const cRect = container.getBoundingClientRect();
  const ph = panel._placeholder;
  const phRect = (ph || panel).getBoundingClientRect();
  const bar = ph ? ph.parentElement : panel.closest(".home-banner-bottom");

  let left = phRect.left - cRect.left;
  let right = phRect.right - cRect.left;
  if (bar && !isWrapMode(panel)) {
    const arrow = bar.querySelector(".home-banner-scroll-to-main");
    const social = bar.querySelector(".social-contacts");
    if (arrow && getComputedStyle(arrow).display !== "none")
      left = arrow.getBoundingClientRect().right - cRect.left + EXPAND_GAP_SIDE;
    if (social && getComputedStyle(social).display !== "none")
      right = social.getBoundingClientRect().left - cRect.left - EXPAND_GAP_SIDE;
  } else if (bar) {
    const barRect = bar.getBoundingClientRect();
    const cs = getComputedStyle(bar);
    left = barRect.left - cRect.left + (parseFloat(cs.paddingLeft) || 0);
    right = barRect.right - cRect.left - (parseFloat(cs.paddingRight) || 0);
  }

  const bottomInContainer = phRect.bottom - cRect.top;
  // The container's TOP in page coords is scroll-invariant; the fixed navbar sits at
  // page top. So the highest the panel top may reach, in container coords, is the
  // navbar's bottom minus the container's page offset. All constants / stable.
  const cTopPage = cRect.top + window.scrollY;
  const topBound = navbarHeight() + EXPAND_GAP_TOP - cTopPage;
  const maxHeight = Math.max(160, bottomInContainer - topBound);

  const geom = { left, width: Math.max(220, right - left), bottomInContainer, maxHeight };
  panel._bannerGeom = geom;
  return geom;
}

// Content-adaptive expanded height: exactly as tall as the list needs, capped by
// the banner region. NO "fill to available" threshold — so when the compose input
// grows by Δ the panel grows by exactly Δ, the scroll viewport
// (panelH − fieldTop − fieldBottom) is invariant, and the older bubbles do not
// move at all. This is the root fix for the gap-jump-on-typing bug. (Problem 3.)
function expandedHeight(measured, maxHeight) {
  const contentNeeded =
    measured.fieldTop + Math.ceil(measured.stackHOlder + PAD * 2) + measured.fieldBottom;
  return clamp(Math.round(contentNeeded), Math.min(maxHeight, 140), maxHeight);
}

// Apply an absolute (container-coords) frame to the panel, optionally animated.
// dur/delay allow callers to sync the panel resize with card-level expansion.
export function animateFrame(panel, t, animate, dur = FRAME_MS, delay = 0) {
  const reduced = prefersReducedMotion();
  const d = delay ? ` ${delay}ms` : "";
  // Background + box-shadow ride the same transition so the `notes-elevated`
  // glass (toggled right after this call on expand) morphs IN SYNC with the frame
  // resize instead of popping. (Problem 2.)
  panel.style.transition = animate && !reduced
    ? `left ${dur}ms ${GLIDE}${d}, top ${dur}ms ${GLIDE}${d}, width ${dur}ms ${GLIDE}${d}, height ${dur}ms ${GLIDE}${d}, background ${dur}ms ${GLIDE}${d}, box-shadow ${dur}ms ${GLIDE}${d}`
    : "none";
  panel.style.left = `${Math.round(t.left)}px`;
  panel.style.top = `${Math.round(t.top)}px`;
  panel.style.width = `${Math.round(t.width)}px`;
  panel.style.height = `${Math.round(t.height)}px`;
  panel._expandedRect = { left: t.left, top: t.top, width: t.width, height: t.height };
}

function collapseOverlay(panel, reduced, done) {
  const ph = panel._placeholder;
  const container = panel._container;
  const cRect = container ? container.getBoundingClientRect() : { left: 0, top: 0 };
  const phRect = ph ? ph.getBoundingClientRect() : panel.getBoundingClientRect();
  const target = {
    left: phRect.left - cRect.left,
    top: phRect.top - cRect.top,
    width: phRect.width,
    height: phRect.height,
  };
  panel.style.transition = reduced
    ? "none"
    : `left ${FRAME_MS}ms ${GLIDE}, top ${FRAME_MS}ms ${GLIDE}, width ${FRAME_MS}ms ${GLIDE}, height ${FRAME_MS}ms ${GLIDE}, background ${FRAME_MS}ms ${GLIDE}, box-shadow ${FRAME_MS}ms ${GLIDE}`;
  // Drop the elevated glass under the same transition so it fades back to the
  // compact panel style while the frame shrinks. (Problem 2.)
  panel.classList.remove("notes-elevated");
  panel.style.left = `${target.left}px`;
  panel.style.top = `${target.top}px`;
  panel.style.width = `${target.width}px`;
  panel.style.height = `${target.height}px`;

  const finish = () => {
    panel.classList.remove("notes-elevated");
    // Return the panel to its flex slot in the bottom bar, then drop the placeholder.
    if (ph && ph.parentElement) {
      ph.parentElement.insertBefore(panel, ph);
      ph.parentElement.removeChild(ph);
    }
    panel.style.transition = "";
    panel.style.position = "";
    panel.style.margin = "";
    panel.style.left = "";
    panel.style.top = "";
    panel.style.width = "";
    panel.style.height = "";
    panel.style.zIndex = "";
    panel._placeholder = null;
    panel._container = null;
    panel._expandedRect = null;
    panel._bannerGeom = null;
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
//
// keepGeom: FREEZE the horizontal layout (per-bubble width, leftEdge, pinnedLeft)
// and reuse the values cached at the last width-establishing pass instead of
// re-deriving them from slotWidth/avatarMetrics. Typing in the compose input and
// adding/removing a bubble change only the VERTICAL layout (input height, stack
// height) — they must never re-run the width math, because re-deriving it against
// a frame that is momentarily mid-resize yields a slightly different maxW and
// re-wraps every bubble, so their width (and the gaps that follow from wrapping)
// visibly jump. The width geometry is therefore computed ONCE on expand and again
// only on a real width trigger (window-width resize), and every intermediate
// reflow reuses it verbatim. (Problem 3.)
export function measureExpandedList(panel, slotWidth, keepGeom) {
  const field = panel.querySelector("#instant-notes-field");
  const am = avatarMetrics(panel);

  let leftEdge, pinnedLeft, maxW;
  if (keepGeom && typeof panel._listLeftEdge === "number") {
    leftEdge = panel._listLeftEdge;
    pinnedLeft = panel._listPinnedLeft;
    maxW = panel._listMaxW;
  } else {
    const rightGutter = panel._isAdmin ? 76 : PAD;
    // Admin bubbles wear an active/expired badge to their LEFT. Reserve a left
    // gutter so the badge stays on-panel on narrow viewports.
    const leftGutter = panel._isAdmin ? STATUS_LEFT_RESERVE : PAD;
    leftEdge = clamp(
      Math.round(am.avR - AVATAR_OVERLAP),
      leftGutter,
      slotWidth - MIN_READABLE_W - rightGutter,
    );
    maxW = Math.max(MIN_READABLE_W, Math.min(LIST_MAX_W, slotWidth - leftEdge - rightGutter));
    // The pinned bottom slot (newest note / admin input) hugs the avatar and never
    // shifts right for the admin status badge — only the OLDER badge-bearing bubbles
    // indent to `leftEdge` to keep their active/expired span on-panel. (Problem 4.)
    pinnedLeft = clamp(Math.round(am.avR - AVATAR_OVERLAP), PAD, leftEdge);
    panel._listLeftEdge = leftEdge;
    panel._listPinnedLeft = pinnedLeft;
    panel._listMaxW = maxW;
  }

  const order = expandedOrder(panel);
  const widths = order.map((el) => {
    // Reuse the frozen width when keeping geometry; a freshly-added bubble (post)
    // has no cached width yet, so it is sized once here and cached like the rest.
    if (keepGeom && typeof el._listWidth === "number") return el._listWidth;
    const w = Math.round(bubbleHasEmoji(el) ? Math.max(MIN_READABLE_W, maxW - EMOJI_W_PAD) : maxW);
    el._listWidth = w;
    return w;
  });
  order.forEach((el, i) => {
    el.style.transition = "none";
    el.style.display = "";
    // Neutralise the entrance transform/blur BEFORE measuring — identical to what
    // computeLayout does for the compact path. The base `.instant-note-bubble` rule
    // carries `transform: scale(0.86)`, and a freshly-reconciled admin history bubble
    // has no inline transform yet, so measuring it here would return a height 14% too
    // SHORT. The first expand then packs the list too tightly; the reflow on the first
    // keystroke re-measures at full scale (placeBubble having since cleared the
    // transform) and the gaps jump OUT to their correct size. Zeroing the transform
    // here makes both measurements identical, so the gap is right from frame one —
    // this is the single measurement path both use now. (Problem 3.)
    el.style.transform = "none";
    el.style.filter = "none";
    el.classList.add("in-list");
    if (el.classList.contains("instant-notes-input-bubble")) el.style.width = `${widths[i]}px`;
    else wrapCard(el, widths[i]);
  });
  // Measure heights with the panel TEMPORARILY at the final expanded width. During
  // expand the panel is still at its narrow compact size (enterOverlay), so the field
  // would constrain wide cards, wrapping them more, inflating measured heights and
  // reserving extra vertical gaps that vary with the compact width. Restored right
  // after so animateFrame can still glide from the compact frame. (Problem 2.)
  const prevPanelW = panel.style.width;
  panel.style.width = `${slotWidth}px`;
  if (field) void field.offsetWidth;
  const heights = order.map((el) => el.getBoundingClientRect().height);
  panel.style.width = prevPanelW;
  // Re-flush layout at the RESTORED width. The height measurement above left the
  // browser's last committed layout at `slotWidth`; without this flush, a following
  // animated animateFrame() would take that stale slotWidth as the width-transition
  // START — equal to its END — so width would SNAP to full instantly (the panel
  // appears to pop out from the side) while only height/top glide. Flushing here
  // pins the true (compact) width as the baseline so width glides in step. (Problem 2.)
  if (field) void field.offsetWidth;

  // ── Single source of truth for every top/bottom reservation ────────────────
  // expandedHeight (sizes the frame) and positionExpandedList (places the bubbles)
  // both read fieldTop/fieldBottom/stackHOlder from HERE, so the frame's height and
  // the list's layout are always built from the identical numbers. Any drift between
  // "how tall the frame is" and "where the bubbles sit" is structurally impossible —
  // which is what keeps the scroll viewport (and thus the gaps) rock-steady. (Problem 3.)
  const fieldTop = LABEL_PAD + PAD;
  const pinnedClear = bubbleHasEmoji(order[0]) ? EMOJI_TOP_EXTRA : 0;
  const fieldBottom = Math.max(
    PAD, Math.round(am.avBottomGap + am.avH + heights[0] + pinnedClear + LIST_GAP_Y + 2),
  );
  let stackHOlder = 0;
  for (let i = 1; i < order.length; i++) {
    if (i > 1) stackHOlder += LIST_GAP_Y;
    stackHOlder += heights[i];
    if (bubbleHasEmoji(order[i])) stackHOlder += EMOJI_TOP_EXTRA;
  }

  return { order, heights, widths, leftEdge, pinnedLeft, fieldTop, fieldBottom, stackHOlder };
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
  place(pinnedEl, m.pinnedLeft != null ? m.pinnedLeft : m.leftEdge, pinnedTop, m.widths[0]);

  // ── Scroll region (older bubbles) above the pinned slot ───────────────────
  const older = order.slice(1);
  const olderH = m.heights.slice(1);
  const olderW = m.widths.slice(1);

  // fieldTop/fieldBottom come from measureExpandedList — the SAME values
  // expandedHeight sized the frame with, so the scroll viewport always has exactly
  // the room the frame was built for (no more silently-diverging copies of this
  // math — see measureExpandedList). (Problem 3.)
  const fieldTop = m.fieldTop;
  const fieldBottom = m.fieldBottom;
  field.style.top = `${fieldTop}px`;
  field.style.bottom = `${fieldBottom}px`;
  const viewportH = Math.max(40, innerH - fieldTop - fieldBottom);

  older.forEach((el) => {
    el.classList.remove("is-pinned");
    el.style.zIndex = "";
    if (el.parentElement !== field) field.appendChild(el);
  });

  const stackH = m.stackHOlder;
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
// Recomputes the banner geometry fresh (this IS the path for a real width change),
// re-establishing the cached band + cap.
export function relayoutExpanded(panel, animateFrameFlag) {
  fadeOutBubbles(expandedOrder(panel).filter(Boolean));
  const run = () => {
    const geom = bannerExpandGeom(panel);
    const measured = measureExpandedList(panel, geom.width);
    const finalH = expandedHeight(measured, geom.maxHeight);
    animateFrame(panel, { left: geom.left, top: geom.bottomInContainer - finalH, width: geom.width, height: finalH }, !!animateFrameFlag);
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

  // Reuse the CACHED banner geometry — this reflow is driven by the input growing
  // TALLER, never wider. The band (left/width) and the bottom anchor stay frozen;
  // only the content-adaptive height changes, and it grows by exactly the input's
  // delta, so the scroll viewport is invariant and older bubbles do not move. (Problem 3.)
  const geom = panel._bannerGeom || bannerExpandGeom(panel);
  const measured = measureExpandedList(panel, geom.width, true);
  const finalH = expandedHeight(measured, geom.maxHeight);
  // Snap instantly (not animated); the frame's left/width/bottom are all fixed.
  animateFrame(panel, { left: geom.left, top: geom.bottomInContainer - finalH, width: geom.width, height: finalH }, false);
  positionExpandedList(panel, measured, finalH, true, animDur, animDelay);

  if (field) {
    // Content is bottom-aligned in the spacer: when it grows by Δ everything
    // shifts down by Δ in scroll coords, so scroll down by Δ to hold the view.
    const newContentH = panel._listContentH || 0;
    field.scrollTop = Math.max(0, prevScroll + (newContentH - oldContentH));
    updateScrollFade(panel);
  }
}

// Re-flow the expanded list INSTANTLY inside the CURRENT panel frame — no frame
// resize, no cross-fade, no per-bubble animation. Re-measures widths/heights and
// snaps every bubble to its new top/left. The caller (admin add/remove) captures
// each surviving bubble's screen rect BEFORE this and FLIP-glides them afterwards,
// so keeping the frame fixed means the glide starts from the true on-screen spot
// (no coordinate-origin jump). Returns the field element. (Problem 2.)
export function repositionExpandedListInstant(panel) {
  if (!panel._expanded) return null;
  const geom = panel._bannerGeom || bannerExpandGeom(panel);
  // keepGeom: surviving bubbles keep their frozen width; only a freshly-posted
  // bubble is sized (it has no cached width yet). Add/remove is a VERTICAL change. (Problem 3.)
  const measured = measureExpandedList(panel, geom.width, true);
  const innerH = panel._expandedRect
    ? panel._expandedRect.height
    : panel.getBoundingClientRect().height;
  positionExpandedList(panel, measured, innerH, false);
  return panel.querySelector("#instant-notes-field");
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
