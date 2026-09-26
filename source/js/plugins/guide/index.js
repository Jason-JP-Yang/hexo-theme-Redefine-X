/**
 * Guide — the director.
 *
 * Decides where the cursor goes, when, and what happens after. The route is data
 * (tips.js); the cursor and what it says are cursor.js and callout.js; the
 * walkthroughs behind "View More" load only when one is opened (tours.js).
 *
 * A page view is one FLOW: the page's stops walked in order by one cursor that
 * stays on screen from the first to the last, instead of coming and going.
 *   • It flies straight from one stop to the next. A next stop below the screen
 *     is neither skipped nor scrolled to: the cursor waits at the bottom edge,
 *     asks the reader to scroll, and goes to it the moment it is in view.
 *   • A stop tied to reading — a photo, a code block, the author's note — waits
 *     for the reader to reach it; meanwhile the cursor rests beside the side
 *     tools rather than leaving.
 *   • Whatever takes the reader away — an overlay, typing, another tab, a page
 *     turn — only pauses the flow, and it picks up the moment the page is free.
 *     A reader back after a while is welcomed first; one left idle is invited on.
 *   • The guide never scrolls the page. Let's try does what a stop is about with
 *     the page's own controls, as the reader would.
 *   • Let's Explore, or Let's try on a signed-in reader's first stop, takes a
 *     detour through the inbox (tips.js `inbox`) and then carries on.
 *
 * Answers:
 *   Understand, Let's try   done for good in this browser; on to the next stop
 *   View More               the walkthrough; finishing it makes the stop done
 *   ×, Esc                  nothing more on this page; the next one picks up here
 *   no answer               on to the next; the stop returns on the next visit
 */

import { isDone, markDone, markShown, wasShown, loadStrings, t, resetAll } from "./store.js";
import { Loop, Run, isCancel, CANCELLED, sleep } from "./motion.js";
import { Cursor } from "./cursor.js";
import { Callout } from "./callout.js";
import { plan, inbox } from "./tips.js";
import { shown, rectRatio, ratioInView, anchorOf, isIOS, isStandalone } from "./dom.js";
import { onScroll, onRawScroll, getMetrics } from "../../tools/scrollScheduler.js";

const T = {
  SETTLE: 700, // after a page view, before anything is considered
  FIRST: 300, // then, before the first stop
  CALM: 450, // the page must have been still this long before the cursor moves
  INPUT: 700, // and this long since the last press or key outside the guide
  CHAIN: 260, // between one stop and the next
  DWELL: 500, // a reading stop's target must stay in view this long
  ANSWER: 12000, // unanswered this long once said, the cursor moves on
  NUDGE: 5000, // a "press here" hop this often while waiting, twice at most
  PROMPT: 12000, // a scroll prompt folds back into the label after this long
  BOB: 1500, // how often the waiting cursor hints at the scroll
  AWAY: 15000, // away from the tab this long, the reader is welcomed back
  WELCOME: 2400, // how long the welcome stays
  IDLE: 30000, // untouched this long, the reader is invited further down
  IDLES: 2, // idle invitations per page view
  TICK: 1500, // a flow with nothing to say looks again this often
};

// Anything open over the page. The guide's own card is on the list too: while
// it is open the page behind it is not the reader's focus. The inbox is not,
// while the guide is the one walking the reader through it.
const COVERS = [".image-viewer-container.active", ".search-pop-overlay.active", "body.navbar-drawer-show", ".is-editing", ".gd-tour"];
const BUSY = COVERS.concat("#notifications-panel.is-open").join(",");
const BUSY_BUT_INBOX = COVERS.join(",");

let ctx = null;
let token = 0;
let ui = null;
let flow = null;
let toursModule = null;
let opening = false;
let lastScroll = 0;
let lastInput = 0;
let lastMove = 0;
let hiddenAt = 0;
let booted = false;

const safe = (fn) => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

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
  return preloaderOn() || !!document.querySelector(flow && flow.detour ? BUSY_BUT_INBOX : BUSY);
}

// Typing, or holding a selection — including into an embedded frame (comments).
function typing() {
  const ae = document.activeElement;
  if (ae && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT|IFRAME)$/.test(ae.tagName))) return true;
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
      setTimeout(check, 150);
    };
    check();
  });
}

function progress() {
  const m = getMetrics();
  const max = m.docH - m.viewportH;
  return max > 0 ? m.scrollY / max : 1;
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
  const cursor = new Cursor({ layer, loop, label: t("label", "Guide"), bounds });
  ui = { layer, loop, sr, cursor, callout: new Callout(cursor, onAction) };
  // A resting cursor sleeps; where it rests moves with the window.
  window.addEventListener("resize", () => loop.wake(), { passive: true });
  return ui;
}

function announce(text) {
  if (!ui) return;
  ui.sr.textContent = "";
  setTimeout(() => {
    if (ui) ui.sr.textContent = `${t("label", "Guide")}: ${text}`;
  }, 60);
}

const vw = () => document.documentElement.clientWidth;
const vh = () => window.innerHeight;

// Beside the side tools, where the cursor waits for the next thing to show.
function parkPoint() {
  const rail = document.querySelector(".side-tools-container .visible-tools-list");
  const r = rail && rail.getBoundingClientRect();
  if (r && r.width) return { x: Math.max(16, r.left - 72), y: Math.max(16, r.top + 12) };
  return { x: vw() - 120, y: vh() - 120 };
}

// Where the cursor asks for a scroll: the edge the target will come in by, as
// nearly above or below it as the screen allows.
function edgePoint(el, up) {
  const r = el.getBoundingClientRect();
  const x = Math.min(Math.max(r.left + r.width / 2, vw() * 0.2), vw() * 0.8);
  return { x, y: up ? 96 : vh() - 104 };
}

function placePoint(at, seed) {
  if (at === "middle") return { x: vw() * (0.3 + 0.3 * seed.x), y: vh() * (0.36 + 0.18 * seed.y) };
  return { x: vw() * 0.5 - 60, y: vh() * 0.42 };
}

/** 0 on screen, 1 below it, -1 above. */
function side(el) {
  const r = el.getBoundingClientRect();
  if (rectRatio(r) >= 0.5) return 0;
  return r.top + r.height / 2 > vh() / 2 ? 1 : -1;
}

/** To the side tools; `show` brings back a cursor that is not on screen. */
function park(show = true) {
  if (!ui) return;
  const c = ui.cursor;
  if (!c.visible && !show) return;
  c.rest(true);
  if (!c.flight && c.visible && c.anchor === parkPoint) return;
  ui.callout.close();
  c.flyTo(parkPoint, { appear: !c.visible });
}

function leave() {
  if (!ui || !ui.cursor.visible) return;
  ui.callout.close();
  ui.cursor.rest(false);
  ui.cursor.leave();
}

// Out of the way of whatever now covers the page.
function conceal() {
  if (!ui || !ui.cursor.visible) return;
  ui.callout.close();
  ui.cursor.vanish();
}

// ─── the flow ────────────────────────────────────────────────
class Flow {
  constructor(my) {
    this.my = my;
    this.run = new Run();
    this.stops = [];
    this.views = new Map();
    this.kept = new Map();
    this.quiet = false;
    this.greet = false;
    this.idles = 0;
    this.answer = null;
    this.waker = null;
    this.running = false;
    // A route taken on request (the inbox), before the page's own carries on.
    this.detour = null;
    this.through = new Set();
    this.opened = false;
  }

  get live() {
    return this.my === token && !this.run.dead;
  }

  /** Until something changes, or `ms`. */
  pause(ms) {
    return this.run.guard(
      new Promise((resolve) => {
        const id = setTimeout(() => {
          this.waker = null;
          resolve("tick");
        }, ms);
        this.waker = (why) => {
          clearTimeout(id);
          this.waker = null;
          resolve(why);
        };
      }),
    );
  }

  wake(why) {
    if (why === "greet" && this.answer && this.answer.resolve) this.answer.resolve("greet");
    if (this.waker) this.waker(why);
  }

  end() {
    this.run.kill();
    for (const v of this.views.values()) v.io.disconnect();
    this.views.clear();
    if (this.answer && this.answer.resolve) this.answer.resolve("stop");
  }
}

async function play(f) {
  const r = f.run;
  f.running = true;
  try {
    if (!(await untilReady(f.my))) return;
    await r.guard(loadStrings());
    if (!f.live) return;
    f.stops = plan(ctx);
    ensureUI().cursor.setLabel(t("label", "Guide"));
    for (const s of f.stops) if (s.mode === "reach") arm(f, s);
    await r.wait(T.FIRST);

    for (;;) {
      await free(f);
      if (f.greet) {
        f.greet = false;
        await welcome(f);
        continue;
      }
      if (f.detour) {
        if ((await detour(f)) === "later") return hush(f);
        continue;
      }
      const next = choose(f);
      if (next && next.stop) {
        const why = await visit(f, next);
        if (why === "later") return hush(f);
        if (why !== "busy" && why !== "greet") await r.wait(T.CHAIN);
        continue;
      }
      // Nothing to say right now: wait by the tools while something may still
      // come, leave when nothing will — and welcome and invite either way.
      if (next) park();
      else leave();
      await f.pause(T.TICK);
      if (idleDue(f) && (await invite(f)) === "later") return hush(f);
    }
  } catch (e) {
    if (!isCancel(e)) console.error("[guide] the flow failed", e);
  } finally {
    f.running = false;
  }
}

/** Until the page is the reader's again: nothing over it, nothing typed, not scrolling. */
async function free(f) {
  for (;;) {
    if (!f.live) throw CANCELLED;
    // The guide's own card borrows the cursor; anything else is only out of its way.
    const own = opening || !!document.querySelector(".gd-tour");
    if (document.hidden || own || overlayOpen()) {
      if (!own) conceal();
      await f.pause(250);
      continue;
    }
    if (typing()) {
      park(false);
      await f.pause(250);
      continue;
    }
    const now = performance.now();
    const s = window.__redefineScroll;
    if ((s && s.isScrollFlight && s.isScrollFlight()) || now - lastScroll < T.CALM || now - lastInput < T.INPUT) {
      await f.pause(140);
      continue;
    }
    return;
  }
}

function settled(s) {
  if (isDone(s.key) || wasShown(s.id)) return true;
  if (s.fulfilled && safe(() => s.fulfilled(ctx))) {
    markDone(s.key);
    return true;
  }
  return false;
}

/** The next stop that can be shown now, `{pending}` if one may be later, or null. */
function choose(f) {
  let pending = false;
  const read = progress();
  for (const s of f.stops) {
    if (settled(s)) continue;
    const before = s.after && f.stops.find((o) => o.id === s.after);
    if ((before && !settled(before)) || (s.progress && read < s.progress)) {
      pending = true;
      continue;
    }
    if (s.mode === "place") return { stop: s };
    if (s.mode === "reach") {
      const el = reached(f, s);
      if (el) return { stop: s, el };
      if (f.views.has(s.id)) pending = true;
      continue;
    }
    if (s.skip && safe(s.skip)) {
      markShown(s.id);
      continue;
    }
    const el = safe(() => s.target(ctx, f));
    if (!el || !el.isConnected) {
      markShown(s.id);
      continue;
    }
    // A stop that reveals its own target (a menu, a folded list) is judged by its host.
    if (s.ready ? !safe(() => s.ready(el)) : !s.prepare && !el.getClientRects().length) {
      if (s.ready) pending = true;
      else markShown(s.id);
      continue;
    }
    const host = s.host ? s.host() : el;
    if (!host || !shown(host)) {
      pending = true;
      continue;
    }
    const where = side(host);
    // Scrolled past: it waits for the next visit, unless it asks to be gone back to.
    if (where < 0 && !s.up) {
      markShown(s.id);
      continue;
    }
    return { stop: s, el, where };
  }
  return pending ? { pending: true } : null;
}

// ─── reading stops ───────────────────────────────────────────
function arm(f, s, attempt = 0) {
  let els = [];
  try {
    els = (s.targets(ctx) || []).filter(Boolean);
  } catch {}
  if (!els.length) {
    // Late content — a list drawn after a network answer, a decrypted article —
    // gets a couple more looks.
    if (attempt < 3) setTimeout(() => f.live && arm(f, s, attempt + 1), 2500 * (attempt + 1));
    return;
  }
  const v = { seen: new Map(), io: null };
  v.io = new IntersectionObserver(
    (entries) => {
      const now = performance.now();
      const h = window.innerHeight;
      for (const e of entries) {
        const ok = e.isIntersecting && (e.intersectionRatio >= s.ratio || e.intersectionRect.height >= h * 0.45);
        if (ok) {
          if (!v.seen.has(e.target)) v.seen.set(e.target, now);
        } else v.seen.delete(e.target);
      }
      if (v.seen.size) setTimeout(() => f.wake("reach"), T.DWELL + 60);
    },
    { threshold: [0, 0.3, 0.45, 0.6, 0.8, 1] },
  );
  for (const el of els.slice(0, 40)) v.io.observe(el);
  f.views.set(s.id, v);
}

function reached(f, s) {
  const v = f.views.get(s.id);
  if (!v) return null;
  const now = performance.now();
  for (const [el, since] of v.seen) {
    if (now - since < T.DWELL || !el.isConnected || ratioInView(el) < 0.3) continue;
    if (s.accept && !safe(() => s.accept(el, ctx))) continue;
    return el;
  }
  return null;
}

// ─── a stop ──────────────────────────────────────────────────
async function visit(f, { stop: s, el, where }) {
  if (where) {
    const got = await beckon(f, s, el, where < 0);
    if (got !== "arrived") return got;
    await free(f);
  }
  const { why, target } = await present(f, s, el);
  switch (why) {
    case "ok":
    case "acted":
    case "fulfilled":
      markDone(s.key);
      break;
    case "try":
      markDone(s.key);
      await attempt(f, s, target);
      break;
    case "more":
      markShown(s.id);
      await openTour(s.tour, { from: s.tourFrom || null, key: s.key });
      break;
    case "timeout":
    case "lost":
    case "gone":
      markShown(s.id);
      break;
    default:
      // later: said again on the next page; busy, greet: as soon as the page is free.
      break;
  }
  return why;
}

async function present(f, s, el) {
  const u = ui;
  const a = { stop: s, resolve: null, outcome: null, target: null, anchor: null, timer: 0, onTarget: null, cleanup: null };
  f.answer = a;
  try {
    if (s.prepare && el) a.cleanup = s.prepare(el, ctx) || null;
    if (s.settle) await f.run.wait(s.settle);

    let target = null;
    let anchor;
    if (s.mode === "place") {
      const seed = { x: Math.random(), y: Math.random() };
      anchor = () => placePoint(s.at, seed);
    } else {
      target = s.resolve ? s.resolve(el, ctx) : el;
      if (!target || !target.isConnected || !shown(target) || ratioInView(target) < 0.3) return { why: "lost" };
      anchor = anchorOf(target, typeof s.point === "function" ? s.point(target) : s.point);
    }
    const text = s.text(ctx, target);
    if (!text || (!text.title && !text.body)) return { why: "gone" };
    a.target = target;
    a.anchor = anchor;

    // Laid out before the flight, so the cursor arrives facing the side the
    // finished bubble fits on.
    const tryable = !!s.tryIt && !s.tour && (!s.canTry || !!safe(() => s.canTry(target)));
    u.cursor.rest(false);
    u.callout.prepare({
      id: s.id,
      colon: t("colon", ": "),
      title: text.title,
      body: text.body,
      ok: t(s.ok || "understand"),
      more: s.tour ? t("more") : "",
      try: tryable ? t("lets_try") : "",
      later: t("later"),
      wait: T.ANSWER,
    });
    await f.run.guard(u.cursor.flyTo(anchor, { appear: s.mode === "place" }));
    if (target && !target.isConnected) return { why: "lost" };
    if (overlayOpen()) return { why: "busy" };
    if (f.greet) return { why: "greet" };

    u.callout.speak();
    announce(`${text.title ? `${text.title}. ` : ""}${u.callout.text}`);
    // Pressing the very thing the stop is about is the best answer there is.
    if (target) {
      a.onTarget = () => a.resolve && a.resolve("acted");
      target.addEventListener("click", a.onTarget, true);
    }
    return { why: await f.run.guard(answer(f, a)), target };
  } finally {
    clearInterval(a.timer);
    if (a.onTarget && a.target) a.target.removeEventListener("click", a.onTarget, true);
    if (a.cleanup) safe(a.cleanup);
    if (f.answer === a) f.answer = null;
    if (ui) ui.callout.close();
  }
}

function answer(f, a) {
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
      if (!f.live) return a.resolve("stop");
      if (f.greet) return a.resolve("greet");
      if (a.target) {
        if (!a.target.isConnected) return a.resolve("lost");
        // The cursor measures its target every frame; its rect costs nothing here.
        if (rectRatio(a.anchor.rect) < 0.3) {
          lostFor += dt;
          if (lostFor > 700) return a.resolve("lost");
        } else lostFor = 0;
      }
      if (a.stop.fulfilled && safe(() => a.stop.fulfilled(ctx))) return a.resolve("fulfilled");
      if (overlayOpen()) return a.resolve("busy");

      // The clock starts once everything has been said.
      const c = ui.callout;
      if (!c.ready || c.held || document.hidden) return;
      elapsed += dt;
      if (a.target && nudges < 2 && elapsed > T.NUDGE * (nudges + 1)) {
        nudges++;
        ui.cursor.nudge();
      }
      if (elapsed >= T.ANSWER) a.resolve("timeout");
    }, 200);
  });
}

/** What a stop's Let's try is handed: the cursor's press, a pause, and the inbox route. */
function hands(f) {
  const c = ui.cursor;
  return {
    press: async (el, fx = 0.5, fy = 0.55) => {
      if (!el || !el.isConnected) return false;
      await f.run.guard(c.flyTo(anchorOf(el, [fx, fy])));
      c.press();
      await f.run.wait(170);
      return el.isConnected;
    },
    wait: (ms) => f.run.wait(ms),
    explore: (follow = false) => f.run.guard(explore(follow)),
  };
}

/** Let's try: the stop's own action, pressed by the cursor. */
async function attempt(f, s, target) {
  const g = hands(f);
  try {
    await s.tryIt(target, g, ctx);
  } catch (e) {
    if (isCancel(e)) throw e;
    console.error("[guide] Let's try failed", e);
  }
  // Let what it started — an overlay, a scroll, a page turn — begin first.
  await f.run.wait(600);
}

/** Waiting at the edge the target will come in by, asking for the scroll. */
async function beckon(f, s, el, up) {
  const u = ui;
  const c = u.cursor;
  c.rest(true);
  const say = t(s.prompt || (up ? "prompt_up" : "prompt_down"));
  u.callout.prepare({ id: `${s.id}:scroll`, colon: t("colon", ": "), title: "", body: say, later: t("later"), wait: 0 });
  await f.run.guard(c.flyTo(() => edgePoint(el, up)));
  u.callout.speak();
  announce(u.callout.text);

  const a = { stop: s, resolve: null, outcome: null, timer: 0 };
  f.answer = a;
  try {
    return await f.run.guard(
      new Promise((resolve) => {
        const since = performance.now();
        let bobbed = since;
        let folded = false;
        a.resolve = (why) => {
          if (a.outcome) return;
          a.outcome = why;
          clearInterval(a.timer);
          resolve(why);
        };
        a.timer = setInterval(() => {
          if (!f.live) return a.resolve("stop");
          if (f.greet) return a.resolve("greet");
          if (!el.isConnected) return a.resolve("gone");
          if (overlayOpen()) return a.resolve("busy");
          if (side(el) === 0) return a.resolve("arrived");
          const now = performance.now();
          if (!folded && now - since > T.PROMPT) {
            folded = true;
            u.callout.close();
          }
          if (!document.hidden && now - bobbed > T.BOB) {
            bobbed = now;
            c.bob(up ? -1 : 1);
          }
        }, 150);
      }),
    );
  } finally {
    clearInterval(a.timer);
    if (f.answer === a) f.answer = null;
    u.callout.close();
  }
}

// ─── the reader, away and idle ───────────────────────────────
async function welcome(f) {
  const u = ensureUI();
  const c = u.cursor;
  c.rest(true);
  u.callout.prepare({ id: "welcome", colon: t("colon", ": "), title: "", body: t("welcome"), wait: 0 });
  await f.run.guard(c.flyTo(() => placePoint("centre"), { appear: !c.visible }));
  u.callout.speak();
  announce(u.callout.text);
  await f.run.wait(T.WELCOME);
  u.callout.close();
}

function idleDue(f) {
  if (f.quiet || f.idles >= T.IDLES || document.hidden || overlayOpen() || typing()) return false;
  if (performance.now() - Math.max(lastInput, lastScroll, lastMove) < T.IDLE) return false;
  const m = getMetrics();
  return m.docH - m.viewportH > 200 && m.scrollY + m.viewportH < m.docH - 120;
}

/** Idle and not at the foot of the page: an invitation to read on. */
async function invite(f) {
  f.idles++;
  const u = ensureUI();
  const c = u.cursor;
  c.rest(true);
  u.callout.prepare({ id: "idle", colon: t("colon", ": "), title: "", body: t("prompt_idle"), later: t("later"), wait: 0 });
  await f.run.guard(c.flyTo(() => ({ x: vw() * 0.5, y: vh() - 104 }), { appear: !c.visible }));
  u.callout.speak();
  announce(u.callout.text);

  const from = lastScroll;
  const a = { resolve: null, outcome: null, timer: 0 };
  f.answer = a;
  try {
    return await f.run.guard(
      new Promise((resolve) => {
        const since = performance.now();
        let bobbed = since;
        a.resolve = (why) => {
          if (a.outcome) return;
          a.outcome = why;
          clearInterval(a.timer);
          resolve(why);
        };
        a.timer = setInterval(() => {
          if (!f.live) return a.resolve("stop");
          if (f.greet) return a.resolve("greet");
          if (lastScroll > from) return a.resolve("scrolled");
          if (overlayOpen()) return a.resolve("busy");
          const now = performance.now();
          if (now - since > T.PROMPT) return a.resolve("timeout");
          if (!document.hidden && now - bobbed > T.BOB) {
            bobbed = now;
            c.bob(1);
          }
        }, 150);
      }),
    );
  } finally {
    clearInterval(a.timer);
    if (f.answer === a) f.answer = null;
    u.callout.close();
  }
}

// ─── the inbox, on request ───────────────────────────────────
/**
 * Walk the reader through their inbox — Let's Explore, or Let's try on the home
 * page's first stop — then carry on with the page. `follow`: a Follow was just
 * pressed, and the reader has to be a follower before there is an inbox.
 */
async function explore(follow = false) {
  if (follow && !(await becomeFollower())) return;
  let f = flow;
  if (!f || !f.live || !f.running) {
    begin();
    f = flow;
  }
  if (!f) return;
  f.quiet = false;
  f.detour = inbox;
  f.through = new Set();
  f.opened = false;
  f.wake("detour");
}

async function becomeFollower(ms = 15000) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    if (document.documentElement.classList.contains("blog-following")) return true;
    await sleep(250);
  }
  return false;
}

/** The detour's own stops, in order; the reader closing the inbox ends it early. */
async function detour(f) {
  const d = f.detour;
  if (!f.opened) {
    f.opened = true;
    await d.open(hands(f));
  }
  let waited = 0;
  for (;;) {
    const s = d.stops.find((x) => !f.through.has(x.id));
    if (!s || !d.alive()) break;
    const el = safe(() => s.target(ctx, f));
    // The inbox fills in after it opens: a stop with nothing to point at yet is
    // given a few seconds before it is passed by.
    if (!el || !el.isConnected) {
      if (waited < 4000) {
        waited += 250;
        await f.pause(250);
        continue;
      }
      f.through.add(s.id);
      waited = 0;
      continue;
    }
    waited = 0;
    if (s.skip && safe(s.skip)) {
      f.through.add(s.id);
      continue;
    }
    await free(f);
    if (f.greet) return "greet";
    const { why, target } = await present(f, s, el);
    if (why === "later") {
      f.detour = null;
      return why;
    }
    if (why === "busy" || why === "greet") return why;
    f.through.add(s.id);
    if (why === "try") await attempt(f, s, target);
    await f.run.wait(T.CHAIN);
  }
  f.detour = null;
  return "done";
}

/** × or Esc: nothing more on this page. */
function hush(f) {
  f.quiet = true;
  leave();
}

function onAction(act) {
  const a = flow && flow.answer;
  if (a && a.resolve) a.resolve(act);
}

// ─── walkthroughs ────────────────────────────────────────────
async function tours() {
  if (!toursModule) toursModule = await import("./tours.js");
  return toursModule;
}

async function openTour(id, { from = null, key = null } = {}) {
  if (opening) return;
  opening = true;
  const u = ensureUI();
  let result = null;
  try {
    await loadStrings();
    const mod = await tours();
    result = await mod.openTour(id, ctx || readContext(), { from, cursor: u.cursor });
    if (result && result.completed && key) markDone(key);
  } catch (e) {
    console.error("[guide] the walkthrough could not open", e);
  } finally {
    opening = false;
  }
  closed(result);
}

// How a walkthrough ended: Let's Explore opens the inbox for the guide to walk
// through; Follow has handed over to the page's own Follow, and the inbox waits
// for it to land.
function closed(result) {
  if (!result) return;
  if (result.explore) explore();
  else if (result.follow) explore(true);
}

async function openMenu() {
  if (opening) return;
  opening = true;
  const u = ensureUI();
  let reset = false;
  let result = null;
  try {
    await loadStrings();
    const mod = await tours();
    result = await mod.openMenu(ctx || readContext(), { cursor: u.cursor });
    reset = !!(result && result.reset);
  } catch (e) {
    console.error("[guide] the guide menu could not open", e);
  } finally {
    opening = false;
  }
  if (reset) {
    resetAll();
    begin();
  } else closed(result);
}

// ─── lifecycle ───────────────────────────────────────────────
function begin() {
  const my = ++token;
  if (flow) flow.end();
  ctx = readContext();
  if (!ctx) {
    flow = null;
    leave();
    return;
  }
  flow = new Flow(my);
  play(flow);
}

// A page turn: what was being said stops, and the cursor stays where it is to
// carry on on the next page.
function leaving() {
  token++;
  if (flow) flow.end();
  if (ui) {
    ui.callout.close();
    ui.cursor.hold();
  }
  if (toursModule) toursModule.closeAll();
}

function boot() {
  if (booted) return;
  booted = true;

  onRawScroll(() => {
    lastScroll = performance.now();
  });
  // A resting flow looks again as the page moves: a reading stop may be in view
  // now, or enough of the page read.
  onScroll(
    () => {
      if (flow && flow.waker) flow.wake("scroll");
    },
    null,
    "guide",
  );

  // Answering the guide is not the reader being busy with the page.
  const outside = (e) => !(e.target && e.target.closest && e.target.closest(".gd-layer"));
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (outside(e)) lastInput = performance.now();
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "pointermove",
    () => {
      lastMove = performance.now();
    },
    { passive: true },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (outside(e)) lastInput = performance.now();
      if (e.key === "Escape" && flow && flow.answer && !overlayOpen()) onAction("later");
    },
    true,
  );
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".tool-guide")) {
      e.preventDefault();
      openMenu();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = performance.now();
      return;
    }
    const away = hiddenAt && performance.now() - hiddenAt >= T.AWAY;
    hiddenAt = 0;
    // Only a reader who has met the guide is welcomed back by it.
    if (away && flow && flow.live && !flow.quiet && isDone("intro")) {
      flow.greet = true;
      flow.wake("greet");
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
