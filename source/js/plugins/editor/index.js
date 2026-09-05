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
  docToMarkdown,
  emitBlock,
  escapeHTML,
  markdownToDoc,
  nextId,
  parseBlocks,
  parseFrontMatter,
  setFrontMatterKey,
} from "./markdown.js";
import { insertInline } from "./inline.js";
import { createFrontCard } from "./frontmatter.js";
import { loadComponents } from "./render.js";
import {
  bindImage,
  buildPreloader,
  loadManifest,
  resolveAsset,
  setVaultAssets,
  siteRoot,
} from "./assets.js";
import initLazyLoad, {
  forceLoadAllPreloaders,
  registerSrcResolver,
} from "../../layouts/lazyload.js";
import { assetURL } from "../../tools/vaultCrypto.js";
import * as session from "./session.js";
import * as gitea from "./gitea.js";
import { contentChanged, crossFade, enter, exit, flip, pop } from "./motion.js";

const AUTOSTASH_MS = 4000;
const EDGE = 90;        // px from a viewport edge where a drag starts scrolling
const EDGE_SPEED = 18;  // px per frame at the very edge

/* Everything downstream of the body: present when reading, away when writing. */
const FURNITURE = [
  ".post-copyright-info",
  ".post-tags-box",
  ".recommended-article",
  ".article-nav",
  ".comment-container",
  ".toc-content-container",
];

const state = {
  on: false,
  host: null,
  canvas: null,
  titleHost: null,
  snapshot: [],
  titleSnapshot: [],
  put: [],
  doc: null,
  views: [],
  focused: null,
  entry: null,
  pending: [],
  dirty: false,
  saving: false,
  dragId: null,
  dropAt: "",
  vaultChoice: undefined,
  stashTimer: null,
  scrollRAF: 0,
  pointerY: 0,
};

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

/**
 * Publish the document bar's height so the floating toolbar can sit under it.
 *
 * Measured rather than assumed: the bar wraps at narrow widths and grows a row
 * whenever a notice or the publish progress appears, and a toolbar parked at a
 * guessed offset lands on top of it the moment either happens.
 */
function watchDocbarHeight(bar) {
  const publish = () => {
    document.documentElement.style.setProperty("--ed-docbar-h", `${Math.round(bar.offsetHeight)}px`);
  };
  publish();
  const ro = new ResizeObserver(publish);
  ro.observe(bar);
  return ro;
}

function releaseDocbarHeight() {
  if (ui && ui.barSize) ui.barSize.disconnect();
  document.documentElement.style.removeProperty("--ed-docbar-h");
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
    if (state.views[0] && state.views[0].focus) state.views[0].focus("start");
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
  state.titleHost = titleHost;
  // The NODES, not their markup. Restoring from a string reparses the article:
  // every picture in it is requested a second time, and any preloader that was
  // still loading when the editor opened comes back as a fresh element the
  // observer has already been told about. Detached nodes keep their identity,
  // their decoded images and their place in the observer.
  state.snapshot = Array.from(canvas.childNodes);
  state.titleSnapshot = Array.from(titleHost.childNodes);

  host.classList.add("is-editing");
  document.documentElement.classList.add("blog-editing");

  ui = { bar: buildDocbar() };
  host.insertBefore(ui.bar, canvas);
  Object.assign(ui, {
    path: ui.bar.querySelector(".ed-docbar-path"),
    vaultTag: ui.bar.querySelector(".ed-tag-vault"),
    draftTag: ui.bar.querySelector(".ed-tag-draft"),
    dot: ui.bar.querySelector(".ed-dot"),
    save: ui.bar.querySelector(".ed-save"),
    publish: ui.bar.querySelector(".ed-publish"),
    close: ui.bar.querySelector(".ed-close"),
    progress: ui.bar.querySelector(".ed-progress"),
    notice: ui.bar.querySelector(".ed-notice"),
    barSize: watchDocbarHeight(ui.bar),
  });

  ui.file = document.createElement("input");
  ui.file.type = "file";
  ui.file.accept = "image/*";
  ui.file.hidden = true;
  document.body.appendChild(ui.file);

  // Wired before anything can fail: a bar that reports an error must also be
  // the way out of it.
  ui.close.addEventListener("click", () => deactivate());

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

  let ticketError = null;
  try {
    await gitea.getTicket(true);
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

  const identity = pageIdentity(host);

  try {
    await Promise.all([loadComponents(), loadManifest()]);

    if (identity.fresh) {
      state.doc = session.newDocument();
      state.entry = state.doc.entry;
    } else {
      const entry = await session.entryForPage(identity);
      if (!entry) throw new Error(t("no_document", "This post is not in the repository you can write to."));
      state.doc = await session.openDocument(entry);
      state.entry = entry;

      if (entry.draft && identity.source) {
        notice("info", t("editing_draft", "You are editing the draft that supersedes this post."));
      } else if (state.doc.stale) {
        notice("warn", t("stale", "The published copy is behind the repository — a build is probably still running."));
      }

      const cached = await session.recover(state.doc.path, entry.grant);
      if (cached && cached.source !== docToMarkdown(state.doc)) {
        const when = new Date(cached.at).toLocaleString();
        if (window.confirm(`${t("recover", "An unsaved local copy from")} ${when} ${t("recover_tail", "was found. Restore it?")}`)) {
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

  // The same one plugins/vault.js installs, for the pages it is not loaded on.
  registerSrcResolver((node) => assetURL(node.getAttribute("data-vault-asset")));

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
    ask: (kind, current) => askFor(ui.toolbar.el, { t }, kind, current),
    ownsSelection: (sel) => state.canvas.contains(sel.anchorNode),
  };
  ui.toolbar = createToolbar(ctx);
  ui.slash = createSlashMenu(ctx);
  document.body.appendChild(ui.toolbar.el);

  await crossFade(state.canvas, () => {
    state.canvas.innerHTML = "";
    state.views = [];
    for (const block of state.doc.blocks) mountBlock(block);
    if (!state.views.length) {
      const block = makeBlock("paragraph");
      state.doc.blocks.push(block);
      mountBlock(block);
    }
  });

  paintTitle();
  enter(ui.front.el);
  syncHeader();
  wire();
  ui.toolbar.sync();
  contentChanged();

  if (identity.fresh) state.titleHost.querySelector(".ed-title").focus();
}

/* ─── deactivate ───────────────────────────────────────────────────────────── */

async function deactivate() {
  if (!state.on) return;
  if (state.dirty && !window.confirm(t("discard", "This post has unsaved changes. Leave it?"))) return;

  clearInterval(progressTimer);
  clearTimeout(state.stashTimer);
  unwire();
  releaseDocbarHeight();

  const bar = ui.bar;
  const front = ui.front && ui.front.el;
  await Promise.all([exit(bar), front ? exit(front) : Promise.resolve()]);
  bar.remove();
  if (front) front.remove();
  if (ui.toolbar) ui.toolbar.el.remove();
  if (ui.slash) ui.slash.el.remove();
  if (ui.file) ui.file.remove();
  document.querySelectorAll(".ed-ask, .ed-dragshot").forEach((el) => el.remove());

  await crossFade(state.canvas, () => {
    state.canvas.replaceChildren(...state.snapshot);
    state.titleHost.replaceChildren(...state.titleSnapshot);
  });

  // Anything that was mid-swap when the article was taken apart was released by
  // the loader; this is where it gets picked up again.
  observeImages();

  for (const node of state.put) node.classList.remove("ed-put-away");
  state.host.classList.remove("is-editing");
  document.documentElement.classList.remove("blog-editing");

  for (const asset of state.pending) URL.revokeObjectURL(asset.url);
  Object.assign(state, {
    on: false, host: null, canvas: null, titleHost: null, snapshot: [], titleSnapshot: [],
    put: [], doc: null, views: [], entry: null, pending: [], dirty: false, focused: null, vaultChoice: undefined,
  });
  ui = null;
  contentChanged();
}

/* ─── header ───────────────────────────────────────────────────────────────── */

function syncHeader() {
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
  markDirty();

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
  markDirty();
}

/* ─── blocks ───────────────────────────────────────────────────────────────── */

function blockCtx() {
  return {
    t,
    onChange: markDirty,
    onFocus: (view) => {
      const moved = state.focused !== view;
      state.focused = view;
      for (const other of state.views) other.el.dataset.on = other === view ? "1" : "0";
      // The Block tab is about THIS block, so it is repainted the moment the
      // caret lands in another one.
      if (moved && ui && ui.toolbar) ui.toolbar.sync();
    },
    onOptionsChanged: () => {
      if (ui && ui.toolbar) ui.toolbar.refresh();
    },
    onRemount: (id) => remountBlock(id),
    onRawEdited: (id, text) => applyRaw(id, text),
    ask: (kind, current) => askFor(ui.toolbar.el, { t }, kind, current),
    onInsertAfter: (id) => insertBlock(makeBlock("paragraph"), id, true),
    onSplit: (id, tailText) => {
      const index = indexOf(id);
      insertBlock(makeBlock("paragraph", { text: tailText }), id, true);
      state.views[index + 1].focus("start");
    },
    onDelete: (id, move) => deleteBlock(id, move),
    onMergeBack: (id) => mergeBack(id),
    onConvert: (id, type, fields) => convertBlock(id, type, fields),
    onFocusSibling: (id, delta) => {
      const view = state.views[indexOf(id) + delta];
      if (view && view.focus) view.focus(delta > 0 ? "start" : "end");
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
    observeImages,
    figureIndex,
    pickImage,
  };
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

/** Which figure this is, counted the way the build counts them. */
function figureIndex(id) {
  let n = 0;
  for (const block of state.doc.blocks) {
    if (block.type === "image") n += 1;
    if (block.id === id) return n;
  }
  return n;
}

/** Figure numbers are positional, so every image restates its own after a move. */
function renumberFigures() {
  for (const view of state.views) if (view.renumber) view.renumber();
}

function mountBlock(block) {
  const view = createView(block, blockCtx());
  state.canvas.appendChild(view.el);
  state.views.push(view);
  return view;
}

function indexOf(id) {
  return state.views.findIndex((v) => v.block.id === id);
}

function insertBlock(block, afterId, focus) {
  const index = afterId == null ? state.doc.blocks.length - 1 : indexOf(afterId);
  state.doc.blocks.splice(index + 1, 0, block);

  const view = createView(block, blockCtx());
  const anchor = state.views[index];
  if (anchor) anchor.el.after(view.el);
  else state.canvas.appendChild(view.el);
  state.views.splice(index + 1, 0, view);

  enter(view.el).then(() => {
    if (focus && view.focus) view.focus("start");
    contentChanged();
  });
  renumberFigures();
  markDirty();
  return view;
}

async function deleteBlock(id, move) {
  const index = indexOf(id);
  if (index < 0) return;
  if (state.views.length === 1) return void convertBlock(id, "paragraph", { text: "" });

  const view = state.views[index];
  await exit(view.el);
  view.el.remove();
  state.views.splice(index, 1);
  state.doc.blocks.splice(index, 1);

  const next = state.views[move === "next" ? index : Math.max(0, index - 1)];
  if (next && next.focus) next.focus("end");

  renumberFigures();
  markDirty();
  contentChanged();
}

/** Backspace at the head of a block folds it into the one above. */
function mergeBack(id) {
  const index = indexOf(id);
  if (index <= 0) return;

  const prev = state.views[index - 1];
  const here = state.views[index];
  if (!prev.editable || prev.block.type === "list") return;

  prev.read();
  here.read();
  const joined = (prev.block.text || "") + (here.block.text || "");
  const caretAt = joined.length - (here.block.text || "").length;

  const fields = { text: joined };
  if (prev.block.type === "heading") fields.level = prev.block.level;
  convertBlock(prev.block.id, prev.block.type, fields);
  deleteBlock(id, "prev");
  const rebuilt = state.views[index - 1];
  if (rebuilt && rebuilt.focus) rebuilt.focus(caretAt === 0 ? "start" : "end");
}

function convertBlock(id, type, fields) {
  const index = indexOf(id);
  if (index < 0) return;

  const old = state.doc.blocks[index];
  const block = makeBlock(type, fields);
  block.after = old.after;
  state.doc.blocks[index] = block;

  const view = createView(block, blockCtx());
  state.views[index].el.replaceWith(view.el);
  state.views[index] = view;

  if (view.focus) view.focus("end");
  markDirty();
  contentChanged();
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

  const here = state.views[indexOf(id)];
  if (here && here.isEmpty && here.isEmpty()) deleteBlock(id, "next");
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

/** Insert at the caret: inline where the caret is inline, a block where not. */
function insertItem(key, host) {
  const item = INSERTS.find((entry) => entry.key === key);
  if (!item) return;

  const target = host || state.focused;
  const root = richRoot();

  if (item.where === "mark" && root) {
    if (key === "link") {
      return void askFor(ui.toolbar.el, { t }, "url", "https://").then((url) => {
        if (url == null) return;
        ui.toolbar.applyMark("link", { href: url });
      });
    }
    return void ui.toolbar.applyMark("code", {});
  }

  if (item.where === "inline" && root && target) {
    return void insertInlineNode(key);
  }

  const spec = BLOCK_SEEDS[key];
  if (!spec) return;

  if (target && target.isEmpty && target.isEmpty()) {
    return void convertBlock(target.block.id, spec.type, spec.fields);
  }
  insertBlock(makeBlock(spec.type, spec.fields), target ? target.block.id : null, true);
}

/** What each insertable BLOCK starts life as. */
const BLOCK_SEEDS = {
  image: { type: "image", fields: { url: "", alt: "" } },
  table: { type: "table" },
  code: { type: "code", fields: { lang: "", code: "" } },
  math: { type: "math", fields: { tex: "" } },
  mermaid: { type: "mermaid", fields: { code: "graph TD\n  A --> B" } },
  hr: { type: "hr" },
  note: { type: "component", fields: { name: "note", args: "info", body: "" } },
  notel: { type: "component", fields: { name: "notel", args: "info fa-circle-info Title", body: "" } },
  box: { type: "component", fields: { name: "box", args: "blue", body: "" } },
  folding: { type: "component", fields: { name: "folding", args: "blue::Details", body: "" } },
  tabs: { type: "component", fields: { name: "tabs", args: "GROUP", body: "<!-- tab One -->\n\n<!-- endtab -->" } },
  btn: { type: "component", fields: { name: "btn", args: "Label::https://", body: null } },
};

/**
 * The things that go INTO a line rather than after it.
 *
 * An image dropped into a paragraph is an inline image, which is a different
 * thing from an image block, and markdown says so: `![](…)` inside a sentence.
 * The node carries the same `data-md` the parser emits, so it reads back out as
 * the markdown it came from.
 */
async function insertInlineNode(key) {
  const root = richRoot();
  if (!root) return;

  if (key === "image") {
    const picked = await pickImage();
    if (!picked) return;
    const img = document.createElement("img");
    img.setAttribute("data-md", "image");
    img.src = resolveAsset(picked.site, state.pending);
    img.alt = "";
    img.dataset.mdSrc = `![](${picked.site})`;
    insertInline(root, img);
  } else if (key === "imath") {
    const tex = await askFor(ui.toolbar.el, { t }, "tex", "");
    if (tex == null) return;
    const span = document.createElement("span");
    span.className = "ed-math-inline";
    span.setAttribute("data-md", "math");
    span.setAttribute("data-tex", tex);
    span.textContent = tex;
    insertInline(root, span);
  } else {
    return;
  }

  commitInline();
}

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
  const index = indexOf(id);
  if (index < 0) return;

  const blocks = parseBlocks(text).map((b) => Object.assign(b, { dirty: true }));
  const old = state.doc.blocks[index];

  if (!blocks.length) return void deleteBlock(id, "prev");
  if (blocks.length === 1 && blocks[0].type === old.type && emitBlock(blocks[0]) === emitBlock(old)) {
    return void remountBlock(id);
  }

  blocks[blocks.length - 1].after = old.after;
  state.doc.blocks.splice(index, 1, ...blocks);

  const views = blocks.map((block) => createView(block, blockCtx()));
  state.views[index].el.replaceWith(...views.map((v) => v.el));
  state.views.splice(index, 1, ...views);

  markDirty();
  renumberFigures();
  contentChanged();
  if (views[0].focus) views[0].focus("end");
}

/** Rebuild one block's view in place — its own fields decided to change shape. */
function remountBlock(id) {
  const index = indexOf(id);
  if (index < 0) return;
  const block = state.doc.blocks[index];
  const view = createView(block, blockCtx());
  state.views[index].el.replaceWith(view.el);
  state.views[index] = view;
  state.focused = view;
  if (view.focus) view.focus("end");
  renumberFigures();
  contentChanged();
  if (ui && ui.toolbar) ui.toolbar.sync();
}

function moveFocused(delta) {
  const view = state.focused;
  if (!view) return;
  const from = indexOf(view.block.id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= state.doc.blocks.length) return;

  const nodes = state.views.map((v) => v.el);
  flip(nodes, () => {
    const [block] = state.doc.blocks.splice(from, 1);
    state.doc.blocks.splice(to, 0, block);
    const [moved] = state.views.splice(from, 1);
    state.views.splice(to, 0, moved);
    const anchor = state.views[to + (delta > 0 ? -1 : 1)];
    if (delta > 0) anchor.el.after(moved.el);
    else anchor.el.before(moved.el);
  });

  markDirty();
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
 * Which slot the pointer is over, decided by geometry rather than by hit
 * testing what is under it.
 *
 * `e.target.closest(".ed-block")` only answers while the pointer is inside a
 * block's own box, so the gutter, the article's padding, the gap between two
 * paragraphs and everything past the last one all came back as "nowhere" — no
 * indicator, and the cursor went to no-drop. Every Y inside the page maps to a
 * slot here, including above the first block and below the last.
 */
function dropTargetAt(y) {
  const rows = state.views.filter((v) => v.block.id !== state.dragId);
  if (!rows.length) return null;

  for (const view of rows) {
    const rect = view.el.getBoundingClientRect();
    if (y < rect.bottom) {
      return { id: view.block.id, where: y < rect.top + rect.height / 2 ? "before" : "after" };
    }
  }
  return { id: rows[rows.length - 1].block.id, where: "after" };
}

/**
 * Paint the insertion line, and ONLY when it moves.
 *
 * Clearing every block's `data-drop` on each `dragover` and re-setting it tore
 * the pseudo-element down and built it again several times a second, which
 * restarted its entrance animation each time — the flicker was the indicator
 * being recreated, not redrawn.
 */
function paintDrop(target) {
  const key = target ? target.id + ":" + target.where : "";
  if (key === state.dropAt) return;
  state.dropAt = key;

  for (const view of state.views) {
    const want = target && view.block.id === target.id ? target.where : "";
    if (view.el.dataset.drop !== want) view.el.dataset.drop = want;
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

  const from = indexOf(dragId);
  const to = indexOf(target.id);
  const after = target.where === "after";
  const anchor = state.views[to].el;
  if (from < 0 || to < 0) return;

  await flip(Array.from(state.canvas.querySelectorAll(".ed-block")), () => {
    const [view] = state.views.splice(from, 1);
    const [block] = state.doc.blocks.splice(from, 1);
    const at = to + (after ? 1 : 0) - (from < to ? 1 : 0);
    state.views.splice(at, 0, view);
    state.doc.blocks.splice(at, 0, block);
    if (after) anchor.after(view.el);
    else anchor.before(view.el);
  });

  // Order is the one thing a moved block cannot carry in `src`: its trailing
  // separator belonged to the position it left.
  state.doc.blocks.forEach((b) => (b.after = b.after || "\n\n"));
  renumberFigures();
  markDirty();
}

function onCanvasDragOver(e) {
  if (state.dragId) return;
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
}

// Files only. A block being carried is handled on the document, above.
async function onCanvasDrop(e) {
  if (state.dragId) return;

  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  e.preventDefault();
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const asset = await stageImage(file);
    insertBlock(makeBlock("image", { url: asset.site, alt: "" }), null, false);
  }
}

/* ─── assets ───────────────────────────────────────────────────────────────── */

function pickImage() {
  return new Promise((resolve) => {
    ui.file.value = "";
    ui.file.onchange = async () => {
      const file = ui.file.files && ui.file.files[0];
      resolve(file ? await stageImage(file) : null);
    };
    ui.file.click();
  });
}

/** Read a file off disk, hold it as a blob, and queue it for the next commit. */
async function stageImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const path = await gitea.assetPath(file.name, bytes);
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
  markDirty();
  return asset;
}

/* ─── dirty / save ─────────────────────────────────────────────────────────── */

function markDirty() {
  state.dirty = true;
  syncHeader();

  clearTimeout(state.stashTimer);
  state.stashTimer = setTimeout(() => {
    readAll();
    session.stash(state.doc, state.entry && state.entry.grant);
  }, AUTOSTASH_MS);
}

function readAll() {
  for (const view of state.views) if (view.read) view.read();
}

async function doSave(mode) {
  if (!state.doc || state.saving) return;
  readAll();

  if (!parseFrontMatter(state.doc.front).title) {
    return void notice("error", t("need_title", "Give the post a title before saving it."));
  }

  state.saving = true;
  syncHeader();
  notice(null, "");

  try {
    const result = await session.save(state.doc, mode, state.pending, state.vaultChoice);

    for (const asset of state.pending) URL.revokeObjectURL(asset.url);
    state.pending = [];
    state.dirty = false;

    // Edited blocks STAY dirty. Their `src` is the text they were parsed from
    // and is now stale, so re-emitting from their fields is the only thing that
    // still reproduces what was just committed.
    await session.dropStash(state.doc.path);

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

    const fresh = await gitea.read(result.path);
    state.doc.sha = fresh ? fresh.sha : "";
    ui.front.paint(); // `updated` was stamped by the save

    notice("info", `${t("saved", "Saved")} ${result.short}`);
    startProgress(result);
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

/* ─── the publish rail ─────────────────────────────────────────────────────── */

const STAGES = [
  { key: "committed", icon: "fa-code-commit", label: "Committed" },
  { key: "building", icon: "fa-hammer", label: "Building" },
  { key: "pushed", icon: "fa-upload", label: "Artifact pushed" },
  { key: "deployed", icon: "fa-globe", label: "Deployed" },
];

let progressTimer = null;

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

    let runs = [];
    try {
      runs = await gitea.runs(5);
    } catch (err) {
      return;
    }

    const run = runs.find((r) => r.sha && result.sha && r.sha.startsWith(result.sha.slice(0, 7))) || runs[0];
    if (!run) return;

    if (run.url) {
      link.href = run.url;
      link.hidden = false;
    }

    if (run.status === "running" || run.status === "in_progress") mark("building", "live");
    if (run.conclusion === "success") {
      mark("building", "done");
      mark("pushed", "done");
      mark("deployed", "live");
      clearInterval(progressTimer);
      // Vercel is downstream of a push nothing here sees, so the last stage is
      // optimistic by design: the artifact is out of our hands.
      setTimeout(() => mark("deployed", "done"), 20000);
    } else if (run.conclusion === "failure" || run.conclusion === "cancelled") {
      mark("building", "fail");
      clearInterval(progressTimer);
      notice("error", t("build_failed", "The build failed. The post is committed; nothing published has changed."));
    }
  }, 6000);
}

/* ─── wiring ───────────────────────────────────────────────────────────────── */

function wire() {
  ui.save.addEventListener("click", () => doSave("draft"));

  ui.publish.addEventListener("click", () => {
    const question = (state.entry || {}).draft
      ? t("publish_draft", "Publish this draft over the post it replaces?")
      : t("publish_direct", "Commit this straight to the published post?");
    if (window.confirm(question)) doSave("publish");
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
  window.addEventListener("beforeunload", onLeave);
}

function unwire() {
  state.canvas.removeEventListener("paste", onCanvasPaste);
  state.canvas.removeEventListener("dragover", onCanvasDragOver);
  state.canvas.removeEventListener("drop", onCanvasDrop);
  document.removeEventListener("selectionchange", onSelectionChange);
  document.removeEventListener("keydown", onKey, true);
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

function onSelectionChange() {
  if (!state.on || !ui || !ui.toolbar) return;
  if (state.canvas.contains(document.activeElement)) ui.toolbar.sync();
}

function onKey(e) {
  if (!state.on) return;
  if (ui.slash && ui.slash.key(e)) return;

  if (e.key === "Escape" && !state.canvas.contains(document.activeElement)) {
    e.preventDefault();
    return void deactivate();
  }

  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;

  if (e.key === "s") {
    e.preventDefault();
    return void doSave("draft");
  }
  if (!state.canvas.contains(document.activeElement)) return;

  if (e.key === "k") {
    e.preventDefault();
    return void insertItem("link", null);
  }

  const marks = { b: "strong", i: "em", u: "u", e: "code" };
  if (marks[e.key]) {
    e.preventDefault();
    ui.toolbar.applyMark(marks[e.key]);
  }
}

function onLeave(e) {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = "";
}

/* ─── boot ─────────────────────────────────────────────────────────────────── */

let pencil = null;

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
  pencil = document.querySelector(".tool-edit-post");
  if (pencil) pencil.addEventListener("click", onPencil);
}

function onPencil(e) {
  e.preventDefault();
  openHere();
}

export function teardownEditor() {
  clearInterval(progressTimer);
  clearTimeout(state.stashTimer);
  stopEdgeScroll();

  if (pencil) {
    pencil.removeEventListener("click", onPencil);
    pencil = null;
  }
  if (!state.on) return;

  unwire();
  releaseDocbarHeight();
  document.querySelectorAll(".ed-docbar, .ed-front, .ed-toolbar, .ed-slash, .ed-ask, .ed-dragshot").forEach((el) => el.remove());
  document.documentElement.classList.remove("blog-editing");
  for (const asset of state.pending) URL.revokeObjectURL(asset.url);
  Object.assign(state, {
    on: false, host: null, canvas: null, titleHost: null, put: [],
    doc: null, views: [], entry: null, pending: [], dirty: false, focused: null,
  });
  ui = null;
}
