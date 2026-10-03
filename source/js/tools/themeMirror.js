/**
 * A live second rendering of the page in the OTHER colour scheme.
 *
 * One document paints in one scheme, so the ring of a light/dark switch needs a
 * copy of <body> for the side the page is not on. It lives in a shadow root on a
 * host at the document origin, so it scrolls with the page natively and its fixed
 * and sticky parts sit where the real ones do. The site's stylesheets are copied
 * with `html`, `:root`, `body`, user-action pseudo-classes, `::selection` and
 * custom elements rewritten onto stand-ins of the same specificity.
 *
 * Hidden, the host is at opacity 0, which nothing inside can override and no
 * engine paints, while style and layout stay current. Video, canvas and frames
 * are placeholders, and `holes()` says where their pictures show through; a
 * frame that can be loaded again in the other scheme registers `liveFrames()`.
 */

import { onScroll, requestScrollPass } from "./scrollScheduler.js";

const SKIP_ATTRS = new Set(["data-tg", "data-scheme"]);
const ROOT_CLASS = /^(dark|light|theme-switching)$/;
const BODY_CLASS = /^(dark-mode|light-mode)$/;
const MEDIA = new Set(["iframe", "video", "canvas", "embed", "object", "audio"]);
const OBSERVE = { subtree: true, childList: true, attributes: true, characterData: true };
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
let canvas = null;
let rootEl = null;
let bodyEl = null;
let tone = null;
let observer = null;
let baseSheet = null;
let ownSheet = null;
let scheme = null; // the copy's: true = dark
let flipToken = 0;
let flipping = false;
let flipTarget = null;
let marked = [];
let sheetsReady = false;
let sheetsToken = 0;
let pumpQueued = false;
let live = false;
let rootDirty = false;
let scrollDirty = false;
let unsubscribe = null;

const toMirror = new WeakMap();
const owned = new WeakSet();
const defined = new WeakSet(); // copies of defined custom elements
const mirrorRoots = new WeakSet();
const rewritten = new WeakSet();
const copies = new WeakMap(); // a component's constructed sheet -> its copy
const pendingParents = new Set();
const dirtyAttrs = new Map();
const dirtyText = new Set();
const scrolled = new Set();
const scrollReads = [];
const media = new Set(); // real media elements with a placeholder
const sizes = new WeakMap(); // placeholder -> [width, height]
const themed = new Set(); // copies inside components that carry `data-theme`
const frameSpecs = [];
const liveCopies = new Map(); // real frame -> [copy, spec]
const renamed = new Set(["iframe"]);
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
  [/:root(?![\w-])/g, ".m-r"],
  [/:focus-visible(?![\w-])/g, ".m-focus-visible"],
  [/:focus-within(?![\w-])/g, ".m-focus-within"],
  [/:focus(?![\w-])/g, ".m-focus"],
  [/:hover(?![\w-])/g, ".m-hover"],
  [/:active(?![\w-])/g, ".m-active"],
  [/::(?:-moz-)?selection(?![\w-])/g, "::highlight(m-sel)"],
  [/:defined(?![\w-])/g, ":is(:defined, .m-d)"],
];
const TYPES = new Map([["html", "m-root"], ["body", "m-body"]]);
const typeRes = new Map();

function retype(sel, name) {
  let re = typeRes.get(name);
  if (!re) typeRes.set(name, (re = new RegExp(`(^|[\\s>+~,(])${name}(?=$|[\\s.#:[>+~,)])`, "g")));
  return sel.replace(re, `$1${TYPES.get(name) || "m-" + name}`);
}

function rewriteRules(rules, names, full) {
  for (const rule of rules) {
    if (typeof rule.selectorText === "string") {
      let s = rule.selectorText;
      if (full) {
        for (const [re, to] of PSEUDO) s = s.replace(re, to);
        for (const name of TYPES.keys()) s = retype(s, name);
      }
      for (const name of names) s = retype(s, name);
      if (s !== rule.selectorText) rule.selectorText = s;
    }
    if (rule.cssRules) rewriteRules(rule.cssRules, names, full);
  }
}

function rewriteSheet(sheet) {
  if (!sheet || rewritten.has(sheet)) return;
  rewritten.add(sheet);
  try {
    rewriteRules(sheet.cssRules, renamed, true);
  } catch (e) {}
}

function constructed(text, baseURL, media) {
  const sheet = new CSSStyleSheet({ baseURL: baseURL || document.baseURI, media: media || "" });
  sheet.replaceSync(text);
  rewriteSheet(sheet);
  return sheet;
}

function textOf(sheet) {
  try {
    return Array.prototype.map.call(sheet.cssRules, (r) => r.cssText).join("\n");
  } catch (e) {
    return null; // cross-origin: font faces, which apply inside shadow trees anyway
  }
}

// Copies of the document's own sheets (those in <body> are copied as elements).
function* documentSheets() {
  for (const source of document.styleSheets) {
    const owner = source.ownerNode;
    if (source.disabled || !owner || document.body.contains(owner)) continue;
    const text = textOf(source);
    if (text != null) yield () => constructed(text, source.href, source.media && source.media.mediaText);
  }
}

function adoptSheets(list) {
  shadow.adoptedStyleSheets = [baseSheet, ...list, ownSheet];
  sheetsReady = true;
}

async function buildSheets() {
  const token = ++sheetsToken;
  const known = renamed.size;
  const out = [];
  for (const make of documentSheets()) {
    await nextIdle();
    if (token !== sheetsToken) return;
    out.push(make());
  }
  // Custom elements met while these were being built.
  if (renamed.size !== known) for (const sheet of out) rewriteRules(sheet.cssRules, renamed, false);
  adoptSheets(out);
}

function buildSheetsNow() {
  ++sheetsToken;
  adoptSheets([...documentSheets()].map((make) => make()));
}

// A custom element seen for the first time: its copies are `m-<name>`, so every
// sheet that names it is renamed too.
function rename(name) {
  renamed.add(name);
  const sheets = [...(shadow ? shadow.adoptedStyleSheets : [])];
  if (shadow) for (const el of shadow.querySelectorAll("style")) sheets.push(el.sheet);
  for (const sheet of sheets) {
    try {
      if (sheet) rewriteRules(sheet.cssRules, [name], false);
    } catch (e) {}
  }
}

const BASE_CSS = `
m-root, m-body { display: block; }
m-iframe { display: inline-block; width: 300px; height: 150px; border: 2px inset; }
::highlight(m-sel) { background-color: Highlight; color: HighlightText; }
`;

const OWN_CSS = `
m-root { width: var(--m-vw) !important; height: var(--m-vh) !important; }
m-root, m-body { overflow: visible !important; }
* { pointer-events: none !important; }
.m-canvas { position: absolute; inset: 0; z-index: -2147483647; background: var(--background-color); }
.m-tone { position: fixed; inset: 0; z-index: 2147483647; opacity: 0; }
`;

/* ─── copying ─────────────────────────────────────────────────────────────── */

function blocked(el, name) {
  if (SKIP_ATTRS.has(name) || name === "autofocus") return true;
  const tag = el.localName;
  if (tag === "iframe") return name === "src" || name === "srcdoc";
  if (tag === "video" || tag === "audio") return name === "src" || name === "autoplay" || name === "poster";
  if ((tag === "source" || tag === "track") && /^(video|audio)$/.test(el.parentElement?.localName || "")) return name === "src";
  if (tag === "embed") return name === "src";
  if (tag === "object") return name === "data";
  return false;
}

function copyValue(from, to) {
  try {
    if (from.type === "checkbox" || from.type === "radio") to.checked = from.checked;
    else if (from.type !== "file" && typeof from.value === "string" && to.value !== from.value) to.value = from.value;
  } catch (e) {}
}

function cleanStyle(m) {
  // Resolved by the page for ITS scheme; the copy's stylesheet supplies its own.
  if (m.style && m.style.getPropertyValue("--mathjax-scroll-bg-color")) m.style.removeProperty("--mathjax-scroll-bg-color");
}

function restoreState(m, el) {
  for (const key in states) if (states[key].has(el)) m.classList.add(STATE_CLASS[key]);
}

const themeName = () => (scheme ? "dark" : "light");

// A component's own `data-theme` (the emoji picker) follows the copy's scheme.
function inComponent(el) {
  return el.getRootNode() !== document;
}

function withAttrs(m, node) {
  for (const { name, value } of node.attributes) if (!blocked(node, name)) m.setAttribute(name, value);
  return m;
}

// A frame that can be loaded again, in the copy's scheme, is: a second frame.
function liveCopy(node) {
  const spec = frameSpecs.find((s) => node.matches(s.selector));
  if (!spec) return null;
  const m = withAttrs(document.createElement("iframe"), node);
  m.src = spec.src(node, scheme);
  liveCopies.set(node, [m, spec]);
  spec.made?.(m);
  return m;
}

function copyElement(node, tag) {
  if (renamed.has(tag) || (tag.includes("-") && customElements.get(tag) && (rename(tag), true))) {
    // A copy must not upgrade: it would be a second, separately running widget.
    const m = withAttrs(document.createElement("m-" + tag), node);
    defined.add(m);
    m.classList.add("m-d");
    return m;
  }
  const m = node.cloneNode(false);
  for (const name of m.getAttributeNames()) if (blocked(node, name)) m.removeAttribute(name);
  return m;
}

function cloneOf(node) {
  let m;
  if (node.nodeType !== 1) {
    m = node.cloneNode(false);
  } else {
    const tag = node.localName;
    m = (tag === "iframe" && liveCopy(node)) || copyElement(node, tag);
    if (MEDIA.has(tag) && !liveCopies.has(node)) {
      media.add(node);
      if (node.isConnected) sizeTo(m, node.offsetWidth, node.offsetHeight);
    }
    if (tag === "script") m.setAttribute("type", "text/x-mirror");
    if (m.hasAttribute("contenteditable")) m.setAttribute("spellcheck", "false");
    if (tag === "input" || tag === "textarea" || tag === "select") copyValue(node, m);
    if (m.hasAttribute("data-theme") && inComponent(node)) {
      themed.add(m);
      m.setAttribute("data-theme", themeName());
    }
    cleanStyle(m);
    restoreState(m, node);
  }
  toMirror.set(node, m);
  if (node.nodeType === 1 && node.shadowRoot) mirrorShadow(node, m);
  if (node.firstChild) pendingParents.add(node);
  return m;
}

// An open shadow root (a component's) is copied like the light tree.
function mirrorShadow(el, m) {
  const sr = el.shadowRoot;
  if (!sr || toMirror.has(sr) || m.shadowRoot) return;
  let ms;
  try {
    ms = m.attachShadow({ mode: "open" });
  } catch (e) {
    return;
  }
  toMirror.set(sr, ms);
  mirrorRoots.add(ms);
  ms.adoptedStyleSheets = sr.adoptedStyleSheets.map((sheet) => {
    let copy = copies.get(sheet);
    if (!copy) copies.set(sheet, (copy = constructed(textOf(sheet) || "")));
    return copy;
  });
  observer.observe(sr, OBSERVE);
  sr.addEventListener("scroll", onScrolled, { capture: true, passive: true });
  if (sr.firstChild) pendingParents.add(sr);
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
  if (el.nodeType === 1) {
    if (swapContent(el)) return;
    if (el.shadowRoot) mirrorShadow(el, m);
  }
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
  if (m.localName === "style") rewriteSheet(m.sheet);
}

function copyAttrs(from, to) {
  const own = (name) => name === "class" || name === "style" || SKIP_ATTRS.has(name);
  for (const name of to.getAttributeNames()) if (!own(name) && !from.hasAttribute(name)) to.removeAttribute(name);
  for (const { name, value } of from.attributes) if (!own(name)) to.setAttribute(name, value);
}

function sizeViewport() {
  host.style.setProperty("--m-vw", real.clientWidth + "px");
  host.style.setProperty("--m-vh", real.clientHeight + "px");
}

function syncRoot() {
  copyAttrs(real, rootEl);
  const mode = themeName();
  rootEl.className = ["m-r", mode, ...[...real.classList].filter((c) => !ROOT_CLASS.test(c))].join(" ");
  rootEl.style.cssText = real.style.cssText;
  rootEl.style.colorScheme = mode;
  canvas.className = `m-canvas ${mode}`;
  restoreState(rootEl, real);
  sizeViewport();
}

function syncBody() {
  const body = document.body;
  copyAttrs(body, bodyEl);
  bodyEl.className = [scheme ? "dark-mode" : "light-mode", ...[...body.classList].filter((c) => !BODY_CLASS.test(c))].join(" ");
  bodyEl.style.cssText = body.style.cssText;
  cleanStyle(bodyEl);
  restoreState(bodyEl, body);
}

function syncAttrs(el, names) {
  if (el === document.body) return void syncBody();
  const m = toMirror.get(el);
  if (!m || m.nodeType !== 1) return;
  for (const name of names) {
    if (blocked(el, name)) continue;
    const value = el.getAttribute(name);
    if (value === null) m.removeAttribute(name);
    else if (m.getAttribute(name) !== value) m.setAttribute(name, value);
  }
  if (names.has("style")) cleanStyle(m);
  if (names.has("class")) {
    restoreState(m, el);
    if (defined.has(m)) m.classList.add("m-d");
  }
  if (names.has("data-theme") && m.hasAttribute("data-theme") && inComponent(el)) {
    themed.add(m);
    m.setAttribute("data-theme", themeName());
  }
  if (names.has("style") && sizes.has(m)) sizeTo(m, ...sizes.get(m));
  if (names.has("src") && liveCopies.has(el)) {
    const [copy, spec] = liveCopies.get(el);
    copy.src = spec.src(el, scheme);
  }
}

function pump(deadline, all) {
  pumpQueued = false;
  if (!host) return;
  const started = performance.now();
  const more = () => all || live || timeLeft(deadline, started);
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
    if (m && m.data !== node.data) {
      m.data = node.data;
      if (m.parentNode && m.parentNode.localName === "style") rewriteSheet(m.parentNode.sheet);
    }
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
  if (live) pump(null, true);
  else schedule();
}

/* ─── state that is not in the DOM ────────────────────────────────────────── */

function chain(el) {
  const out = [];
  for (let n = el; n; n = n.parentNode || n.host) if (n.nodeType === 1) out.push(n);
  return out;
}

function setState(key, els) {
  const next = new Set(els);
  const cls = STATE_CLASS[key];
  for (const el of states[key]) if (!next.has(el)) toMirror.get(el)?.classList.remove(cls);
  for (const el of next) toMirror.get(el)?.classList.add(cls);
  states[key] = next;
}

function deepActive() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el && el !== document.body && el !== real ? el : null;
}

function syncFocus() {
  const focused = deepActive();
  setState("focus", focused ? [focused] : []);
  setState("within", focused ? chain(focused) : []);
  let visible = false;
  try {
    visible = !!focused && focused.matches(":focus-visible");
  } catch (e) {}
  setState("visible", visible ? [focused] : []);
}

// The innermost element matching a state, through open shadow roots.
function deepest(selector) {
  let scope = document;
  let hit = null;
  while (scope) {
    const list = scope.querySelectorAll(selector);
    const last = list[list.length - 1];
    if (!last) break;
    hit = last;
    scope = last.shadowRoot;
  }
  return hit;
}

function syncHover() {
  const hovered = deepest(":hover");
  setState("hover", hovered ? chain(hovered) : []);
  const active = deepest(":active");
  setState("active", active ? chain(active) : []);
}

// The selection, as a custom highlight over the same text in the copy.
function syncSelection() {
  if (!window.CSS || !CSS.highlights || typeof Highlight === "undefined") return;
  const sel = document.getSelection();
  const ranges = [];
  for (let i = 0; sel && i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    const a = toMirror.get(r.startContainer);
    const b = toMirror.get(r.endContainer);
    if (r.collapsed || !a || !b) continue;
    try {
      const m = new Range();
      m.setStart(a, r.startOffset);
      m.setEnd(b, r.endOffset);
      ranges.push(m);
    } catch (e) {}
  }
  if (ranges.length) CSS.highlights.set("m-sel", new Highlight(...ranges));
  else CSS.highlights.delete("m-sel");
}

const target = (e) => (e.composedPath ? e.composedPath()[0] : e.target);
const onPointer = (e) => {
  if (e.type === "pointerover") setState("hover", chain(target(e)));
  else if (e.type === "pointerdown") setState("active", chain(target(e)));
  else setState("active", []);
};
const onFocus = () => syncFocus();
const onValue = (e) => {
  const el = target(e);
  const m = toMirror.get(el);
  if (m) copyValue(el, m);
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
  ["selectionchange", syncSelection],
];

// Inner scrollers only; the document's own scroll moves the copy natively.
function onScrolled(e) {
  const t = e.target;
  if (!t || t.nodeType !== 1) return;
  scrolled.add(t);
  scrollDirty = true;
  if (live) requestScrollPass();
}
document.addEventListener("scroll", onScrolled, { capture: true, passive: true });

function readScroll() {
  if (!scrollDirty) return;
  scrollDirty = false;
  for (const el of scrolled) {
    if (!el.isConnected) {
      scrolled.delete(el);
      continue;
    }
    const m = toMirror.get(el);
    if (m) scrollReads.push([m, el.scrollTop, el.scrollLeft]);
  }
}

function writeScroll() {
  for (const [m, top, left] of scrollReads) {
    if (m.scrollTop !== top) m.scrollTop = top;
    if (m.scrollLeft !== left) m.scrollLeft = left;
  }
  scrollReads.length = 0;
}

// Media are placeholders the size the real ones are laid out at.
function sizeTo(m, w, h) {
  sizes.set(m, [w, h]);
  m.style.boxSizing = "border-box";
  m.style.width = w + "px";
  m.style.height = h + "px";
}

function sizeMedia() {
  const measured = [];
  for (const el of media) {
    if (!el.isConnected) {
      media.delete(el);
      continue;
    }
    const m = toMirror.get(el);
    if (m) measured.push([m, el.offsetWidth, el.offsetHeight]);
  }
  for (const [m, w, h] of measured) sizeTo(m, w, h);
}

// The part of a media element its picture covers: a letterboxed video's
// bars are the element's own background, which the copy draws.
function picture(el) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const cs = getComputedStyle(el);
  let { left, top, width, height } = r;
  let round = parseFloat(cs.borderTopLeftRadius) || 0;
  if (el.localName === "video" && el.videoWidth && el.videoHeight && /^(contain|scale-down)$/.test(cs.objectFit)) {
    const px = (p) => parseFloat(cs[p]) || 0;
    const cw = width - px("borderLeftWidth") - px("paddingLeft") - px("borderRightWidth") - px("paddingRight");
    const ch = height - px("borderTopWidth") - px("paddingTop") - px("borderBottomWidth") - px("paddingBottom");
    let s = Math.min(cw / el.videoWidth, ch / el.videoHeight);
    if (cs.objectFit === "scale-down") s = Math.min(s, 1);
    left += px("borderLeftWidth") + px("paddingLeft") + (cw - el.videoWidth * s) / 2;
    top += px("borderTopWidth") + px("paddingTop") + (ch - el.videoHeight * s) / 2;
    width = el.videoWidth * s;
    height = el.videoHeight * s;
    round = 0;
  }
  return { x: left + scrollX, y: top + scrollY, w: width, h: height, round };
}

/** Where the page's media pictures are, in document coordinates. */
export function holes() {
  const out = [];
  for (const el of media) {
    const r = el.isConnected && picture(el);
    if (r) out.push(r);
  }
  return out;
}

export function liveFrames(spec) {
  frameSpecs.push(spec);
}

/* ─── animations ──────────────────────────────────────────────────────────── */

const nativeAnimate = Element.prototype.animate;
// While the copy is shown, a script animation on the page plays on its copy too.
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

const samePseudo = (a, b) => (a.effect.pseudoElement || null) === (b.effect.pseudoElement || null);
const isCopy = (el) => mirrorRoots.has(el.getRootNode());

// Copies' CSS animations take the page's clocks; a transition the copy started
// on its own (its last flip) is finished, so nothing fades inside the ring.
function syncAnimations() {
  const matched = new Set();
  for (const a of document.getAnimations()) {
    const effect = a.effect;
    const el = effect && effect.target;
    if (!el || isCopy(el)) continue;
    const m = toMirror.get(el);
    if (!m || m.nodeType !== 1) continue;
    if (window.CSSAnimation && a instanceof CSSAnimation) {
      const b = m.getAnimations().find((x) => x instanceof CSSAnimation && x.animationName === a.animationName && samePseudo(a, x));
      if (b) {
        b.currentTime = a.currentTime;
        if (a.playState === "paused") b.pause();
        matched.add(b);
      }
    } else if (window.CSSTransition && a instanceof CSSTransition) {
      const b = m.getAnimations().find((x) => x instanceof CSSTransition && x.transitionProperty === a.transitionProperty && samePseudo(a, x));
      if (b) {
        b.currentTime = a.currentTime;
        matched.add(b);
      }
    } else {
      try {
        const b = nativeAnimate.call(m, effect.getKeyframes(), { ...effect.getTiming(), pseudoElement: effect.pseudoElement || undefined });
        b.currentTime = a.currentTime;
        b.playbackRate = a.playbackRate;
        if (a.playState === "paused") b.pause();
        pairs.push([a, b]);
      } catch (e) {}
    }
  }
  for (const b of shadow.getAnimations()) {
    if (window.CSSTransition && b instanceof CSSTransition && !matched.has(b)) b.finish();
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

function frame() {
  if (!live) return;
  syncPairs();
  requestAnimationFrame(frame);
}

/* ─── scheme ──────────────────────────────────────────────────────────────── */

function swapAll() {
  for (const look of lookups) {
    for (const el of document.body.querySelectorAll(look.selector)) swapContent(el);
  }
}

function adoptScheme(dark) {
  scheme = dark;
  syncRoot();
  syncBody();
  for (const m of themed) m.setAttribute("data-theme", themeName());
  for (const [el, [copy, spec]] of liveCopies) {
    if (el.isConnected) spec.theme(copy, dark);
    else liveCopies.delete(el);
  }
  swapAll();
}

function unmark() {
  for (const el of marked) {
    el.removeAttribute("data-scheme");
    el.removeAttribute("data-tg");
  }
  marked = [];
}

// Restyled a subtree at a time while idle, transitions held, so no frame carries
// the whole copy.
async function setScheme(dark) {
  const token = ++flipToken;
  const current = () => token === flipToken;
  flipping = true;
  flipTarget = dark;
  unmark();
  const mode = dark ? "dark" : "light";
  const chunks = partition(bodyEl);
  for (let i = 0; i < chunks.length; ) {
    await nextIdle();
    if (!current()) return;
    for (let budget = SLICE; i < chunks.length && budget > 0; i++) {
      const el = chunks[i][0];
      el.setAttribute("data-tg", "");
      el.setAttribute("data-scheme", mode);
      marked.push(el);
      budget -= chunks[i][1];
    }
  }
  await nextIdle();
  if (!current()) return;
  adoptScheme(dark);
  while (marked.length) {
    await nextIdle();
    if (!current()) return;
    for (let budget = SLICE; marked.length && budget > 0; budget -= CHUNK) {
      const el = marked.pop();
      el.removeAttribute("data-scheme");
      el.removeAttribute("data-tg");
    }
  }
  if (current()) flipping = false;
}

function flipNow(dark) {
  ++flipToken;
  flipping = false;
  unmark();
  if (scheme !== dark) adoptScheme(dark);
}

/* ─── interface ───────────────────────────────────────────────────────────── */

function sheetOf(text) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(text);
  return sheet;
}

function build() {
  host = document.createElement("div");
  host.className = "theme-mirror";
  host.inert = true;
  host.setAttribute("aria-hidden", "true");
  shadow = host.attachShadow({ mode: "open" });
  mirrorRoots.add(shadow);
  baseSheet = sheetOf(BASE_CSS);
  ownSheet = sheetOf(OWN_CSS);
  shadow.adoptedStyleSheets = [baseSheet, ownSheet];
  canvas = document.createElement("div");
  rootEl = document.createElement("m-root");
  bodyEl = document.createElement("m-body");
  tone = document.createElement("div");
  tone.className = "m-tone";
  rootEl.append(bodyEl);
  shadow.append(canvas, rootEl, tone);
  scheme = !real.classList.contains("dark");
  toMirror.set(real, rootEl);
  toMirror.set(document.body, bodyEl);
  real.append(host);
  syncRoot();
  syncBody();

  const rootChanged = () => {
    rootDirty = true;
    if (live) pump(null, true);
    else schedule();
  };
  observer = new MutationObserver(observe);
  observer.observe(document.body, OBSERVE);
  new MutationObserver(rootChanged).observe(real, { attributes: true });
  // Only a stylesheet coming or going rebuilds the copy's sheets — not the title
  // and meta tags every navigation rewrites.
  const isSheet = (n) => n.nodeName === "STYLE" || (n.nodeName === "LINK" && /stylesheet/i.test(n.rel || ""));
  new MutationObserver((records) => {
    for (const r of records) {
      const nodes = [...r.addedNodes, ...r.removedNodes];
      if (nodes.some(isSheet) || r.target.nodeName === "STYLE" || (r.type === "characterData" && r.target.parentNode?.nodeName === "STYLE")) {
        sheetsReady = false;
        return void idle(buildSheets);
      }
    }
  }).observe(document.head, { childList: true, subtree: true, characterData: true });
  addEventListener("resize", rootChanged);

  pendingParents.add(document.body);
  idle(buildSheets);
  schedule();
}

/** Builds the copy once, then keeps it in the scheme opposite the page's. */
export function prepare() {
  if (!host) return void idle(() => host || build());
  if (live) return;
  const want = !real.classList.contains("dark");
  if (flipping ? flipTarget !== want : scheme !== want) setScheme(want);
}

/** Whatever is still pending is done now, so the copy shows `dark` exactly. */
export function settle(dark) {
  if (!host) build();
  if (!sheetsReady) buildSheetsNow();
  pump(null, true);
  if (flipping || scheme !== dark) flipNow(dark);
}

/** Shows the copy (opacity 1, unmasked until the caller masks it). */
export function show() {
  live = true;
  pump(null, true);
  swapAll();
  for (const el of document.body.querySelectorAll("input, textarea, select")) {
    const m = toMirror.get(el);
    if (m) copyValue(el, m);
  }
  scrollDirty = true;
  readScroll();
  sizeMedia();
  writeScroll();
  syncHover();
  syncFocus();
  syncSelection();
  syncAnimations();
  for (const [type, fn] of LISTEN) document.addEventListener(type, fn, { capture: true, passive: true });
  unsubscribe = onScroll(readScroll, writeScroll, "theme-mirror");
  host.classList.add("is-shown");
  requestAnimationFrame(frame);
  return { host, tone };
}

export function hide() {
  live = false;
  host.classList.remove("is-shown");
  for (const [type, fn] of LISTEN) document.removeEventListener(type, fn, true);
  unsubscribe?.();
  unsubscribe = null;
  for (const [, b] of pairs) b.cancel();
  pairs.length = 0;
  if (window.CSS && CSS.highlights) CSS.highlights.delete("m-sel");
  schedule();
}
