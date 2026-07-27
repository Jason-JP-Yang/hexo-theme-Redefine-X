/**
 * Noto animated emoji runtime — GLOBAL, viewport-scoped, overlay-based.
 *
 * Policy (applies to every piece of text on the blog — post bodies, titles,
 * navbar, sidebar, instant-notes, anywhere):
 *
 *   1. Emoji are PLAIN TEXT, always. The site font stack renders them as static
 *      Noto Color Emoji — identical to normal text, zero requests, zero markup
 *      difference in the generated HTML.
 *   2. A client-side scanner walks the rendered page, finds every emoji that has
 *      an animated Noto counterpart and wraps it WITHOUT changing how it reads
 *      or lays out:
 *
 *        <span class="noto-anim" data-code="…"><span class="noto-anim-box">😀</span></span>
 *
 *      …and the overlay, while it exists, is simply an <img> inside that box.
 *
 *   3. The animation exists ONLY while the emoji is inside the viewport. On
 *      entry a fresh <img> is built, decoded and dropped into the box; on exit it
 *      is destroyed outright — the element, its decoded frames and its playback
 *      all go away. Nothing is pooled, parked or cached by us: a re-entry simply
 *      re-requests the URL and the BROWSER's own disk cache serves it.
 *   4. The static → animated → static switch never flashes, jumps or ghosts:
 *        • geometry — the box is `line-height: 1`, which makes the static glyph's
 *          artwork sit dead centre in it, so the overlay just centres itself in
 *          the very same box. No offsets, nothing to drift (basic.styl);
 *        • timing — the overlay is only inserted once it has fully DECODED, and
 *          it fades in ON TOP of the still-opaque static glyph. The glyph is
 *          hidden only after the overlay reached opacity 1 (i.e. while it is
 *          completely covered), and is restored before the overlay starts
 *          fading out. At every instant exactly one fully opaque copy of the
 *          artwork is on screen — no cross-fade dip, no double image.
 *
 * Consumers:
 *   • initNotoAnim() (main.js, every page view) — loads the animated-set table
 *     (/libs/emoji-mart/noto-animated.json) and scans the whole page.
 *   • attachNotoEmoji(el, native) — wires runtime-built elements (instant-notes
 *     bubble badges, picker trigger buttons) into the same machinery.
 */

const CDN = "https://fonts.gstatic.com/s/e/notoemoji/latest";
const DATA_URL = "/libs/emoji-mart/noto-animated.json";
// Kept in sync with --noto-fade in css/common/basic.styl.
const FADE_MS = 180;

// ─── Animated-set table + match regex ─────────────────────────────────────────
let animatedMap = null;
let emojiRe = null;
let mapPromise = null;

// Cheap pre-filter: bail out of scanning for text that cannot contain emoji
// (surrogates, misc symbol blocks, VS16/ZWJ).
const QUICK_RE = /[\uD800-\uDFFF←-⯿☀-➿️‍〰〽㊗㊙]/;

function loadMap() {
  if (!mapPromise) {
    mapPromise = fetch(DATA_URL)
      .then((r) => r.json())
      .then((m) => {
        animatedMap = m || {};
        const natives = Object.keys(animatedMap).sort((a, b) => b.length - a.length);
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        emojiRe = natives.length
          ? new RegExp(natives.map(esc).join("|"), "g")
          : null;
      })
      .catch(() => {
        animatedMap = {};
      });
  }
  return mapPromise;
}

export function codeForNative(native) {
  return Array.from(native)
    .map((ch) => ch.codePointAt(0).toString(16))
    .join("_");
}

function reducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {
    return false;
  }
}

// ─── Element shape ────────────────────────────────────────────────────────────
// `.noto-anim-box` is an inline-block so the geometry is identical whether the
// host is a text run, a flex item (instant-notes badge) or a button (picker
// trigger) — and `line-height: 1` (in CSS) makes the emoji artwork sit dead
// centre in it, so the overlay only ever has to centre itself in the same box.
function buildBox(native) {
  const box = document.createElement("span");
  box.className = "noto-anim-box";
  box.textContent = native;
  return box;
}

// ─── Overlay lifecycle ────────────────────────────────────────────────────────
function destroyOverlay(el) {
  clearTimeout(el._notoTimer);
  el._notoTimer = null;
  el.classList.remove("is-anim", "anim-on");
  const img = el._notoSlot;
  el._notoSlot = null;
  // Playback stops and the decoded frames become garbage: the "fully unloaded"
  // state. Nothing is kept for later — a re-entry re-requests the URL and the
  // browser's own disk cache serves it.
  if (img) img.remove();
}

function enter(el) {
  if (el._notoIn) return;
  el._notoIn = true;
  clearTimeout(el._notoTimer);
  const code = el.dataset.code;
  if (!code) return;

  // Re-entered while the previous overlay was still fading out — reuse the very
  // element that is already on screen instead of restarting from nothing, so a
  // scroll wiggle at the viewport edge can never flicker.
  if (el._notoSlot) {
    if (el._notoSlot.isConnected) {
      el.classList.add("is-anim");
      el._notoTimer = setTimeout(() => el.classList.add("anim-on"), FADE_MS);
      return;
    }
    destroyOverlay(el); // stale reference (host rebuilt its content) — start over
  }

  const gen = (el._notoGen = (el._notoGen || 0) + 1);
  const img = document.createElement("img");
  img.className = "noto-anim-img";
  img.decoding = "async";
  img.setAttribute("aria-hidden", "true");
  img.alt = "";
  img.draggable = false;
  img.src = `${CDN}/${code}/512.webp`;

  const show = () => {
    // Stale (left the viewport, emoji changed, or node detached) → drop it.
    if (el._notoGen !== gen || !el._notoIn || !el.isConnected) return;
    const box = el.querySelector(".noto-anim-box");
    if (!box) return;
    box.appendChild(img);
    el._notoSlot = img;

    if (reducedMotion()) {
      el.classList.add("is-anim", "anim-on");
      return;
    }
    void img.offsetWidth; // commit opacity:0 as the transition's start value
    el.classList.add("is-anim"); // overlay fades in ON TOP of the opaque glyph
    el._notoTimer = setTimeout(() => {
      // Overlay is fully opaque now, so the glyph beneath is completely covered:
      // hiding it is invisible, and it stops the static artwork peeking out when
      // an animation frame shrinks (🎉, ❤️ …).
      if (el._notoGen === gen) el.classList.add("anim-on");
    }, FADE_MS);
  };

  if (img.decode) img.decode().then(show).catch(() => {});
  else img.onload = show;
}

function leave(el) {
  if (!el._notoIn) return;
  el._notoIn = false;
  el._notoGen = (el._notoGen || 0) + 1; // cancels any in-flight show()
  clearTimeout(el._notoTimer);
  if (!el._notoSlot) {
    el.classList.remove("is-anim", "anim-on");
    return;
  }
  if (reducedMotion()) {
    destroyOverlay(el);
    return;
  }
  // Un-hide the static glyph FIRST — it is still fully covered by the opaque
  // overlay, so nothing is visible yet — then fade the overlay out over it and
  // destroy it. One opaque copy of the artwork at all times.
  el.classList.remove("anim-on");
  el.classList.remove("is-anim");
  el._notoTimer = setTimeout(() => destroyOverlay(el), FADE_MS + 20);
}

// ─── Viewport activation ──────────────────────────────────────────────────────
// rootMargin 0: the overlay exists ONLY while the emoji is actually on screen.
let io = null;
function observer() {
  if (!io) {
    io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        const el = e.target;
        // Detached by a page swap / list re-render: unload and stop tracking it.
        if (!el.isConnected) {
          io.unobserve(el);
          leave(el);
          destroyOverlay(el);
          return;
        }
        if (e.isIntersecting) enter(el);
        else leave(el);
      });
    });
  }
  return io;
}

// ─── Runtime elements (bubble badges, picker triggers) ────────────────────────
// Static text now, animated overlay while in-viewport. Re-attaching the same
// element with a DIFFERENT emoji rewires it cleanly.
export function attachNotoEmoji(el, native) {
  const code = codeForNative(native);
  // Rebuilding the box orphans any live overlay, so always start from a clean
  // slate — otherwise re-selecting the SAME emoji would hit the "reuse" path in
  // enter() with a slot that is no longer in the document, and nothing would play.
  destroyOverlay(el);
  el._notoNative = native;
  el.dataset.code = code;
  el.classList.add("noto-anim");
  el.textContent = "";
  el.appendChild(buildBox(native));
  observer().observe(el); // observing an already-observed target is a no-op
  // Already on screen: observers only fire on intersection CHANGES, so if this
  // element was live before the swap, re-arm the overlay now.
  if (el._notoIn) {
    el._notoIn = false;
    enter(el);
  }
}

// Undo attachNotoEmoji: unload the animation and stop tracking the element. Used
// when a host stops showing an emoji at all (e.g. the picker trigger falling back
// to its placeholder icon), so nothing keeps trying to animate it.
export function detachNotoEmoji(el) {
  if (!el) return;
  destroyOverlay(el);
  el._notoIn = false;
  el._notoGen = (el._notoGen || 0) + 1;
  el._notoNative = null;
  delete el.dataset.code;
  el.classList.remove("noto-anim");
  if (io) io.unobserve(el);
}

// ─── Global page scanner ──────────────────────────────────────────────────────
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "TEXTAREA", "NOSCRIPT", "IFRAME", "INPUT", "SELECT",
  "OPTION", "TITLE", "CANVAS", "VIDEO", "AUDIO", "TEMPLATE",
]);

function wrapMatches(textNode) {
  const text = textNode.nodeValue;
  emojiRe.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let last = 0;
  let m;
  while ((m = emojiRe.exec(text))) {
    if (m.index > last) {
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    }
    // The emoji stays TEXT — the wrapper is purely the animation hook.
    const span = document.createElement("span");
    span.className = "noto-anim";
    span.dataset.code = animatedMap[m[0]];
    span._notoNative = m[0];
    span.appendChild(buildBox(m[0]));
    frag.appendChild(span);
    observer().observe(span);
    last = m.index + m[0].length;
  }
  if (last === 0) return; // no match after all
  if (last < text.length) {
    frag.appendChild(document.createTextNode(text.slice(last)));
  }
  textNode.parentNode.replaceChild(frag, textNode);
}

export function scanNotoEmoji(root) {
  if (!emojiRe) return;
  const scope = root || document.body;
  if (!scope) return;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue;
      if (!text || !QUICK_RE.test(text)) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p || SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p.closest(".noto-anim")) return NodeFilter.FILTER_REJECT; // wrapped
      emojiRe.lastIndex = 0;
      return emojiRe.test(text)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(wrapMatches);
}

// Runs on every page view (swup); wrapping is idempotent (wrapped emoji are
// skipped by the scanner).
export function initNotoAnim() {
  loadMap().then(() => scanNotoEmoji(document.body));
}
