/**
 * Instant Notes – Danmaku-style chat bubbles on the home banner.
 *
 * The panel (#instant-notes) is a flex item inside the bottom bar,
 * between the scroll arrow and social contacts.
 *
 * Layout inside the panel:
 *  ┌───────────────────────────────────────────────────┐
 *  │ Instant Notes                                     │
 *  │           [msg2]  ··  [msg3]  ···  [msg4]  [msg5] │
 *  │  [avatar][newest▸]                                │
 *  └───────────────────────────────────────────────────┘
 *
 *  • Bubbles are absolutely positioned in .instant-notes-field
 *  • Newest bubble overlaps avatar's top-right corner
 *  • Older bubbles spread rightward with vertical stagger
 *  • Tail at bottom-left of each card (CSS triangle pair)
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

// ─── Entry point ───────────────────────────────────────────
export default function initInstantNotes() {
  const panel = document.getElementById("instant-notes");
  if (!panel) return;

  const apiUrl = theme.home_banner?.instant_notes?.api_url;
  if (!apiUrl) return;

  fetchNotes(apiUrl).then((notes) => {
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
  wrap.className = "instant-note-bubble" + (isNewest ? " bubble-newest" : "");

  // Set --bubble-bg on the wrapper so the tail ::after picks it up
  if (color) {
    wrap.style.setProperty("--bubble-bg", color);
    wrap.style.setProperty("--bubble-border", "rgba(255,255,255,0.18)");
  }
  // Default colours are handled by CSS variables on .instant-note-bubble

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

// ─── Build DOM & position bubbles ──────────────────────────
//
// Hybrid layout:
//  1. Determine lane count and panel height using conservative
//     "beside newest" spacing (newestR + GAP_X).
//  2. After setting height, check which lanes are physically
//     ABOVE the avatar/newest row. Those lanes get a wider
//     startX (newestL + 15) for more horizontal space.
//  3. Assign bubbles to lanes using lane-specific startX.
//
function buildDOM(notes, panel) {
  const field = panel.querySelector("#instant-notes-field");
  if (!field) return;
  field.innerHTML = "";

  const bubbleEls = notes.map((n, i) => createBubble(n, i === 0));

  // ── Neutralise transforms for measurement ─────────────
  const origPanelTransform = panel.style.transform;
  panel.style.transform = "none";
  const avatarEl = panel.querySelector("#instant-notes-avatar");
  const origAvatarTransform = avatarEl ? avatarEl.style.transform : "";
  if (avatarEl) avatarEl.style.transform = "scale(1)";

  bubbleEls.forEach((b) => {
    b.style.visibility = "hidden";
    b.style.opacity = "0";
    b.style.position = "absolute";
    b.style.transform = "scale(1) translateY(0)";
    b.style.filter = "none";
    field.appendChild(b);
  });

  // ── Measure ───────────────────────────────────────────
  const W = panel.getBoundingClientRect().width;
  const sizes = bubbleEls.map((b) => {
    const r = b.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });

  const TAIL = 14;
  const GAP_X = 5;
  const GAP_Y = 2;
  const PAD = 6;
  const EMOJI_TOP_MIN = 18;
  const LABEL_PAD = 28;
  const MAX_LANES = 3;
  const maxH = Math.min(280, window.innerHeight * 0.35);

  // Avatar geometry
  const panelRectPre = panel.getBoundingClientRect();
  let avL = 14, avW = 64, avH = 64;
  if (avatarEl) {
    const ar = avatarEl.getBoundingClientRect();
    avL = ar.left - panelRectPre.left;
    avW = ar.width;
    avH = ar.height;
  }
  const avR = avL + avW;

  const newestL = Math.min(avR - 6, W - sizes[0].w - PAD);
  const newestR = newestL + (sizes[0]?.w || 0);
  const besideStartX = newestR + GAP_X; // narrow start (beside newest)
  const aboveStartX = newestL + 8;      // wider start (above newest)

  const olderSizes = sizes.slice(1);
  if (olderSizes.length === 0) {
    panel.style.transform = origPanelTransform;
    if (avatarEl) avatarEl.style.transform = origAvatarTransform;
    bubbleEls.forEach((b) => { b.style.visibility = ""; b.style.transform = ""; b.style.filter = ""; });
    panel._dynamicH = 150;
    return;
  }

  const maxBH = olderSizes.reduce((m, s) => Math.max(m, s.h), 36);
  const laneSlot = maxBH + TAIL + GAP_Y;

  // ── Phase 1: Determine lane count (vertical limit) ────
  const verticalBudget = maxH - LABEL_PAD - PAD * 2;
  const maxVertLanes = Math.max(1, Math.floor(verticalBudget / laneSlot));
  const laneCount = Math.min(MAX_LANES, maxVertLanes, Math.max(1, olderSizes.length));

  // Needed height based on lane count
  const neededH = LABEL_PAD + PAD * 2 + laneCount * laneSlot;
  const dynamicH = Math.max(150, Math.min(Math.ceil(neededH), maxH));

  // ── Phase 2: Set panel height ─────────────────────────
  panel.style.height = `${dynamicH}px`;
  const H = panel.getBoundingClientRect().height;

  // Calculate lane Y positions
  const usableTop = LABEL_PAD + PAD;
  const usableH = H - usableTop - PAD;
  const laneY = [];
  if (laneCount === 1) {
    laneY.push(Math.round(usableTop + (usableH - maxBH - TAIL) / 2));
  } else {
    const span = usableH - maxBH - TAIL;
    for (let l = 0; l < laneCount; l++) {
      laneY.push(Math.round(usableTop + l * (span / (laneCount - 1))));
    }
  }

  // ── Phase 3: Determine lane-specific startX ───────────
  // Avatar is at bottom-left (CSS: bottom:12px).
  let avT = H - 12 - avH;
  if (avatarEl) {
    const pRect = panel.getBoundingClientRect();
    const ar2 = avatarEl.getBoundingClientRect();
    avT = ar2.top - pRect.top;
  }
  // Newest bubble is roughly at avT - sizes[0].h * 0.9
  const newestTop = Math.max(PAD, avT - sizes[0].h * 0.9);

  // For each lane: if its bottom edge is above the newest bubble's top,
  // it can use the wider "above" startX. Otherwise, "beside" startX.
  const stagger = [0, 8, 4];
  const laneStartX = [];
  for (let l = 0; l < laneCount; l++) {
    const laneBottom = laneY[l] + maxBH + TAIL;
    if (laneBottom <= newestTop) {
      // This lane is physically above the avatar/newest row → wider
      laneStartX.push(aboveStartX + (stagger[l] || 0));
    } else {
      // Overlaps with avatar/newest → must start to the right
      laneStartX.push(besideStartX + (stagger[l] || 0));
    }
  }

  // ── Phase 4: Assign bubbles to lanes ──────────────────
  let cursors = laneStartX.slice();
  let assignments = [];
  for (let i = 0; i < olderSizes.length; i++) {
    const bw = olderSizes[i].w;
    let best = 0, mc = cursors[0];
    for (let l = 1; l < laneCount; l++) {
      if (cursors[l] < mc) { mc = cursors[l]; best = l; }
    }
    if (cursors[best] + bw > W - PAD) {
      assignments.push(null);
    } else {
      assignments.push({ lane: best, left: cursors[best] });
      cursors[best] += bw + GAP_X;
    }
  }

  // ── Phase 4a: Aggressive wrapping for overflows ────────
  // If any bubbles overflow, calculate a per-lane target width
  // (even distribution) and wrap ALL bubbles wider than that.
  // This frees space so previously-overflowing bubbles can fit.
  const overflowCount = assignments.filter((a) => !a).length;
  if (overflowCount > 0) {
    const maxLaneW = Math.max(...laneStartX.map((sx) => W - PAD - sx));
    // Even distribution: each lane should hold ceil(total/lanes) bubbles
    const bPerLane = Math.ceil(olderSizes.length / laneCount);
    const targetW = Math.max(80, Math.floor((maxLaneW - (bPerLane - 1) * GAP_X) / bPerLane));
    if (targetW < maxLaneW) {
      const wrapCards = [];
      for (let i = 0; i < olderSizes.length; i++) {
        if (olderSizes[i].w > targetW) {
          const card = bubbleEls[i + 1].querySelector(".bubble-card");
          if (card) {
            card.style.maxWidth = targetW + "px";
            card.style.whiteSpace = "normal";
            card.style.wordBreak = "break-word";
            wrapCards.push({ card, idx: i });
          }
        }
      }

      if (wrapCards.length > 0) {
        // Re-measure all older bubbles
        const newSizes = bubbleEls.slice(1).map((b) => {
          const r = b.getBoundingClientRect();
          return { w: r.width, h: r.height };
        });

        // Check if wrapping causes lane count to shrink (taller bubbles)
        const newMaxBH = newSizes.reduce((m, s) => Math.max(m, s.h), 36);
        const newSlot = newMaxBH + TAIL + GAP_Y;
        const newMaxVLanes = Math.max(1, Math.floor(verticalBudget / newSlot));
        const newLaneCount = Math.min(MAX_LANES, newMaxVLanes, Math.max(1, newSizes.length));

        // Re-compute laneStartX for new lane count/height
        const newNeededH = LABEL_PAD + PAD * 2 + newLaneCount * newSlot;
        const newDynH = Math.max(150, Math.min(Math.ceil(newNeededH), maxH));
        const newUsableH = newDynH - usableTop - PAD;
        const newLaneY = [];
        if (newLaneCount === 1) {
          newLaneY.push(Math.round(usableTop + (newUsableH - newMaxBH - TAIL) / 2));
        } else {
          const sp = newUsableH - newMaxBH - TAIL;
          for (let l = 0; l < newLaneCount; l++)
            newLaneY.push(Math.round(usableTop + l * (sp / (newLaneCount - 1))));
        }
        const newNewestTop = Math.max(PAD, (newDynH - 12 - avH) - sizes[0].h * 0.9);
        const newLSX = [];
        for (let l = 0; l < newLaneCount; l++) {
          const lb = newLaneY[l] + newMaxBH + TAIL;
          newLSX.push(lb <= newNewestTop
            ? aboveStartX + (stagger[l] || 0)
            : besideStartX + (stagger[l] || 0));
        }

        // Re-assign
        const newCursors = newLSX.slice();
        const newAssign = [];
        for (let i = 0; i < newSizes.length; i++) {
          const bw = newSizes[i].w;
          let best = 0, mc2 = newCursors[0];
          for (let l = 1; l < newLaneCount; l++) {
            if (newCursors[l] < mc2) { mc2 = newCursors[l]; best = l; }
          }
          if (newCursors[best] + bw > W - PAD) {
            newAssign.push(null);
          } else {
            newAssign.push({ lane: best, left: newCursors[best] });
            newCursors[best] += bw + GAP_X;
          }
        }

        const newOverflows = newAssign.filter((a) => !a).length;
        if (newOverflows <= overflowCount) {
          // Accept wrapping — update everything
          assignments = newAssign;
          for (let i = 0; i < newSizes.length; i++) {
            olderSizes[i] = newSizes[i];
            sizes[i + 1] = newSizes[i];
          }
          // Update lane geometry for Phase 5
          laneY.length = 0;
          newLaneY.forEach((y) => laneY.push(y));
          laneStartX.length = 0;
          newLSX.forEach((x) => laneStartX.push(x));
          panel.style.height = `${newDynH}px`;
        } else {
          // Reject — undo wrapping
          wrapCards.forEach(({ card }) => {
            card.style.maxWidth = "";
            card.style.whiteSpace = "";
            card.style.wordBreak = "";
          });
        }
      }
    }
  }

  // ── Phase 4c: Force-fit remaining overflows ─────────────
  // Wrap still-overflowing bubbles to whatever space remains.
  const effectiveLaneCount = laneY.length;
  cursors = laneStartX.slice();
  for (let i = 0; i < olderSizes.length; i++) {
    if (assignments[i]) {
      const l = assignments[i].lane;
      const endX = assignments[i].left + olderSizes[i].w + GAP_X;
      if (endX > cursors[l]) cursors[l] = endX;
    }
  }
  for (let i = 0; i < olderSizes.length; i++) {
    if (assignments[i]) continue;
    let best = 0, bestSpace = (W - PAD) - cursors[0];
    for (let l = 1; l < effectiveLaneCount; l++) {
      const sp = (W - PAD) - cursors[l];
      if (sp > bestSpace) { bestSpace = sp; best = l; }
    }
    if (bestSpace >= 60) {
      const card = bubbleEls[i + 1].querySelector(".bubble-card");
      if (card) {
        card.style.maxWidth = bestSpace + "px";
        card.style.whiteSpace = "normal";
        card.style.wordBreak = "break-word";
      }
      const r = bubbleEls[i + 1].getBoundingClientRect();
      olderSizes[i] = { w: r.width, h: r.height };
      sizes[i + 1] = olderSizes[i];
      assignments[i] = { lane: best, left: cursors[best] };
      cursors[best] += olderSizes[i].w + GAP_X;
    }
  }

  // ── Phase 4d: Justify — spread bubbles within each lane ─
  const laneGroups = {};
  assignments.forEach((a, i) => {
    if (a) {
      if (!laneGroups[a.lane]) laneGroups[a.lane] = [];
      laneGroups[a.lane].push(i);
    }
  });
  for (const [lane, indices] of Object.entries(laneGroups)) {
    if (indices.length <= 1) continue;
    const lStart = laneStartX[+lane];
    const totalBW = indices.reduce((s, i) => s + olderSizes[i].w, 0);
    const available = (W - PAD) - lStart;
    const idealGap = Math.min(GAP_X * 3, Math.max(GAP_X, (available - totalBW) / indices.length));
    let x = lStart;
    for (const idx of indices) {
      assignments[idx].left = x;
      x += olderSizes[idx].w + idealGap;
    }
  }

  // ── Restore transforms ────────────────────────────────
  panel.style.transform = origPanelTransform;
  if (avatarEl) avatarEl.style.transform = origAvatarTransform;

  // ── Phase 5: Apply positions ──────────────────────────
  const finalH = panel.getBoundingClientRect().height;

  let finalAvT = finalH - 12 - avH;
  if (avatarEl) {
    const pRect = panel.getBoundingClientRect();
    const ar2 = avatarEl.getBoundingClientRect();
    finalAvT = ar2.top - pRect.top;
  }

  const positions = [];

  // Newest bubble: overlap avatar top-right
  let nT = Math.max(PAD, finalAvT - sizes[0].h * 0.9);
  if (bubbleEls[0].querySelector(".instant-note-emoji")) nT = Math.max(EMOJI_TOP_MIN, nT);
  positions.push({
    left: newestL,
    top: Math.max(PAD, Math.min(nT, finalH - sizes[0].h - TAIL - PAD)),
  });

  // Older bubbles — add random Y jitter for shorter bubbles in the lane
  const currentMaxBH = olderSizes.reduce((m, s) => Math.max(m, s.h), 36);
  for (let i = 0; i < olderSizes.length; i++) {
    const a = assignments[i];
    if (!a) {
      positions.push({ left: W + 100, top: 0 });
    } else {
      let top = laneY[a.lane];
      // Random vertical offset for shorter bubbles within the lane
      const slack = Math.max(0, currentMaxBH - olderSizes[i].h);
      if (slack > 3) top += Math.floor(Math.random() * slack);
      top = Math.max(PAD, Math.min(top, finalH - olderSizes[i].h - TAIL - PAD));
      if (bubbleEls[i + 1].querySelector(".instant-note-emoji")) top = Math.max(EMOJI_TOP_MIN, top);
      positions.push({ left: a.left, top });
    }
  }

  bubbleEls.forEach((b, i) => {
    if (positions[i]) {
      b.style.left = `${positions[i].left}px`;
      b.style.top = `${positions[i].top}px`;
    }
    b.style.visibility = "";
    b.style.transform = "";
    b.style.filter = "";
  });

  panel._dynamicH = finalH;
}

// ─── Reveal animation ──────────────────────────────────────
function revealNotes(panel) {
  // 1. Fade in glass panel
  panel.classList.add("notes-visible");

  // 2. Shift title/subtitle upward to re-center above the taller bottom bar
  const bannerContainer = document.querySelector(".home-banner-container");
  if (bannerContainer && panel._dynamicH) {
    // Shift by a fraction of the panel height (so title stays visually centered)
    const shift = Math.round(Math.max(0, panel._dynamicH - 50) * 0.3);
    bannerContainer.style.setProperty("--notes-shift", `${shift}px`);
    bannerContainer.classList.add("has-notes");
  }

  // 3. Avatar pop-in
  const avatar = panel.querySelector("#instant-notes-avatar");
  setTimeout(() => avatar?.classList.add("avatar-visible"), 280);

  // 4. Stagger-pop each bubble: newest first
  const bubbles = panel.querySelectorAll(".instant-note-bubble");
  bubbles.forEach((b, i) => {
    setTimeout(() => b.classList.add("bubble-pop"), 420 + i * 140);
  });
}

