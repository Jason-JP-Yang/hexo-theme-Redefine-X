/**
 * Pull to refresh — one gesture on every platform.
 *
 * An installed app on iOS and iPadOS has no way to reload at all, a macOS web
 * app keeps it in a menu, and every browser that has a pull has its own. This is
 * the one gesture everywhere: at the very top of a page, pull down with a finger
 * — or keep scrolling up with a trackpad or wheel — and a tile in the side
 * tools' shape slides out from under the navbar, its outline closing as the pull
 * deepens. Past the threshold it floods with the primary colour and its arrow
 * turns; letting go reloads the whole page.
 *
 * The resistance is deliberate. The tile's travel is an exponential of the
 * input, so arming it takes about 200px of finger — a pull, never a stray
 * scroll — and a wheel stream only counts if it BEGAN at the top: momentum
 * carried up from further down the page never becomes a pull.
 *
 * The browser's own pull is switched off only while the first screen is showing
 * (`html.ptr-zone`, pull-refresh.styl), which is what gives this one precedence
 * without costing the rubber band at the foot of a long page.
 */

import { onScroll, requestScrollPass } from "./scrollScheduler.js";

const TILE = 42; // the side tools' button
const MAX = 132; // travel the pull tends towards and never reaches
const ARM = 78; // travel at which letting go reloads
const REST = 62; // where the tile holds while the page reloads
const RESIST = 220; // input for 63% of MAX
const WHEEL_GAIN = 0.55; // a wheel notch is a smaller pull than a finger's travel
const LOCK = 8; // px of touch travel before it is read as a pull or not
const PRESS_MS = 450; // a touch held still this long is a press, not a pull
const STREAM_MS = 300; // wheel silence that starts a new stream
const QUIET_MS = 220; // wheel silence that counts as letting go: notches of a spun wheel land inside it
const RELOAD_DELAY = 240; // the tile is seen to settle before the page goes

const travel = (p) => MAX * (1 - Math.exp(-p / RESIST));
const inputFor = (d) => -RESIST * Math.log(1 - Math.min(d, MAX - 0.5) / MAX);
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
const easeBack = (k) => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);

let booted = false;
let el = null;
let paths = [];
let glyph = null;

let phase = "idle"; // idle | pulling | settling | reloading
let d = 0;
let armed = false;
let top = 0;
let frame = 0;
let tween = null;

let touch = null;
const wheel = { last: -Infinity, ok: false, p: 0, quiet: 0 };

function build() {
  el = document.createElement("div");
  el.className = "pull-refresh";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML =
    '<div class="pull-refresh-tile">' +
    '<svg class="pull-refresh-frame" viewBox="0 0 42 42">' +
    '<path pathLength="100" d="M21 1H30A11 11 0 0 1 41 12V30A11 11 0 0 1 30 41H21"/>' +
    '<path pathLength="100" d="M21 1H12A11 11 0 0 0 1 12V30A11 11 0 0 0 12 41H21"/>' +
    "</svg>" +
    '<span class="pull-refresh-glyph"><i class="pull-refresh-arrow fa-solid fa-arrow-down"></i></span>' +
    '<svg class="pull-refresh-spinner" viewBox="0 0 42 42"><circle cx="21" cy="21" r="8" pathLength="100"/></svg>' +
    "</div>";
  document.body.appendChild(el);
  paths = Array.from(el.querySelectorAll(".pull-refresh-frame path"));
  glyph = el.querySelector(".pull-refresh-glyph");
}

// ─── rendering ───────────────────────────────────────────────
function paint() {
  const q = phase === "reloading" ? 1 : Math.min(1, d / ARM);
  const scale = 0.7 + 0.3 * (1 - (1 - q) * (1 - q));
  el.classList.toggle("is-active", d > 0.5 || phase === "reloading");
  el.style.transform = `translate3d(-50%, ${(top - TILE + d).toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
  el.style.opacity = Math.min(1, d / (TILE * 0.55)).toFixed(3);
  const offset = (100 - q * 100).toFixed(2);
  paths.forEach((path) => (path.style.strokeDashoffset = offset));
  glyph.style.opacity = Math.min(1, Math.max(0, (q - 0.12) / 0.4)).toFixed(3);
  glyph.style.transform = `translateY(${((1 - Math.min(1, q / 0.6)) * -7).toFixed(2)}px)`;
}

function request() {
  if (frame) return;
  frame = requestAnimationFrame((now) => {
    frame = 0;
    if (tween) tween(now);
    paint();
    if (tween) request();
  });
}

function animate(to, ms, ease, done) {
  const from = d;
  let start = 0;
  tween = (now) => {
    start = start || now;
    const k = Math.min(1, (now - start) / ms);
    d = from + (to - from) * ease(k);
    if (k < 1) return;
    tween = null;
    if (done) done();
  };
  request();
}

function setArmed(on) {
  if (on === armed) return;
  armed = on;
  el.classList.toggle("is-armed", on);
  if (!on) return;
  try {
    if (navigator.userActivation && navigator.userActivation.hasBeenActive) navigator.vibrate(8);
  } catch {}
}

// ─── the pull ────────────────────────────────────────────────
function atTop() {
  return (window.scrollY || document.documentElement.scrollTop || 0) <= 0.5;
}

/** Whether a gesture that starts on `target` belongs to the page, not to a panel over it. */
function eligible(target) {
  const root = document.documentElement;
  if (root.classList.contains("blog-editing") || root.classList.contains("is-changing")) return false;
  const vv = window.visualViewport;
  if (vv && (vv.scale > 1.01 || vv.offsetTop > 0.5)) return false;
  const preloader = document.querySelector(".preloader");
  if (preloader && preloader.style.display !== "none") return false;
  if (getComputedStyle(root).overflowY === "hidden" || getComputedStyle(document.body).overflowY === "hidden") {
    return false;
  }
  for (let node = target instanceof Element ? target : null; node && node !== document.body; node = node.parentElement) {
    if (node.matches("input, textarea, select, [contenteditable]:not([contenteditable='false']), [data-no-pull]")) {
      return false;
    }
    const style = getComputedStyle(node);
    // A fixed layer is a panel over the page — the navbar the tile comes out of excepted.
    if (style.position === "fixed" && !node.classList.contains("main-content-header")) return false;
    if (/auto|scroll|overlay/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return false;
  }
  return true;
}

function begin() {
  const input = phase === "settling" ? inputFor(d) : 0;
  tween = null;
  phase = "pulling";
  const header = document.querySelector(".main-content-header");
  top = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
  return input;
}

function pullTo(p) {
  d = travel(Math.max(0, p));
  setArmed(d >= ARM);
  request();
}

function release(commit) {
  if (phase !== "pulling") return;
  if (commit && armed) return reload();
  phase = "settling";
  setArmed(false);
  animate(0, 180 + d * 1.2, easeOut, () => {
    phase = "idle";
    d = 0;
  });
}

function reload() {
  phase = "reloading";
  el.classList.add("is-refreshing");
  animate(REST, 420, easeBack);
  setTimeout(() => location.reload(), RELOAD_DELAY);
}

// ─── touch ───────────────────────────────────────────────────
function findTouch(list) {
  for (let i = 0; i < list.length; i++) if (list[i].identifier === touch.id) return list[i];
  return null;
}

function onTouchStart(event) {
  if (phase === "reloading") return;
  if (event.touches.length !== 1) {
    if (touch && touch.pulling) release(false);
    touch = null;
    return;
  }
  if (!atTop() || !eligible(event.target)) return;
  const t = event.touches[0];
  touch = { id: t.identifier, x: t.clientX, y: t.clientY, at: event.timeStamp, pulling: false, base: 0 };
}

function onTouchMove(event) {
  if (!touch) return;
  const t = findTouch(event.touches);
  if (!t) return;
  const dx = t.clientX - touch.x;
  const dy = t.clientY - touch.y;

  if (!touch.pulling) {
    if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return;
    const selection = window.getSelection && window.getSelection();
    if (
      dy <= 0 ||
      Math.abs(dx) > Math.abs(dy) ||
      event.timeStamp - touch.at > PRESS_MS ||
      (selection && !selection.isCollapsed) ||
      !atTop()
    ) {
      touch = null;
      return;
    }
    touch.pulling = true;
    touch.base = begin();
  }

  // The page scrolled under the finger: whatever this was, it is not a pull any more.
  if (!atTop()) {
    touch = null;
    return release(false);
  }
  pullTo(touch.base + dy);
}

function onTouchEnd(event) {
  if (!touch || !findTouch(event.changedTouches)) return;
  const pulling = touch.pulling;
  touch = null;
  if (pulling) release(event.type === "touchend");
}

// ─── wheel and trackpad ──────────────────────────────────────
function onWheel(event) {
  if (phase === "reloading" || event.ctrlKey || event.shiftKey) return;
  if (event.timeStamp - wheel.last > STREAM_MS) wheel.ok = null;
  wheel.last = event.timeStamp;
  // A stream is judged by its first vertical movement: a trackpad often opens
  // with a few events that carry none.
  if (wheel.ok === null) {
    if (!event.deltaY) return;
    wheel.ok =
      event.deltaY < 0 && Math.abs(event.deltaY) >= Math.abs(event.deltaX) && atTop() && eligible(event.target);
  }
  if (!wheel.ok) return;
  if (!atTop()) {
    wheel.ok = false;
    return release(false);
  }

  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
  const delta = -event.deltaY * unit * WHEEL_GAIN;
  if (phase !== "pulling") {
    if (delta <= 0) return;
    wheel.p = begin();
  }
  wheel.p = Math.max(0, wheel.p + delta);
  pullTo(wheel.p);

  // A trackpad's momentum trails off in sub-pixel steps; only a real movement
  // keeps the pull held.
  if (Math.abs(event.deltaY) * unit < 2 && wheel.quiet) return;
  clearTimeout(wheel.quiet);
  wheel.quiet = setTimeout(() => {
    wheel.quiet = 0;
    // The rest of this stream is momentum from the pull just ended.
    wheel.ok = false;
    release(true);
  }, QUIET_MS);
}

// ─── boot ────────────────────────────────────────────────────
export default function initPullRefresh() {
  if (booted || window.self !== window.top) return;
  booted = true;
  build();

  let zone = null;
  onScroll(
    null,
    (m) => {
      const next = m.scrollY < m.viewportH;
      if (next === zone) return;
      zone = next;
      document.documentElement.classList.toggle("ptr-zone", next);
    },
    "pull-refresh",
  );
  requestScrollPass();

  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchmove", onTouchMove, { passive: true });
  document.addEventListener("touchend", onTouchEnd, { passive: true });
  document.addEventListener("touchcancel", onTouchEnd, { passive: true });
  window.addEventListener("wheel", onWheel, { passive: true });
}
