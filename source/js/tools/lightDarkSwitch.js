import { main } from "../main.js";
import { onScroll } from "./scrollScheduler.js";
import { inSlices } from "./frameSlices.js";
import * as mirror from "./themeMirror.js";
import * as giscus from "./giscusTwin.js";

/**
 * Light/dark switch.
 *
 * The scheme is `dark`/`light` on <html> (theme.styl) and `dark-mode`/`light-mode`
 * on <body>; head.ejs applies both before the first paint.
 *
 * A ring opens from the button with the new scheme inside, while outside the old
 * one dims or lifts and melts away. Both sides are live: outside is the page,
 * inside is tools/themeMirror.js, a copy kept in step and already styled in the
 * other scheme. Once the ring covers the screen the page is switched under it
 * and the copy is put away. Pressed again mid-way, every animation runs
 * backwards and the ring closes into the button.
 *
 * Dimming, lifting and the new page's tone are layers whose opacity animates on
 * the compositor: black at opacity a is brightness 1 - a, and grey g under
 * color-dodge divides by 1 - g, a brightness above 1.
 */

const root = document.documentElement;
const DURATION = 700;
// Reduced motion: the melt alone.
const FADE = 240;
const WAVE = "cubic-bezier(.5, 0, .2, 1)";
const MELT = "cubic-bezier(.4, 0, .7, .7)";
const SHADE = "cubic-bezier(.2, .8, .2, 1)";
const RING =
  "radial-gradient(circle at var(--theme-x) var(--theme-y), #000 var(--theme-r), rgb(0 0 0 / var(--theme-m)) calc(var(--theme-r) + 1.5px))";
const SOLID = "linear-gradient(#000 0 0)";
const MASK = ["maskImage", "maskSize", "maskPosition", "maskRepeat", "maskComposite"];
// How long the copy keeps covering the comments while their frame changes theme.
const LAND = 400;

// The old page's brightness at the end, and the new page's at the start.
const shadeOf = (dark) => (dark ? 0.9 : 1.12);
const toneOf = (dark) => (dark ? 1.12 : 0.95);

const isDark = () => root.classList.contains("dark");
const button = () => document.querySelector(".side-tools-container .tool-dark-light-toggle");
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

let run = null; // the switch on screen
let next = null; // a scheme asked for while one was ending

// Where the switch on screen is going, after any reversal.
const heading = (r) => (r.dir > 0 ? r.to : !r.to);
const wanted = () => next ?? (run ? heading(run) : isDark());

function apply(dark) {
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", !dark);
  root.style.colorScheme = dark ? "dark" : "light";
  document.body.classList.toggle("dark-mode", dark);
  document.body.classList.toggle("light-mode", !dark);
  main.styleStatus.isDark = dark;
  try {
    main.setStyleStatus();
  } catch (e) {}
}

const announce = (dark) =>
  window.dispatchEvent(new CustomEvent("redefine:color-scheme-change", { detail: { isDark: dark } }));

/*
 * The page takes a scheme in one style pass. A palette change reaches every
 * element through inherited colour anyway, so nothing smaller exists; the pass
 * runs while the copy covers the screen. Every element has a colour transition
 * (basic.styl), so <html> holds `--tg`/`--tgd` at zero for that pass, then hands
 * the hold to bounded subtrees (`data-tg`, the same value, so they are not
 * restyled again), which let it go a share per frame once the switch is over.
 */
const marks = new Map(); // subtrees holding their colour transitions -> size
const forceStyle = () => getComputedStyle(document.body).color;
let restoring = 0;

function land(dark) {
  restoring++;
  root.classList.add("theme-switching");
  apply(dark);
  announce(dark);
  forceStyle();
  for (const [el, size] of mirror.partition(document.body)) {
    el.setAttribute("data-tg", "");
    marks.set(el, size);
  }
  root.classList.remove("theme-switching");
}

function restore() {
  const token = ++restoring;
  inSlices(
    [...marks],
    (el) => {
      el.removeAttribute("data-tg");
      marks.delete(el);
    },
    forceStyle,
    () => token === restoring && !run,
  );
}

// The wave starts at the button, or at its rail's corner when the button is
// out of sight (a system switch, a collapsed rail).
function origin(btn) {
  const w = innerWidth;
  const h = innerHeight;
  const seen = (r) => r && r.width && r.right > 0 && r.bottom > 0 && r.left < w && r.top < h;
  let r = btn && btn.isConnected && btn.getBoundingClientRect();
  if (!seen(r)) r = document.querySelector(".side-tools-container .toggle-tools-list")?.getBoundingClientRect();
  const x = seen(r) ? r.left + r.width / 2 : w;
  const y = seen(r) ? r.top + r.height / 2 : h;
  return { x, y, radius: Math.hypot(Math.max(x, w - x), Math.max(y, h - y)) + 2 };
}

/*
 * The toggle's glyphs trade places on a spin, the leaving one first: out in
 * 220ms, the arriving one 80ms later with a slight overshoot. Every change of
 * direction starts both from where they ACTUALLY are and keeps that order —
 * running the spin backwards instead put the arriving glyph's slow exit after
 * the leaving glyph's quick return, and both showed at once.
 */
const SHOWN = { o: 1, r: 0, s: 1 };
const asFrame = (p, at) => ({ offset: at, opacity: p.o, transform: `rotate(${p.r}deg) scale(${p.s})` });
const mix = (a, b, t) => ({ o: a.o + (b.o - a.o) * t, r: a.r + (b.r - a.r) * t, s: a.s + (b.s - a.s) * t });
const spins = new WeakMap(); // glyph -> { anim, path }
let glyphAnims = [];

function poseOf(el, shown) {
  const spin = spins.get(el);
  const t = spin && spin.anim.playState !== "idle" ? spin.anim.effect.getComputedTiming().progress : null;
  if (t == null) return shown ? SHOWN : { o: 0, r: 90, s: 0.4 };
  const path = spin.path;
  for (let i = 1; i < path.length; i++) {
    if (t <= path[i].at) return mix(path[i - 1].p, path[i].p, (t - path[i - 1].at) / (path[i].at - path[i - 1].at));
  }
  return path[path.length - 1].p;
}

function spin(el, path, duration, easing, delay) {
  spins.get(el)?.anim.cancel();
  const anim = el.animate(path.map(({ at, p }) => asFrame(p, at)), { duration, easing, delay, fill: "both" });
  spins.set(el, { anim, path });
  glyphAnims.push(anim);
}

// `back`: the switch was taken back, so the spin turns the other way.
function turnGlyphs(dark, back) {
  if (reducedMotion()) return;
  const sign = back ? -1 : 1;
  glyphAnims = [];
  for (const btn of document.querySelectorAll(".tool-dark-light-toggle")) {
    const moon = btn.querySelector(".theme-icon-moon");
    const sun = btn.querySelector(".theme-icon-sun");
    if (!moon || !sun) continue;
    const [come, go] = dark ? [sun, moon] : [moon, sun];
    // Read both before either is restarted.
    const fromGo = poseOf(go, (go === sun) === isDark());
    const fromCome = poseOf(come, (come === sun) === isDark());
    // Already where it is going (taken back before it moved).
    if (fromGo.o === 0 && fromCome === SHOWN) continue;
    spin(go, [{ at: 0, p: fromGo }, { at: 1, p: { o: 0, r: -90 * sign, s: 0.4 } }], 220, "cubic-bezier(.4, 0, 1, 1)", 0);
    const start = fromCome.o > 0.01 ? fromCome : { o: 0, r: 90 * sign, s: 0.4 };
    spin(
      come,
      [{ at: 0, p: start }, { at: 0.65, p: { o: 1, r: -12 * sign, s: 1.08 } }, { at: 1, p: SHOWN }],
      380,
      "cubic-bezier(.2, .8, .2, 1)",
      start.o > 0.5 ? 0 : 80,
    );
  }
}

// Once the spin is over and the scheme final, the stylesheet shows the glyph.
function settleGlyphs() {
  const list = glyphAnims;
  Promise.all(list.map((a) => a.finished)).then(() => {
    if (list !== glyphAnims || run) return;
    list.forEach((a) => a.cancel());
    glyphAnims = [];
  }, () => {});
}

/* ─── layers and masks ────────────────────────────────────────────────────── */

// Dims or lifts the real page under the copy as the old scheme gives way.
const shade = document.createElement("div");
shade.className = "theme-shade";

// A layer that, at full opacity, brings what is under it to brightness `b`;
// returns that opacity.
function veil(el, b) {
  const s = el.style;
  if (b < 1) {
    s.background = "#000";
    s.mixBlendMode = "normal";
    return 1 - b;
  }
  const g = Math.round(255 * (1 - 1 / b));
  s.background = `rgb(${g}, ${g}, ${g})`;
  s.mixBlendMode = "color-dodge";
  return 1;
}

const shape = ({ w, h, round }) =>
  round
    ? `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'%3E%3Crect width='100%25' height='100%25' rx='${round}'/%3E%3C/svg%3E")`
    : SOLID;

// A mask of `base` with rectangles cut out of it, or of the rectangles alone.
function cut(el, base, list) {
  const s = el.style;
  const layers = base ? [{ base }, ...list] : list;
  s.maskImage = layers.map((o) => o.base || shape(o)).join(", ");
  s.maskSize = layers.map((o) => (o.base ? "100% 100%" : `${o.w}px ${o.h}px`)).join(", ");
  s.maskPosition = layers.map((o) => (o.base ? "0 0" : `${o.x}px ${o.y}px`)).join(", ");
  s.maskRepeat = "no-repeat";
  s.maskComposite = layers.map((o, i) => (base && i === 0 ? "subtract" : "add")).join(", ");
}

function uncut(el) {
  for (const p of MASK) el.style[p] = "";
}

function centre(el, x, y) {
  el.style.setProperty("--theme-x", `${x}px`);
  el.style.setProperty("--theme-y", `${y}px`);
}

// The copy and the shade cover the document; the ring stays on the button
// while the page scrolls under it.
function measure(r, m) {
  r.w = Math.max(root.scrollWidth, root.clientWidth);
  r.h = Math.max(m ? m.docH : root.scrollHeight, root.clientHeight);
  r.x = r.at.x + scrollX;
  r.y = r.at.y + scrollY;
}

function place(r) {
  for (const el of [r.host, shade]) {
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
  }
  centre(r.host, r.x, r.y);
}

/* ─── the switch ──────────────────────────────────────────────────────────── */

function startLive(dark, btn) {
  const r = { to: dark, dir: 1, anims: [], ended: false, reduced: reducedMotion(), at: origin(btn) };
  run = r;
  const list = mirror.holes();
  const { host, tone } = mirror.show();
  r.host = host;
  measure(r, null);
  place(r);
  cut(host, RING, list);
  r.unfollow = onScroll((m) => measure(r, m), () => place(r), "theme-switch");
  turnGlyphs(dark, false);

  const add = (target, frames, duration, easing) => {
    r.anims.push(target.animate(frames, { duration, easing, fill: "both" }));
  };
  if (r.reduced) {
    host.style.setProperty("--theme-r", "-2px");
    add(host, { "--theme-m": [0, 1] }, FADE, "ease");
  } else {
    add(host, { "--theme-r": ["-2px", `${r.at.radius}px`] }, DURATION, WAVE);
    add(host, { "--theme-m": [0, 1] }, DURATION, MELT);
    add(tone, { opacity: [veil(tone, toneOf(dark)), 0] }, DURATION, SHADE);
    add(shade, { opacity: [0, veil(shade, shadeOf(dark))] }, DURATION, SHADE);
    if (list.length) cut(shade, SOLID, list);
    else uncut(shade);
    root.append(shade);
  }
  r.anims[0].finished.then(() => end(r), () => {});
}

// Resolves after `ms`, or as soon as another switch is asked for.
function linger(ms) {
  return new Promise((resolve) => {
    const started = performance.now();
    const tick = () => (next !== null || performance.now() - started >= ms ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

async function end(r) {
  if (r.ended) return;
  r.ended = true;
  // Ring all the way out: the copy covers the screen, and the page is switched
  // under it. All the way back: the page never changed.
  if (r.dir > 0) {
    land(r.to);
    await nextFrame();
    // The comments' frame changes theme in its own process: the copy keeps
    // covering just them until it has.
    const frames = giscus.landing(r.to);
    if (frames.length) {
      shade.remove();
      cut(r.host, null, frames);
      await linger(LAND);
    }
  }
  r.unfollow();
  mirror.hide();
  uncut(r.host);
  r.host.style.width = r.host.style.height = "";
  r.host.style.removeProperty("--theme-r");
  shade.remove();
  r.anims.forEach((a) => a.cancel());
  finish();
}

// Glyphs settle, the copy goes over to the scheme the next switch would go to
// once the reader is still, and the page's held transitions come back.
function afterSwitch() {
  settleGlyphs();
  mirror.prepare();
  restore();
}

function finish() {
  run = null;
  const asked = next;
  next = null;
  if (asked !== null && asked !== isDark()) return start(asked, button());
  afterSwitch();
}

function turn(r) {
  r.dir = -r.dir;
  for (const a of r.anims) {
    a.reverse();
    a.updatePlaybackRate(r.dir);
  }
  turnGlyphs(heading(r), r.dir < 0);
}

// A tab nobody is looking at switches at once.
function instant(dark) {
  land(dark);
  giscus.landing(dark);
  turnGlyphs(dark, false);
  afterSwitch();
}

function start(dark, btn) {
  if (document.visibilityState !== "visible") return instant(dark);
  mirror.settle(dark);
  startLive(dark, btn);
}

// The scheme the reader asks for — mid-switch that turns the motion around, or
// waits for one that is already ending.
function request(dark, btn) {
  if (run) {
    if (run.ended) next = dark;
    else if (dark !== heading(run)) turn(run);
    return;
  }
  if (dark !== isDark()) start(dark, btn);
}

const bound = new WeakSet();
let systemBound = false;

function bind(el, events) {
  if (!el || bound.has(el)) return;
  bound.add(el);
  for (const [type, fn] of events) el.addEventListener(type, fn);
}

export default function initModeToggle() {
  main.getStyleStatus();
  main.styleStatus.isDark = isDark();
  if (!run) mirror.prepare();

  // The rail is inside #swup, so every page view brings a new button. The
  // pointer on it, or on the rail's opener, warms the copy for the press.
  const warm = () => mirror.warm();
  const btn = button();
  bind(btn, [
    // A press must not take the focus or selection: an editor would read that
    // as its block being left, and put its chrome away.
    [
      "pointerdown",
      (e) => {
        e.preventDefault();
        warm();
      },
    ],
    ["pointerenter", warm],
    ["focus", warm],
    ["click", () => request(!wanted(), btn)],
  ]);
  bind(document.querySelector(".side-tools-container .toggle-tools-list"), [["pointerdown", warm]]);

  // Once: matchMedia hands back a new list each call, and one listener per
  // navigation would switch once per page visited.
  if (systemBound) return;
  systemBound = true;
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", (e) =>
    request(e.matches, button()),
  );
}
