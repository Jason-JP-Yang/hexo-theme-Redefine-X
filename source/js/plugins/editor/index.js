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
import { CATALOGUE, createSlashMenu, createToolbar, openMoreMenu } from "./toolbar.js";
import {
  docToMarkdown,
  escapeHTML,
  markdownToDoc,
  parseBlocks,
  parseFrontMatter,
  setFrontMatterKey,
} from "./markdown.js";
import { createFrontCard } from "./frontmatter.js";
import { loadComponents } from "./render.js";
import { loadManifest, resolveAsset, siteRoot } from "./assets.js";
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
  snapshot: "",
  titleSnapshot: "",
  put: [],
  doc: null,
  views: [],
  focused: null,
  entry: null,
  pending: [],
  dirty: false,
  saving: false,
  dragId: null,
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
        <img src="${escapeHTML(resolveAsset(cover, state.pending))}" alt="" class="article-cover-image dark:brightness-75">
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

  const heading = state.titleHost.querySelector(".ed-title");
  heading.addEventListener("input", () => {
    writeFront("title", heading.textContent.trim());
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
  state.snapshot = canvas.innerHTML;
  state.titleSnapshot = titleHost.innerHTML;

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

  ui.front = createFrontCard(state.doc, {
    t,
    onChange: onFrontChange,
    pickImage,
    resolveAsset: (src) => resolveAsset(src, state.pending),
  });
  host.insertBefore(ui.front.el, state.canvas);

  const ctx = {
    t,
    onInsert: (key) => insertFromCatalogue(key, null),
    onPick: (item, hostView) => insertFromCatalogue(item.key, hostView),
    onMore: (anchor) => openMoreMenu(anchor, { t, onInsert: (key) => insertFromCatalogue(key, null) }),
    onMarked: () => {
      if (state.focused) {
        state.focused.touch();
        state.focused.read();
      }
    },
    ownsSelection: (sel) => state.canvas.contains(sel.anchorNode),
    link_url: t("link_url", "Link URL"),
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

  const bar = ui.bar;
  const front = ui.front && ui.front.el;
  await Promise.all([exit(bar), front ? exit(front) : Promise.resolve()]);
  bar.remove();
  if (front) front.remove();
  if (ui.toolbar) ui.toolbar.el.remove();
  if (ui.slash) ui.slash.el.remove();
  if (ui.file) ui.file.remove();
  document.querySelectorAll(".ed-more-menu, .ed-icon-picker").forEach((el) => el.remove());

  await crossFade(state.canvas, () => {
    state.canvas.innerHTML = state.snapshot;
    state.titleHost.innerHTML = state.titleSnapshot;
  });

  for (const node of state.put) node.classList.remove("ed-put-away");
  state.host.classList.remove("is-editing");
  document.documentElement.classList.remove("blog-editing");

  for (const asset of state.pending) URL.revokeObjectURL(asset.url);
  Object.assign(state, {
    on: false, host: null, canvas: null, titleHost: null, snapshot: "", titleSnapshot: "",
    put: [], doc: null, views: [], entry: null, pending: [], dirty: false, focused: null,
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

function onFrontChange(key) {
  markDirty();

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
  if (img) img.src = resolveAsset(cover, state.pending);
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
      state.focused = view;
      for (const other of state.views) other.el.dataset.on = other === view ? "1" : "0";
    },
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
      state.canvas.classList.add("is-dragging");
    },
    onDragEnd: () => {
      state.dragId = null;
      stopEdgeScroll();
      state.canvas.classList.remove("is-dragging");
      state.canvas.querySelectorAll(".ed-block").forEach((el) => (el.dataset.drop = ""));
    },
    resolveAsset: (src) => resolveAsset(src, state.pending),
    pickImage,
  };
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

function insertFromCatalogue(key, host) {
  const item = CATALOGUE.find((c) => c.key === key);
  if (!item) return;

  const type = item.type || (item.key === "heading2" || item.key === "heading3" ? "heading" : item.key);
  const target = host || state.focused;

  if (target && target.isEmpty && target.isEmpty()) {
    return void convertBlock(target.block.id, type, item.fields);
  }
  insertBlock(makeBlock(type, item.fields), target ? target.block.id : null, true);
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

function onCanvasDragOver(e) {
  if (state.dragId) {
    e.preventDefault();
    startEdgeScroll(e.clientY);
    const over = e.target.closest(".ed-block");
    state.canvas.querySelectorAll(".ed-block").forEach((el) => (el.dataset.drop = ""));
    if (over && over.dataset.id !== state.dragId) {
      const rect = over.getBoundingClientRect();
      over.dataset.drop = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    }
    return;
  }
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
}

async function onCanvasDrop(e) {
  if (state.dragId) {
    e.preventDefault();
    stopEdgeScroll();
    const over = e.target.closest(".ed-block");
    state.canvas.querySelectorAll(".ed-block").forEach((el) => (el.dataset.drop = ""));
    if (!over || over.dataset.id === state.dragId) return;

    const from = indexOf(state.dragId);
    const to = indexOf(over.dataset.id);
    const after = over.dataset.drop === "after";

    await flip(Array.from(state.canvas.querySelectorAll(".ed-block")), () => {
      const [view] = state.views.splice(from, 1);
      const [block] = state.doc.blocks.splice(from, 1);
      const target = to + (after ? 1 : 0) - (from < to ? 1 : 0);
      state.views.splice(target, 0, view);
      state.doc.blocks.splice(target, 0, block);
      if (after) over.after(view.el);
      else over.before(view.el);
    });

    // Order is the one thing a moved block cannot carry in `src`: its trailing
    // separator belonged to where it used to be.
    state.doc.blocks.forEach((b) => (b.after = b.after || "\n\n"));
    markDirty();
    return;
  }

  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  e.preventDefault();
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const asset = await stageImage(file);
    insertBlock(makeBlock("image", { src: asset.site, alt: "" }), null, false);
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

  const asset = {
    path,
    site: "/" + path.replace(/^source\//, ""),
    bytes,
    url: URL.createObjectURL(file),
    name: file.name,
  };
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
    const result = await session.save(state.doc, mode, state.pending);

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
      state.entry = { ...state.entry, kind: "public", path: result.path, encrypted: false, draft: false, grant: null };
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
  window.removeEventListener("beforeunload", onLeave);
  stopEdgeScroll();
}

async function onCanvasPaste(e) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    e.preventDefault();
    const asset = await stageImage(item.getAsFile());
    insertBlock(makeBlock("image", { src: asset.site, alt: "" }), state.focused ? state.focused.block.id : null, false);
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

  const marks = { b: "strong", i: "em", k: "link" };
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
  document.querySelectorAll(".ed-docbar, .ed-front, .ed-toolbar, .ed-slash, .ed-more-menu, .ed-icon-picker").forEach((el) => el.remove());
  document.documentElement.classList.remove("blog-editing");
  for (const asset of state.pending) URL.revokeObjectURL(asset.url);
  Object.assign(state, {
    on: false, host: null, canvas: null, titleHost: null, put: [],
    doc: null, views: [], entry: null, pending: [], dirty: false, focused: null,
  });
  ui = null;
}
