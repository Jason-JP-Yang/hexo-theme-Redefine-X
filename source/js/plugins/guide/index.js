/**
 * Guide — the director.
 *
 * Decides WHICH tip the cursor gives, WHEN, and what happens after. The tips
 * themselves are data (tips.js); the cursor, its ring and the card are drawn by
 * cursor.js and callout.js; the walkthroughs behind "View More" are loaded only
 * when one is opened (tours.js).
 *
 * Pacing, which is the whole difference between a guide and a pop-up:
 *   • nothing happens until the page has settled — preloader gone, Swup's
 *     scroll-to-top landed — and the reader has been still for a moment;
 *   • one tip at a time, never while an overlay is open, text is selected or
 *     something is being typed, and at most PER_VIEW per page view;
 *   • a tip left unanswered moves on by itself: the cursor flies straight to the
 *     next one in the chain instead of leaving;
 *   • a tip is only ever pointed at something ON screen. The guide never scrolls
 *     the page — a view tip waits for the reader to arrive at its target.
 *
 * Outcomes:
 *   Understand      stored; never shown again in this browser
 *   the target      the reader did what the tip suggested — stored the same way
 *   View More       opens the walkthrough; finishing it stores the tip
 *   ×, Esc          not now: gone until the next visit, and a long pause
 *   no answer       gone until the next visit; the chain continues
 */

import { isDone, markDone, markShown, wasShown, loadStrings, t, resetAll } from "./store.js";
import { Loop, Run, isCancel, CANCELLED } from "./motion.js";
import { Cursor, Halo } from "./cursor.js";
import { Callout } from "./callout.js";
import { catalog, notes } from "./tips.js";
import { shown, rectRatio, ratioInView, unionRect, anchorOf, isIOS, isStandalone } from "./dom.js";
import { onScroll, onRawScroll, getMetrics } from "../../tools/scrollScheduler.js";

const T = {
  SETTLE: 1500, // after a page view, before anything is considered
  FIRST: 1100, // then, before the first tip
  DWELL: 800, // a view tip's target must stay in view this long
  CALM: 700, // and the page must have been still this long
  INPUT: 1200, // or this long since the last press or key
  ANSWER: 15000, // unanswered this long, the cursor moves on
  NUDGE: 3800, // a "press here" gesture this often while waiting
  MIN_SHOWN: 2200, // on screen for less than this, a tip has not been seen
  CHAIN: 700, // between links of a chain
  COOLDOWN: 9000, // between unrelated tips
  LATER: 45000, // after "not now"
  LINGER: 2600, // how long the cursor waits for a next tip before leaving
  PER_VIEW: 4, // tips per page view
};

// Anything open over the page. The tour card is on the list too: while it is
// open the page behind it is not the reader's focus.
const BUSY = [
  ".image-viewer-container.active",
  ".search-pop-overlay.active",
  "#notifications-panel.is-open",
  "body.navbar-drawer-show",
  ".is-editing",
  ".gd-tour",
].join(",");

let ctx = null;
let token = 0;
let views = [];
let seqs = [];
let active = null;
let ui = null;
let opening = false;
let toursModule = null;
let perView = 0;
let cooldownUntil = 0;
let pumpTimer = 0;
let lingerTimer = 0;
let lastScroll = 0;
let lastInput = 0;
let booted = false;

// ─── context ─────────────────────────────────────────────────
function pageKind() {
  const has = (s) => !!document.querySelector(s);
  if (has(".home-content-container")) return "home";
  if (has("#masonry-container")) return "album";
  if (has("[data-masonry-heading]")) return "albums";
  if (has(".article-content-container .article-content")) return "article";
  if (has(".archive-container, .tagcloud-header, .category-name, .tag-name")) return "listing";
  return "other";
}

function mq(query) {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

function identity() {
  const auth = window.blogAuth;
  return {
    following: document.documentElement.classList.contains("blog-following"),
    signedIn: !!(auth && auth.isAuthenticated),
    login: (auth && auth.user && auth.user.login) || "",
  };
}

function readContext() {
  if (window.__umamiFramed) return null;
  if (/\/blog-management(\/|$)/.test(location.pathname)) return null;
  const backend = (window.theme && window.theme.backend) || {};
  return Object.assign(
    {
      kind: pageKind(),
      notifications: !!(backend.notifications && backend.notifications.enable && window.blogAuth),
      hover: mq("(hover: hover) and (pointer: fine)"),
      touch: mq("(pointer: coarse)"),
      ios: isIOS(),
      android: /Android/i.test(navigator.userAgent || ""),
      standalone: isStandalone(),
      pushable: "serviceWorker" in navigator && "PushManager" in window && window.isSecureContext !== false,
    },
    identity(),
  );
}

// ─── readiness ───────────────────────────────────────────────
function preloaderOn() {
  const p = document.querySelector(".preloader");
  return !!p && p.style.display !== "none";
}

function overlayOpen() {
  return preloaderOn() || !!document.querySelector(BUSY);
}

function busy(now, arriving = false) {
  if (document.hidden || overlayOpen()) return true;
  const s = window.__redefineScroll;
  if (s && s.isScrollFlight && s.isScrollFlight()) return true;
  if (arriving) return false;
  if (now - lastScroll < T.CALM || now - lastInput < T.INPUT) return true;
  const ae = document.activeElement;
  if (ae && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) return true;
  const sel = window.getSelection && window.getSelection();
  return !!(sel && !sel.isCollapsed && String(sel).trim());
}

function untilReady(my) {
  const start = performance.now();
  return new Promise((resolve) => {
    const check = () => {
      if (my !== token) return resolve(false);
      const s = window.__redefineScroll;
      const flying = s && s.isScrollFlight && s.isScrollFlight();
      if (!preloaderOn() && !flying && performance.now() - start >= T.SETTLE) return resolve(true);
      setTimeout(check, 250);
    };
    check();
  });
}

// ─── ui ──────────────────────────────────────────────────────
function ensureUI() {
  if (ui) return ui;
  const layer = document.createElement("div");
  layer.className = "gd-layer";
  const sr = document.createElement("div");
  sr.className = "gd-sr";
  sr.setAttribute("aria-live", "polite");
  layer.appendChild(sr);
  document.body.appendChild(layer);

  const loop = new Loop();
  const bounds = () => ({ w: document.documentElement.clientWidth, h: window.innerHeight });
  ui = {
    layer,
    loop,
    sr,
    halo: new Halo(layer, loop),
    cursor: new Cursor({ layer, loop, label: t("label", "Guide"), bounds }),
    callout: new Callout(layer, loop, onAction),
  };
  return ui;
}

function announce(text) {
  if (!ui) return;
  ui.sr.textContent = "";
  setTimeout(() => {
    if (ui) ui.sr.textContent = `${t("label", "Guide")}: ${text}`;
  }, 60);
}

// ─── arming ──────────────────────────────────────────────────
function eligible(tip) {
  if (!tip.pages.includes("*") && !tip.pages.includes(ctx.kind)) return false;
  if (isDone(tip.key) || wasShown(tip.id)) return false;
  try {
    return !tip.when || !!tip.when(ctx);
  } catch {
    return false;
  }
}

function arm(tip, my, attempt = 0) {
  if (tip.trigger !== "view") {
    seqs.push({ tip, ready: tip.trigger !== "read" });
    return;
  }
  let els = [];
  try {
    els = (tip.targets(ctx) || []).filter(Boolean);
  } catch {}
  if (!els.length) {
    // Late content — hearts drawn after a network answer, a decrypted article —
    // gets a couple more looks before the tip gives up for this view.
    if (attempt < 3) setTimeout(() => my === token && arm(tip, my, attempt + 1), 2500 * (attempt + 1));
    return;
  }
  const watch = { tip, seen: new Map(), io: null };
  watch.io = new IntersectionObserver(
    (entries) => {
      const now = performance.now();
      const vh = window.innerHeight;
      for (const e of entries) {
        const ok = e.isIntersecting && (e.intersectionRatio >= tip.ratio || e.intersectionRect.height >= vh * 0.45);
        if (ok) {
          if (!watch.seen.has(e.target)) watch.seen.set(e.target, now);
        } else watch.seen.delete(e.target);
      }
      if (watch.seen.size) pumpSoon(T.DWELL + 60);
    },
    { threshold: [0, 0.3, 0.45, 0.6, 0.8, 1] },
  );
  for (const el of els.slice(0, 40)) watch.io.observe(el);
  views.push(watch);
}

function disarm() {
  for (const v of views) v.io.disconnect();
  views = [];
  seqs = [];
}

// ─── choosing ────────────────────────────────────────────────
function retired(tip) {
  return isDone(tip.key) || wasShown(tip.id);
}

function pickOffer(now) {
  const offers = [];
  for (const v of views) {
    if (retired(v.tip)) continue;
    for (const [el, since] of v.seen) {
      if (now - since < T.DWELL || !el.isConnected || ratioInView(el) < 0.3) continue;
      if (v.tip.accept && !v.tip.accept(el, ctx)) continue;
      offers.push({ tip: v.tip, el, rank: v.tip.order });
      break;
    }
  }
  for (const s of seqs) {
    if (!s.ready || retired(s.tip)) continue;
    let el = null;
    try {
      el = s.tip.target(ctx);
    } catch {}
    if (el && shown(el) && ratioInView(el) >= 0.5) offers.push({ tip: s.tip, el, rank: s.tip.order + 0.5 });
  }
  offers.sort((a, b) => a.rank - b.rank);
  return offers[0] || null;
}

function waiting(now) {
  for (const v of views) {
    if (retired(v.tip)) continue;
    for (const since of v.seen.values()) if (now - since < T.DWELL) return true;
  }
  return false;
}

function pumpSoon(ms) {
  clearTimeout(pumpTimer);
  pumpTimer = setTimeout(pump, Math.max(0, ms));
}

function pump() {
  pumpTimer = 0;
  if (!ctx || active || opening) return;
  if (perView >= T.PER_VIEW) return linger();
  const now = performance.now();
  if (now < cooldownUntil) return pumpSoon(cooldownUntil - now + 40);
  if (busy(now)) return pumpSoon(450);
  const offer = pickOffer(now);
  if (offer) return void present(offer);
  if (waiting(now)) pumpSoon(500);
  else linger();
}

function linger() {
  clearTimeout(lingerTimer);
  lingerTimer = setTimeout(() => {
    if (!active && !opening && ui && ui.cursor.visible) ui.cursor.leave();
  }, T.LINGER);
}

// ─── presenting ──────────────────────────────────────────────
async function present({ tip, el }) {
  const a = {
    tip,
    key: tip.key,
    run: new Run(),
    target: null,
    shownAt: 0,
    outcome: null,
    resolve: null,
    cleanup: null,
    onTarget: null,
    timer: 0,
  };
  active = a;
  perView++;
  clearTimeout(lingerTimer);

  let outcome = "abort";
  try {
    const strings = await a.run.guard(loadStrings());
    if (!strings || !strings.tips) throw CANCELLED;
    const u = ensureUI();
    u.cursor.setLabel(t("label", "Guide"));

    if (tip.prepare) a.cleanup = tip.prepare(el, ctx) || null;
    if (tip.settle) await a.run.wait(tip.settle);

    const target = tip.resolve ? tip.resolve(el, ctx) : el;
    if (!target || !shown(target) || ratioInView(target) < 0.3) throw CANCELLED;
    const text = tip.text(ctx, target);
    if (!text || !text.title) throw CANCELLED;
    a.target = target;

    const anchor = anchorOf(target, tip.point);
    await a.run.guard(u.cursor.flyTo(anchor));
    if (!target.isConnected || busy(performance.now(), true)) throw CANCELLED;
    if (ratioInView(target) < 0.3) {
      a.outcome = "lost";
      throw CANCELLED;
    }

    const extra = tip.frame ? tip.frame(target) || [] : [];
    const avoid = () => unionRect([target, ...extra]);
    u.halo.show(target);
    u.callout.open(
      {
        id: tip.id,
        kicker: text.kicker || t("kicker"),
        title: text.title,
        body: text.body,
        ok: t("understand"),
        more: tip.tour ? t("more") : "",
        later: t("later"),
        wait: T.ANSWER,
      },
      anchor,
      avoid,
    );
    announce(text.title);
    a.shownAt = performance.now();

    // Pressing the very thing the tip is about is the best answer there is.
    a.onTarget = () => a.resolve && a.resolve("acted");
    target.addEventListener("click", a.onTarget, true);

    outcome = await waitAnswer(a);
  } catch (e) {
    if (!isCancel(e)) console.error("[guide] a tip failed", e);
    // Cancelled before it was ever shown — its target went away while the
    // cursor was on its way — is a skip, not an interruption.
    outcome = a.outcome || "skip";
  }
  conclude(a, outcome);
}

function waitAnswer(a) {
  return new Promise((resolve) => {
    let elapsed = 0;
    let lostFor = 0;
    let nudges = 0;
    let last = performance.now();

    a.resolve = (why) => {
      if (a.outcome) return;
      a.outcome = why;
      clearInterval(a.timer);
      resolve(why);
    };

    a.timer = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      const u = ui;
      if (!a.target.isConnected) return a.resolve("lost");
      try {
        if (a.tip.fulfilled && a.tip.fulfilled(ctx)) return a.resolve("fulfilled");
      } catch {}
      if (overlayOpen()) return a.resolve("lost");

      // The ring is measured every frame by the loop; reading its rect here
      // costs no layout of our own.
      if (rectRatio(u.halo.rect) < 0.3) {
        lostFor += dt;
        if (lostFor > 700) return a.resolve("lost");
      } else lostFor = 0;

      if (u.callout.held || document.hidden) return;
      elapsed += dt;
      if (nudges < 3 && elapsed > T.NUDGE * (nudges + 1)) {
        nudges++;
        u.cursor.nudge();
      }
      if (elapsed >= T.ANSWER) a.resolve("timeout");
    }, 200);
  });
}

function onAction(act) {
  if (!active || !active.resolve) return;
  if (act === "ok") active.resolve("understand");
  else if (act === "more") active.resolve("more");
  else if (act === "later") active.resolve("later");
}

function conclude(a, outcome) {
  clearInterval(a.timer);
  a.run.kill();
  if (a.onTarget && a.target) a.target.removeEventListener("click", a.onTarget, true);
  if (a.cleanup) {
    try {
      a.cleanup();
    } catch {}
  }
  const u = ui;
  if (u) {
    u.callout.close();
    u.halo.hide();
  }

  const seen = a.shownAt && performance.now() - a.shownAt >= T.MIN_SHOWN;
  if (outcome === "understand" || outcome === "acted" || outcome === "fulfilled") markDone(a.key);
  else if (outcome === "more" || outcome === "later" || outcome === "timeout" || (outcome === "lost" && seen)) {
    markShown(a.tip.id);
  }
  if (active === a) active = null;

  const now = performance.now();
  if (outcome === "abort") {
    if (u) u.cursor.vanish();
    return;
  }
  if (outcome === "skip") {
    // Retired for this visit so a target that keeps failing cannot loop.
    markShown(a.tip.id);
    perView = Math.max(0, perView - 1);
    linger();
    pumpSoon(300);
    return;
  }
  if (outcome === "more") {
    openTour(a.tip.tour, { from: a.tip.tourFrom || null, key: a.key });
    return;
  }

  const chain = outcome === "understand" || outcome === "timeout";
  cooldownUntil = now + (chain ? T.CHAIN : outcome === "later" ? T.LATER : T.COOLDOWN);
  if (chain) linger();
  else if (u) u.cursor.leave();
  pumpSoon(cooldownUntil - now + 40);
}

// ─── walkthroughs ────────────────────────────────────────────
async function tours() {
  if (!toursModule) toursModule = await import("./tours.js");
  return toursModule;
}

async function openTour(id, { from = null, key = null } = {}) {
  if (opening) return;
  opening = true;
  clearTimeout(lingerTimer);
  const u = ensureUI();
  try {
    await loadStrings();
    const mod = await tours();
    const result = await mod.openTour(id, ctx || readContext(), { from, cursor: u.cursor, halo: u.halo });
    if (result && result.completed && key) markDone(key);
  } catch (e) {
    console.error("[guide] the walkthrough could not open", e);
    u.cursor.leave();
  } finally {
    opening = false;
    cooldownUntil = performance.now() + T.COOLDOWN;
    pumpSoon(T.COOLDOWN + 40);
  }
}

async function openMenu() {
  if (opening) return;
  if (active && active.resolve) active.resolve("later");
  opening = true;
  const u = ensureUI();
  let reset = false;
  try {
    await loadStrings();
    const mod = await tours();
    const result = await mod.openMenu(ctx || readContext(), { cursor: u.cursor, halo: u.halo });
    reset = !!(result && result.reset);
  } catch (e) {
    console.error("[guide] the guide menu could not open", e);
  } finally {
    opening = false;
  }
  if (reset) {
    resetAll();
    begin();
  }
}

// ─── lifecycle ───────────────────────────────────────────────
function stopAll() {
  clearTimeout(pumpTimer);
  clearTimeout(lingerTimer);
  pumpTimer = 0;
  disarm();
  perView = 0;
  cooldownUntil = 0;
  if (active) {
    const a = active;
    if (a.resolve) a.resolve("abort");
    else {
      a.outcome = "abort";
      a.run.kill();
    }
  } else if (ui) {
    ui.cursor.vanish();
    ui.halo.hide();
    ui.callout.close();
  }
}

async function begin() {
  const my = ++token;
  stopAll();
  ctx = readContext();
  if (!ctx) return;
  if (!(await untilReady(my))) return;

  let tips = [];
  try {
    tips = catalog(ctx).concat(notes(ctx)).filter(eligible);
  } catch (e) {
    console.error("[guide] the tip catalog failed", e);
  }
  if (!tips.length) return;
  loadStrings();
  for (const tip of tips) arm(tip, my);

  // A page too short to scroll never gets a scroll pass to say how far down it
  // is; read tips are measured once here as well.
  const m = getMetrics();
  const max = m.docH - m.viewportH;
  const progress = max > 0 ? m.scrollY / max : 1;
  for (const s of seqs) if (!s.ready && progress >= s.tip.progress) s.ready = true;

  pumpSoon(T.FIRST);
}

function leaving() {
  token++;
  stopAll();
  if (toursModule) toursModule.closeAll();
}

function boot() {
  if (booted) return;
  booted = true;

  onRawScroll(() => {
    lastScroll = performance.now();
  });
  onScroll(
    (m) => {
      if (!seqs.length) return;
      const max = m.docH - m.viewportH;
      const progress = max > 0 ? m.scrollY / max : 1;
      for (const s of seqs) if (!s.ready && progress >= s.tip.progress) s.ready = true;
      if (!active && !opening && seqs.some((s) => s.ready && !retired(s.tip))) pumpSoon(T.CALM + 80);
    },
    null,
    "guide",
  );

  document.addEventListener(
    "pointerdown",
    () => {
      lastInput = performance.now();
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      lastInput = performance.now();
      if (e.key === "Escape" && active && active.resolve && !overlayOpen()) active.resolve("later");
    },
    true,
  );
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".tool-guide")) {
      e.preventDefault();
      openMenu();
    }
  });

  window.addEventListener("blog:auth-change", () => {
    if (ctx) Object.assign(ctx, identity());
  });
  // Content decrypted into a page that is already open never reaches Swup's
  // `page:view`; plugins/vault.js announces it here instead.
  window.addEventListener("redefine:content-injected", () => begin());

  try {
    swup.hooks.on("visit:start", leaving);
    swup.hooks.on("page:view", () => begin());
  } catch (e) {}

  begin();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
