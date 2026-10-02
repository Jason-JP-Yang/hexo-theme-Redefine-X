import { main } from "../main.js";
import * as mirror from "./themeMirror.js";

/**
 * Light/dark switch.
 *
 * The scheme is `dark`/`light` on <html> (theme.styl's custom properties) and
 * `dark-mode`/`light-mode` on <body>. head.ejs applies both before the first
 * paint and CSS picks the toggle's glyph, so a page view costs nothing here.
 *
 * A scheme lands in one style pass under `theme-switching`, which zeroes the
 * colour duration of the global `*` transition (`--tg`, animated.styl): no
 * element starts a colour transition — thousands of them froze heavy pages —
 * and every transition already running carries on untouched.
 *
 * The motion: a circle opens from the button with the new scheme inside it,
 * while outside the old one dims or lifts and melts away.
 *
 * Normally both sides are LIVE. The page stays the real page in the old scheme
 * the whole way, and the new scheme inside the ring is tools/themeMirror.js — a
 * copy of the page kept in step with it and already styled in the other
 * scheme, so showing it costs no style pass at all. Once the ring covers the
 * screen the page itself is switched under it a subtree per frame, and the
 * copy is put away.
 *
 * Until the copy is ready (straight after a page loads) the same motion runs
 * as a view transition that captures only the OLD state: a snapshot over the
 * real document, which stays painted and hit-tested (`theme-live`; a captured
 * root takes no input). There, input anywhere makes the snapshot hurry off.
 *
 * A switch is one reversible motion. Pressed again mid-way, every animation
 * runs backwards and the ring closes into the button; pressed again, it opens.
 * A ring that closes all the way leaves the snapshot covering the page, the old
 * scheme is restored under it and only then is the transition taken down — a
 * held animation keeps it up until that moment.
 */

const root = document.documentElement;
const DURATION = 700;
// Reduced motion: the melt alone.
const FADE = 240;
const WAVE = "cubic-bezier(.5, 0, .2, 1)";
const MELT = "cubic-bezier(.4, 0, .7, .7)";
const SHADE = "cubic-bezier(.2, .8, .2, 1)";
// Time left once the reader does something else mid-switch.
const HURRY = 160;
const OLD = "::view-transition-old(root)";
const INPUTS = ["pointerdown", "wheel", "touchstart", "keydown"];
// Elements re-styled per slice when the colour hold is lifted, or the page is
// switched under the copy.
const SLICE = 1500;

const isDark = () => root.classList.contains("dark");
const button = () => document.querySelector(".side-tools-container .tool-dark-light-toggle");
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const whenIdle = (fn) =>
  window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 800 }) : setTimeout(fn, 200);

let run = null; // the switch on screen
let next = null; // a scheme asked for while one was ending
let giscusTimer = 0;

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

/*
 * Colour transitions held off. `--tg`/`--tgd` are zeroed for the pass that lands
 * a scheme, and lifting them is a style pass over every element — a long task
 * right after the wave if done in one go. So the zero is carried by <html> AND by
 * bounded subtrees (`data-tg`): lifted from <html> first, only the thin spine
 * above the subtrees is re-styled (a subtree root whose own value is unchanged
 * stops the pass there), then the subtrees go a slice at a time while idle.
 */
let held = false;
let chunks = [];
let lifting = 0;

function holdColour() {
  if (held) return;
  held = true;
  lifting++;
  for (const [el] of chunks) el.removeAttribute("data-tg");
  chunks = mirror.partition(document.body);
  for (const [el] of chunks) el.setAttribute("data-tg", "");
  root.classList.add("theme-switching");
}

function releaseColour() {
  const token = ++lifting;
  const live = () => token === lifting && !run;
  whenIdle(() => {
    if (!live()) return;
    held = false;
    root.classList.remove("theme-switching");
    let i = 0;
    const slice = () => {
      if (!live()) return;
      for (let budget = SLICE; i < chunks.length && budget > 0; i++) {
        chunks[i][0].removeAttribute("data-tg");
        budget -= chunks[i][1];
      }
      if (i < chunks.length) whenIdle(slice);
      else chunks = [];
    };
    whenIdle(slice);
  });
}

const announce = (dark) =>
  window.dispatchEvent(new CustomEvent("redefine:color-scheme-change", { detail: { isDark: dark } }));

function land(dark) {
  holdColour();
  apply(dark);
  announce(dark);
}

// The page switched while the copy covers it, a slice of subtrees per frame
// (`data-scheme` carries the palette on each), then <html> and <body> last.
async function flipUnderCover(dark) {
  holdColour();
  const mode = dark ? "dark" : "light";
  for (let i = 0; i < chunks.length; ) {
    await nextFrame();
    for (let budget = SLICE; i < chunks.length && budget > 0; i++) {
      chunks[i][0].setAttribute("data-scheme", mode);
      budget -= chunks[i][1];
    }
  }
  await nextFrame();
  apply(dark);
  announce(dark);
  await nextFrame();
  for (const [el] of chunks) el.removeAttribute("data-scheme");
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

// Giscus re-themes in its own process, so it is told first; its frame only
// listens once loaded.
function giscus(tries = 0) {
  clearTimeout(giscusTimer);
  const frames = [...document.querySelectorAll("iframe.giscus-frame")];
  if (!frames.length && !document.getElementById("giscus-container")) return;
  if (!frames.length || frames.some((f) => f.classList.contains("giscus-frame--loading"))) {
    if (tries < 30) giscusTimer = setTimeout(giscus, 500, tries + 1);
    return;
  }
  for (const f of frames) postGiscus(f, wanted());
}

const giscusTheme = new WeakMap();
function postGiscus(frame, dark) {
  if (frame.classList.contains("giscus-frame--loading") || giscusTheme.get(frame) === dark) return;
  giscusTheme.set(frame, dark);
  frame.contentWindow?.postMessage({ giscus: { setConfig: { theme: dark ? "dark" : "light" } } }, "https://giscus.app");
}

// On the live path giscus shows through the copy, so it changes when the ring
// reaches it rather than when the switch starts.
function giscusRing(r, { x, y, radius }) {
  const p = r.master.effect.getComputedTiming().progress ?? 0;
  const reach = r.reduced ? (p >= 0.5 ? Infinity : -Infinity) : -2 + (radius + 2) * p;
  for (const f of document.querySelectorAll("iframe.giscus-frame")) {
    const b = f.getBoundingClientRect();
    postGiscus(f, Math.hypot(b.left + b.width / 2 - x, b.top + b.height / 2 - y) <= reach ? r.to : !r.to);
  }
}

// The new page's tone settling, drawn over the live document by a sheet that
// lets every pointer through.
const tone = document.createElement("div");
tone.className = "theme-tone";
const toneFrom = (dark) => (dark ? "brightness(1.12)" : "brightness(.95)");
// The old scheme dimming or lifting, over the real page and under the copy.
const shade = document.createElement("div");
shade.className = "theme-shade";

function turn(r) {
  r.dir = -r.dir;
  for (const a of r.anims) {
    a.reverse();
    a.updatePlaybackRate(r.dir);
  }
  turnGlyphs(heading(r), r.dir < 0);
  if (r.kind !== "live") giscus();
}

// Any input but the toggle means the reader wants the page back now.
function watchInput(r) {
  const go = (e) => {
    if (r.ended || e.target?.closest?.(".tool-dark-light-toggle")) return;
    const m = r.master;
    const left = r.dir > 0 ? m.effect.getComputedTiming().endTime - m.currentTime : m.currentTime;
    if (left <= HURRY) return;
    for (const a of r.anims) a.updatePlaybackRate((r.dir * left) / HURRY);
  };
  INPUTS.forEach((t) => addEventListener(t, go, { capture: true, passive: true }));
  r.unwatch = () => INPUTS.forEach((t) => removeEventListener(t, go, true));
}

function animate(r, { x, y, radius }) {
  const add = (target, frames, duration, easing, pseudoElement) => {
    const a = target.animate(frames, { duration, easing, pseudoElement, fill: "both" });
    r.anims.push(a);
    return a;
  };
  try {
    r.hold = root.animate({ "--theme-hold": ["0", "1"] }, { duration: 1e7, pseudoElement: OLD });
    if (r.reduced) {
      r.master = add(root, { opacity: [1, 0] }, FADE, "ease", OLD);
    } else {
      r.master = add(
        root,
        { "--theme-x": [`${x}px`, `${x}px`], "--theme-y": [`${y}px`, `${y}px`], "--theme-r": ["-2px", `${radius}px`] },
        DURATION,
        WAVE,
        OLD,
      );
      add(root, { opacity: [1, 0] }, DURATION, MELT, OLD);
      add(root, { filter: ["none", r.to ? "brightness(.9)" : "brightness(1.12)"] }, DURATION, SHADE, OLD);
      add(tone, { backdropFilter: [toneFrom(r.to), "brightness(1)"] }, DURATION, SHADE);
    }
  } catch (e) {
    // No script-driven pseudo-element animation here: the snapshot just goes.
    r.anims.forEach((a) => a.cancel());
    r.anims = [];
    return void end(r);
  }
  // Pressed again before the motion began: it starts already on its way back.
  if (r.dir < 0) {
    r.dir = 1;
    turn(r);
  }
  r.master.finished.then(() => end(r), () => {});
  watchInput(r);
}

function startLive(dark, btn) {
  const r = { kind: "live", to: dark, dir: 1, anims: [], ended: false, reduced: reducedMotion() };
  run = r;
  const at = origin(btn);
  const host = mirror.show();
  shade.style.backdropFilter = "";
  root.append(shade);
  turnGlyphs(dark, false);
  const add = (target, frames, duration, easing) => {
    const a = target.animate(frames, { duration, easing, fill: "both" });
    r.anims.push(a);
    return a;
  };
  if (r.reduced) {
    r.master = add(host, { "--theme-m": [0, 1] }, FADE, "ease");
  } else {
    r.master = add(
      host,
      { "--theme-x": [`${at.x}px`, `${at.x}px`], "--theme-y": [`${at.y}px`, `${at.y}px`], "--theme-r": ["-2px", `${at.radius}px`] },
      DURATION,
      WAVE,
    );
    add(host, { "--theme-m": [0, 1] }, DURATION, MELT);
    add(host, { filter: [toneFrom(dark), "brightness(1)"] }, DURATION, SHADE);
    add(shade, { backdropFilter: ["brightness(1)", dark ? "brightness(.9)" : "brightness(1.12)"] }, DURATION, SHADE);
  }
  r.master.finished.then(() => end(r), () => {});
  const tick = () => {
    if (run !== r || r.ended) return;
    giscusRing(r, at);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function endLive(r) {
  // Ring all the way out: the copy covers the screen, and the page is switched
  // under it. All the way back: the page never changed.
  if (r.dir > 0) await flipUnderCover(r.to);
  for (const f of document.querySelectorAll("iframe.giscus-frame")) postGiscus(f, isDark());
  await nextFrame();
  await nextFrame();
  mirror.hide();
  shade.remove();
  r.anims.forEach((a) => a.cancel());
}

async function end(r) {
  if (r.ended) return;
  r.ended = true;
  r.unwatch?.();
  if (r.kind === "live") {
    await endLive(r);
    return finish();
  }
  if (r.dir < 0) {
    // The ring has closed and the snapshot covers the page again: the old scheme
    // goes back under it before it is taken away.
    land(!r.to);
    await nextFrame();
    await nextFrame();
  }
  tone.getAnimations().forEach((a) => a.cancel());
  tone.remove();
  r.vt?.skipTransition();
  await r.vt?.finished.catch(() => {});
  r.hold?.cancel();
  r.anims.forEach((a) => a.cancel());
  root.classList.remove("theme-reveal", "theme-live");
  finish();
}

function finish() {
  run = null;
  const asked = next;
  next = null;
  if (asked !== null && asked !== isDark()) return start(asked, button());
  settleGlyphs();
  releaseColour();
  // The copy goes over to the scheme the next switch would go to.
  mirror.prepare();
}

function start(dark, btn) {
  const visible = document.visibilityState === "visible";
  if (visible && mirror.ready(dark)) return startLive(dark, btn);
  if (!document.startViewTransition || !visible) {
    land(dark);
    turnGlyphs(dark, false);
    settleGlyphs();
    giscus();
    releaseColour();
    mirror.prepare();
    return;
  }

  const r = { to: dark, dir: 1, anims: [], ended: false, reduced: reducedMotion() };
  run = r;
  giscus();
  const at = origin(btn);
  root.classList.add("theme-reveal");
  try {
    r.vt = document.startViewTransition(() => {
      // Skipped before it began, and already taken back: nothing to land.
      if (r.ended && r.dir < 0) return;
      root.classList.add("theme-live");
      if (!r.reduced) {
        tone.style.backdropFilter = toneFrom(dark);
        document.body.appendChild(tone);
      }
      land(dark);
      turnGlyphs(heading(r), r.dir < 0);
    });
  } catch (e) {
    land(dark);
    run = null;
    root.classList.remove("theme-reveal");
    releaseColour();
    mirror.prepare();
    return;
  }
  r.vt.ready.then(() => animate(r, at), () => end(r));
  // Taken down from outside (a hidden tab): the run ends with it.
  r.vt.finished.then(() => end(r), () => end(r));
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

export default function initModeToggle() {
  main.getStyleStatus();
  main.styleStatus.isDark = isDark();
  if (!run) mirror.prepare();

  // The rail is inside #swup, so every page view brings a new button.
  const btn = button();
  if (btn && !bound.has(btn)) {
    bound.add(btn);
    // A press must not take the focus or selection: an editor would read that
    // as its block being left, and put its chrome away.
    btn.addEventListener("pointerdown", (e) => e.preventDefault());
    btn.addEventListener("click", () => request(!wanted(), btn));
  }

  // Once: matchMedia hands back a new list each call, and one listener per
  // navigation would switch once per page visited.
  if (systemBound) return;
  systemBound = true;
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", (e) =>
    request(e.matches, button()),
  );
}
