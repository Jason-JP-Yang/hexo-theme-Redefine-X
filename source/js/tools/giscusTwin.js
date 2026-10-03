import { liveFrames } from "./themeMirror.js";

/**
 * giscus inside the light/dark ring.
 *
 * The comments are a cross-origin frame that cannot be copied, so the mirror's
 * copy of it is a second giscus frame on the same discussion, in the mirror's
 * scheme — drawn over the mirror's own background, as the page draws its frame.
 * The page's frame stays the one the reader uses, and changes theme under the
 * mirror once the ring has covered it.
 */

const ORIGIN = "https://giscus.app";
const SELECTOR = "iframe.giscus-frame";
const REFRESH = 1000;

const twins = new Set();
const loaded = new WeakSet();
const stamps = new WeakMap();
let refreshTimer = 0;

const themeName = (dark) => (dark ? "dark" : "light");
const loading = (f) => f.classList.contains("giscus-frame--loading");

function param(src, name) {
  try {
    return new URL(src).searchParams.get(name);
  } catch (e) {
    return null;
  }
}

function withTheme(src, theme) {
  const url = new URL(src);
  url.searchParams.set("theme", theme);
  return url.toString();
}

const post = (f, config) => f.contentWindow?.postMessage({ giscus: { setConfig: config } }, ORIGIN);

liveFrames({
  selector: SELECTOR,
  src: (el, dark) => withTheme(el.src, themeName(dark)),
  made(copy) {
    twins.add(copy);
    copy.addEventListener("load", () => loaded.add(copy));
  },
  theme(copy, dark) {
    if (loaded.has(copy)) post(copy, { theme: themeName(dark) });
    else if (copy.src) copy.src = withTheme(copy.src, themeName(dark));
  },
});

// The copy follows the page's frame when its discussion changes.
function note(frame, discussion) {
  const sig = [discussion.totalCommentCount, discussion.totalReplyCount, discussion.reactionCount].join("/");
  const before = stamps.get(frame);
  stamps.set(frame, sig);
  if (before === undefined || before === sig) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const term = param(frame.src, "term");
    for (const t of twins) if (t.isConnected) post(t, term != null ? { term } : { number: Number(param(frame.src, "number")) });
  }, REFRESH);
}

// Ahead of giscus-client.js's own listener, which would size its frame by the
// copy's messages.
addEventListener(
  "message",
  (e) => {
    if (e.origin !== ORIGIN) return;
    for (const t of twins) {
      if (!t.isConnected) twins.delete(t);
      else if (e.source === t.contentWindow) return void e.stopImmediatePropagation();
    }
    const discussion = e.data && typeof e.data === "object" && e.data.giscus?.discussion;
    if (!discussion) return;
    for (const f of document.querySelectorAll(SELECTOR)) if (f.contentWindow === e.source) note(f, discussion);
  },
  true,
);

/**
 * The page's frames go over to the new theme. Returns those on screen, in
 * document coordinates, for the mirror to keep covering while they change.
 */
export function landing(dark) {
  const out = [];
  for (const f of document.querySelectorAll(SELECTOR)) {
    // A frame only listens once loaded.
    if (loading(f)) {
      f.addEventListener("load", () => post(f, { theme: themeName(document.documentElement.classList.contains("dark")) }), { once: true });
      continue;
    }
    post(f, { theme: themeName(dark) });
    const r = f.getBoundingClientRect();
    if (r.width && r.height && r.bottom > 0 && r.top < innerHeight) out.push({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, round: 0 });
  }
  return out;
}
