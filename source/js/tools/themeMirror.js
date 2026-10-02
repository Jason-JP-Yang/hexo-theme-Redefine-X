/**
 * A live second rendering of the page, kept in the OTHER colour scheme.
 *
 * One document paints in one scheme. For a light/dark switch to show the new
 * scheme inside its ring while everything outside stays the real page — live,
 * interactive, in the old scheme — the new scheme has to be painted by
 * something else: this mirror. It is a copy of <body> inside a shadow root (its
 * own ids, its own copy of the site's stylesheets with `html`/`:root`/`body` and
 * the user-action pseudo-classes rewritten onto classes), kept in step with the
 * page, already styled and laid out in the scheme a switch would go to, and
 * hidden. A switch only has to show it.
 *
 * Kept in step: the DOM and its attributes (a slice at a time while idle, at
 * once while shown), document and inner scroll positions, form values, hover /
 * active / focus (as `m-*` classes), CSS animations (time-aligned when shown)
 * and script animations (copied onto the mirror while it is shown). Content a
 * clone cannot carry — iframes, video, canvas, the emoji picker — is shown
 * through holes onto the page itself. Mermaid drawings, whose palette is baked
 * into the SVG, are swapped for the mirror's scheme (`redefineSchemeContent`).
 */

const SKIP_ATTRS = new Set(["data-tg", "data-scheme"]);
const ROOT_CLASS = /^(dark|light|theme-switching|theme-reveal|theme-live)$/;
const BODY_CLASS = /^(dark-mode|light-mode)$/;
const HOLES = "iframe, video, canvas, em-emoji-picker";
const RING =
  "radial-gradient(circle at var(--theme-x) var(--theme-y), #000 var(--theme-r), rgb(0 0 0 / var(--theme-m)) calc(var(--theme-r) + 1.5px))";
// Elements per subtree for sliced restyles, and per idle slice.
const CHUNK = 600;
const SLICE = 1500;

const real = document.documentElement;
const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 800 }) : setTimeout(() => fn(null), 120));
const nextIdle = () => new Promise((r) => idle(r));
const timeLeft = (deadline, started) =>
  deadline && !deadline.didTimeout ? deadline.timeRemaining() > 2 : performance.now() - started < 8;

let host = null;
let shadow = null;
let scroller = null;
let rootEl = null;
let bodyEl = null;
let scheme = null; // the mirror's: true = dark
let flipping = 0;
let flipTarget = null;
let sheetsReady = false;
let sheetsQueued = false;
let pumpQueued = false;
let live = false;
let rootDirty = false;
let scrollDirty = false;

const toMirror = new WeakMap();
const owned = new WeakSet(); // mirror elements whose content is swapped, not copied
const pendingParents = new Set();
const dirtyAttrs = new Map();
const dirtyText = new Set();
const scrolled = new Set();
const pairs = [];
const states = { hover: new Set(), active: new Set(), focus: new Set(), within: new Set(), visible: new Set() };
const STATE_CLASS = { hover: "m-hover", active: "m-active", focus: "m-focus", within: "m-focus-within", visible: "m-focus-visible" };
const lookups = (window.redefineSchemeContent ||= []);

/** Splits a tree into subtrees of at most CHUNK elements; returns [root, size]. */
export function partition(top) {
  const out = [];
  const sizes = new Map();
  const count = (el) => {
    let n = 1;
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) n += count(c);
    sizes.set(el, n);
    return n;
  };
  const pick = (el) => {
    if (sizes.get(el) <= CHUNK) return void out.push([el, sizes.get(el)]);
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) pick(c);
  };
  count(top);
  pick(top);
  return out;
}

/* ─── stylesheets ─────────────────────────────────────────────────────────── */

const PSEUDO = [
  [/:focus-visible(?![\w-])/g, ".m-focus-visible"],
  [/:focus-within(?![\w-])/g, ".m-focus-within"],
  [/:focus(?![\w-])/g, ".m-focus"],
  [/:hover(?![\w-])/g, ".m-hover"],
  [/:active(?![\w-])/g, ".m-active"],
];

function rewriteSelector(sel) {
  let s = sel
    .replace(/:root(?![\w-])/g, ".m-root")
    .replace(/(^|[\s>+~,(])html(?=$|[\s.#:[>+~,)])/g, "$1.m-root")
    .replace(/(^|[\s>+~,(])body(?=$|[\s.#:[>+~,)])/g, "$1.m-body");
  for (const [re, to] of PSEUDO) s = s.replace(re, to);
  return s;
}

function rewriteRules(rules) {
  for (const rule of rules) {
    if (typeof rule.selectorText === "string") {
      const next = rewriteSelector(rule.selectorText);
      if (next !== rule.selectorText) rule.selectorText = next;
    }
    if (rule.cssRules) rewriteRules(rule.cssRules);
  }
}

const OWN_CSS = `
.m-scroll { position: absolute; inset: 0; overflow: hidden; background: var(--background-color); --tg: 0s; --tgd: 0s; }
.m-root, .m-body { overflow: visible !important; }
* { pointer-events: none !important; }
`;

async function buildSheets() {
  sheetsQueued = false;
  const out = [];
  for (const source of document.styleSheets) {
    const owner = source.ownerNode;
    if (source.disabled || !owner || document.body.contains(owner)) continue;
    let text;
    try {
      text = Array.prototype.map.call(source.cssRules, (r) => r.cssText).join("\n");
    } catch (e) {
      continue; // cross-origin: font faces, which apply to the whole document anyway
    }
    const media = source.media && source.media.mediaText;
    if (media && media !== "all") text = `@media ${media} {\n${text}\n}`;
    await nextIdle();
    const sheet = new CSSStyleSheet({ baseURL: source.href || document.baseURI });
    await sheet.replace(text);
    await nextIdle();
    rewriteRules(sheet.cssRules);
    out.push(sheet);
  }
  const own = new CSSStyleSheet();
  own.replaceSync(OWN_CSS);
  out.push(own);
  shadow.adoptedStyleSheets = out;
  sheetsReady = true;
}

function queueSheets() {
  if (sheetsQueued) return;
  sheetsQueued = true;
  idle(() => buildSheets());
}

/* ─── copying ─────────────────────────────────────────────────────────────── */

function blocked(el, name) {
  if (SKIP_ATTRS.has(name) || name === "autofocus") return true;
  const tag = el.localName;
  if (tag === "iframe") return name === "src" || name === "srcdoc";
  if (tag === "video" || tag === "audio" || tag === "source") return name === "src" || name === "autoplay";
  return false;
}

function copyValue(from, to) {
  try {
    if (from.type === "checkbox" || from.type === "radio") to.checked = from.checked;
    else if (from.type !== "file" && typeof from.value === "string" && to.value !== from.value) to.value = from.value;
  } catch (e) {}
}

function cleanStyle(m) {
  // Resolved by the page for ITS scheme; the mirror's stylesheet supplies its own.
  if (m.style && m.style.getPropertyValue("--mathjax-scroll-bg-color")) m.style.removeProperty("--mathjax-scroll-bg-color");
}

function restoreState(m, el) {
  for (const key in states) if (states[key].has(el)) m.classList.add(STATE_CLASS[key]);
}

function cloneOf(el) {
  let m;
  if (el.nodeType === 1 && el.localName === "em-emoji-picker") {
    // Its content lives in a shadow root a copy cannot carry: a hole shows it.
    m = document.createElement("div");
    m.style.cssText = `width:${el.offsetWidth}px;height:${el.offsetHeight}px`;
  } else {
    m = el.cloneNode(false);
  }
  toMirror.set(el, m);
  if (m.nodeType === 1) {
    for (const name of [...m.getAttributeNames()]) if (blocked(m, name)) m.removeAttribute(name);
    if (m.localName === "script") m.setAttribute("type", "text/x-mirror");
    if (m.hasAttribute("contenteditable")) m.setAttribute("spellcheck", "false");
    if (/^(input|textarea|select)$/.test(m.localName)) copyValue(el, m);
    cleanStyle(m);
    restoreState(m, el);
  }
  if (el.firstChild) pendingParents.add(el);
  return m;
}

function swapContent(el) {
  const m = toMirror.get(el);
  if (!m || m.nodeType !== 1) return false;
  for (const look of lookups) {
    if (!el.matches(look.selector)) continue;
    const markup = look.markup(el, scheme);
    if (markup == null) return false;
    if (m.__markup !== markup) {
      m.innerHTML = markup;
      m.__markup = markup;
    }
    owned.add(m);
    return true;
  }
  return false;
}

function reconcile(el) {
  const m = toMirror.get(el);
  if (!m) return;
  if (swapContent(el)) return;
  if (owned.has(m)) {
    owned.delete(m);
    m.__markup = null;
    m.textContent = "";
  }
  let ref = m.firstChild;
  for (let c = el.firstChild; c; c = c.nextSibling) {
    const mc = toMirror.get(c) || cloneOf(c);
    if (mc === ref) ref = ref.nextSibling;
    else m.insertBefore(mc, ref);
  }
  while (ref) {
    const next = ref.nextSibling;
    ref.remove();
    ref = next;
  }
}

function syncRoot() {
  for (const name of rootEl.getAttributeNames()) {
    if (name !== "class" && name !== "style" && !real.hasAttribute(name)) rootEl.removeAttribute(name);
  }
  for (const { name, value } of real.attributes) {
    if (name !== "class" && name !== "style" && !SKIP_ATTRS.has(name)) rootEl.setAttribute(name, value);
  }
  const mode = scheme ? "dark" : "light";
  rootEl.className = ["m-root", mode, ...[...real.classList].filter((c) => !ROOT_CLASS.test(c))].join(" ");
  rootEl.style.cssText = real.style.cssText;
  rootEl.style.colorScheme = mode;
  rootEl.style.width = real.clientWidth + "px";
  scroller.className = `m-scroll ${mode}`;
  restoreState(rootEl, real);
}

function syncBody() {
  const body = document.body;
  for (const name of bodyEl.getAttributeNames()) {
    if (name !== "class" && !body.hasAttribute(name)) bodyEl.removeAttribute(name);
  }
  for (const { name, value } of body.attributes) {
    if (name !== "class" && !SKIP_ATTRS.has(name)) bodyEl.setAttribute(name, value);
  }
  const mode = scheme ? "dark-mode" : "light-mode";
  bodyEl.className = ["m-body", mode, ...[...body.classList].filter((c) => !BODY_CLASS.test(c))].join(" ");
  cleanStyle(bodyEl);
  restoreState(bodyEl, body);
}

function syncAttrs(el, names) {
  if (el === document.body) return void syncBody();
  const m = toMirror.get(el);
  if (!m || m.nodeType !== 1 || el.localName === "em-emoji-picker") return;
  for (const name of names) {
    if (blocked(el, name)) continue;
    const value = el.getAttribute(name);
    if (value === null) m.removeAttribute(name);
    else if (m.getAttribute(name) !== value) m.setAttribute(name, value);
  }
  if (names.has("style")) cleanStyle(m);
  if (names.has("class")) restoreState(m, el);
}

// Everything queued, or as much as the idle period allows.
function pump(deadline) {
  pumpQueued = false;
  if (!host) return;
  const started = performance.now();
  const more = () => live || timeLeft(deadline, started);
  if (rootDirty) {
    rootDirty = false;
    syncRoot();
  }
  for (const el of pendingParents) {
    if (!more()) break;
    pendingParents.delete(el);
    reconcile(el);
  }
  for (const [el, names] of dirtyAttrs) {
    if (!more()) break;
    dirtyAttrs.delete(el);
    syncAttrs(el, names);
  }
  for (const node of dirtyText) {
    if (!more()) break;
    dirtyText.delete(node);
    const m = toMirror.get(node);
    if (m && m.data !== node.data) m.data = node.data;
  }
  if (pendingParents.size || dirtyAttrs.size || dirtyText.size) schedule();
}

function schedule() {
  if (pumpQueued || live) return;
  pumpQueued = true;
  idle(pump);
}

function observe(records) {
  for (const r of records) {
    if (r.type === "childList") pendingParents.add(r.target);
    else if (r.type === "attributes") {
      if (SKIP_ATTRS.has(r.attributeName)) continue;
      let names = dirtyAttrs.get(r.target);
      if (!names) dirtyAttrs.set(r.target, (names = new Set()));
      names.add(r.attributeName);
    } else dirtyText.add(r.target);
  }
  if (live) pump(null);
  else schedule();
}

/* ─── state that is not in the DOM ────────────────────────────────────────── */

function chain(el) {
  const out = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) out.push(n);
  return out;
}

function setState(key, els) {
  const next = new Set(els);
  const cls = STATE_CLASS[key];
  for (const el of states[key]) if (!next.has(el)) toMirror.get(el)?.classList.remove(cls);
  for (const el of next) toMirror.get(el)?.classList.add(cls);
  states[key] = next;
}

function syncFocus() {
  const el = document.activeElement;
  const focused = el && el !== document.body && el !== real ? el : null;
  setState("focus", focused ? [focused] : []);
  setState("within", focused ? chain(focused) : []);
  let visible = false;
  try {
    visible = !!focused && focused.matches(":focus-visible");
  } catch (e) {}
  setState("visible", visible ? [focused] : []);
}

function syncHover() {
  const hovered = document.querySelectorAll(":hover");
  setState("hover", hovered.length ? chain(hovered[hovered.length - 1]) : []);
  const active = document.querySelectorAll(":active");
  setState("active", active.length ? chain(active[active.length - 1]) : []);
}

const onPointer = (e) => {
  if (e.type === "pointerover") setState("hover", chain(e.target));
  else if (e.type === "pointerdown") setState("active", chain(e.target));
  else if (e.type === "pointerup" || e.type === "pointercancel") setState("active", []);
};
const onFocus = () => syncFocus();
const onValue = (e) => {
  const m = toMirror.get(e.target);
  if (m) copyValue(e.target, m);
};
const LISTEN = [
  ["pointerover", onPointer],
  ["pointerdown", onPointer],
  ["pointerup", onPointer],
  ["pointercancel", onPointer],
  ["focusin", onFocus],
  ["focusout", onFocus],
  ["input", onValue],
  ["change", onValue],
];

// Inner scrollers are only recorded here; the document's own scroll is read
// once a frame while the mirror is shown.
document.addEventListener(
  "scroll",
  (e) => {
    const t = e.target;
    if (t && t.nodeType === 1) {
      scrolled.add(t);
      scrollDirty = true;
    }
  },
  { capture: true, passive: true },
);

function syncScroll() {
  if (scroller.scrollTop !== window.scrollY) scroller.scrollTop = window.scrollY;
  if (scroller.scrollLeft !== window.scrollX) scroller.scrollLeft = window.scrollX;
  if (!scrollDirty) return;
  scrollDirty = false;
  for (const el of scrolled) {
    if (!el.isConnected) {
      scrolled.delete(el);
      continue;
    }
    const m = toMirror.get(el);
    if (!m) continue;
    if (m.scrollTop !== el.scrollTop) m.scrollTop = el.scrollTop;
    if (m.scrollLeft !== el.scrollLeft) m.scrollLeft = el.scrollLeft;
  }
}

/* ─── animations ──────────────────────────────────────────────────────────── */

const nativeAnimate = Element.prototype.animate;
// While the mirror is shown, a script animation on the page plays on its copy too.
Element.prototype.animate = function (keyframes, options) {
  const a = nativeAnimate.call(this, keyframes, options);
  if (live) {
    const m = toMirror.get(this);
    if (m && m.nodeType === 1) {
      try {
        const b = nativeAnimate.call(m, keyframes, options);
        b.currentTime = a.currentTime;
        pairs.push([a, b]);
      } catch (e) {}
    }
  }
  return a;
};

function samePseudo(a, b) {
  return (a.effect.pseudoElement || null) === (b.effect.pseudoElement || null);
}

function syncAnimations() {
  for (const a of document.getAnimations()) {
    const effect = a.effect;
    const target = effect && effect.target;
    if (!target || target.getRootNode() !== document) continue;
    const m = toMirror.get(target);
    if (!m || m.nodeType !== 1) continue;
    if (window.CSSAnimation && a instanceof CSSAnimation) {
      const b = m.getAnimations().find((x) => x instanceof CSSAnimation && x.animationName === a.animationName && samePseudo(a, x));
      if (b) {
        b.currentTime = a.currentTime;
        if (a.playState === "paused") b.pause();
      }
    } else if (window.CSSTransition && a instanceof CSSTransition) {
      const b = m.getAnimations().find((x) => x instanceof CSSTransition && x.transitionProperty === a.transitionProperty && samePseudo(a, x));
      if (b) b.currentTime = a.currentTime;
    } else {
      try {
        const timing = effect.getTiming();
        const b = nativeAnimate.call(m, effect.getKeyframes(), { ...timing, pseudoElement: effect.pseudoElement || undefined });
        b.currentTime = a.currentTime;
        b.playbackRate = a.playbackRate;
        if (a.playState === "paused") b.pause();
        pairs.push([a, b]);
      } catch (e) {}
    }
  }
}

function syncPairs() {
  for (let i = pairs.length - 1; i >= 0; i--) {
    const [a, b] = pairs[i];
    if (a.playState === "idle") {
      b.cancel();
      pairs.splice(i, 1);
      continue;
    }
    if (b.playbackRate !== a.playbackRate) b.playbackRate = a.playbackRate;
    if (a.currentTime !== null && b.currentTime !== a.currentTime) b.currentTime = a.currentTime;
    if (a.playState === "paused" && b.playState !== "paused") b.pause();
  }
}

/* ─── holes ───────────────────────────────────────────────────────────────── */

function cutHoles() {
  const rects = [];
  for (const el of document.body.querySelectorAll(HOLES)) {
    const r = el.getBoundingClientRect();
    if (r.width && r.height && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) rects.push(r);
  }
  const s = host.style;
  if (!rects.length) {
    if (s.maskImage) for (const p of ["maskImage", "maskPosition", "maskSize", "maskRepeat", "maskComposite"]) s[p] = "";
    return;
  }
  s.maskImage = [RING, ...rects.map(() => "linear-gradient(#000 0 0)")].join(", ");
  s.maskPosition = ["0 0", ...rects.map((r) => `${r.left}px ${r.top}px`)].join(", ");
  s.maskSize = ["100% 100%", ...rects.map((r) => `${r.width}px ${r.height}px`)].join(", ");
  s.maskRepeat = "no-repeat";
  s.maskComposite = ["subtract", ...rects.map(() => "add")].slice(0, rects.length + 1).join(", ");
}

function frame() {
  if (!live) return;
  syncScroll();
  syncPairs();
  cutHoles();
  requestAnimationFrame(frame);
}

/* ─── scheme ──────────────────────────────────────────────────────────────── */

function swapAll() {
  for (const look of lookups) {
    for (const el of document.body.querySelectorAll(look.selector)) swapContent(el);
  }
}

// Restyled a subtree at a time while idle, so no frame carries the whole copy.
async function setScheme(dark) {
  if (scheme === dark) return;
  const token = ++flipping;
  flipTarget = dark;
  const mode = dark ? "dark" : "light";
  const chunks = partition(bodyEl);
  for (let i = 0; i < chunks.length; ) {
    await nextIdle();
    if (token !== flipping) return;
    for (let budget = SLICE; i < chunks.length && budget > 0; i++) {
      chunks[i][0].setAttribute("data-scheme", mode);
      budget -= chunks[i][1];
    }
  }
  await nextIdle();
  if (token !== flipping) return;
  scheme = dark;
  syncRoot();
  syncBody();
  swapAll();
  await nextIdle();
  for (const [el] of chunks) el.removeAttribute("data-scheme");
  if (token === flipping) flipping = 0;
}

/* ─── interface ───────────────────────────────────────────────────────────── */

function build() {
  host = document.createElement("div");
  host.className = "theme-mirror";
  host.inert = true;
  host.setAttribute("aria-hidden", "true");
  shadow = host.attachShadow({ mode: "open" });
  scroller = document.createElement("div");
  rootEl = document.createElement("div");
  bodyEl = document.createElement("div");
  scroller.append(rootEl);
  rootEl.append(bodyEl);
  shadow.append(scroller);
  scheme = !real.classList.contains("dark");
  toMirror.set(real, rootEl);
  toMirror.set(document.body, bodyEl);
  syncRoot();
  syncBody();
  real.append(host);

  new MutationObserver(observe).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  new MutationObserver(() => {
    rootDirty = true;
    if (live) pump(null);
    else schedule();
  }).observe(real, { attributes: true });
  // Only a stylesheet coming or going rebuilds the copy's sheets — not the title
  // and meta tags every navigation rewrites.
  const isSheet = (n) => n.nodeName === "STYLE" || (n.nodeName === "LINK" && /stylesheet/i.test(n.rel || ""));
  new MutationObserver((records) => {
    for (const r of records) {
      const nodes = [...r.addedNodes, ...r.removedNodes];
      if (nodes.some(isSheet) || r.target.nodeName === "STYLE" || (r.type === "characterData" && r.target.parentNode?.nodeName === "STYLE")) {
        return void queueSheets();
      }
    }
  }).observe(document.head, { childList: true, subtree: true, characterData: true });
  addEventListener("resize", () => {
    rootDirty = true;
    schedule();
  });

  pendingParents.add(document.body);
  queueSheets();
  schedule();
}

/** Builds the mirror once, then keeps it in the scheme opposite the page's. */
export function prepare() {
  if (!host) return void idle(() => host || build());
  if (live) return;
  const want = !real.classList.contains("dark");
  if (flipping ? flipTarget !== want : scheme !== want) setScheme(want);
}

/** Whether a switch to `dark` can be shown through the mirror right now. */
export function ready(dark) {
  return !!host && sheetsReady && !flipping && scheme === dark && pendingParents.size < 64;
}

export function element() {
  return host;
}

/** Brings the copy fully up to date and shows it; returns the host to animate. */
export function show() {
  live = true;
  pump(null);
  swapAll();
  for (const el of document.body.querySelectorAll("input, textarea, select")) {
    const m = toMirror.get(el);
    if (m) copyValue(el, m);
  }
  scrollDirty = true;
  syncScroll();
  syncHover();
  syncFocus();
  syncAnimations();
  cutHoles();
  for (const [type, fn] of LISTEN) document.addEventListener(type, fn, { capture: true, passive: true });
  host.classList.add("is-shown");
  requestAnimationFrame(frame);
  return host;
}

export function hide() {
  live = false;
  host.classList.remove("is-shown");
  for (const [type, fn] of LISTEN) document.removeEventListener(type, fn, true);
  for (const [, b] of pairs) b.cancel();
  pairs.length = 0;
  for (const p of ["maskImage", "maskPosition", "maskSize", "maskRepeat", "maskComposite"]) host.style[p] = "";
  schedule();
}
