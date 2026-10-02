import { main } from "../main.js";

/**
 * Light/dark switch.
 *
 * The scheme is `dark`/`light` on <html> (theme.styl's custom properties) and
 * `dark-mode`/`light-mode` on <body>. head.ejs applies both before the first
 * paint and CSS picks the toggle's glyph, so a page view costs nothing here.
 *
 * A switch is ONE style recalculation and one paint. The browser snapshots the
 * page, the new scheme lands with every CSS transition off (`theme-switching`),
 * and the new page is uncovered by a circle growing from the button while the
 * old one dims or lifts beneath it — all on composited snapshots. Animating the
 * colours themselves (the global `*` transition) recalculated and repainted
 * every element on every frame, which is what froze heavy pages.
 */

const root = document.documentElement;
const DURATION = 700;
const WAVE = "cubic-bezier(.5, 0, .2, 1)";
const SHADE = "cubic-bezier(.2, .8, .2, 1)";
// The glyph's turn (side-tools.styl) outlasts a switch with no reveal.
const ICON_TURN = 480;

const isDark = () => root.classList.contains("dark");
const button = () => document.querySelector(".side-tools-container .tool-dark-light-toggle");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const whenIdle = (fn) =>
  window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 800 }) : setTimeout(fn, 200);

let target = null; // the scheme a running switch goes to
let queued = null; // asked for while one was running
let giscusTimer = 0;

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

// The wave starts at the button, or at its rail's corner when the button is
// out of sight (a system switch, a collapsed rail).
function origin(btn) {
  const w = innerWidth;
  const h = innerHeight;
  const seen = (r) => r && r.width && r.right > 0 && r.bottom > 0 && r.left < w && r.top < h;
  let r = btn && btn.getBoundingClientRect();
  if (!seen(r)) r = document.querySelector(".side-tools-container .toggle-tools-list")?.getBoundingClientRect();
  const x = seen(r) ? r.left + r.width / 2 : w;
  const y = seen(r) ? r.top + r.height / 2 : h;
  return { x, y, radius: Math.hypot(Math.max(x, w - x), Math.max(y, h - y)) + 2 };
}

function turnIcons(on) {
  for (const b of document.querySelectorAll(".tool-dark-light-toggle")) b.classList.toggle("is-turning", on);
}

// Listeners that redraw something heavy wait for `settled`, so the drawing
// never competes with the reveal.
function announce(dark, settled) {
  window.dispatchEvent(
    new CustomEvent("redefine:color-scheme-change", { detail: { isDark: dark, settled } }),
  );
}

// Giscus paints in its own frame, which only listens once it has loaded.
function giscus(tries = 0) {
  clearTimeout(giscusTimer);
  const frames = [...document.querySelectorAll("iframe.giscus-frame")];
  if (!frames.length && !document.getElementById("giscus-container")) return;
  if (!frames.length || frames.some((f) => f.classList.contains("giscus-frame--loading"))) {
    if (tries < 30) giscusTimer = setTimeout(giscus, 500, tries + 1);
    return;
  }
  const theme = isDark() ? "dark" : "light";
  for (const f of frames) {
    f.contentWindow?.postMessage({ giscus: { setConfig: { theme } } }, "https://giscus.app");
  }
}

function wave(dark, { x, y, radius }) {
  const at = `${x}px ${y}px`;
  try {
    root.animate(
      {
        clipPath: [`circle(0px at ${at})`, `circle(${radius}px at ${at})`],
        transform: ["scale(1.02)", "none"],
        transformOrigin: [at, at],
      },
      { duration: DURATION, easing: WAVE, pseudoElement: "::view-transition-new(root)" },
    );
    root.animate(
      { filter: ["none", dark ? "brightness(.86)" : "brightness(1.2)"] },
      { duration: DURATION, easing: SHADE, pseudoElement: "::view-transition-old(root)" },
    );
  } catch (e) {
    // No script-driven pseudo-element animation: the browser's cross-fade.
    root.classList.replace("theme-reveal", "theme-fade");
  }
}

async function play(dark, btn) {
  const at = origin(btn);
  let settle;
  const settled = new Promise((r) => (settle = r));
  const commit = () => {
    root.classList.add("theme-switching");
    apply(dark);
    turnIcons(true);
    announce(dark, settled);
    giscus();
  };

  if (!document.startViewTransition || document.visibilityState !== "visible") {
    commit();
    await wait(ICON_TURN);
  } else {
    const mode = matchMedia("(prefers-reduced-motion: reduce)").matches ? "theme-fade" : "theme-reveal";
    root.classList.add(mode);
    try {
      const vt = document.startViewTransition(commit);
      if (mode === "theme-reveal") vt.ready.then(() => wave(dark, at), () => {});
      await vt.finished.catch(() => {});
    } catch (e) {
      if (isDark() !== dark) commit();
    }
    root.classList.remove("theme-reveal", "theme-fade");
  }
  turnIcons(false);
  settle();
}

function switchTo(dark, btn) {
  if (target !== null) {
    queued = dark;
    return;
  }
  if (dark === isDark()) return;
  target = dark;
  play(dark, btn).finally(() => {
    target = null;
    const next = queued;
    queued = null;
    if (next !== null && next !== isDark()) return switchTo(next, btn);
    // Transitions come back once nothing is switching. Lifting the class is a
    // style pass over every element, so it waits for an idle moment.
    whenIdle(() => {
      if (target === null) root.classList.remove("theme-switching");
    });
  });
}

function toggle(btn) {
  const now = queued ?? target ?? isDark();
  switchTo(!now, btn);
}

const bound = new WeakSet();
let systemBound = false;

export default function initModeToggle() {
  main.getStyleStatus();
  main.styleStatus.isDark = isDark();

  // The rail is inside #swup, so every page view brings a new button.
  const btn = button();
  if (btn && !bound.has(btn)) {
    bound.add(btn);
    btn.addEventListener("click", () => toggle(btn));
  }

  // Once: matchMedia hands back a new list each call, and one listener per
  // navigation would switch once per page visited.
  if (systemBound) return;
  systemBound = true;
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", (e) =>
    switchTo(e.matches, button()),
  );
}
