/**
 * The editor.
 *
 * ── It is not a page ────────────────────────────────────────────────────────
 *
 * There is no workspace, no document rail and no editor layout. Editing happens
 * ON the article: you reach a post, press the pencil in the tools rail, and the
 * page you were reading becomes the page you are writing — same container, same
 * typography, same cover and same title, in the same places. What is on screen
 * while you type is not a preview of the post; it is the post.
 *
 * That is the whole design constraint, and it is why the chrome is so small.
 * Three things are ADDED to the article and nothing is moved: a bar naming the
 * file, a card holding the front matter, and a floating toolbar. Everything
 * downstream of the body — copyright, tags, recommendations, comments — is put
 * away while editing, because none of it is yours to edit here.
 *
 * `/blog-management/write/` is the same editor over an empty article shell, so
 * a new post is composed in exactly the layout it will be published in.
 *
 * ── Nothing here is a security boundary ─────────────────────────────────────
 *
 * The pencil is hidden by a CSS class. The Worker decides whether a ticket
 * comes back, and Gitea decides what that ticket may write.
 */

import { createView, makeBlock } from "./blocks.js";
import { INSERTS, askFor, createSlashMenu, createToolbar } from "./toolbar.js";
import { conversions, entryFor, fieldsFor, linesOf } from "./convert.js";
import {
  blocksToBody,
  docToMarkdown,
  emitBlock,
  escapeHTML,
  markdownToDoc,
  nextId,
  parseBlocks,
  parseFrontMatter,
  setFrontMatterKey,
} from "./markdown.js";
import { closeDialogs, createStage, forgetTree, noteCommitted, openAsk, openPicker, openSheet, pickerLive, sheetLive, siteAddress } from "./picker.js";
import { charSpan, createHistory, propsKey, signature } from "./history.js";
import { domRange, domText, spotClear, spotElement, spotRange, spotSeam } from "./spotlight.js";
import { toggleMath } from "./inline.js";
import { holdTOC, holdTOCActive, releaseTOC, scheduleTOC } from "./toc.js";
import { getTOC, refreshTOC as measureTOC } from "../../layouts/toc.js";
import { createFrontCard } from "./frontmatter.js";
import {
  PERCH_AT,
  hideVersionChrome,
  navigate,
  releaseDocbar as dropDocbar,
  watchDocbar,
  watchPerch,
} from "./chrome.js";
import {
  anchored,
  headroom,
  offScreen,
  readable,
  restingY,
  scrollTween,
  travelTo,
  useChrome,
  viewBottom,
} from "./travel.js";
import { loadComponents, typesetMath } from "./render.js";
import {
  bindImage,
  buildPreloader,
  loadManifest,
  naturalSize,
  registerRewind,
  repoURL,
  resolveAsset,
  relockPreviewed,
  setVaultAssets,
  setVaultIndex,
  shapeMedia,
  siteRoot,
  unlockSealed,
} from "./assets.js";
import initLazyLoad, {
  forceLoadAllPreloaders,
  registerSrcFallback,
  registerSrcResolver,
} from "../../layouts/lazyload.js";
import * as session from "./session.js";
import * as repo from "./repo.js";
import * as credentials from "./credentials.js";
import { EASE, contentChanged, crossFade, enter, exit, flip, flowCost, pop, reduced, toolbarIn, toolbarOut } from "./motion.js";

const AUTOSTASH_MS = 4000;
const EDGE = 90;        // px from a viewport edge where a drag starts scrolling
const EDGE_SPEED = 18;  // px per frame at the very edge

/*
 * Everything downstream of the body: present when reading, away when writing.
 *
 * The contents rail is NOT in this list, and its being here is what killed it in
 * edit mode: `.ed-put-away` is `display: none !important`, so the rail was gone
 * before anything could be written into it. Everything else here is downstream
 * of the article and none of it is yours to edit; the rail is a way of MOVING
 * AROUND the article, which is exactly what a long post being written needs.
 * plugins/editor/toc.js keeps it fed.
 */
const FURNITURE = [
  ".post-copyright-info",
  ".post-tags-box",
  ".recommended-article",
  ".article-nav",
  ".comment-container",
];

/**
 * Everything one editing session holds, as it is before one starts.
 *
 * ONE list, used to reset as well as to begin. A reset that named its fields by
 * hand forgot `snapshot` — for an encrypted post the decrypted article — and
 * kept it alive behind every page the author went on to read.
 */
function blank() {
  return {
    on: false,
    host: null,
    canvas: null,
    titleHost: null,
    snapshot: [],
    titleSnapshot: [],
    put: [],
    doc: null,
    root: null,
    focused: null,
    entry: null,
    pending: [],
    dirty: false,
    saving: false,
    painting: false,
    dragId: null,
    dropAt: "",
    vaultChoice: undefined,
    stage: null,
    stashTimer: null,
    leaving: false,
    perchOff: null,
    versionOff: null,
    viewportOff: null,
    composing: false,
    // The author's own choice to put the bars away, for this session only.
    minimized: false,
    // Opened on /blog-management/write/ rather than on an article. There is no
    // page under this editor to go back to or to reload, so both exits are
    // somewhere else: the console, or the site.
    fresh: false,
  };
}

const state = Object.assign(blank(), { boxes: new Set(), scrollRAF: 0, pointerY: 0 });

let ui = null;
let strings = null;

function t(key, fallback) {
  return (strings && strings[key]) || fallback;
}

/**
 * The editor's strings are by far the largest table in the theme and the editor
 * can now open on any post, so they are fetched once instead of riding every
 * page's config block.
 */
async function loadStrings() {
  if (strings) return strings;
  try {
    const res = await fetch(`${siteRoot()}/blog-management/editor-i18n.json`, { cache: "force-cache" });
    strings = res.ok ? await res.json() : {};
  } catch (err) {
    strings = {};
  }
  return strings;
}

/* ─── the page in front of us ──────────────────────────────────────────────── */

function findHost() {
  return document.querySelector(".article-content-container");
}

/** What this page is, in the terms `session.entryForPage` speaks. */
function pageIdentity(host) {
  if (host.dataset.postNew === "1") return { fresh: true };
  const gate = document.querySelector(".vault-gate[data-vault-slug]");
  if (gate) return { slug: gate.dataset.vaultSlug };
  return { source: host.dataset.postSource || "" };
}

/* ─── chrome ───────────────────────────────────────────────────────────────── */

function releaseDocbar() {
  dropDocbar(ui && ui.barSize);
}

function buildDocbar() {
  const bar = document.createElement("div");
  bar.className = "ed-docbar";
  bar.innerHTML = `
    <div class="ed-docbar-id">
      <i class="fa-solid fa-file-code" aria-hidden="true"></i>
      <code class="ed-docbar-path"></code>
      <span class="ed-tag ed-tag-vault" hidden><i class="fa-solid fa-lock-keyhole"></i>${escapeHTML(t("encrypted", "Encrypted"))}</span>
      <span class="ed-tag ed-tag-draft" hidden><i class="fa-solid fa-pen-nib"></i>${escapeHTML(t("draft", "Draft"))}</span>
    </div>
    <div class="ed-docbar-actions">
      <button type="button" class="ed-act ed-backend" hidden></button>
      <span class="ed-dot" data-state="clean" title=""></span>
      <button type="button" class="ed-act ed-save" disabled>
        <i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i><span>${escapeHTML(t("save", "Save draft"))}</span>
      </button>
      <button type="button" class="ed-act ed-act-primary ed-publish">
        <i class="fa-solid fa-paper-plane" aria-hidden="true"></i><span>${escapeHTML(t("publish", "Publish"))}</span>
      </button>
      <button type="button" class="ed-act ed-close" title="${escapeHTML(t("close", "Stop editing"))}">
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>
    </div>
    <div class="ed-progress" hidden></div>
    <div class="ed-notice" hidden></div>`;
  return bar;
}

/**
 * The article's own title block, rebuilt from the front matter.
 *
 * It is rebuilt rather than patched because the cover can be ADDED or REMOVED
 * while editing, and those are two different templates: with a cover the title
 * sits inside the frame, without one it is a plain heading. Emitting the same
 * markup the layout emits is what keeps "what you are editing" and "what will
 * be published" the same thing.
 */
function titleMarkup(front) {
  const cover = front.cover || front.banner || front.thumbnail || "";
  const centred = (window.theme?.articles?.style?.title_alignment || "") === "center";
  const place = centred ? "justify-center" : "justify-start";
  const title = escapeHTML(front.title || "");

  const pick = `<button type="button" class="ed-cover-act" data-cover="pick" title="${escapeHTML(t("cover_pick", "Change cover"))}"><i class="fa-solid fa-image" aria-hidden="true"></i></button>`;
  const drop = `<button type="button" class="ed-cover-act" data-cover="drop" title="${escapeHTML(t("cover_drop", "Remove cover"))}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;

  if (cover) {
    return `
      <div class="article-cover-frame sm:rounded-t-large">
        <img alt="" class="article-cover-image dark:brightness-75">
        <span class="ed-cover-tools">${pick}${drop}</span>
      </div>
      <div class="w-full flex items-center absolute bottom-0 ${place}">
        <h1 class="article-title-cover ed-title text-center mx-6 my-6 text-second-text-color bg-background-color-transparent px-4 py-3 text-3xl sm:text-4xl md:text-5xl font-semibold backdrop-blur-lg rounded-xl border border-border-color"
            contenteditable="true" spellcheck="false" data-placeholder="${escapeHTML(t("untitled", "Untitled"))}">${title}</h1>
      </div>`;
  }

  return `
    <div class="w-full flex items-center pt-6 ${place}">
      <h1 class="article-title-regular ed-title text-second-text-color tracking-tight text-4xl md:text-6xl font-semibold px-2 sm:px-6 md:px-8 py-3"
          contenteditable="true" spellcheck="false" data-placeholder="${escapeHTML(t("untitled", "Untitled"))}">${title}</h1>
    </div>
    <span class="ed-cover-tools is-bare">${pick}</span>`;
}

function paintTitle() {
  const front = parseFrontMatter(state.doc.front);
  state.titleHost.innerHTML = titleMarkup(front);

  // Bound rather than written into the markup: a sealed cover has no URL until
  // its bytes have been fetched and decrypted.
  bindImage(
    state.titleHost.querySelector(".article-cover-image"),
    front.cover || front.banner || front.thumbnail || "",
    state.pending
  );

  const heading = state.titleHost.querySelector(".ed-title");
  heading.addEventListener("input", () => {
    const title = heading.textContent.trim();
    writeFront("title", title);
    // The heading and the front matter's Title are one field shown twice.
    if (ui.front) ui.front.set("title", title);
    ui.path.textContent = pathLabel();
  });
  heading.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const first = state.root && state.root.views[0];
    if (first && first.focus) first.focus("start");
  });
}

function pathLabel() {
  if (state.doc.path) return state.doc.path;
  const title = parseFrontMatter(state.doc.front).title;
  return title ? `source/_posts/${title}.md` : t("unsaved_file", "not saved yet");
}

/* ─── activate ─────────────────────────────────────────────────────────────── */

async function activate(host) {
  if (state.on) return;
  state.on = true;

  const canvas = host.querySelector(".article-content");
  const titleHost = host.querySelector(".article-title");
  if (!canvas || !titleHost) {
    state.on = false;
    return;
  }

  state.host = host;
  state.canvas = canvas;
  state.stage = createStage();
  state.titleHost = titleHost;
  // The NODES, not their markup. Restoring from a string reparses the article:
  // every picture in it is requested a second time, and any preloader that was
  // still loading when the editor opened comes back as a fresh element the
  // observer has already been told about. Detached nodes keep their identity,
  // their decoded images and their place in the observer.
  state.snapshot = Array.from(canvas.childNodes);
  state.titleSnapshot = Array.from(titleHost.childNodes);

  host.classList.add("is-editing");
  // The site's mathjax plugin re-typesets the whole document whenever
  // MathJax.typesetPromise exists — and the editor is what makes it exist. This
  // class is the one MathJax was told to ignore, so the canvas is typeset by
  // the editor alone rather than by both of them.
  canvas.classList.add("ed-no-typeset");
  document.documentElement.classList.add("blog-editing");
  // "Published / View draft" and the encrypted badge describe what a READER is
  // being shown. Editing makes the canvas the draft, so they describe nothing —
  // and they go NOW, with the press, rather than after the repository has
  // answered: a control that lingers for a second and then disappears reads as
  // the page correcting itself.
  state.versionOff = hideVersionChrome(document);

  ui = { bar: buildDocbar() };
  host.insertBefore(ui.bar, canvas);
  Object.assign(ui, {
    path: ui.bar.querySelector(".ed-docbar-path"),
    vaultTag: ui.bar.querySelector(".ed-tag-vault"),
    draftTag: ui.bar.querySelector(".ed-tag-draft"),
    dot: ui.bar.querySelector(".ed-dot"),
    backend: ui.bar.querySelector(".ed-backend"),
    save: ui.bar.querySelector(".ed-save"),
    publish: ui.bar.querySelector(".ed-publish"),
    close: ui.bar.querySelector(".ed-close"),
    progress: ui.bar.querySelector(".ed-progress"),
    notice: ui.bar.querySelector(".ed-notice"),
    barSize: watchDocbar(ui.bar),
  });
  // What `travel.js` measures the readable band against. Registered here and
  // dropped in `forgetSession`, so the shared helpers always read the editor
  // that is actually open.
  useChrome(() => ({
    bar: ui && ui.bar,
    toolbar: ui && ui.toolbar && ui.toolbar.el,
    hidden: chromeHidden(),
  }));

  ui.file = document.createElement("input");
  ui.file.type = "file";
  ui.file.accept = "image/*";
  ui.file.hidden = true;
  document.body.appendChild(ui.file);

  // Wired before anything can fail: a bar that reports an error must also be
  // the way out of it, and a session that never finished opening must still be
  // closed by the navigation that leaves it.
  ui.close.addEventListener("click", () => deactivate());
  watchNavigation();

  ui.path.textContent = t("opening", "Opening");
  enter(ui.bar);

  // Put the reading furniture away before the body changes under it, so the
  // page settles once rather than twice.
  state.put = [];
  for (const sel of FURNITURE) {
    for (const node of document.querySelectorAll(sel)) {
      state.put.push(node);
      node.classList.add("ed-put-away");
    }
  }

  // Claimed BEFORE the ticket is asked for, so every exit below — including the
  // ones that fail — has something to release. See credentials.js for the list
  // of events that take it away again.
  credentials.hold();

  let ticketError = null;
  let opened = null;
  try {
    opened = await repo.open(true);
  } catch (err) {
    ticketError = err;
  }

  const gate = host.querySelector(".ed-gate");
  if (gate) gate.remove();

  if (ticketError) {
    notice("error", ticketError.message === "forbidden"
      ? t("denied", "This page is for the blog's administrator.")
      : t("unreachable", "Could not reach the backend."));
    ui.path.textContent = "";
    return;
  }

  settleBackend(opened);

  const identity = pageIdentity(host);
  state.fresh = !!identity.fresh;

  try {
    await Promise.all([loadComponents(), loadManifest()]);

    if (identity.fresh) {
      state.doc = session.newDocument();
      state.entry = state.doc.entry;
    } else {
      const entry = await session.entryForPage(identity);
      if (!entry) throw new Error(t("no_document", "This post is not in the repository you can write to."));

      // A published post that already HAS a draft is edited ON THE DRAFT —
      // `entryForPage` has already resolved to it. It opens HERE, in place: the
      // draft's own page carries no text this page does not, so sending the
      // author there was a full page load between pressing Edit and being able
      // to type. Every address the session uses comes off `entry`, not off the
      // URL — `doc.path`, `doc.sha`, the recovery stash and the save target are
      // the draft's — so the two versions do not share anything but a viewport.
      state.doc = await session.openDocument(entry);
      state.entry = entry;

      if (entry.draft) {
        notice("info", t("editing_draft", "You are editing the draft that supersedes this post."));
      } else if (state.doc.stale) {
        notice("warn", t("stale", "The published copy is behind the repository — a build is probably still running."));
      }

      const cached = await session.recover(state.doc.path, entry.grant);
      if (cached && cached.source !== docToMarkdown(state.doc)) {
        const answer = await openAsk(
          { t },
          {
            icon: "fa-clock-rotate-left",
            title: t("recover_title", "Unsaved local copy"),
            message: t("recover", "There is a copy of this post that was never committed."),
            note: new Date(cached.at).toLocaleString(),
            actions: [
              { key: "no", label: t("recover_drop", "Open what is committed") },
              { key: "yes", label: t("recover_use", "Restore it"), icon: "fa-rotate-left", kind: "primary" },
            ],
          }
        );
        if (answer === "yes") {
          Object.assign(state.doc, markdownToDoc(cached.source), {
            path: state.doc.path, sha: state.doc.sha, entry,
          });
          markDirty();
        }
      }
    }
  } catch (err) {
    notice("error", err.message);
    ui.path.textContent = "";
    return;
  }

  // Every sealed image this post owns, and the key for them. A public post
  // clears whatever the previous document registered.
  setVaultAssets(
    state.entry && state.entry.grant,
    state.entry && state.entry.assets,
    state.entry && state.entry.sizes
  );

  // And every sealed image the vault holds, which is a different question: a
  // post may show a picture belonging to ANOTHER encrypted post or album, and
  // that picture is published at no plaintext route at all. Without this the
  // canvas asked the site for a 404 and drew a broken image — the index was
  // loaded only when the picture browser opened.
  try {
    setVaultIndex(await session.sealedIndex());
  } catch (err) {
    setVaultIndex(null);
  }

  // Through the session rather than straight to `assetURL`: a borrowed picture
  // is sealed under its own item's key, and `unlockAsset` is what finds it.
  registerSrcResolver((node) => unlockSealed(node.getAttribute("data-vault-asset")));

  // A picture committed a minute ago is in the repository and not yet on the
  // site. The site is still asked first — that is the copy readers get — and
  // this is what stops the answer being a broken image for the length of a
  // build the author has only just started.
  registerSrcFallback((node) => repoURL(node.dataset.edSrc || "", state.pending));

  // A rename is a note to the build, not an act on the file. The document is
  // rewritten to the new address immediately, because that is what gets
  // committed; every REQUEST is rewound to where the bytes still are, because
  // nothing has moved yet. See the header of assets.js.
  registerRewind(liveAddress);

  ui.front = createFrontCard(state.doc, {
    t,
    onChange: onFrontChange,
    pickImage,
    bindImage: (img, src) => bindImage(img, src, state.pending),
  });
  host.insertBefore(ui.front.el, state.canvas);

  const ctx = {
    t,
    view: () => state.focused,
    richRoot,
    onInsert: (key) => insertItem(key, null),
    onPick: (item, hostView) => (item.kind === "convert" ? convertTo(item.key) : insertItem(item.key, hostView)),
    onConvert: (key) => convertTo(key),
    onSource: (on) => toggleSource(on),
    onAct: (act, arg) => {
      if (act === "move") return void moveFocused(Number(arg));
      if (act === "duplicate") return void duplicateFocused();
      if (act === "delete") return void (state.focused && deleteBlock(state.focused.block.id, "prev"));
      if (state.focused && state.focused.act) state.focused.act(act, arg);
    },
    onMarked: commitInline,
    onMath: (root) => applyMath(root),
    onStep: (dir) => (dir === "redo" ? history.redo() : history.undo()),
    onChrome: () => toggleChrome(),
    ask: (kind, current) => askFor(ui.toolbar.el, { t }, kind, current),
    ownsSelection: (sel) => state.canvas.contains(sel.anchorNode),
  };
  ui.toolbar = createToolbar(ctx);
  ui.slash = createSlashMenu(ctx);
  document.body.appendChild(ui.toolbar.el);

  await crossFade(state.canvas, () => {
    state.canvas.innerHTML = "";
    state.boxes.clear();
    state.root = createBox(state.doc.blocks, state.canvas, { depth: 0 });
    for (const block of state.doc.blocks) mountBlock(block, state.root);
    if (!state.root.views.length) {
      const block = makeBlock("paragraph");
      state.doc.blocks.push(block);
      mountBlock(block, state.root);
    }
  });

  paintTitle();
  enter(ui.front.el);
  syncHeader();
  wire();
  ui.toolbar.sync();
  contentChanged();
  holdTOC(state.canvas);

  // The post as it was opened — or as it was recovered, which is the same
  // thing to somebody who has not typed yet — becomes the step there is no
  // going back beyond. Nothing above this point was the author's doing.
  // A post opened on a recovered local copy is already ahead of the file, so it
  // has no clean step to compare against.
  history.start(!state.dirty);

  // Shown on the way in whatever the scroll position is — the toolbar arriving
  // IS the editor opening — and only then handed over to the perch rule below.
  ui.toolbar.el.dataset.perch = "show";
  await toolbarIn(ui.toolbar.el);
  state.perchOff = watchPerch(ui.toolbar.el, chromeHidden);
  state.viewportOff = watchViewport();
  syncChrome();

  if (identity.fresh) state.titleHost.querySelector(".ed-title").focus();
}

/* ─── composing on a phone ────────────────────────────────────────────── */

/**
 * The keyboard, and what the page is allowed to do about it.
 *
 * A soft keyboard does not push a page up — the browser scrolls the DOCUMENT
 * until the caret clears it, and on a short post that means scrolling past the
 * end: a screen of blank under the paragraph, with the navigation, the document
 * bar and the toolbar all shoved off the top. Everything the author needs while
 * typing ends up somewhere they can only reach by dismissing the keyboard they
 * are typing on.
 *
 * So the editor takes the decision back. The two bars that are no use mid-word
 * step aside — through the transition the navigation already owns, so it reads
 * as chrome making room rather than as a repaint — the toolbar is pinned to the
 * top of what is actually VISIBLE, and the page is scrolled ONCE, by us, so the
 * line being typed comes to rest a fifth of the way down the band that is left.
 *
 * ── What says the keyboard is up ────────────────────────────────────────────
 *
 * The FOCUS, and nothing else. Asking the visual viewport — "has it lost 140px?"
 * — was the obvious test and it never once fired: Chrome on Android answers the
 * keyboard by shrinking the LAYOUT viewport, so `innerHeight` falls by exactly as
 * much as `visualViewport.height` does and the difference stays zero. Safari
 * offsets the visual viewport instead and the same test does fire. One behaviour
 * per browser, none of it reliable; a caret in a field on a touch screen means a
 * keyboard, in every one of them.
 *
 * `interactive-widget=resizes-content` is set on the viewport for as long as the
 * editor is open, which is what makes the fixed toolbar land ABOVE the keyboard
 * on Chrome rather than behind it; `--ed-vv-top` covers the browsers that offset
 * instead of resizing.
 *
 * Nothing above the fold is pushed. The one height that changes is a band of
 * padding at the END of the article — without it a short post has nothing to
 * scroll INTO, which is exactly why the browser was over-scrolling and leaving
 * blank under the paragraph.
 */
const KB_WIDE = 820;    // above this, a soft keyboard is not what is happening
const KB_SETTLE = 120;  // the keyboard's own animation, roughly
const KB_BAND = 0.2;    // where in the band the line being typed comes to rest
const KB_TRAVEL = 220;  // taking the line there, rather than arriving at it
// Long enough to survive the caret being handed from one block to the next — an
// insert blurs and refocuses, and treating that as "the keyboard closed" is what
// made it close and reopen.
const KB_LINGER = 180;

const VIEWPORT_TAG = "width=device-width, initial-scale=1";
const VIEWPORT_EDIT = VIEWPORT_TAG + ", interactive-widget=resizes-content";

function setViewport(editing) {
  const tag = document.querySelector('meta[name="viewport"]');
  if (!tag) return;
  const want = editing ? VIEWPORT_EDIT : VIEWPORT_TAG;
  if (tag.getAttribute("content") !== want) tag.setAttribute("content", want);
}

function touchy() {
  return window.matchMedia("(pointer: coarse)").matches && window.innerWidth <= KB_WIDE;
}

/** Is this the editor's own field — a block, the title, a front-matter row? */
function editing(el) {
  if (!el || el === document.body) return false;
  return !!(
    (state.canvas && state.canvas.contains(el)) ||
    (state.titleHost && state.titleHost.contains(el)) ||
    (ui && ui.front && ui.front.el && ui.front.el.contains(el))
  );
}

/** The line being typed, which on a long paragraph is nowhere near its top. */
function caretRect() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rects = range.getClientRects();
  if (rects.length && rects[0].height) return rects[0];
  // A collapsed range on a boundary has no rectangle of its own.
  const node = range.startContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  return el ? el.getBoundingClientRect() : null;
}

function composeScroll() {
  if (!state.composing || !state.on) return;
  const at = caretRect();
  if (!at) return;

  const top = headroom();
  const foot = viewBottom();
  // Already somewhere it can be read. Correcting a few pixels on every viewport
  // event is a page that never settles under the hand.
  if (at.top >= top + 8 && at.bottom <= foot - 8) return;

  const band = Math.max(140, foot - top);
  const most = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const want = window.scrollY + at.top - top - band * KB_BAND;
  scrollTween(Math.min(most, Math.max(0, Math.round(want))), KB_TRAVEL);
}

function setCompose(on) {
  if (!!state.composing === !!on) return;
  state.composing = !!on;
  if (on) document.documentElement.dataset.edCompose = "1";
  else delete document.documentElement.dataset.edCompose;
  syncChrome();
}

/**
 * Whether the navigation and the document bar are put away.
 *
 * Only on a phone-sized touch screen, where the toolbar carries the button that
 * brings them back: while typing, because the keyboard has taken the room, or
 * because the author put them away and has not asked for them back.
 */
function chromeHidden() {
  return touchy() && (state.composing || state.minimized);
}

function syncChrome() {
  if (!state.on) return;
  const hidden = chromeHidden();
  const root = document.documentElement;
  const was = root.dataset.edChrome === "min";
  if (hidden) root.dataset.edChrome = "min";
  else delete root.dataset.edChrome;

  if (!ui || !ui.toolbar) return;
  ui.toolbar.chrome(hidden);
  if (hidden) ui.toolbar.el.dataset.perch = "show";
  else if (was) ui.toolbar.el.dataset.perch = window.scrollY > PERCH_AT ? "show" : "hide";
}

/** Minimise, or maximise — and bringing the bars back is also how typing ends. */
function toggleChrome() {
  if (!chromeHidden()) {
    state.minimized = true;
    return void syncChrome();
  }
  state.minimized = false;
  if (state.composing) {
    clearTimeout(composeLinger);
    clearTimeout(composeLook);
    const live = document.activeElement;
    if (live && live.blur && editing(live)) live.blur();
    setCompose(false);
  }
  syncChrome();
}

/** Take the caret out of the article, which is what closes the keyboard. */
function dropCaret() {
  const live = document.activeElement;
  if (live && live.blur && editing(live)) live.blur();
  composeAsk(false);
}

let composeTimer = 0;
let composeLinger = 0;
let composeLook = 0;

/**
 * Ask for compose mode, or let it go.
 *
 * Letting go is delayed: an insert blurs one field and focuses the next, and a
 * mode that ended in that gap put the keyboard away and brought it back for every
 * new block.
 */
function composeAsk(want) {
  clearTimeout(composeLinger);
  if (want) {
    setCompose(true);
    clearTimeout(composeTimer);
    composeTimer = setTimeout(composeScroll, KB_SETTLE);
    return;
  }
  composeLinger = setTimeout(() => {
    if (!editing(document.activeElement)) setCompose(false);
  }, KB_LINGER);
}

/**
 * The caret landed somewhere, or left. Re-asked on both — after the tick, because
 * `focusout` fires while `document.activeElement` is still the field being left.
 */
function composeCheck() {
  if (!state.on) return;
  clearTimeout(composeLook);
  composeLook = setTimeout(() => composeAsk(touchy() && editing(document.activeElement)), 0);
}

/**
 * Publish where the visible band is.
 *
 * `--ed-vv-top` is where it starts inside the layout viewport, which is what a
 * `position: fixed` toolbar has to be offset by on the browsers that answer a
 * keyboard by offsetting the visual viewport rather than resizing the page.
 */
function watchViewport() {
  const vv = window.visualViewport;
  const publish = () => {
    const root = document.documentElement.style;
    root.setProperty("--ed-vv-top", Math.round(vv ? vv.offsetTop : 0) + "px");
    root.setProperty("--ed-vv-h", Math.round(vv ? vv.height : window.innerHeight) + "px");
  };

  // The keyboard arriving or changing height is the only thing that changes what
  // "readable" means. Panning is left alone: that is the author looking at
  // something, and scrolling the page back under them would be the editor arguing.
  const react = () => {
    publish();
    // Turning a phone, or a window crossing the width, decides whether there is
    // a button to bring the bars back — so it decides whether they may be away.
    syncChrome();
    if (state.composing) {
      clearTimeout(composeTimer);
      composeTimer = setTimeout(composeScroll, KB_SETTLE);
    }
  };

  setViewport(true);
  publish();
  if (vv) {
    vv.addEventListener("resize", react);
    vv.addEventListener("scroll", publish);
  }
  window.addEventListener("resize", react);

  return () => {
    clearTimeout(composeTimer);
    clearTimeout(composeLinger);
    clearTimeout(composeLook);
    if (vv) {
      vv.removeEventListener("resize", react);
      vv.removeEventListener("scroll", publish);
    }
    window.removeEventListener("resize", react);
    setCompose(false);
    delete document.documentElement.dataset.edChrome;
    setViewport(false);
    const root = document.documentElement.style;
    root.removeProperty("--ed-vv-top");
    root.removeProperty("--ed-vv-h");
  };
}

/* ─── letting go of unsaved work ───────────────────────────────────────────── */

/**
 * The one question worth interrupting somebody for, asked properly.
 *
 * `window.confirm` has two answers, and this has three: the work can be
 * committed as a draft, published, or abandoned. Offering only "leave / stay"
 * meant the way OUT of the editor was never the way to keep what was in it,
 * which is how a native prompt turns a save into a decision under pressure.
 *
 * A save that fails leaves the editor open with its own error showing —
 * `doSave` swallows the error into a notice and leaves `dirty` set, so that
 * flag is the answer to "did the work survive".
 *
 * @returns {Promise<boolean>} true when it is safe to leave
 */
async function confirmLeave() {
  if (!state.on || !state.dirty) return true;
  // Asking is asynchronous, so a second press — the close button twice, a link
  // while the dialogue is already up — must not open a second dialogue over the
  // first and start a second teardown behind it.
  if (state.leaving) return false;
  state.leaving = true;

  try {
    const draft = (state.entry || {}).draft;
    // Left to right in the order the decision is actually weighed: leave, keep
    // it as a draft, put it live. One filled button, and it is the one that
    // publishes — the same button that publishes everywhere else in the editor,
    // wearing the same icon. Enter answers "save draft" rather than the filled
    // button: a key pressed to dismiss something must not publish a post.
    const answer = await openAsk(
      { t },
      {
        icon: "fa-triangle-exclamation",
        title: t("unsaved", "Unsaved changes"),
        message: t("discard", "This post has changes that are not committed yet."),
        note: state.doc ? state.doc.path : "",
        enter: "draft",
        actions: [
          { key: "quit", label: t("quit", "Leave without saving"), icon: "fa-arrow-right-from-bracket" },
          { key: "draft", label: t("save", "Save draft"), icon: "fa-cloud-arrow-up" },
          {
            key: "publish",
            label: draft ? t("publish_over", "Publish over the post") : t("publish", "Publish"),
            icon: "fa-paper-plane",
            kind: "primary",
          },
        ],
      }
    );

    if (!answer) return false;
    if (answer === "quit") return true;

    await doSave(answer);
    return !state.dirty;
  } finally {
    state.leaving = false;
  }
}

/* ─── deactivate ───────────────────────────────────────────────────────────── */

async function deactivate() {
  if (!state.on) return;
  // `state.on` is re-read after the await: the question is asynchronous, and
  // what it was asked about may be gone by the time it is answered.
  if (!(await confirmLeave()) || !state.on) return;

  // Stopping work on a NEW post leaves nothing behind to look at — the composer
  // is an empty article shell — so the way out is back to the console it was
  // opened from. Read before the teardown resets it.
  const composer = state.fresh;

  clearInterval(progressTimer);
  clearTimeout(state.stashTimer);
  // The steps belong to the session, not to the post: reopening the editor on
  // the same article starts from what is committed, not from where somebody
  // left off half an hour ago.
  history.reset();
  spotClear();
  unwire();
  if (state.perchOff) state.perchOff();
  if (state.viewportOff) state.viewportOff();
  if (state.versionOff) state.versionOff();

  // The toolbar leaves FIRST, and `releaseDocbar` comes after it.
  //
  // Its left edge and width are `var(--ed-docbar-x/w)`, published by the
  // document bar; releasing those first left the toolbar with no width to
  // inherit, so it snapped out to the full viewport for the length of its own
  // disappearance. `toolbarOut` also freezes the box it measured, so taking the
  // variables away underneath it changes nothing.
  // Held here, not read off `state` after each await: a navigation can close the
  // session outright while this is still animating it away.
  const chrome = ui;
  const { canvas, titleHost, snapshot, titleSnapshot, put, host } = state;
  const bar = chrome.bar;
  const front = chrome.front && chrome.front.el;
  const floating = chrome.toolbar && chrome.toolbar.el;

  if (floating) await toolbarOut(floating);
  releaseDocbar();

  await Promise.all([exit(bar), front ? exit(front) : Promise.resolve()]);
  bar.remove();
  if (front) front.remove();
  if (floating) floating.remove();
  if (chrome.slash) chrome.slash.el.remove();
  if (chrome.file) chrome.file.remove();
  document.querySelectorAll(".ed-ask, .ed-dragshot").forEach((el) => el.remove());
  closeDialogs();
  if (ui !== chrome) return;

  await crossFade(canvas, () => {
    canvas.replaceChildren(...snapshot);
    titleHost.replaceChildren(...titleSnapshot);
  });

  // Anything that was mid-swap when the article was taken apart was released by
  // the loader; this is where it gets picked up again.
  observeImages();
  // After the article is back, not before: the published list anchors on the
  // heading ids in THAT article, and measuring them while the canvas still held
  // editor blocks would put every heading at infinity.
  releaseTOC();

  for (const node of put) node.classList.remove("ed-put-away");
  canvas.classList.remove("ed-no-typeset");
  host.classList.remove("is-editing");
  document.documentElement.classList.remove("blog-editing");

  if (ui !== chrome) return;
  forgetSession();
  contentChanged();

  // `/blog-management/write/` is an empty article with nothing left in it once
  // the editor closes, so the console it was started from is the page. Through
  // swup, like every other link on the site.
  if (composer) navigate(`${siteRoot()}/blog-management/`);
}

/**
 * Let go of everything the session was lent: the document and every step of it,
 * the pictures staged for it, the post's image map, and — unless the console is
 * holding them for a commit of its own — the repository tokens.
 */
function forgetSession() {
  for (const asset of state.pending) URL.revokeObjectURL(asset.url);
  repo.forgetBlobs();
  credentials.release();
  forgetTree();
  useChrome(null);
  registerRewind(null);
  registerSrcFallback(null);
  // Every key the canvas borrowed for a picture belonging to another encrypted
  // item, and the bytes opened with it.
  relockPreviewed();
  setVaultAssets(null);
  setVaultIndex(null);
  state.boxes.clear();
  Object.assign(state, blank());
  ui = null;
}

/**
 * Close the editor NOW — no question, no animation.
 *
 * For when the page is going away underneath it: a navigation has started, or
 * the next page is already here. Nothing about the session may outlive that,
 * and nothing it left on the document may keep acting — a key handler still
 * wired to a closed session commits that session's document on Ctrl-S from
 * whatever page the author reads next.
 *
 * `leaving` keeps what is inside the article where it is: that page is already
 * on its way out, and pulling the document bar out of it mid-transition is a
 * jump in the one animation the author is watching.
 */
function abandon(leaving) {
  clearInterval(progressTimer);
  clearTimeout(state.stashTimer);
  history.reset();
  spotClear();
  stopEdgeScroll();
  if (!state.on) return;

  const live = document.activeElement;
  if (live && live.blur && editing(live)) live.blur();

  unwire();
  if (state.perchOff) state.perchOff();
  if (state.viewportOff) state.viewportOff();
  if (state.versionOff) state.versionOff();
  releaseDocbar();
  releaseTOC();
  for (const box of state.boxes) for (const view of box.views) releaseView(view);
  const floating = ".ed-toolbar, .ed-slash, .ed-ask, .ed-dragshot, .ed-spot";
  document.querySelectorAll(leaving ? floating : floating + ", .ed-docbar, .ed-front").forEach((el) => el.remove());
  if (ui && ui.file) ui.file.remove();
  closeDialogs();
  document.documentElement.classList.remove("blog-editing");
  forgetSession();
}

/**
 * A navigation has begun. A link or a history step with uncommitted work has
 * already asked; anything else that navigates still leaves the sealed recovery
 * copy behind before the session goes.
 */
function onVisitStart() {
  if (!state.on) return;
  if (state.dirty) {
    readAll();
    session.stash(state.doc, state.entry && state.entry.grant).catch(() => {});
  }
  abandon(true);
}

/**
 * Back or forward, with uncommitted work.
 *
 * A history step cannot be held open for a question the way a click can: by the
 * time it is heard the address bar has already moved. So the step is put back
 * first and asked about second, and the visit only happens once the work is
 * committed or deliberately left.
 */
function onPopVisit(visit, args, perform) {
  if (!state.on || !state.dirty) return perform();
  const to = visit.to.url + (visit.to.hash || "");
  window.history.go(visit.history.direction === "forwards" ? -1 : 1);
  confirmLeave().then((go) => {
    if (!go) return;
    state.dirty = false;
    navigate(to);
  });
}

/* ─── header ───────────────────────────────────────────────────────────────── */

function syncHeader() {
  if (!ui) return;
  const entry = state.entry || {};
  ui.path.textContent = pathLabel();
  ui.vaultTag.hidden = !entry.encrypted;
  ui.draftTag.hidden = !entry.draft;
  ui.save.disabled = !state.dirty || state.saving;
  ui.publish.disabled = state.saving;
  ui.dot.dataset.state = state.saving ? "busy" : state.dirty ? "dirty" : "clean";
  ui.dot.title = state.saving
    ? t("saving", "Saving")
    : state.dirty
      ? t("unsaved", "Unsaved changes")
      : t("saved_clean", "Everything is committed");
}

function notice(kind, text) {
  if (!ui) return;
  if (!text) {
    ui.notice.hidden = true;
    return;
  }
  const icon = kind === "error" ? "fa-circle-exclamation" : kind === "warn" ? "fa-triangle-exclamation" : "fa-circle-info";
  ui.notice.hidden = false;
  ui.notice.dataset.kind = kind;
  ui.notice.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${escapeHTML(text)}</span>`;
  pop(ui.notice);
}

const COVER_KEYS = ["cover", "banner", "thumbnail"];

function onFrontChange(key, value) {
  markDirty("front", key);

  // Remembered because publishing has to tell the author's decision apart from
  // the `vault: true` the draft machinery writes on every fork.
  if (key === "vault") state.vaultChoice = value;

  if (key === "title") {
    const heading = state.titleHost.querySelector(".ed-title");
    if (heading && heading !== document.activeElement) {
      heading.textContent = parseFrontMatter(state.doc.front).title || "";
    }
    ui.path.textContent = pathLabel();
    return;
  }

  if (!COVER_KEYS.includes(key)) return;

  // Gaining or losing a cover is a different template; changing which picture
  // it is only changes an `src`. Rebuilding on every keystroke would take the
  // caret out of the field being typed into.
  const front = parseFrontMatter(state.doc.front);
  const cover = front.cover || front.banner || front.thumbnail || "";
  const img = state.titleHost.querySelector(".article-cover-image");
  if (!cover !== !img) return void paintTitle();
  bindImage(img, cover, state.pending);
}

function writeFront(key, value) {
  state.doc.front = setFrontMatterKey(state.doc.front, key, value);
  state.doc.frontDirty = true;
  markDirty("front", key);
}

/* ─── blocks ───────────────────────────────────────────────────────────────── */

function blockCtx(box) {
  const home = box || state.root;
  return {
    t,
    box: home,
    onChange: (view, kind) => {
      // The box the view is in NOW, not the one it was built in. A block dragged
      // between a note and the article keeps its view — rebuilding it there is
      // what re-fetched its picture and made the page jump — so the only thing
      // that has to follow it across is which box its edits are written back to.
      writeBox((view && view.box) || home);
      markDirty(kind || "text", view && view.block ? view.block.id : "");
      if (view && view.block && view.block.type === "heading") refreshTOC();
    },
    onFocus: (view) => {
      const moved = state.focused !== view;
      state.focused = view;
      for (const other of allViews()) other.el.dataset.on = other === view ? "1" : "0";
      // The Block tab is about THIS block, so it is repainted the moment the
      // caret lands in another one.
      if (moved && ui && ui.toolbar) ui.toolbar.sync();
    },
    /** A nesting component asks for a box of its own; one level, never two. */
    nest: (el, markdown, opts) => {
      if (home.depth >= 1) return null;
      const child = createBox([], el, {
        depth: home.depth + 1,
        write: opts.write,
        onEmpty: opts.onEmpty,
      });
      // Carried on the box so the component that opened it can hand it to
      // `morphHeight`, which otherwise measures a pane whose blocks have not
      // drawn and animates to a height that is about to change.
      child.ready = fillBox(child, markdown);
      return child;
    },
    unnest: dropBox,
    fillBox,
    writeBox,
    onOptionsChanged: () => {
      if (ui && ui.toolbar) ui.toolbar.refresh();
    },
    onRemount: (id) => remountBlock(id),
    onRawEdited: (id, text) => applyRaw(id, text),
    ask: (kind, current) => askFor(ui.toolbar.el, { t }, kind, current),
    onInsertBefore: (id) => insertBlock(makeBlock("paragraph"), id, true, null, "before"),
    onSplit: (id, tailText) => {
      const view = insertBlock(makeBlock("paragraph", { text: tailText }), id, false);
      if (view && view.focus) view.focus("start");
    },
    onDelete: (id, move) => deleteBlock(id, move),
    onMergeBack: (id) => mergeBack(id),
    onConvert: (id, type, fields) => convertBlock(id, type, fields),
    onFocusSibling: (id, delta) => {
      const at = locate(id);
      if (!at) return;
      // Past anything that holds no caret — a picture is typed into nowhere.
      for (let i = at.index + delta; i >= 0 && i < at.box.views.length; i += delta) {
        const view = at.box.views[i];
        if (view.focus) return void view.focus(delta > 0 ? "start" : "end");
      }
    },
    onSlash: (view) => ui.slash.open(view),
    onPasteMarkdown: (id, text) => pasteMarkdown(id, text),
    onDragStart: (id) => {
      state.dragId = id;
      state.dropAt = "";
      state.canvas.classList.add("is-dragging");
      document.addEventListener("dragover", onDocDragOver);
      document.addEventListener("drop", onDocDrop);
    },
    onDragEnd: () => {
      state.dragId = null;
      stopEdgeScroll();
      document.removeEventListener("dragover", onDocDragOver);
      document.removeEventListener("drop", onDocDrop);
      state.canvas.classList.remove("is-dragging");
      paintDrop(null);
    },
    resolveAsset: (src) => resolveAsset(src, state.pending),
    bindImage: (img, src) => bindImage(img, src, state.pending),
    buildPreloader: (src, alt) => buildPreloader(src, alt, state.pending),
    shapeMedia,
    exifLabels: () => (strings && strings.image_exif) || {},
    settleFigure,
    observeImages,
    figureIndex,
    pickImage,
    imageProps,
    openViewer,
  };
}

/**
 * Everything the theme's `{% exifimage %}` can be told, and NOTHING ELSE.
 *
 * The fields ARE the tag's, one for one: a caption title and an auto-exif
 * switch in its arguments, a description in the image line, and the seventeen
 * names scripts/modules/image-exif.js matches inside `<!-- exif-info -->`. A
 * field the tag has no idea about is not a field — a hover title, for
 * instance, is read by the tag as part of the image's PATH, so `title` is never
 * offered and a plain image keeps whatever it was written with.
 */
const EXIF_GROUPS = [
  ["g_camera", "Camera", ["Make", "Model", "DateTimeOriginal"]],
  ["g_lens", "Lens", ["LensModel", "FocalLength", "FocusMode"]],
  ["g_exposure", "Exposure", ["ExposureTime", "Aperture", "ISOSpeedRatings", "ExposureProgram", "ExposureBias", "MeteringMode"]],
  ["g_other", "Other", ["Flash", "WhiteBalance", "GPSLatitude", "GPSLongitude", "GPSAltitude"]],
];

function propsOf(block) {
  return Object.assign(
    { exifTitle: block.exifTitle || "", alt: block.alt || "", autoExif: block.autoExif !== false },
    block.exif || {}
  );
}

/**
 * The sheet, on one picture.
 *
 * Opened by the Properties button it is a question; opened by a step (`quiet`)
 * it is a window onto the change, and an Apply from either is ONE step of kind
 * `props` — which is what brings undoing it back here, to the field, instead of
 * to a caption on the canvas.
 *
 * @returns the live sheet, so a step can stand on a field and mark it
 */
function imageProps(view, quiet) {
  const held = sheetLive();
  if (held && held.id === view.block.id) return held;
  if (held) held.close();

  const api = window.RedefineComponents;
  const labels = (api && api.EXIF_LABELS) || {};
  const id = view.block.id;

  openSheet(
    { t },
    {
      id,
      quiet,
      title: t("properties", "Picture properties"),
      values: propsOf(view.block),
      groups: [
        {
          label: t("g_caption", "Caption"),
          fields: [
            { key: "exifTitle", label: t("f_title", "Title"), wide: true },
            { key: "alt", label: t("f_description", "Description"), wide: true },
            {
              kind: "note",
              text: t(
                "exif_note",
                "With this on, the build reads the camera data out of the picture file, so those values appear on the published page and not here. Any field filled in below replaces the one read from the file."
              ),
            },
            { key: "autoExif", label: t("auto_exif", "Read EXIF at build time"), kind: "toggle" },
          ],
        },
        ...EXIF_GROUPS.map(([key, label, keys]) => ({
          label: t(key, label),
          fields: keys.filter((k) => labels[k]).map((k) => ({ key: k, label: labels[k] })),
        })),
      ],
    }
  ).then((answer) => {
    const at = answer && state.on ? locate(id) : null;
    if (!at) return;
    const exif = {};
    for (const key of Object.keys(labels)) if (answer[key]) exif[key] = answer[key];
    const next = { alt: answer.alt, exifTitle: answer.exifTitle, autoExif: answer.autoExif !== false, exif };
    if (!propsKey(at.view.block, next)) return;
    Object.assign(at.view.block, next);
    at.view.touch("props");
    at.view.paint();
    if (ui && ui.toolbar) ui.toolbar.refresh();
  });

  return sheetLive();
}

function closeSheet() {
  const held = sheetLive();
  if (held) held.close();
}

/**
 * The lightbox, on request — a click on the canvas selects instead.
 *
 * Every picture on the canvas wears `data-no-viewer`, and the viewer builds its
 * gallery from the pictures that do not, synchronously as it opens. So the mark
 * comes off all of them for exactly that call: a gallery of one is a viewer
 * that cannot step to the next picture, and one built from stale nodes shows
 * the caption the picture had before its properties changed.
 */
function openViewer(node) {
  const viewer = window.__REDEFINE_X_IMAGE_VIEWER__;
  if (!node || !viewer || !viewer.api || !state.canvas) return;
  const marked = Array.from(state.canvas.querySelectorAll("[data-no-viewer]"));
  for (const el of marked) el.removeAttribute("data-no-viewer");
  try {
    viewer.api.open(node);
  } finally {
    for (const el of marked) el.setAttribute("data-no-viewer", "");
  }
}

/** The EXIF card's own collapse and layout, for cards the page never rendered. */
function settleFigure() {
  if (window.__redefineExif) window.__redefineExif.init();
}

/**
 * Hand the article's images to the site's own lazyload observer.
 *
 * Deferred to the next frame, and coalesced. A block paints itself BEFORE it is
 * appended to the canvas, so a pass run inline could not see the image it was
 * called for — every image was picked up by the next block's pass and the last
 * one in the post by nobody, which is why it sat on its skeleton forever. One
 * pass after the mounting burst sees all of them, and asks the observer once
 * instead of once per image.
 */
let observePass = 0;

function observeImages() {
  if (observePass) return;
  observePass = requestAnimationFrame(() => {
    observePass = 0;
    const articles = (window.theme && window.theme.articles) || {};
    if (articles.lazyload !== true) return void forceLoadAllPreloaders();
    initLazyLoad({ preload: articles.lazyload_preload === true });
  });
}

/**
 * Which figure this is, counted the way the build counts them — in the order
 * they appear on the page, which for a picture inside a note means counting
 * through the note rather than around it.
 */
function figureIndex(id) {
  let n = 0;
  if (!state.canvas) return 1;
  for (const el of state.canvas.querySelectorAll('.ed-block[data-type="image"]')) {
    n += 1;
    if (el.dataset.id === id) return n;
  }
  // Not on the canvas yet: a picture being mounted, which lands after the rest.
  return n + 1;
}

/** Figure numbers are positional, so every image restates its own after a move. */
/* ─── boxes ────────────────────────────────────────────────────────────────── */

/**
 * A list of blocks with a home.
 *
 * The document is one box; the body of a large note, a folding or a tab pane is
 * another. Everything below works on a BOX rather than on the document, which
 * is what lets a note hold real blocks — with their own gutters, their own
 * conversions and their own drag handles — instead of a slab of rich text that
 * looked like the article but behaved like nothing else in it.
 *
 * One level only. A box inside a box would mean a note inside a note, which the
 * markdown can express but nobody can read, so a nested box refuses to take a
 * block that would open a third.
 */
/**
 * The button at the END of a box.
 *
 * Every block's gutter `+` inserts ABOVE it, which leaves exactly one place in
 * a box that no button can reach: after the last block. Inside a tab pane, a
 * large note or a folding that is the only place there is when the component
 * holds one line — and at the foot of the article it is where writing actually
 * continues. So each box grows a tail of its own, and it is also where the drop
 * indicator goes when a dragged block is heading for the end (see `paintDrop`).
 */
function makeTail(box) {
  // A ROW holding the button, not a button spanning the row. The drop indicator
  // has to be as wide as the gap it stands for, and the button has to be the
  // same 26px square as every other `+` in the editor — one element cannot be
  // both, and a full-width button is also a full-width hover target for a
  // control that occupies one corner of it.
  const tail = document.createElement("div");
  tail.className = "ed-tail";
  tail.contentEditable = "false";

  const add = document.createElement("button");
  add.type = "button";
  // The gutter's own class, deliberately: this is the same button in the one
  // place a gutter cannot reach, and it should not be a second design of it.
  add.className = "ed-gutter-btn ed-tail-add";
  add.tabIndex = -1;
  add.title = t("insert_end", "Add a block at the end");
  add.innerHTML = `<i class="fa-solid fa-plus" aria-hidden="true"></i>`;
  add.addEventListener("mousedown", (e) => e.preventDefault());
  add.addEventListener("click", (e) => {
    e.preventDefault();
    insertBlock(makeBlock("paragraph"), null, true, box);
  });

  tail.appendChild(add);
  return tail;
}

let boxSeq = 0;

function createBox(blocks, el, opts) {
  const box = Object.assign({ blocks, views: [], el, depth: 0, write: null, onEmpty: null }, opts || {});
  box.uid = ++boxSeq;
  box.tail = makeTail(box);
  el.appendChild(box.tail);
  state.boxes.add(box);
  return box;
}

function dropBox(box) {
  if (box.tail) box.tail.remove();
  state.boxes.delete(box);
}

/**
 * Forget every box drawn inside `el`, because `el` is about to be discarded.
 *
 * A component builds its box while its own view is still being CONSTRUCTED and
 * therefore still detached from the page, so "is it connected?" cannot be the
 * test for whether a box is alive — asked at the wrong moment it answers no
 * about a box that is seconds old, and dropping it there takes the note's
 * blocks out of `locate` entirely: no dragging, no deleting, no inserting, no
 * typing. Abandonment is an event, not a state, so it is recorded where it
 * happens: every place that replaces or removes a view calls this first.
 */
function dropBoxesIn(el) {
  if (!el) return;
  for (const box of state.boxes) {
    if (box === state.root || !box.el || !el.contains(box.el)) continue;
    for (const view of box.views) releaseView(view);
    state.boxes.delete(box);
  }
  // The view being discarded is not in a box of its own, so it is released here.
  for (const box of state.boxes) {
    for (const view of box.views) if (view.el === el) releaseView(view);
  }
}

/** Every view on the canvas, in the order they are painted. */
function allViews() {
  const out = [];
  for (const box of state.boxes) out.push(...box.views);
  return out;
}

/** Which box holds this block, and where in it. */
function locate(id) {
  for (const box of state.boxes) {
    const index = box.views.findIndex((v) => v.block.id === id);
    if (index >= 0) return { box, index, view: box.views[index] };
  }
  return null;
}

/**
 * A nested box writes itself back into the component that owns it.
 *
 * Guarded, because writing calls the component's `touch`, which asks its OWN
 * box to write — a short loop that would otherwise run until the stack ended.
 */
function writeBox(box) {
  if (!box || !box.write || box.writing) return;
  box.writing = true;
  try {
    for (const view of box.views) view.read();

    // A box nothing has been typed into emits the text it was BUILT from, not a
    // reconstruction of it.
    //
    // `blocksToBody` cannot reproduce a body exactly: it is handed `""` as the
    // lead, so the blank lines before the first block are gone, and the caller
    // trims the separator after the last. So merely READING a note came back a
    // few whitespace characters different from the note in the file — and that
    // difference reached the document as an edit, with a step of its own, aimed
    // at whichever block the re-parse had shifted. Every four seconds, because
    // that is when the recovery stash reads.
    // "Nothing has been typed into it" is not enough on its own: a block dragged
    // OUT of a note leaves every block that remains untouched, and emitting the
    // text the box was built from would put the departed block back. The list of
    // ids is what says the box still holds what it held.
    const stamp = box.blocks.map((block) => block.id).join(",");
    const clean = box.source != null && box.stamp === stamp && !box.blocks.some((block) => block.dirty);
    const text = clean ? box.source : blocksToBody(box.blocks, "").replace(/\s+$/, "");
    box.source = text;
    box.stamp = stamp;
    box.write(text);
  } finally {
    box.writing = false;
  }
}

function renumberFigures() {
  for (const view of allViews()) if (view.renumber) view.renumber();
}

function mountBlock(block, box) {
  const home = box || state.root;
  const view = createView(block, blockCtx(home));
  view.box = home;
  // Before the tail, which is the last thing in every box.
  home.el.insertBefore(view.el, home.tail || null);
  home.views.push(view);
  return view;
}

/** A view being discarded: anything it subscribed to outside itself goes too. */
function releaseView(view) {
  if (view && view.release) view.release();
}

/** The contents rail follows the headings on the canvas. Debounced; see toc.js. */
function refreshTOC() {
  if (state.on && state.canvas) scheduleTOC(state.canvas);
}

/**
 * Fill a box with the blocks its markdown parses to — reusing what is there.
 *
 * Called by a nesting component when it mounts, whenever the body it holds is
 * replaced from outside — a tab pane switching — and now on every step that
 * lands inside one.
 *
 * Nothing here can be matched by identity: `parseBlocks` mints a fresh id every
 * time it runs, so the same paragraph is a different id on the way back in. The
 * alignment is by SIGNATURE from both ends inwards, and only the middle is
 * rebuilt. That is the whole reason undoing one line of a note no longer makes
 * an unrelated picture two lines below it fetch itself again.
 *
 * @returns {Promise} the box's first paint. A pane that holds a diagram, an
 *   equation or a code listing is not its final height in the tick it is built,
 *   and the component animating open around it has to know that.
 */
/**
 * What a block SAYS, with no account of what follows it.
 *
 * `signature` includes the separator, which is right for the document — two
 * paragraphs a blank line apart are not the same file as two that are not — and
 * wrong for deciding whether a block changed. A nested box writes itself back
 * with its last separator trimmed, so re-parsing gives the final block a
 * different `after` every other pass: matched on `signature`, that read as an
 * edit to a block nobody had touched.
 */
function shapeOf(block) {
  return block.type + " " + (block.dirty ? emitBlock(block) : block.src || "");
}

function fillBox(box, markdown) {
  // What this box is to emit while nothing in it has been typed into. See
  // `writeBox`: the round-trip law applies to a note's body as much as to a post.
  box.source = String(markdown == null ? "" : markdown);
  const wanted = parseBlocks(box.source);
  if (!wanted.length) wanted.push(makeBlock("paragraph"));

  const old = box.views.slice();
  const was = old.map((view) => shapeOf(view.block));
  const now = wanted.map((block) => shapeOf(block));

  let head = 0;
  while (head < old.length && head < wanted.length && was[head] === now[head]) head += 1;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < wanted.length - head &&
    was[old.length - 1 - tail] === now[wanted.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midOld = old.slice(head, old.length - tail);
  const midNew = wanted.slice(head, wanted.length - tail);

  const views = old.slice(0, head);
  const fresh = [];
  const patched = [];
  const painting = [];

  // A block that matched keeps its view and takes the separator that came with
  // the new text. `after` belongs to the POSITION, not to the words, and a box
  // writes itself back with its last separator trimmed — so a block that had
  // said "\n\n" said "" the next time round, and every pass through here found
  // a difference nobody had typed.
  for (let i = 0; i < head; i++) old[i].block.after = wanted[i].after;
  for (let i = 1; i <= tail; i++) {
    old[old.length - i].block.after = wanted[wanted.length - i].after;
  }

  /**
   * Pair the middle by CONTENT, then by type, and only then give up.
   *
   * Pairing by position was the bug behind a picture vanishing: swap a
   * paragraph and an image inside a note and position 0 offers the image view
   * the paragraph's words and position 1 offers the paragraph view the image's.
   * A block that has only changed PLACES keeps the view it had, so a reorder
   * inside a note travels rather than being rebuilt around the author.
   */
  const spare = midOld.slice();
  const claim = (want) => {
    const same = spare.findIndex((view) => view && shapeOf(view.block) === shapeOf(want));
    if (same >= 0) {
      const view = spare[same];
      spare[same] = null;
      return { view, same: true };
    }
    const kin = spare.findIndex((view) => view && view.patch && view.patch(want, true));
    if (kin >= 0) {
      const view = spare[kin];
      spare[kin] = null;
      return { view, same: false };
    }
    return null;
  };

  for (const want of midNew) {
    const got = claim(want);

    if (got && got.same) {
      // Same words, different separator: take the separator and leave the block
      // alone. Rewriting it would be a repaint, a caret restore and a report of
      // a change, for something nobody typed.
      got.view.block.after = want.after;
      views.push(got.view);
      continue;
    }
    if (got) {
      const text = domText(got.view.body);
      got.view.patch(want);
      patched.push({ view: got.view, was: text });
      views.push(got.view);
      continue;
    }

    const view = createView(want, blockCtx(box));
    view.box = box;
    views.push(view);
    fresh.push(view);
    if (view.ready) painting.push(Promise.resolve(view.ready).catch(() => {}));
  }

  for (const view of spare) {
    if (!view) continue;
    dropBoxesIn(view.el);
    view.el.remove();
  }
  views.push(...old.slice(old.length - tail));

  box.blocks.length = 0;
  box.views.length = 0;
  for (const view of views) {
    box.blocks.push(view.block);
    box.views.push(view);
  }

  let anchor = box.tail || null;
  for (let i = views.length - 1; i >= 0; i--) {
    const el = views[i].el;
    if (el.parentNode !== box.el || el.nextSibling !== anchor) box.el.insertBefore(el, anchor);
    anchor = el;
  }

  // What `writeBox` compares against to know the box still holds what it was
  // built from. Taken after the reconcile, not before it.
  box.stamp = box.blocks.map((block) => block.id).join(",");

  // Left for `harvest` to pick up: what a step actually did to this box is what
  // decides where the spotlight goes, and a box does not know it is in a step.
  box.lastFresh = fresh;
  box.lastPatched = patched;
  renumberFigures();
  return painting.length ? Promise.all(painting) : null;
}

/**
 * Put a block into a box.
 *
 * `where` is "after" (the default, and what Enter does) or "before" — the
 * gutter's `+`, which reads as "a new block here" and used to mean "a new block
 * one line further down".
 */
function insertBlock(block, anchorId, focus, box, where) {
  const at = anchorId == null ? null : locate(anchorId);
  const home = box || (at ? at.box : state.root);
  const index = at
    ? where === "before"
      ? at.index
      : at.index + 1
    : home.blocks.length;

  home.blocks.splice(index, 0, block);
  const view = createView(block, blockCtx(home));
  view.box = home;

  const next = home.views[index];
  const anchor = next ? next.el : home.tail || null;
  // Read while the box is still the box it was. `:first-child` and
  // `:last-of-type` move to the new block the instant it is in the tree, and the
  // margin they take off whichever block used to hold them is space that would
  // otherwise arrive in one frame rather than over the length of the animation.
  const gone = flowCost(home.el, anchor);

  if (anchor) anchor.before(view.el);
  else home.el.appendChild(view.el);
  home.views.splice(index, 0, view);

  // Numbered and written back BEFORE it travels: a caption that gains a number
  // afterwards is a height the animation has already finished arriving at.
  renumberFigures();
  writeBox(home);
  markDirty("insert", block.id);

  // `view.ready` is the block's own first paint where it has one — a diagram or
  // an equation renders asynchronously, and measuring before that finished is
  // what made a new block at the end of an article stutter and then snap to a
  // different height.
  enter(view.el, view.ready, gone).then(() => {
    // A picture has nothing to type into. Focusing its caption opened the
    // keyboard over the picture the author had just chosen to look at.
    if (focus && view.focus && block.type !== "image") view.focus("start");
    else if (focus && block.type === "image") dropCaret();
    contentChanged();
    refreshTOC();
  });
  return view;
}

async function deleteBlock(id, move) {
  const at = locate(id);
  if (!at) return;
  const { box, index, view } = at;

  // The last block in the document becomes an empty paragraph — there has to be
  // somewhere to type. The last block in a NESTED box takes the box with it,
  // because a note with nothing in it is not a note.
  if (box.views.length === 1) {
    if (!box.onEmpty) return void convertBlock(id, "paragraph", { text: "" });
    return void box.onEmpty();
  }

  // Something still on screen that is NOT what is leaving, held at the pixel it
  // stands on. `exit` collapses the box and the caret then moves to a neighbour,
  // and both of those slide the article under the reader.
  const steady = steadyAnchor(view.el);
  await exit(view.el);

  await anchored(steady, () => {
    dropBoxesIn(view.el);
    view.el.remove();
    box.views.splice(index, 1);
    box.blocks.splice(index, 1);

    const next = box.views[move === "next" ? index : Math.max(0, index - 1)];
    if (next && next.focus) next.focus("end");
  });

  renumberFigures();
  writeBox(box);
  markDirty("delete", id);
  contentChanged();
  refreshTOC();
}

/** Backspace at the head of a block folds it into the one above. */
function mergeBack(id) {
  const at = locate(id);
  if (!at || at.index <= 0) return;

  const prev = at.box.views[at.index - 1];
  const here = at.view;
  if (!prev.editable || prev.block.type === "list") return;

  prev.read();
  here.read();
  const joined = (prev.block.text || "") + (here.block.text || "");
  const caretAt = joined.length - (here.block.text || "").length;

  const fields = { text: joined };
  if (prev.block.type === "heading") fields.level = prev.block.level;
  convertBlock(prev.block.id, prev.block.type, fields);
  deleteBlock(id, "prev");
  const rebuilt = at.box.views[at.index - 1];
  if (rebuilt && rebuilt.focus) rebuilt.focus(caretAt === 0 ? "start" : "end");
}

function convertBlock(id, type, fields) {
  const at = locate(id);
  if (!at) return;
  const { box, index } = at;

  const old = box.blocks[index];
  const block = makeBlock(type, fields);
  block.after = old.after;
  box.blocks[index] = block;

  const view = createView(block, blockCtx(box));
  view.box = box;
  dropBoxesIn(box.views[index].el);
  box.views[index].el.replaceWith(view.el);
  box.views[index] = view;
  state.focused = view;

  if (view.focus) view.focus("end");
  writeBox(box);
  markDirty("convert", id);
  contentChanged();
  refreshTOC();
}

/** A multi-line paste is a document: it arrives as blocks, not as one line. */
function pasteMarkdown(id, text) {
  const blocks = parseBlocks(text).map((b) => Object.assign(b, { dirty: true }));
  if (!blocks.length) return;

  let anchor = id;
  for (const block of blocks) {
    insertBlock(block, anchor, false);
    anchor = block.id;
  }

  const here = locate(id);
  if (here && here.view.isEmpty && here.view.isEmpty()) deleteBlock(id, "next");
}

/* ─── the four ways of editing ─────────────────────────────────────────────── */

/** The contenteditable the caret is in, which is what an inline mark acts on. */
function richRoot() {
  const node = document.activeElement;
  if (!node || !state.canvas || !state.canvas.contains(node)) return null;
  if (!node.isContentEditable) return null;
  const root = node.closest("[contenteditable=true]");
  // A component's title is plain text — the tag's arguments, not its body — so
  // it is editable without being formattable.
  return root && !root.classList.contains("ed-inplace") ? root : null;
}

/**
 * Write an inline change back into the document.
 *
 * `view.read()` is not enough on its own: a component's body, a tab's pane and a
 * table's cells are read by their OWN input listeners, and a mark applied from
 * the toolbar fires no input event. Replaying one is what makes formatting
 * inside a note reach the file — without it the note looked right and saved
 * unchanged.
 */
function commitInline() {
  const root = richRoot();
  if (root) root.dispatchEvent(new Event("input", { bubbles: true }));
  if (state.focused) {
    state.focused.touch();
    state.focused.read();
  }
}

/**
 * Words ⇄ equation.
 *
 * The chip is typeset here rather than in inline.js because MathJax is the
 * editor's to load, and the block is committed through its OWN editable rather
 * than through `commitInline` — taking a chip apart removes the element the
 * caret was in, so the rich root the toolbar was holding is detached by the time
 * the change needs reporting.
 */
function applyMath(root) {
  const view = state.focused;
  const host = (view && view.editable) || root;
  const made = toggleMath(root || host);
  if (made) typesetMath(made);
  if (host && host.isConnected) host.dispatchEvent(new Event("input", { bubbles: true }));
  if (view) {
    view.touch();
    view.read();
  }
}

/**
 * Change what this block IS, carrying its words across.
 *
 * The conversion is expressed in plain lines, so nothing can be lost on the way
 * — and a target that cannot hold those lines (a heading, given three of them)
 * is refused here as well as greyed out in the toolbar, because the slash menu
 * reaches the same table.
 */
function convertTo(key) {
  const view = state.focused;
  const entry = entryFor(key);
  if (!view || !entry) return;

  const allowed = conversions(view.block).find((row) => row.key === key);
  if (!allowed || allowed.disabled || allowed.on) return;

  view.read();
  const lines = linesOf(view.block);
  convertBlock(view.block.id, entry.type, fieldsFor(entry, lines));
}

/**
 * Insert: always a new block, after the one the caret is in.
 *
 * There is no inline half any more. Everything that goes INSIDE a line — a
 * link, a highlight, a code span, an equation — needs words to act on, so it
 * belongs to the selection and lives in Format.
 */
async function insertItem(key, host) {
  const item = INSERTS.find((entry) => entry.key === key);
  if (!item) return;

  const target = host || state.focused;
  const spec = BLOCK_SEEDS[key];
  if (!spec) return;

  // One level of nesting. A note inside a note is expressible and unreadable.
  const box = (target && target.box) || state.root;
  if (spec.nests && box.depth >= 1) {
    return void notice("warn", t("no_deeper", "A note, folding or tab group cannot go inside another one."));
  }

  // A picture is the one insert that cannot start empty: an image block with no
  // address is a broken image, drawn as a failure the author did not cause. So
  // the picture is chosen FIRST and the block is made from the answer — and
  // cancelling the browser inserts nothing at all.
  let fields = spec.fields;
  if (key === "image") {
    const picked = await pickImage();
    if (!picked) return;
    fields = { url: picked.site, alt: "" };
  }

  if (target && target.isEmpty && target.isEmpty()) {
    return void convertBlock(target.block.id, spec.type, fields);
  }
  insertBlock(makeBlock(spec.type, fields), target ? target.block.id : null, true);
}

/** What each insertable BLOCK starts life as. */
const BLOCK_SEEDS = {
  paragraph: { type: "paragraph", fields: { text: "" } },
  image: { type: "image", fields: { url: "", alt: "" } },
  table: { type: "table" },
  code: { type: "code", fields: { lang: "", code: "" } },
  math: { type: "math", fields: { tex: "" } },
  mermaid: { type: "mermaid", fields: { code: "graph TD\n  A --> B" } },
  hr: { type: "hr" },
  note: { type: "component", fields: { name: "note", args: "info", body: "" } },
  notel: { type: "component", nests: true, fields: { name: "notel", args: "info fa-circle-info Title", body: "" } },
  box: { type: "component", fields: { name: "box", args: "blue", body: "" } },
  folding: { type: "component", nests: true, fields: { name: "folding", args: "blue::Details", body: "" } },
  tabs: { type: "component", nests: true, fields: { name: "tabs", args: "GROUP", body: "<!-- tab One -->\n\n<!-- endtab -->" } },
  btn: { type: "component", fields: { name: "btn", args: "Label::https://", body: null } },
};

/* ─── the block's own markdown ─────────────────────────────────────────────── */

function toggleSource(on) {
  const view = state.focused;
  if (!view) return;
  if (on) view.showRaw();
  else view.hideRaw();
  if (ui && ui.toolbar) ui.toolbar.refresh();
}

/**
 * What the author typed into the raw field, back through the parser.
 *
 * It may come back as several blocks, or as none. Both are ordinary: a section
 * pasted in whole is several, and clearing the field is a deletion — the one
 * thing that must not happen is a block left holding text the parser never saw.
 */
function applyRaw(id, text) {
  const at = locate(id);
  if (!at) return;
  const { box, index } = at;

  const blocks = parseBlocks(text).map((b) => Object.assign(b, { dirty: true }));
  const old = box.blocks[index];

  if (!blocks.length) return void deleteBlock(id, "prev");
  if (blocks.length === 1 && blocks[0].type === old.type && emitBlock(blocks[0]) === emitBlock(old)) {
    return void remountBlock(id);
  }

  blocks[blocks.length - 1].after = old.after;
  box.blocks.splice(index, 1, ...blocks);

  const views = blocks.map((block) => {
    const view = createView(block, blockCtx(box));
    view.box = box;
    return view;
  });
  dropBoxesIn(box.views[index].el);
  box.views[index].el.replaceWith(...views.map((v) => v.el));
  box.views.splice(index, 1, ...views);

  writeBox(box);
  markDirty("raw", id);
  renumberFigures();
  contentChanged();
  if (views[0].focus) views[0].focus("end");
}

/** Rebuild one block's view in place — its own fields decided to change shape. */
function remountBlock(id) {
  const at = locate(id);
  if (!at) return;
  const { box, index } = at;
  const view = createView(box.blocks[index], blockCtx(box));
  view.box = box;
  dropBoxesIn(box.views[index].el);
  box.views[index].el.replaceWith(view.el);
  box.views[index] = view;
  state.focused = view;
  if (view.focus) view.focus("end");
  renumberFigures();
  contentChanged();
  if (ui && ui.toolbar) ui.toolbar.sync();
}

function moveFocused(delta) {
  const view = state.focused;
  if (!view) return;
  const at = locate(view.block.id);
  if (!at) return;
  const { box, index: from } = at;
  const to = from + delta;
  if (to < 0 || to >= box.blocks.length) return;

  const nodes = box.views.map((v) => v.el);
  flip(nodes, () => {
    const [block] = box.blocks.splice(from, 1);
    box.blocks.splice(to, 0, block);
    const [moved] = box.views.splice(from, 1);
    box.views.splice(to, 0, moved);
    const anchor = box.views[to + (delta > 0 ? -1 : 1)];
    if (delta > 0) anchor.el.after(moved.el);
    else anchor.el.before(moved.el);
  });

  writeBox(box);
  markDirty("move", view.block.id);
  renumberFigures();
}

function duplicateFocused() {
  const view = state.focused;
  if (!view) return;
  view.read();
  const copy = Object.assign({}, view.block, { id: nextId(), dirty: true, src: "" });
  if (copy.items) copy.items = copy.items.map((item) => Object.assign({}, item));
  if (copy.header) {
    copy.header = copy.header.slice();
    copy.align = copy.align.slice();
    copy.rows = copy.rows.map((row) => row.slice());
  }
  insertBlock(copy, view.block.id, true);
}

/* ─── drag reorder ─────────────────────────────────────────────────────────── */

/**
 * A page is taller than a viewport, so a block being dragged has to be able to
 * reach a target that is not on screen. Holding near an edge scrolls, faster
 * the closer to it you hold — `dragover` fires often enough to track the
 * pointer but not evenly enough to scroll from, so it only records the position
 * and a rAF loop does the moving.
 */
function edgeScroll() {
  state.scrollRAF = 0;
  if (!state.dragId) return;

  const y = state.pointerY;
  const h = window.innerHeight;
  let delta = 0;
  if (y < EDGE) delta = -EDGE_SPEED * (1 - y / EDGE);
  else if (y > h - EDGE) delta = EDGE_SPEED * (1 - (h - y) / EDGE);

  if (delta) window.scrollBy(0, delta);
  state.scrollRAF = requestAnimationFrame(edgeScroll);
}

function startEdgeScroll(y) {
  state.pointerY = y;
  if (!state.scrollRAF) state.scrollRAF = requestAnimationFrame(edgeScroll);
}

function stopEdgeScroll() {
  if (state.scrollRAF) cancelAnimationFrame(state.scrollRAF);
  state.scrollRAF = 0;
}

/**
 * Every place a block could land, as a POSITION IN A BOX.
 *
 * "After the third paragraph" and "before the fourth" are one place, not two.
 * Expressed as `{box, index}` they collapse into a single entry; expressed as
 * `{block, before|after}`, which is how this used to work, they stayed two —
 * two lines you could aim at a pixel apart that did exactly the same thing.
 *
 * A box's slots are its own: the gap after the last block INSIDE a note and the
 * gap after the note itself are genuinely different destinations even though
 * they are drawn a few pixels apart, and keying on the box is what keeps them
 * apart. Each slot carries the Y of the line that would be drawn for it, so
 * choosing one is a matter of which line the pointer is nearest — which needs
 * no hit testing, and therefore answers everywhere on the page: in the gutter,
 * in the article's padding, above the first block and below the last.
 */
function dropSlots() {
  const held = state.dragId ? locate(state.dragId) : null;
  const carried = held ? held.view.el : null;
  // A component that opens a box of its own cannot go into one: that would be
  // a note inside a note, which the markdown can express and nobody can read.
  const nesting = held && held.view.nests;

  const out = [];
  for (const box of state.boxes) {
    if (nesting && box.depth >= 1) continue;
    // Measurements on a detached element are all zero, which would put a slot
    // at the top of the viewport. During a drag there is nothing being built,
    // so anything detached here is genuinely not on the page.
    if (!box.el || !box.el.isConnected) continue;
    // A box drawn inside the block being carried is going with it.
    if (carried && box.el !== state.canvas && carried.contains(box.el)) continue;

    const live = box.views.filter((view) => view.el !== carried);
    if (!live.length) {
      const rect = box.el.getBoundingClientRect();
      out.push({ box, index: 0, y: rect.top + 2, depth: box.depth });
      continue;
    }
    for (const view of live) {
      const rect = view.el.getBoundingClientRect();
      out.push({ box, index: box.views.indexOf(view), y: rect.top, depth: box.depth });
    }
    const last = live[live.length - 1];
    out.push({
      box,
      index: box.views.indexOf(last) + 1,
      y: last.el.getBoundingClientRect().bottom,
      depth: box.depth,
    });
  }
  return out;
}

/** The slot whose line is nearest the pointer; ties go to the deeper box. */
function dropTargetAt(y) {
  let best = null;
  for (const slot of dropSlots()) {
    const gap = Math.abs(slot.y - y);
    if (!best || gap < best.gap - 0.5 || (gap < best.gap + 0.5 && slot.depth > best.slot.depth)) {
      best = { gap, slot };
    }
  }
  return best ? best.slot : null;
}

/**
 * Paint the insertion line, and ONLY when it moves.
 *
 * Clearing every block's `data-drop` on each `dragover` and re-setting it tore
 * the pseudo-element down and built it again several times a second, which
 * restarted its entrance animation each time — the flicker was the indicator
 * being recreated, not redrawn.
 *
 * A slot is drawn ABOVE the block that would follow it, and the LAST slot in a
 * box is drawn on that box's `+` — which is the thing actually standing in that
 * gap, and which the block would land immediately before. One line per place,
 * so what is on screen and what will happen are the same count.
 */
function paintDrop(target) {
  const tail = target && target.index >= target.box.views.length ? target.box : null;
  const anchor = target && !tail ? target.box.views[target.index] : null;

  const key = tail ? "tail:" + tail.uid : anchor ? anchor.block.id : "";
  if (key === state.dropAt) return;
  state.dropAt = key;

  for (const view of allViews()) {
    const want = anchor === view ? "before" : "";
    if (view.el.dataset.drop !== want) view.el.dataset.drop = want;
  }
  for (const box of state.boxes) {
    if (!box.tail) continue;
    const want = box === tail ? "1" : "";
    if (box.tail.dataset.drop !== want) box.tail.dataset.drop = want;
  }
}

// On the document, not the canvas: a pointer that wanders over the document bar
// or into a margin is still holding a block, and taking the drop away there is
// what produced a forbidden cursor over half the page. Bound only for the
// length of a drag.
function onDocDragOver(e) {
  if (!state.dragId) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  startEdgeScroll(e.clientY);
  paintDrop(dropTargetAt(e.clientY));
}

async function onDocDrop(e) {
  const dragId = state.dragId;
  if (!dragId) return;
  e.preventDefault();
  stopEdgeScroll();

  const target = dropTargetAt(e.clientY);
  paintDrop(null);
  if (!target) return;

  const held = locate(dragId);
  if (!held) return;

  const leaving = held.box;
  const arriving = target.box;
  // The slot's index counts the block being carried while it is still in the
  // list, so taking it out of an earlier position shifts every later one down.
  let at = target.index;
  if (leaving === arriving) {
    if (held.index < at) at -= 1;
    if (at === held.index) return;
  }

  // A note left with nothing in it is not a note. Noted before the move, acted
  // on after, so the block being carried is safely somewhere else first.
  const emptying = leaving !== arriving && leaving.views.length === 1 && leaving.onEmpty;

  // The tails travel too: a block leaving a note shortens it, and a `+` that
  // teleports to its new place while everything around it slides is the one
  // thing on screen that did not move like the rest.
  await flip(Array.from(state.canvas.querySelectorAll(".ed-block, .ed-tail")), () => {
    leaving.views.splice(held.index, 1);
    const [block] = leaving.blocks.splice(held.index, 1);

    const index = Math.max(0, Math.min(at, arriving.views.length));
    arriving.views.splice(index, 0, held.view);
    arriving.blocks.splice(index, 0, block);
    // The one thing that has to change when a block changes homes. It used to be
    // rebuilt instead, which threw away a decoded picture, a rendered equation
    // and an open tab pane — and paid for them again with a skeleton, a refetch
    // and a page that jumped under the pointer as the height came back.
    held.view.box = arriving;

    const before = arriving.views[index + 1];
    if (before) before.el.before(held.view.el);
    else arriving.el.insertBefore(held.view.el, arriving.tail || null);
  });

  // Order is the one thing a moved block cannot carry in `src`: its trailing
  // separator belonged to the position it left.
  for (const box of state.boxes) box.blocks.forEach((b) => (b.after = b.after || "\n\n"));
  writeBox(leaving);
  if (arriving !== leaving) writeBox(arriving);
  if (emptying) leaving.onEmpty();

  renumberFigures();
  contentChanged();
  refreshTOC();
  markDirty("move", dragId);
}

function onCanvasDragOver(e) {
  if (state.dragId) return;
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
}

/**
 * Files only. A block being carried is handled on the document, above.
 *
 * Everything else is REFUSED rather than ignored. What the browser drops into a
 * contenteditable is markup of its own making — a picture dragged a few
 * centimetres lands as an `<img>` carrying the whole file as a `data:` URI, and
 * the document then held a multi-megabyte line that every read, every step and
 * every digest had to walk. Refusing the drop is what makes that impossible;
 * the drag itself is left alone, because cancelling drags here cancelled the
 * one drag this editor has.
 */
async function onCanvasDrop(e) {
  if (state.dragId) return;

  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const asset = await stageImage(file);
    insertBlock(makeBlock("image", { url: asset.site, alt: "" }), null, false);
  }
}

/* ─── assets ───────────────────────────────────────────────────────────────── */

/**
 * An address the document uses, mapped back to where that file still IS.
 *
 * The staged tidy-up run backwards. `/images/new.png` was written into the post
 * a moment ago and nothing on the site or in the repository answers to it yet,
 * so a request has to go to `/images/old.png` until the commit lands.
 */
function liveAddress(src) {
  const value = String(src || "");
  // Every staged move, not only the uncommitted ones: a save commits the note
  // and the BUILD does the renaming, so the repository answers to the old name
  // for minutes afterwards. Dropping the mapping at save time is what would
  // break every renamed picture on the canvas the moment it was saved.
  if (!state.stage || !state.stage.moves.length || !value.startsWith("/")) return value;
  return siteAddress(state.stage.origin("source" + value));
}

/**
 * Point this document at where its pictures are about to be.
 *
 * Only this one. Finding every other post that used the old name would mean
 * pulling the whole site into the browser, so that job is left to the build,
 * which already has every post open — see scripts/events/build-pipeline.js.
 */
function applyStagedMoves() {
  if (!state.stage || !state.stage.dirty) return;

  // Only what has not been noted yet. A noted move was written into this
  // document by the save that noted it, and applying it a second time would
  // hunt for an address the document no longer contains.
  const fresh = state.stage.moves.filter((move) => !move.noted);
  const swap = (text) => {
    let out = String(text == null ? "" : text);
    for (const move of fresh) {
      const from = siteAddress(move.from);
      const to = siteAddress(move.to);
      out = out.split(from).join(to);
    }
    return out;
  };

  for (const view of allViews()) view.read();
  for (const block of state.doc.blocks) {
    const before = emitBlock(block);
    const after = swap(before);
    if (after === before) continue;
    const parsed = parseBlocks(after)[0];
    if (parsed) Object.assign(block, parsed, { id: block.id, after: block.after, dirty: true });
  }

  const front = swap(state.doc.front);
  if (front !== state.doc.front) {
    state.doc.front = front;
    state.doc.frontDirty = true;
  }
}

/**
 * Name a picture — the one control, wherever the asking happens.
 *
 * A block's address, a replacement, the cover, the thumbnail and the banner all
 * come through here, so there is one place that knows what the repository holds
 * and one place that knows how to add to it.
 */
async function pickImage(current, browse) {
  // The browser is a full-height panel and nothing in it is typed into first. A
  // keyboard left standing under it covers the file tree.
  dropCaret();
  const opened = history.mark();
  const had = state.pending.length;
  const picked = await openPicker(
    {
      t,
      stage: state.stage,
      pending: state.pending,
      upload: stageImage,
      // A tidy-up is half a dozen separate decisions, so each one is a step of
      // its own rather than one lump recorded when the browser closes.
      onStageChange: (path) => markDirty("assets", path),
      // The article's own measurements and resolution rules — a staged blob, a
      // withheld picture's borrowed key, the repository fallback — on a plain
      // `<img>`. NOT the lazyload preloader: that opens a sealed image through the
      // page's key ring, which holds this post's pictures and no other post's.
      naturalSize: (src) => naturalSize(src, state.pending),
      bindImage: (img, src) => bindImage(img, src, state.pending),
    },
    { current, browse }
  );
  // Tidying is a change to the post even when nothing was chosen: the renames
  // travel in this document's commit, and leaving the save button disabled is
  // how a folder someone had just reorganised was thrown away on close.
  if (!browse && state.stage.dirty) markDirty("assets", "");
  if (!picked) return null;

  // Renaming a picture and then choosing it is ONE decision — it is the same
  // picture either way — so whatever the caller is about to point at the new
  // name folds into the rename rather than standing as a second step. Undoing
  // used to put the old address back and leave the rename staged, which is a
  // state the author never created.
  //
  // ADDING a picture is not that. The file arriving in the repository and a
  // paragraph coming to point at it are two things the author did, and folding
  // them made one undo take back both — with no way to keep the picture and drop
  // the reference. So a session that staged an upload never folds.
  if (history.mark() !== opened && state.pending.length === had) history.fold();

  const staged = state.pending.find((a) => state.stage.resolve(a.path) === picked.path);
  return staged || { path: picked.path, site: picked.site };
}

/** Read a file off disk, hold it as a blob, and queue it for the next commit. */
async function stageImage(file, dir) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let path = await repo.assetPath(file.name, bytes);
  // The picker says which folder is open; a paste or a drop has no opinion and
  // goes where every pasted picture has always gone.
  if (dir) path = String(dir).replace(/\/+$/, "") + "/" + path.split("/").pop();
  const existing = state.pending.find((a) => a.path === path);
  if (existing) return existing;

  const url = URL.createObjectURL(file);
  const asset = { path, site: "/" + path.replace(/^source\//, ""), bytes, url, name: file.name };

  // Measured now, because the build has never seen this file and the preloader
  // has to reserve the right box for it like it does for every other image.
  const size = await new Promise((done) => {
    const probe = new Image();
    probe.onload = () => done({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => done(null);
    probe.src = url;
  });
  if (size && size.width) Object.assign(asset, size);

  state.pending.push(asset);
  markDirty("assets", asset.path);
  return asset;
}

/* ─── stepping back and forward ────────────────────────────────────────────── */

/**
 * Undo and redo.
 *
 * The store (history.js) holds the document; everything here is what a step
 * LOOKS like. Three jobs, in this order, because that is the order the author
 * reads them in:
 *
 *   1. go to where the change is about to be — the block, the front-matter row,
 *      the title, or the picture browser, which is opened if the step happened
 *      inside it and closed if it did not;
 *   2. put the document back, reusing every block whose signature is unchanged
 *      so that a one-word undo redraws one paragraph rather than the article;
 *   3. light the place up, once, after the last press of a run rather than once
 *      per press.
 *
 * Changing the text first and scrolling afterwards was the obvious order and the
 * wrong one: what the author saw was the page jumping to somewhere that had
 * ALREADY changed, which says nothing about what the step did.
 */
// Two characters either side of the change, so a one-letter edit is still
// something the eye can land on rather than a sliver.
const SPOT_PAD = 2;

const history = createHistory({
  read: () => readAll(),
  doc: () => state.doc,
  stage: () => state.stage,
  pending: () => state.pending,
  apply: (plan) => applyStep(plan),
  changed: syncSteps,
});

/**
 * What the step store reports, drawn on the chrome.
 *
 * The unsaved marker is decided HERE and not by whoever made the change: a
 * document stepped all the way back to what is committed has nothing to save,
 * and leaving the dot amber there was the editor claiming work that no longer
 * exists.
 */
function syncSteps() {
  if (!ui) return;
  if (ui.toolbar && ui.toolbar.history) ui.toolbar.history(history.can());

  const want = history.dirtyState();
  if (want !== null && state.on && state.doc && state.dirty !== want) {
    state.dirty = want;
    syncHeader();
  }
}

const KEY_NAME = /^[A-Za-z_][\w-]*$/;

/** The one element a step is about, as it stands right now. */
function targetNode(target) {
  if (!target || !state.on) return null;

  if (target.kind === "asset") {
    const held = pickerLive();
    return held ? held.row(target.path) : null;
  }
  if (target.kind === "block") {
    const at = locate(target.id);
    return at ? at.view.el : null;
  }
  if (target.kind === "cover" || target.kind === "title") {
    if (!state.titleHost) return null;
    return (
      (target.kind === "cover" && state.titleHost.querySelector(".article-cover-frame")) ||
      state.titleHost.querySelector(".ed-title") ||
      state.titleHost
    );
  }
  if (target.kind === "front") {
    if (!ui || !ui.front) return null;
    const row = KEY_NAME.test(target.key || "")
      ? ui.front.el.querySelector(`[data-key="${target.key}"]`)
      : null;
    return row || ui.front.el;
  }
  return null;
}

function closeBrowser() {
  const held = pickerLive();
  if (held) held.close();
}

/**
 * The picture browser, standing on the file this step is about.
 *
 * Not awaited as a dialogue — it stays up until the author closes it — but its
 * tree IS awaited, because a step that lands before the folders have been read
 * would rebuild them from a stage that is about to be replaced.
 */
async function openBrowserAt(path) {
  let held = pickerLive();
  if (!held) {
    // `openPicker` builds and mounts its dialogue synchronously, so the handle
    // is there the moment this returns; what is NOT waited on is the author
    // eventually closing it.
    pickImage(path ? siteAddress(path) : "", true).catch(() => {});
    held = pickerLive();
  }
  if (held && held.ready) await held.ready;
  // Already open, on something else: walk it to the file this step is about
  // before the step lands, so what changes is a name and not the whole panel.
  if (held && path) held.goto(path);
}

/**
 * Get to where the step happens, before it happens.
 *
 * Opening the file tree on the right folder, opening a folding, switching to the
 * tab the change is in — a step that lands behind a closed disclosure is a step
 * the author watched do nothing. All of it is awaited, so the article is already
 * showing the right place when the words change; a run of presses skips it,
 * because five reveals in a row is five animations nobody asked for.
 *
 * The travel here is coarse ON PURPOSE. This knows only the block the document
 * named, which for anything inside a note IS the note — and stopping at the top
 * of a long note is how the change itself ended up off screen. So the page only
 * moves when the note is not on screen at all; the precise journey happens in
 * `spotlight`, once there is a real element to travel to.
 */
async function goToStep(target, plan) {
  // The browser opens on the name the file has RIGHT NOW — `target.path` is
  // where the step is about to put it, and a tree drawn from the stage as it
  // stands cannot hold that name yet. Standing on the old one first is what
  // makes the rename visible as a rename.
  if (target.kind === "asset") {
    closeSheet();
    return void (await openBrowserAt(target.was || target.path));
  }
  // Any other step is somewhere else entirely, and a modal over the article is
  // the one thing that would hide it.
  closeBrowser();

  // The picture first, then its sheet, then the field — so what changes is a
  // value the author is already looking at.
  if (target.kind === "props") {
    const at = locate(target.id);
    if (!at) return void closeSheet();
    if (!plan.quick && !readable(at.view.el)) await travelTo(at.view.el);
    const held = imageProps(at.view, true);
    if (held) await held.reveal(target.key, !plan.quick);
    return;
  }
  closeSheet();
  if (target.kind !== "block") return;

  const home = locate(target.id);
  // The block the author had hold of, when the document names something else: one
  // that crossed into a note is a slice of that note's body as far as the
  // document is concerned, and travelling to the note is how the block that
  // actually moved ended up off screen. See `aim` in history.js.
  const lead = target.lead ? locate(target.lead) : null;
  const at = lead || home;
  if (!at) return;
  const next = home ? plan.blocks.find((block) => block.id === target.id) : null;

  if (plan.quick) {
    if (home && home.view.reveal) home.view.reveal(next);
    return;
  }

  // One. Travel, and WAIT for it. A FLIP measured while the viewport is still
  // moving reads every rectangle in a viewport that has already moved.
  //
  // A block the step MOVES is the element itself, so it is brought properly into
  // view and the rearrangement then happens around it. For anything else the
  // block the DOCUMENT names may only be the note the change is inside, so the
  // page moves only when none of it is readable and `spotlight` makes the precise
  // journey once there is a real element to travel to.
  const precise = !!lead || target.how === "move" || target.how === "add";
  if (precise ? !readable(at.view.el) : offScreen(at.view.el)) await travelTo(at.view.el);

  // Two. Open what the change is behind, holding the block still while it grows.
  if (home && home.view.reveal) await anchored(at.view.el, () => home.view.reveal(next));
}

/**
 * Every box's account of what the step did to it, collected once.
 *
 * A box records what it created and what it patched as it reconciles, because
 * only the box knows — the step store works on the document, and the document
 * cannot tell a paragraph inside a note from the note itself.
 */
function harvest() {
  const fresh = [];
  const patched = [];
  for (const box of state.boxes) {
    if (box.lastFresh && box.lastFresh.length) fresh.push(...box.lastFresh);
    if (box.lastPatched && box.lastPatched.length) patched.push(...box.lastPatched);
    box.lastFresh = null;
    box.lastPatched = null;
  }
  return { fresh, patched };
}

/** The same account, read without taking it: `shift` needs it mid-flight. */
function touched() {
  const spots = [];
  for (const box of state.boxes) {
    for (const view of box.lastFresh || []) spots.push({ view, was: null });
    for (const spot of box.lastPatched || []) spots.push(spot);
  }
  return spots.filter((spot) => spot.view.el.isConnected);
}

/**
 * The DEEPEST thing that changed, and only when there is exactly one.
 *
 * A paragraph edited inside a note reaches this as two changes — the note,
 * because its body is a string that now reads differently, and the paragraph
 * itself. The note CONTAINS the paragraph, so it is not the answer: taking the
 * ancestor is what pinned a step to the top of a note and lit the whole of it.
 */
function onlyLeaf(spots) {
  const leaves = spots.filter(
    (spot) => !spots.some((other) => other !== spot && spot.view.el.contains(other.view.el))
  );
  return leaves.length === 1 ? leaves[0] : null;
}

function changedLeaf() {
  const only = onlyLeaf(touched());
  return only ? only.view.el : null;
}

// A touch slower than the toolbar's own morph, deliberately: this is the whole
// article rearranging itself, and at 280ms it read as a snap rather than a move.
const STEP_MS = 380;

function canvasNodes() {
  return state.canvas ? Array.from(state.canvas.querySelectorAll(".ed-block, .ed-tail")) : [];
}

/**
 * What a block says, in the one spelling both sides of a move agree on.
 *
 * A block dragged out of a note is the SAME words in two different states: in
 * the article it is a live block that has been edited, so it emits from its
 * fields, and inside the note it is a slice of the note's body, so it emits its
 * source. `signature` tells those apart — which is right for the document and
 * wrong here, where the question is "is this the block that just left?".
 * `emitBlock` reads both from the fields, so the two match.
 */
function saysWhat(block) {
  try {
    return block.type + " " + emitBlock(block);
  } catch (err) {
    return block.type + " " + (block.src || "");
  }
}

/** Where every block on the canvas stood, keyed by what it said. */
function ghosts() {
  const map = new Map();
  for (const box of state.boxes) {
    for (const view of box.views) {
      if (!view.el.isConnected) continue;
      const key = saysWhat(view.block);
      if (!map.has(key)) map.set(key, { el: view.el, rect: view.el.getBoundingClientRect() });
    }
  }
  return map;
}

/**
 * What the reader is looking at, when the step itself has nothing to offer.
 *
 * A step that CREATES a block has no element to hold still — the block did not
 * exist when the measuring happened — so the page is held by the first block
 * still on screen instead. Without it, restoring a paragraph above the fold slid
 * everything the reader was reading down by its height.
 */
function steadyAnchor(skip) {
  const top = headroom();
  for (const node of canvasNodes()) {
    if (skip && (node === skip || skip.contains(node))) continue;
    if (node.getBoundingClientRect().bottom > top + 1) return node;
  }
  return null;
}

function viewsByEl() {
  const map = new Map();
  for (const box of state.boxes) for (const view of box.views) map.set(view.el, view);
  return map;
}

/**
 * One FLIP over the WHOLE canvas, with the page pinned to an anchor.
 *
 * Every block and every `+` row is measured, the change happens, the page is
 * scrolled INSTANTLY by exactly what the anchor moved, and everything then
 * travels from where it was in one pass. The pin has to be instant and it has to
 * sit between the two measurements: that is what folds it into the same numbers
 * the transforms are built from. An animated scroll here, or an `await` of any
 * kind, lets the browser paint the rearrangement first — and then the article
 * jumps and the animation travels from a position nobody ever saw.
 *
 * The anchor is chosen HERE, not by the caller, because only now is it known what
 * changed. The caller can name the block the DOCUMENT is about, and for anything
 * inside a note that is the note — pinning its top let the change slide within
 * it, which is the one thing the pinning exists to stop. A block with no old
 * rectangle of its own borrows its ghost's: same words, same place to look.
 */
async function shift(fallback, before, mutate) {
  if (reduced()) return void mutate();

  const was = new Map();
  for (const node of canvasNodes()) was.set(node, node.getBoundingClientRect());

  mutate();

  const owner = viewsByEl();
  const leaf = changedLeaf();
  let anchor = null;
  let top = null;

  if (leaf && was.has(leaf)) {
    anchor = leaf;
    top = was.get(leaf).top;
  } else if (leaf) {
    const view = owner.get(leaf);
    const ghost = view && before ? before.get(saysWhat(view.block)) : null;
    if (ghost) {
      anchor = leaf;
      top = ghost.rect.top;
    }
  }
  if (!anchor && fallback && was.has(fallback)) {
    anchor = fallback;
    top = was.get(fallback).top;
  }

  if (top != null && anchor.isConnected) {
    const drift = anchor.getBoundingClientRect().top - top;
    if (Math.abs(drift) > 0.5) window.scrollBy(0, drift);
  }

  const runs = [];

  for (const node of canvasNodes()) {
    const now = node.getBoundingClientRect();
    let from = was.get(node);
    let arriving = false;

    if (!from) {
      const view = owner.get(node);
      const ghost = view && before ? before.get(saysWhat(view.block)) : null;
      if (ghost && !ghost.el.isConnected) {
        from = ghost.rect;
        arriving = true;
      }
    }

    if (!from) {
      // The one block the step is ABOUT is lit a moment later, deliberately, by
      // the spotlight. Fading it in as well is two entrances for one change.
      if (node === leaf) continue;
      runs.push(
        node.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], {
          duration: Math.round(STEP_MS * 0.6),
          easing: EASE,
        })
      );
      continue;
    }

    const dx = from.left - now.left;
    const dy = from.top - now.top;
    if (!dx && !dy) continue;

    runs.push(
      node.animate(
        arriving
          ? [
              { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.45 },
              { transform: "none", opacity: 1 },
            ]
          : [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: STEP_MS, easing: EASE }
      )
    );
  }

  await Promise.all(runs.map((run) => run.finished.catch(() => {})));
}

// A range that wraps onto more lines than this is not a place any more, it is a
// paragraph — and a dozen bars stacked down one is the "overlapping boxes" that
// made a moved block unreadable.
const SPOT_LINES = 6;

/**
 * Is the change a PART of this block, or the whole of it?
 *
 * Lighting a range only says something when there is unlit text either side of
 * it. A block that was replaced outright has none, and drawing its every line as
 * a separate bar is the same picture as lighting every character in it — which
 * is exactly how a block that had been moved was being shown. Whole-block
 * changes get the block.
 */
function subRange(was, now) {
  const span = charSpan(was, now);
  const width = Math.max(span.endA - span.head, span.endB - span.head);
  const whole = Math.max(was.length, now.length);
  return whole > 0 && width < whole * 0.75;
}

/**
 * Light what the step actually did, read from the canvas rather than guessed
 * from the document.
 *
 * The document cannot tell these four apart — a paragraph moving out of a note
 * reaches it as "the note's text changed", which is how a move came to be drawn
 * as a character range over the whole note. The boxes know, because they are the
 * ones that did it:
 *
 *   moved    the block, where it landed
 *   edited   the characters that differ inside the ONE view that took them
 *   arrived  the block, because the block is the change
 *   left     the seam between the two blocks that remain
 */
/** The `+` and the drag handle, which are not part of what a step changed. */
function gutterOf(view) {
  return view && view.el ? view.el.querySelector(":scope > .ed-gutter") : null;
}

async function spotlight(target, report, quick) {
  if (target.kind === "props") {
    const held = sheetLive();
    const at = locate(target.id);
    if (!held || !at || held.id !== target.id) return;
    held.set(propsOf(at.view.block));
    return void held.flash(target.key);
  }

  if (target.kind === "asset") {
    const held = pickerLive();
    if (!held) return;
    // Rebuilt from the stage as it NOW stands: the tree was drawn before the
    // step, under the names the step has just taken away. A file it removed has
    // no row left, so the folder it was in is opened and marked instead.
    held.goto(target.path);
    return void held.flash(target.path);
  }

  // A block that MOVED, first and before anything is compared as text. The same
  // words in a new place reach every other test here as "this block's text is
  // completely different", and a wholesale text difference drawn as a character
  // range is a bar per word — which is what a moved block was being lit as.
  const drift = (report && report.drift) || [];
  const travelled = drift.find((view) => view.el.isConnected);
  if (travelled) {
    await travelTo(travelled.el, quick);
    return void spotElement(travelled.el, "move", gutterOf(travelled));
  }

  const spots = [
    ...((report && report.fresh) || []).map((view) => ({ view, was: null })),
    ...((report && report.patched) || []),
  ].filter((spot) => spot.view.el.isConnected);

  // A block that ARRIVED outranks one that was merely rewritten: a note whose
  // body gained a paragraph reports both, and the paragraph is the event.
  const only = onlyLeaf(spots.filter((spot) => spot.was == null)) || onlyLeaf(spots);

  if (only) {
    const { view, was } = only;
    await travelTo(view.el, quick);

    const now = was == null ? null : domText(view.body);
    // Equal text means the step changed something the reader cannot see — a
    // separator, a source spelling — and there is no range to point at.
    if (now != null && now !== was && subRange(was, now)) {
      const span = charSpan(was, now);
      const from = Math.max(0, span.head - SPOT_PAD);
      const to = Math.min(now.length, Math.max(span.endB, span.head + 1) + SPOT_PAD);
      // The change itself, and the change with two characters of air around it.
      // The first decides which LINES are worth marking, the second how wide
      // the mark is on them — padding that reaches onto the next line marks a
      // line break, which is a thing nobody changed.
      const core = domRange(view.body, span.head, Math.max(span.endB, span.head + 1));
      const range = domRange(view.body, from, to);
      if (range && core && core.getClientRects().length <= SPOT_LINES) {
        // The caret follows the step. Undoing a word three paragraphs up and
        // then typing has to continue THERE, and a caret left behind in the
        // block the author happened to be standing in would put the next letter
        // somewhere the step said nothing about.
        followCaret(view, core);
        return void spotRange(range, core);
      }
    }
    return void spotElement(view.el, "block", gutterOf(view));
  }

  if (target.kind === "seam") {
    const above = target.above ? locate(target.above) : null;
    const below = target.below ? locate(target.below) : null;
    const anchor = (below && below.view.el) || (above && above.view.el);
    if (!anchor) return;
    await travelTo(anchor, quick);
    return void spotSeam(above && above.view.el, below && below.view.el);
  }

  if (target.kind === "block") {
    const at = locate(target.id);
    if (!at) return;
    await travelTo(at.view.el, quick);
    return void spotElement(at.view.el, target.how === "move" ? "move" : "block", gutterOf(at.view));
  }

  const el = targetNode(target);
  if (!el) return;
  await travelTo(el, quick);
  spotElement(el, "field");
}

/**
 * Put the caret at the end of what the step changed.
 *
 * Only when the canvas already had it. A step asked for from the front-matter
 * card, or from a button with nothing focused, must not pull the focus into the
 * article — that is the same "editing mode changed under me" the caret loss
 * used to cause, wearing the opposite sign.
 */
function followCaret(view, range) {
  const host = view && view.editable;
  if (!host || !range || !host.contains(range.startContainer)) return;

  const live = document.activeElement;
  if (live && live !== document.body && !state.canvas.contains(live)) return;

  const at = range.cloneRange();
  at.collapse(false);
  // Without `preventScroll` the browser scrolls the block to its own idea of
  // centre, which on a phone fights the editor's scrolling and bounces the page.
  host.focus({ preventScroll: true });
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(at);
}

/** Put the caret back at the end of a field that was rewritten under it. */
function caretToEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

const COVER_OF = (front) => front.cover || front.banner || front.thumbnail || "";

// Long enough for a typeset to land, short enough that the mark never appears to
// be waiting on one. The motion is already over by the time this is asked.
const RENDER_CAP = 300;

function settleViews(views) {
  const waits = views
    .filter((view) => view && view.ready)
    .map((view) => Promise.resolve(view.ready).catch(() => {}));
  if (!waits.length) return null;
  return Promise.race([Promise.all(waits), new Promise((done) => setTimeout(done, RENDER_CAP))]);
}

/**
 * The canvas, made to match a list of blocks.
 *
 * A block whose signature is unchanged keeps its view — its caret, its decoded
 * picture, its open tab pane, its rendered equation — and only its position may
 * move. Everything else is rebuilt. Rebuilding the whole canvas would have been
 * four lines and would have made every undo cost a full re-render and a fresh
 * request for every image in the post.
 */
async function reconcile(wanted, quick, before, anchor) {
  const box = state.root;
  if (!box) return;

  const held = new Map(box.views.map((view) => [view.block.id, view]));
  const rows = [];
  for (const block of wanted) {
    const view = held.get(block.id);
    if (view) held.delete(block.id);

    if (view && signature(view.block) === signature(block)) {
      rows.push({ block, view, gone: null });
      continue;
    }
    // The same block saying something else. Handing the words to the view it
    // already has keeps the element, and keeping the element keeps the caret,
    // the keyboard, the decoded picture and the rendered equation — all four of
    // which a rebuild threw away on every press. Asked here and DONE inside the
    // mutation below, so the height it changes is one the FLIP has measured
    // against; a view that cannot take the change says so and is rebuilt.
    if (view && view.patch && view.patch(block, true)) {
      rows.push({ block, view, gone: null, patch: true });
      continue;
    }
    rows.push({ block, view: null, gone: view || null });
  }

  // Synchronous, and it must stay that way. A FLIP is measure, mutate, measure,
  // animate with no frame between them; awaiting anything here lets the browser
  // paint the mutation, so the article jumps and the animation then travels from
  // a position nobody ever saw. Asynchronous paints are waited for AFTER the
  // motion, in `applyStep`, where only the mark depends on them.
  const mutate = () => {
    // `dropBoxesIn` is what releases a view being discarded, here as everywhere
    // else in this file — it forgets the boxes drawn inside the element AND the
    // view the element belongs to, and it can only do the second while the old
    // list is still the list.
    for (const row of rows) {
      if (row.patch) {
        row.was = domText(row.view.body);
        row.view.patch(row.block);
        continue;
      }
      if (row.gone) {
        dropBoxesIn(row.gone.el);
        row.gone.el.remove();
      }
      if (row.view) continue;
      row.view = createView(row.block, blockCtx(box));
      row.view.box = box;
      row.fresh = true;
    }
    for (const view of held.values()) {
      dropBoxesIn(view.el);
      view.el.remove();
    }

    box.blocks.length = 0;
    box.views.length = 0;
    for (const row of rows) {
      // The view's OWN block, not the snapshot's copy of it. A reused view is
      // still bound to the object it was built around — `view.read()` writes
      // into that one — and a list holding a different object with the same
      // contents would be a document that stopped hearing what was typed into
      // it. Equal signatures mean the two are interchangeable, so the live one
      // wins and the copy is discarded.
      box.blocks.push(row.view.block);
      box.views.push(row.view);
    }
    // The root box and the document hold ONE array between them; said out loud
    // because everything downstream reads `state.doc.blocks`.
    state.doc.blocks = box.blocks;

    let anchor = box.tail || null;
    for (let i = box.views.length - 1; i >= 0; i--) {
      const el = box.views[i].el;
      if (el.parentNode !== box.el || el.nextSibling !== anchor) box.el.insertBefore(el, anchor);
      anchor = el;
    }

    // Left the way every other box leaves it, so `harvest` can read the whole
    // canvas the same way whether the step landed in the article or in a note.
    box.lastFresh = rows.filter((row) => row.fresh).map((row) => row.view);
    box.lastPatched = rows.filter((row) => row.patch).map((row) => ({ view: row.view, was: row.was }));
  };

  // Every step but the last of a run skips its animation: presses are being
  // counted, and a queue that animates each one arrives seconds after the hand
  // stopped. It is still anchored — a queue that drifts is a queue that ends
  // somewhere the author was not looking.
  if (quick) await anchored(anchor, mutate);
  else await shift(anchor, before, mutate);
}

async function applyStep(plan) {
  if (!state.on || !state.doc || !ui) return;
  const doc = state.doc;
  const chrome = ui;
  const target = plan.target || { kind: "canvas" };

  // The contents rail is held still for the length of the step. It is driven by
  // the scroll pass, and a step scrolls three times — the travel, the pin, the
  // spotlight's own journey — over an article that is being rearranged between
  // them. Lit from those offsets it named a different heading on every frame.
  // One activation at the end, against the offsets that survived.
  holdTOCActive(true);
  let rail = true;
  const release = () => {
    if (!rail) return;
    rail = false;
    holdTOCActive(false);
    // The rail's ENTRIES, in case the step rewrote a heading, and then its
    // offsets and the one entry that should be lit — against the article as it
    // finally stands rather than as it was mid-rearrangement.
    refreshTOC();
    measureTOC();
    const toc = getTOC();
    if (toc) toc.updateActiveTOCLink();
  };

  try {
    // Two awaits below, and the editor can be closed across either of them — by
    // the author, by a navigation, by a teardown. Each one is re-tested against
    // the chrome this step started under rather than against a flag alone.
    await goToStep(target, plan);
    if (!state.on || !state.doc || ui !== chrome) return;

    // Measured while everything still stands where it stood: a block that leaves a
    // note for the article is a new view with a new id, and this is the only
    // record that it used to be somewhere.
    const before = plan.quick ? null : ghosts();
    // Drained first: `fillBox` records for every caller, including a tab switch
    // nobody is stepping through, and a stale entry would be read as this step's.
    harvest();
    const wasFront = doc.front;
    let report = { fresh: [], patched: [], drift: [] };
    // `painting` is the editor's own word for "this is a repaint, not an edit":
    // every listener a restore trips would otherwise report work the author did
    // not do, and the step store would record its own undo.
    state.painting = true;
    try {
      doc.front = plan.front;
      doc.frontRaw = plan.frontRaw;
      doc.frontDirty = plan.frontDirty;
      doc.lead = plan.lead;

      if (state.stage) {
        state.stage.moves.length = 0;
        for (const move of plan.moves) state.stage.moves.push(move);
        state.stage.folders.clear();
        for (const path of plan.folders) state.stage.folders.add(path);
      }
      state.pending.length = 0;
      for (const asset of plan.pending) state.pending.push(asset);

      // The block the step is about is what the page is held still by: it is the
      // one thing the author is looking at, and everything else may move around it.
      const held = target.kind === "block" || target.kind === "props" ? locate(target.id) : null;
      await reconcile(plan.blocks, plan.quick, before, (held && held.view.el) || steadyAnchor());
      if (!state.on || ui !== chrome) return;

      // Every box's account of what just happened to it, root and nested alike.
      report = harvest();
      // Which of the new views came from somewhere rather than from nothing —
      // `shift` has already travelled them; this is only so the spotlight can name
      // the block that MOVED rather than the text it left behind.
      report.drift = before
        ? report.fresh.filter((view) => {
            const ghost = before.get(saysWhat(view.block));
            return !!ghost && !ghost.el.isConnected;
          })
        : [];

      if (wasFront !== plan.front) {
        const before = parseFrontMatter(wasFront);
        const after = parseFrontMatter(plan.front);
        if (ui.front) {
          ui.front.resync();
          ui.front.paint();
        }
        // Gaining or losing a cover is a different template; anything else is a
        // value, and rebuilding the heading for one would take the caret out of
        // the field the author is standing in.
        if (!COVER_OF(before) !== !COVER_OF(after)) {
          paintTitle();
        } else {
          const img = state.titleHost.querySelector(".article-cover-image");
          if (img && COVER_OF(before) !== COVER_OF(after)) bindImage(img, COVER_OF(after), state.pending);
          const heading = state.titleHost.querySelector(".ed-title");
          if (heading && heading.textContent !== (after.title || "")) {
            const live = document.activeElement === heading;
            heading.textContent = after.title || "";
            if (live) caretToEnd(heading);
          }
        }
        ui.path.textContent = pathLabel();
      }

      // The focused view may have been one of the ones just replaced, and a
      // toolbar drawing a released view's options is a toolbar acting on nothing.
      if (state.focused && !allViews().includes(state.focused)) state.focused = null;
      if (!state.focused && target.kind === "block") {
        const at = locate(target.id);
        if (at) state.focused = at.view;
      }
      for (const view of allViews()) view.el.dataset.on = view === state.focused ? "1" : "0";

      renumberFigures();
      observeImages();
      contentChanged();
      if (ui.toolbar) ui.toolbar.sync();

    } finally {
      state.painting = false;
    }

    // Whether anything is left to commit is the step store's answer, given the
    // moment `index` moves — see `syncSteps`. This only redraws the bar around it.
    syncHeader();
    // A block inside a note renders on the note's own pass, which `reconcile`
    // never saw. Lighting a listing or an equation before its paint resolves put
    // the mark on an empty box and then resized it under the eye.
    await settleViews(report.fresh.concat(report.patched.map((spot) => spot.view)));
    await spotlight(target, report, plan.quick);
  } finally {
    release();
  }
}

/* ─── dirty / save ─────────────────────────────────────────────────────────── */

/**
 * Something changed.
 *
 * `kind` and `target` are what the step store collapses on: two edits that name
 * the same pair are the same piece of work continuing and merge into one step,
 * anything else starts a new one. Only typing merges — see history.js — so a
 * structural change may pass whatever names it best.
 */
function markDirty(kind, target) {
  // A repaint is not an edit. `ui.front.paint()` rebuilds the front-matter
  // fields from the values just committed, and the input events that rebuild
  // fires are indistinguishable here from typing — so a post went back to
  // "unsaved" the instant it finished saving, and leaving asked to save again.
  if (state.painting) return;
  state.dirty = true;
  syncHeader();
  history.record(kind, target);

  clearTimeout(state.stashTimer);
  state.stashTimer = setTimeout(() => {
    readAll();
    session.stash(state.doc, state.entry && state.entry.grant);
  }, AUTOSTASH_MS);
}

function readAll() {
  // Innermost first: a nested box has to be read and written back into its
  // component before the component itself is read.
  const boxes = Array.from(state.boxes).sort((a, b) => b.depth - a.depth);
  for (const box of boxes) {
    for (const view of box.views) if (view.read) view.read();
    writeBox(box);
  }
}

async function doSave(mode) {
  if (!state.doc || state.saving) return;
  // The burst being typed when Save was pressed is part of what is committed,
  // so it becomes a step before the commit rather than after it.
  history.flush();
  readAll();

  if (!parseFrontMatter(state.doc.front).title) {
    return void notice("error", t("need_title", "Give the post a title before saving it."));
  }

  state.saving = true;
  syncHeader();
  notice(null, "");

  try {
    // A rename is only real once it is committed, and it is committed with the
    // post that now points at it. The addresses in THIS document are rewritten
    // here; every other post is rewritten by the build, from the note save
    // leaves behind.
    applyStagedMoves();

    const result = await session.save(state.doc, mode, state.pending, state.vaultChoice, state.stage);

    // A dispatch that did not get through means no run is coming for this save:
    // the queue branch holds ONE payload and the next save replaces it, so
    // consuming the staged work here loses the move notes and the uploaded
    // bytes rather than committing them. Everything stays staged, and "save
    // again to retry" below is a real retry. See repo.js.
    if (result.started !== false) {
      // The picture browser's tree is the BUILD's, and the build that will name
      // these has not run yet. Handing them over rebuilds the tree AND keeps them
      // in it until it has. Before `pending` is emptied, which is where they are.
      noteCommitted(state.pending, state.stage);
      for (const asset of state.pending) URL.revokeObjectURL(asset.url);
      state.pending = [];
      // Settled, not cleared. The commit carried the note; the picture itself is
      // moved by the build, so the mapping is still the only thing that knows
      // where the bytes are until that build lands.
      state.stage.settle();
      // Every step still on the stack now describes a document whose pictures are
      // already in the repository, so stepping back through one must not queue
      // those bytes again or re-ask for a rename the build has been told about.
      history.settle();

      // Edited blocks STAY dirty. Their `src` is the text they were parsed from
      // and is now stale, so re-emitting from their fields is the only thing that
      // still reproduces what was just committed.
      await session.dropStash(state.doc.path);
    }

    // What the document IS changes when it is saved: a new post becomes a file,
    // a public post becomes a draft, a draft becomes the published post. The
    // next save has to act on what it is now, not on what it was opened as.
    state.doc.isNew = false;
    state.doc.path = result.path;

    if (result.published) {
      // A post published WITH `vault:` has no key yet — the build mints it and
      // registers it, and only then is there anything to decrypt.
      state.entry = {
        ...state.entry,
        kind: result.encrypted ? "vault" : "public",
        path: result.path,
        encrypted: false,
        draft: false,
        grant: null,
      };
      if (result.encrypted) {
        notice("info", t("will_encrypt", "Published. The next build seals it and registers its key."));
      }
    } else if (result.minted) {
      state.entry = {
        ...state.entry,
        kind: "vault",
        path: result.path,
        encrypted: true,
        draft: true,
        id: result.minted.id,
        slug: result.minted.slug,
        grant: await session.grantFor(result.minted.id),
      };
    }
    state.doc.entry = state.entry;

    const fresh = await repo.read(result.path);
    state.doc.sha = fresh ? fresh.sha : "";
    // `updated` was stamped by the save. Guarded, because repainting a field
    // fires the same input event typing into it does.
    state.painting = true;
    try {
      ui.front.paint();
    } finally {
      state.painting = false;
    }

    // The run has started, so nothing is at stake in leaving any more — said
    // once, here, rather than relying on every path above having left `dirty`
    // alone. A save whose run never started stays dirty, so leaving asks for the
    // retry that would actually commit the staged pictures.
    if (result.started !== false) {
      state.dirty = false;
      clearTimeout(state.stashTimer);
    }
    syncHeader();

    notice("info", `${t("saved", "Saved")} ${result.short}`);

    // The save is on the queue branch either way, but a dispatch that did not
    // get through means no run is coming for it — so the rail would sit at
    // "Building" until it gave up. Said here, where the author is looking.
    if (result.started === false) {
      notice(
        "warn",
        t("save_unstarted", "Saved and queued, but the build was not started — save again to retry.")
      );
    }

    // A post written HERE now lives somewhere else, but the rail is still worth
    // watching: it is the only thing saying whether the commit built. Where it
    // lands is what differs — see `land`.
    startProgress(result);

    // Publishing is the end of a piece of work, and what it produces — the
    // commit line, the build rail, the document bar — is all at the top of the
    // page, while the author is almost always at the bottom of it. The same
    // journey the corner's own button makes (tools/scrollTopBottom.js).
    if (result.published) window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    if (err.kind === "conflict") {
      notice("error", t("conflict_hint", "This file changed in the repository. Your text is safe here — open the post in a new tab to see what landed, then re-apply."));
    } else {
      notice("error", err.message);
    }
  } finally {
    state.saving = false;
    syncHeader();
  }
}

/* ─── which backend takes the commits ──────────────────────────────────────── */

const BACKEND_ICON = { gitea: "fa-solid fa-server", github: "fa-brands fa-github" };

/**
 * The chip is the only place the choice is visible, and it is only worth
 * showing when there is a choice to make: with one backend configured it stays
 * hidden rather than labelling the obvious.
 */
function paintBackend() {
  if (!ui || !ui.backend) return;

  const rows = repo.backends();
  const id = repo.activeId();
  if (!id || rows.length < 2) {
    ui.backend.hidden = true;
    return;
  }

  const now = rows.find((row) => row.id === id);
  const other = rows.find((row) => row.id !== id);
  ui.backend.hidden = false;
  ui.backend.dataset.backend = id;
  ui.backend.innerHTML =
    `<i class="${BACKEND_ICON[id] || BACKEND_ICON.gitea}" aria-hidden="true"></i>` +
    `<span>${escapeHTML((now && now.label) || id)}</span>`;
  ui.backend.title = other
    ? `${t("backend_switch", "Build on")} ${(other.label || other.id)}`
    : "";
}

/**
 * What to do about the result of selection.
 *
 * The editor is already on a working backend by the time this runs, so nothing
 * here is awaited: catching the preferred repository up takes a runner up to
 * two minutes, and holding the post at "Opening" for that would be paying the
 * whole cost of an outage for a convenience.
 *
 * It runs in the background instead, and the session only MOVES to the
 * repository it caught up if the author has not started work in the meantime —
 * changing where a save goes underneath a half-typed post is not worth the
 * tidiness. Left alone, the next session picks Gitea anyway.
 */
function settleBackend(opened) {
  paintBackend();
  if (!opened) return;

  if (opened.diverged) {
    notice("warn", t("backend_diverged", "The two repositories have diverged — each has commits the other does not. This session commits to the one shown."));
    return;
  }
  if (!opened.behind) return;

  const target = opened.behind;
  notice("info", t("backend_catchup", "Bringing the preferred repository up to date…"));

  repo.catchUp(target).then((caught) => {
    if (!state.on) return;
    if (!caught) {
      notice("warn", t("backend_behind", "The preferred repository is still behind; this session commits to the other one."));
      return;
    }
    if (state.dirty || state.saving) return;
    repo.adopt(target.id);
    paintBackend();
    notice("info", t("backend_caught_up", "Up to date."));
  });
}

/** Force the other backend for the rest of the session. */
async function switchBackend() {
  const rows = repo.backends();
  const other = rows.find((row) => row.id !== repo.activeId());
  if (!other) return;

  ui.backend.disabled = true;
  try {
    // Blob shas are content hashes, so an open document's `sha` is still the
    // right one on the other host whenever the two agree — and where they do
    // not, the save is refused rather than silently overwriting.
    await repo.use(other.id);
    paintBackend();
  } catch (err) {
    notice("error", t("unreachable", "Could not reach the backend."));
  } finally {
    ui.backend.disabled = false;
  }
}

/* ─── the publish rail ─────────────────────────────────────────────────────── */

const STAGES = [
  { key: "committed", icon: "fa-code-commit", label: "Committed" },
  { key: "verify", icon: "fa-shield-check", label: "Verify" },
  { key: "build", icon: "fa-hammer", label: "Build" },
  { key: "deploy", icon: "fa-globe", label: "Deploy" },
];

let progressTimer = null;

/**
 * Where the build for the commit just made has got to.
 *
 * Driven by the GitHub Actions run for the commit: each of its jobs — verify,
 * build, deploy — is a stage, and the page reloads once deploy is done.
 *
 * A null answer is "ask again"; a run that has not started yet reports no
 * jobs at all, and that is also just waiting. Only a state the workflow itself
 * put there ends the poll.
 */
function startProgress(result) {
  clearInterval(progressTimer);
  ui.progress.hidden = false;
  ui.progress.innerHTML =
    STAGES.map(
      (stage, i) =>
        `<span class="ed-stage" data-key="${stage.key}" data-state="${i === 0 ? "done" : "wait"}">
           <i class="fa-solid ${stage.icon}" aria-hidden="true"></i>${escapeHTML(t("s_" + stage.key, stage.label))}
         </span>`
    ).join("") + `<a class="ed-stage-link" target="_blank" rel="noopener" hidden>${escapeHTML(t("view_run", "View run"))}</a>`;
  pop(ui.progress);

  const link = ui.progress.querySelector(".ed-stage-link");
  const mark = (key, value) => {
    const node = ui.progress.querySelector(`[data-key="${key}"]`);
    if (node && node.dataset.state !== value) {
      node.dataset.state = value;
      pop(node);
    }
  };

  let ticks = 0;
  progressTimer = setInterval(async () => {
    if ((ticks += 1) > 100) return clearInterval(progressTimer);

    const status = await repo.commitStatus(result.sha);
    if (!status || !status.count) return;

    if (status.url) {
      link.href = status.url;
      link.hidden = false;
    }

    for (const [key, value] of Object.entries(status.stages)) mark(key, value);

    if (status.state === "success") {
      clearInterval(progressTimer);
      land();
    } else if (status.state === "failure") {
      clearInterval(progressTimer);
      notice("error", t("build_failed", "The build failed. The post is committed; nothing published has changed."));
    }
  }, 6000);
}

/**
 * Show the reader what was just published.
 *
 * The rail reaching "Deployed" is exactly the moment the page under the editor
 * became stale — it is the copy that was rendered before the commit. So the
 * page is fetched again, at the SAME address: where the author is standing is
 * their decision, not something a finished build gets to change.
 *
 * Nothing happens if they started editing again while the build ran — their
 * work outranks the refresh, and the page is still there to reload later.
 */
function land() {
  if (!state.on || state.dirty || state.saving) return;

  notice("info", t("deployed_reload", "Published. Loading the page as readers see it…"));
  // `dirty` is already false, so neither the unload prompt nor the swup guard
  // has anything left to protect.
  state.dirty = false;
  // A post written in the composer has no page of its own — this one is the
  // empty article it was written in — so the console it was started from is
  // where it goes. Loaded properly rather than swapped in through swup: every
  // list on that page was sealed into it by the build that has just been
  // replaced, and the same is true of the article underneath this editor.
  const composer = state.fresh;
  setTimeout(() => {
    if (composer) window.location.assign(`${siteRoot()}/blog-management/`);
    else window.location.reload();
  }, 1200);
}

/* ─── wiring ───────────────────────────────────────────────────────────────── */

function wire() {
  ui.backend.addEventListener("click", () => switchBackend());
  ui.save.addEventListener("click", () => doSave("draft"));

  ui.publish.addEventListener("click", async () => {
    const answer = await openAsk(
      { t },
      {
        icon: "fa-paper-plane",
        title: t("publish", "Publish"),
        message: (state.entry || {}).draft
          ? t("publish_draft", "Publish this draft over the post it replaces?")
          : t("publish_direct", "Commit this straight to the published post?"),
        note: state.doc ? state.doc.path : "",
        actions: [
          { key: "no", label: t("cancel", "Cancel") },
          { key: "go", label: t("publish", "Publish"), icon: "fa-paper-plane", kind: "primary" },
        ],
      }
    );
    if (answer === "go") doSave("publish");
  });

  state.titleHost.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-cover]");
    if (!act) return;
    e.preventDefault();
    if (act.dataset.cover === "drop") {
      writeFront("cover", null);
      writeFront("banner", null);
      writeFront("thumbnail", null);
    } else {
      const picked = await pickImage();
      if (!picked) return;
      writeFront("cover", picked.site);
    }
    paintTitle();
    ui.front.paint();
  });

  state.canvas.addEventListener("paste", onCanvasPaste);
  state.canvas.addEventListener("dragover", onCanvasDragOver);
  state.canvas.addEventListener("drop", onCanvasDrop);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", composeCheck);
  document.addEventListener("click", onNavAway, true);
  window.addEventListener("beforeunload", onLeave);
}

let swupOff = [];

function watchNavigation() {
  if (swupOff.length) return;
  try {
    swupOff.push(swup.hooks.on("visit:start", onVisitStart));
    swupOff.push(swup.hooks.replace("history:popstate", onPopVisit));
  } catch (err) {
    /* no swup: every navigation is a full load, and `beforeunload` covers it */
  }
}

function unwire() {
  for (const off of swupOff.splice(0)) {
    try {
      off();
    } catch (err) {
      /* already gone with the hooks it belonged to */
    }
  }
  state.canvas.removeEventListener("paste", onCanvasPaste);
  state.canvas.removeEventListener("dragover", onCanvasDragOver);
  state.canvas.removeEventListener("drop", onCanvasDrop);
  document.removeEventListener("selectionchange", onSelectionChange);
  document.removeEventListener("keydown", onKey, true);
  document.removeEventListener("focusin", onFocusIn);
  document.removeEventListener("focusout", composeCheck);
  document.removeEventListener("click", onNavAway, true);
  document.removeEventListener("dragover", onDocDragOver);
  document.removeEventListener("drop", onDocDrop);
  window.removeEventListener("beforeunload", onLeave);
  state.dragId = null;
  stopEdgeScroll();
}

async function onCanvasPaste(e) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    e.preventDefault();
    const asset = await stageImage(item.getAsFile());
    insertBlock(makeBlock("image", { url: asset.site, alt: "" }), state.focused ? state.focused.block.id : null, false);
    return;
  }
}

/** The caret left the article: no block is being edited, so nothing is shown. */
function onFocusIn(e) {
  if (!state.on || !ui || !ui.toolbar) return;

  // Where the caret is IS whether a keyboard is up; see `watchViewport`.
  composeCheck();

  if (state.canvas.contains(e.target) || ui.toolbar.el.contains(e.target)) return;
  if (e.target.closest && e.target.closest(".ed-ask, .ed-slash, .ed-picker-mask")) return;

  for (const view of allViews()) view.el.dataset.on = "0";
  state.focused = null;
  ui.toolbar.reset();
}

function onSelectionChange() {
  if (!state.on || !ui || !ui.toolbar) return;
  if (state.canvas.contains(document.activeElement)) ui.toolbar.sync();
}

/**
 * A field that is not the document: a prompt, the browser's search box, a file
 * being renamed in place. Nothing typed there is in the post yet, so the
 * browser's own undo is the right one and this one must keep its hands off.
 */
function typing() {
  const node = document.activeElement;
  return !!(node && node.closest && node.closest(".ed-ask, .ed-pick-field, .ed-pick-row, .ed-sheet .ed-f-input"));
}

function onKey(e) {
  if (!state.on) return;
  if (ui.slash && ui.slash.key(e)) return;

  // A dialogue owns Escape while it is open. This handler is registered first,
  // so without the check it closed the picker AND asked to leave the post.
  if (e.key === "Escape") {
    if (document.querySelector(".ed-picker-mask, .ed-ask")) return;
    if (!state.canvas.contains(document.activeElement)) {
      e.preventDefault();
      return void deactivate();
    }
  }

  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;

  if (e.key === "s") {
    e.preventDefault();
    return void doSave("draft");
  }

  // Before the canvas test, because a step is about the DOCUMENT: the caret may
  // be in the front-matter card or in the picture browser and the shortcut still
  // means the same thing. Held rather than passed on, in every one of those
  // places — the browser's own undo would put text back into a field without
  // telling the document, and the two would be different files from then on.
  const step = e.key === "z" || e.key === "Z" ? (e.shiftKey ? "redo" : "undo") : e.key === "y" || e.key === "Y" ? "redo" : "";
  if (step) {
    if (typing()) return;
    e.preventDefault();
    e.stopPropagation();
    if (state.saving) return;
    return void (step === "redo" ? history.redo() : history.undo());
  }

  if (!state.canvas.contains(document.activeElement)) return;

  if (e.key === "k") {
    e.preventDefault();
    return void ui.toolbar.link();
  }

  const marks = { b: "strong", i: "em", u: "u", e: "code" };
  if (marks[e.key]) {
    e.preventDefault();
    ui.toolbar.applyMark(marks[e.key]);
  }
}

/**
 * The last resort, and the ONLY thing left that a browser draws itself.
 *
 * Closing the tab, reloading, and the back button cannot be held open long
 * enough to ask a question, so this is the browser's own prompt or nothing.
 * Every navigation the page CAN hold — which is all of them, on a site running
 * swup — is caught by `onNavAway` below and asked properly.
 */
function onLeave(e) {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = "";
}

/**
 * A link, pressed while there is uncommitted work.
 *
 * The site navigates with swup, so an in-site link never unloads the document:
 * `beforeunload` does not fire, no prompt appears, and the article the editor
 * was mounted on is simply swapped out from under it. Losing a post to a
 * mis-aimed click on the navbar is not a thing an editor may do.
 *
 * Capture on `document` is what makes this work — swup's own delegated listener
 * is a bubbling one, so stopping the event here stops the visit before it is
 * ever proposed.
 */
function onNavAway(e) {
  if (!state.on || !state.dirty || e.defaultPrevented) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

  const link = e.target.closest && e.target.closest("a[href]");
  if (!link) return;

  // A new tab keeps the editor exactly where it is; the editor's own chrome is
  // not navigation; and a link in the canvas is text being edited, which the
  // browser does not follow anyway.
  const target = link.getAttribute("target");
  if (target && target !== "_self") return;
  if (link.closest(".ed-docbar, .ed-front, .ed-toolbar, .ed-slash, .ed-ask, .ed-picker-mask")) return;
  if (state.canvas && state.canvas.contains(link)) return;

  const href = link.href;
  if (!href || !/^https?:/i.test(href)) return;
  // An anchor on this very page is not leaving it.
  if (href.replace(/#.*$/, "") === location.href.replace(/#.*$/, "")) return;

  e.preventDefault();
  e.stopPropagation();

  confirmLeave().then((go) => {
    if (!go) return;
    // Whatever the answer was, the work is either committed or deliberately
    // abandoned — so the unload prompt has nothing left to protect.
    state.dirty = false;
    navigate(href);
  });
}

/* ─── boot ─────────────────────────────────────────────────────────────────── */

// Two of them: one in the article's tools rail, one in the corner rail a phone
// gets instead. CSS shows whichever belongs to the width; both are wired.
let pencils = [];

/**
 * An encrypted post mounts its article only after it decrypts, and the pencil
 * is pressable before that. Waiting a moment is the difference between "the
 * button does nothing" and "the button works".
 */
function waitForHost(deadline) {
  const host = findHost();
  if (host || Date.now() > deadline) return Promise.resolve(host);
  return new Promise((resolve) => setTimeout(() => resolve(waitForHost(deadline)), 120));
}

async function openHere() {
  const [host] = await Promise.all([waitForHost(Date.now() + 6000), loadStrings()]);
  if (host) await activate(host);
}

export async function initEditor() {
  teardownEditor();

  // The write page is the editor with nothing open yet; it does not wait for a
  // press, because arriving there IS the press.
  const host = findHost();
  if (host && host.dataset.postNew === "1") return void openHere();

  // Wired even when the article is not in the DOM yet: an encrypted post mounts
  // its container only after it decrypts, and the pencil resolves the host when
  // it is pressed rather than now.
  pencils = Array.from(document.querySelectorAll(".tool-edit-post"));
  for (const node of pencils) node.addEventListener("click", onPencil);

  // Arriving with `#edit` IS the press. It is how Posts Management opens a
  // post and how the redirect above lands on a draft's own page, and it costs
  // nothing to anyone else: a fragment never reaches a server.
  if (location.hash === "#edit") openHere();
}

function onPencil(e) {
  e.preventDefault();
  openHere();
}

export function teardownEditor() {
  for (const node of pencils) node.removeEventListener("click", onPencil);
  pencils = [];
  abandon(false);
}
