/**
 * Keeping an installed app current.
 *
 * A browser tab gets reloaded by its reader; an app window does not. The site
 * installed to a Home Screen, the macOS Dock or as a Chrome/Edge app sits in the
 * background for days and comes back to the page it was left on, with the
 * notes, the inbox and the site itself as they were then. So an app window runs
 * one clock — every minute while it is on screen, and at once when it comes
 * back — and whatever shows live data subscribes to it with `onFresh`. A tab
 * runs none of this.
 *
 * The clock's own job is the build. `window.config.build` names the build this
 * document's scripts belong to, version.json the one the site serves now. Once
 * they differ, a page Swup fetched would be run by scripts that were not written
 * for it, so every later visit becomes a full page load, and the page reloads
 * itself wherever that interrupts nobody: while it is hidden, or on a return to
 * the top of a page nobody has touched since.
 */

const TICK_MS = 60 * 1000;
// Away for less than this is a glance at something else, not a return.
const AWAY_MS = 15 * 1000;
// The build a reload was last spent on. A page that comes back still naming the
// old build (an edge cache lagging the deploy) must not reload itself again.
const RELOADED_KEY = "redefine-x-reloaded-for";

const listeners = new Set();
let booted = false;
let timer = 0;
let hiddenAt = 0;
let returnedAt = 0;
let touchedAt = 0;
let latest = "";
let checking = false;

export function isStandalone() {
  try {
    return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

/** Run `fn` on the app clock. Registering in a browser tab is harmless: nothing ticks there. */
export function onFresh(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function swupInstance() {
  try {
    return typeof swup !== "undefined" ? swup : window.swup;
  } catch {
    return null;
  }
}

/** The reader is in the middle of something a reload would throw away. */
function occupied() {
  if (document.documentElement.classList.contains("blog-editing")) return true;
  const el = document.activeElement;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|IFRAME)$/.test(el.tagName));
}

function reloadIfUnseen() {
  if (!latest || occupied()) return;
  const hidden = document.visibilityState === "hidden";
  const untouched = returnedAt > 0 && touchedAt < returnedAt && window.scrollY <= 1;
  if (!hidden && !untouched) return;
  try {
    if (sessionStorage.getItem(RELOADED_KEY) === latest) return;
    sessionStorage.setItem(RELOADED_KEY, latest);
  } catch {}
  location.reload();
}

function goStale(build) {
  latest = build;
  const s = swupInstance();
  if (s && s.options) {
    try {
      s.cache.clear();
    } catch {}
    // Every link now leaves by the browser, so the page it lands on runs the new
    // build's scripts. A history step into a page Swup rendered is loaded for real.
    s.options.ignoreVisit = () => true;
    const skip = s.options.skipPopStateHandling;
    s.options.skipPopStateHandling = (event) => {
      if (!skip(event)) location.reload();
      return true;
    };
  }
  reloadIfUnseen();
}

async function checkBuild() {
  const mine = window.config && window.config.build;
  if (!mine || latest || checking) return;
  checking = true;
  try {
    const root = String(window.config.root || "/").replace(/\/*$/, "/");
    const res = await fetch(`${root}version.json?t=${Date.now()}`, { cache: "no-store" });
    const data = res.ok ? await res.json() : null;
    if (data && data.build && data.build !== mine) goStale(String(data.build));
  } catch {
    /* offline, or mid-deploy: the next tick asks again */
  } finally {
    checking = false;
  }
}

function tick(returned) {
  clearTimeout(timer);
  timer = setTimeout(scheduled, TICK_MS);
  if (returned) returnedAt = Date.now();
  checkBuild();
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.error("[freshness] a subscriber threw", err);
    }
  });
}

function scheduled() {
  if (document.visibilityState === "visible") return tick(false);
  // Hidden, only the build is worth asking about — and knowing it is what lets
  // the page reload where nobody sees it happen.
  timer = setTimeout(scheduled, TICK_MS);
  checkBuild();
}

export default function initFreshness() {
  if (booted || !isStandalone()) return;
  booted = true;
  timer = setTimeout(scheduled, TICK_MS);

  const touched = () => {
    touchedAt = Date.now();
  };
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach((type) =>
    window.addEventListener(type, touched, { capture: true, passive: true }),
  );

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      reloadIfUnseen();
    } else if (Date.now() - hiddenAt >= AWAY_MS) {
      tick(true);
    }
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) tick(true);
  });
  window.addEventListener("online", () => tick(false));
}
