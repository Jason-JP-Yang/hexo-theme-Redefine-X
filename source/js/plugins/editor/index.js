/**
 * The editor.
 *
 * Three columns: the documents you can open, the canvas, and the front matter.
 * The canvas is `.article-content.markdown-body` — the class a published
 * article wears — so what is on screen is not a preview of the post, it is the
 * post at the typography it will ship at.
 *
 * Nothing here is a security boundary. The page renders for anyone who reaches
 * the URL; the Worker decides whether a ticket comes back, and Gitea decides
 * what that ticket may write.
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
import { loadComponents } from "./render.js";
import * as session from "./session.js";
import * as gitea from "./gitea.js";
import { contentChanged, enter, exit, flip, pop } from "./motion.js";

const AUTOSTASH_MS = 4000;

const state = {
  root: null,
  doc: null,
  views: [],
  entries: [],
  active: null,
  pending: [],
  dirty: false,
  saving: false,
  dragId: null,
  stashTimer: null,
};

let ui = null;

function t(key, fallback) {
  const table = (window.theme && window.theme.editor_i18n) || {};
  return table[key] || fallback;
}

/* ─── shell ────────────────────────────────────────────────────────────────── */

function paintShell(root) {
  root.innerHTML = `
    <div class="ed-shell">
      <aside class="ed-rail">
        <div class="ed-rail-head">
          <h2>${escapeHTML(t("documents", "Documents"))}</h2>
          <button type="button" class="ed-new" title="${escapeHTML(t("new_post", "New post"))}">
            <i class="fa-solid fa-plus" aria-hidden="true"></i>
          </button>
        </div>
        <input type="search" class="ed-filter" placeholder="${escapeHTML(t("filter", "Filter"))}" spellcheck="false">
        <ul class="ed-doc-list"></ul>
        <div class="ed-rail-foot">
          <h3>${escapeHTML(t("outline", "Outline"))}</h3>
          <ol class="ed-outline"></ol>
        </div>
      </aside>

      <main class="ed-main">
        <header class="ed-bar">
          <div class="ed-bar-title">
            <span class="ed-doc-name"></span>
            <span class="ed-badge ed-badge-draft" hidden><i class="fa-solid fa-pen-nib"></i>${escapeHTML(t("draft", "Draft"))}</span>
            <span class="ed-badge ed-badge-vault" hidden><i class="fa-solid fa-lock-keyhole"></i>${escapeHTML(t("encrypted", "Encrypted"))}</span>
          </div>
          <div class="ed-bar-actions">
            <span class="ed-status" data-state="idle" title=""></span>
            <button type="button" class="ed-save" disabled>
              <i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i>
              <span>${escapeHTML(t("save", "Save draft"))}</span>
            </button>
            <button type="button" class="ed-publish" disabled>
              <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
              <span>${escapeHTML(t("publish", "Publish"))}</span>
            </button>
          </div>
        </header>

        <div class="ed-progress" hidden></div>
        <div class="ed-notice" hidden></div>

        <div class="ed-canvas-scroll">
          <div class="ed-canvas article-content markdown-body" spellcheck="false"></div>
          <div class="ed-empty">
            <i class="fa-regular fa-file-lines" aria-hidden="true"></i>
            <p>${escapeHTML(t("pick_a_doc", "Choose a post on the left, or start a new one."))}</p>
          </div>
        </div>
      </main>

      <aside class="ed-inspector"></aside>
    </div>
    <input type="file" class="ed-file" accept="image/*" hidden multiple>`;

  return {
    shell: root.querySelector(".ed-shell"),
    list: root.querySelector(".ed-doc-list"),
    filter: root.querySelector(".ed-filter"),
    outline: root.querySelector(".ed-outline"),
    canvas: root.querySelector(".ed-canvas"),
    empty: root.querySelector(".ed-empty"),
    name: root.querySelector(".ed-doc-name"),
    draftBadge: root.querySelector(".ed-badge-draft"),
    vaultBadge: root.querySelector(".ed-badge-vault"),
    status: root.querySelector(".ed-status"),
    save: root.querySelector(".ed-save"),
    publish: root.querySelector(".ed-publish"),
    progress: root.querySelector(".ed-progress"),
    notice: root.querySelector(".ed-notice"),
    inspector: root.querySelector(".ed-inspector"),
    file: root.querySelector(".ed-file"),
    newBtn: root.querySelector(".ed-new"),
  };
}

/* ─── status ───────────────────────────────────────────────────────────────── */

const STATUS = {
  idle: "",
  typing: "fa-circle",
  saving: "fa-circle-notch fa-spin",
  saved: "fa-circle-check",
  error: "fa-circle-exclamation",
  offline: "fa-cloud-slash",
};

let statusTimer = null;

function setStatus(kind, text) {
  ui.status.dataset.state = kind;
  ui.status.title = text || "";
  ui.status.innerHTML = STATUS[kind] ? `<i class="fa-solid ${STATUS[kind]}" aria-hidden="true"></i>` : "";
  clearTimeout(statusTimer);
  if (kind === "saved") statusTimer = setTimeout(() => setStatus("idle"), 2400);
}

function notice(kind, html) {
  if (!html) {
    ui.notice.hidden = true;
    return;
  }
  ui.notice.hidden = false;
  ui.notice.dataset.kind = kind;
  ui.notice.innerHTML = html;
  pop(ui.notice);
}

/* ─── the document list ────────────────────────────────────────────────────── */

async function refreshList(selectPath) {
  ui.list.innerHTML = `<li class="ed-doc-blank"><i class="fa-solid fa-circle-notch fa-spin"></i></li>`;
  try {
    state.entries = await session.listDocuments();
  } catch (err) {
    ui.list.innerHTML = `<li class="ed-doc-blank">${escapeHTML(err.message)}</li>`;
    return;
  }
  paintList();
  if (selectPath) {
    const row = state.entries.find((e) => e.path === selectPath);
    if (row) openEntry(row);
  }
}

function paintList() {
  const q = ui.filter.value.trim().toLowerCase();
  const rows = state.entries.filter(
    (e) => !q || (e.title || "").toLowerCase().includes(q) || e.path.toLowerCase().includes(q)
  );

  ui.list.innerHTML = rows.length
    ? rows
        .map((entry) => {
          const on = state.active && state.active.path === entry.path;
          return `<li class="ed-doc" data-path="${escapeHTML(entry.path)}" data-on="${on ? "1" : "0"}" data-draft="${entry.draft ? "1" : "0"}">
            <span class="ed-doc-icon"><i class="fa-solid ${entry.draft ? "fa-pen-nib" : entry.encrypted ? "fa-lock-keyhole" : "fa-file-lines"}" aria-hidden="true"></i></span>
            <span class="ed-doc-text">
              <strong>${escapeHTML(entry.title || entry.path)}</strong>
              <small>${escapeHTML((entry.date || "").slice(0, 10))}${entry.shadowed ? " · " + escapeHTML(t("has_draft", "has a draft")) : ""}</small>
            </span>
          </li>`;
        })
        .join("")
    : `<li class="ed-doc-blank">${escapeHTML(t("no_docs", "Nothing here"))}</li>`;
}

/* ─── opening ──────────────────────────────────────────────────────────────── */

async function openEntry(entry) {
  if (state.dirty && !window.confirm(t("discard", "This post has unsaved changes. Leave it?"))) return;

  setStatus("saving", t("opening", "Opening"));
  notice(null, "");

  try {
    const doc = await session.openDocument(entry);

    const cached = await session.recover(doc.path, entry.grant);
    if (cached && cached.source !== docToMarkdown(doc)) {
      const when = new Date(cached.at).toLocaleString();
      if (window.confirm(t("recover", "An unsaved local copy from") + " " + when + " " + t("recover_tail", "was found. Restore it?"))) {
        Object.assign(doc, markdownToDoc(cached.source), { path: doc.path, sha: doc.sha, entry });
        markDirty();
      }
    }

    state.doc = doc;
    state.active = entry;
    state.pending = [];
    state.dirty = false;

    if (doc.stale) {
      notice("warn", `<i class="fa-solid fa-triangle-exclamation"></i>${escapeHTML(t("stale", "The published copy is behind the repository — a build is probably still running."))}`);
    }

    renderDocument();
    paintList();
    setStatus("idle");
    syncActions();
  } catch (err) {
    setStatus("error", err.message);
    notice("error", `<i class="fa-solid fa-circle-exclamation"></i>${escapeHTML(err.message)}`);
  }
}

function renderDocument() {
  ui.empty.hidden = true;
  ui.canvas.innerHTML = "";
  state.views = [];

  for (const block of state.doc.blocks) mountBlock(block, null);

  paintInspector();
  paintOutline();
  paintHeader();
  contentChanged();
}

function paintHeader() {
  const entry = state.active || {};
  const front = parseFrontMatter(state.doc.front);
  ui.name.textContent = front.title || entry.title || entry.path || "";
  ui.draftBadge.hidden = !entry.draft;
  ui.vaultBadge.hidden = !entry.encrypted || entry.draft;
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
      const block = makeBlock("paragraph", { text: tailText });
      insertBlock(block, id, true);
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
      ui.canvas.classList.add("is-dragging");
    },
    onDragEnd: () => {
      state.dragId = null;
      ui.canvas.classList.remove("is-dragging");
      ui.canvas.querySelectorAll(".ed-block").forEach((el) => (el.dataset.drop = ""));
    },
    resolveAsset,
    pickImage,
  };
}

function mountBlock(block, beforeId) {
  const view = createView(block, blockCtx());
  const index = beforeId == null ? state.views.length : indexOf(beforeId);

  if (beforeId == null) {
    ui.canvas.appendChild(view.el);
    state.views.push(view);
  } else {
    ui.canvas.insertBefore(view.el, state.views[index].el);
    state.views.splice(index, 0, view);
  }
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
  else ui.canvas.appendChild(view.el);
  state.views.splice(index + 1, 0, view);

  enter(view.el).then(() => {
    if (focus && view.focus) view.focus("start");
    contentChanged();
  });
  markDirty();
  paintOutline();
  return view;
}

async function deleteBlock(id, move) {
  const index = indexOf(id);
  if (index < 0) return;
  if (state.views.length === 1) {
    return void convertBlock(id, "paragraph", { text: "" });
  }

  const view = state.views[index];
  await exit(view.el);
  view.el.remove();
  state.views.splice(index, 1);
  state.doc.blocks.splice(index, 1);

  const next = state.views[move === "next" ? index : Math.max(0, index - 1)];
  if (next && next.focus) next.focus("end");

  markDirty();
  paintOutline();
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

  prev.block.text = joined;
  prev.block.dirty = true;
  const caretAt = (prev.block.text || "").length - (here.block.text || "").length;

  convertBlock(prev.block.id, prev.block.type, { text: joined });
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
  paintOutline();
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

/* ─── drag reorder ─────────────────────────────────────────────────────────── */

function wireDrop() {
  ui.canvas.addEventListener("dragover", (e) => {
    if (!state.dragId) return;
    e.preventDefault();
    const over = e.target.closest(".ed-block");
    ui.canvas.querySelectorAll(".ed-block").forEach((el) => (el.dataset.drop = ""));
    if (!over || over.dataset.id === state.dragId) return;
    const rect = over.getBoundingClientRect();
    over.dataset.drop = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  });

  ui.canvas.addEventListener("drop", async (e) => {
    if (!state.dragId) return;
    e.preventDefault();
    const over = e.target.closest(".ed-block");
    ui.canvas.querySelectorAll(".ed-block").forEach((el) => {
      if (el !== over) el.dataset.drop = "";
    });
    if (!over || over.dataset.id === state.dragId) return;

    const from = indexOf(state.dragId);
    const to = indexOf(over.dataset.id);
    const after = over.dataset.drop === "after";
    over.dataset.drop = "";

    await flip(Array.from(ui.canvas.querySelectorAll(".ed-block")), () => {
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
    paintOutline();
  });
}

/* ─── outline ──────────────────────────────────────────────────────────────── */

function paintOutline() {
  const heads = state.doc
    ? state.doc.blocks.filter((b) => b.type === "heading")
    : [];

  ui.outline.innerHTML = heads.length
    ? heads
        .map(
          (b) =>
            `<li data-id="${b.id}" data-level="${b.level}"><span>${escapeHTML(b.text.replace(/[*_`]/g, "")) || "—"}</span></li>`
        )
        .join("")
    : `<li class="ed-outline-blank">${escapeHTML(t("no_headings", "No headings yet"))}</li>`;
}

/* ─── inspector ────────────────────────────────────────────────────────────── */

const FRONT_FIELDS = [
  { key: "title", label: "Title", type: "text" },
  { key: "date", label: "Date", type: "text" },
  { key: "updated", label: "Updated", type: "text" },
  { key: "cover", label: "Cover", type: "asset" },
  { key: "excerpt", label: "Excerpt", type: "area" },
  { key: "categories", label: "Categories", type: "list" },
  { key: "tags", label: "Tags", type: "list" },
  { key: "sticky", label: "Pinned", type: "text" },
  { key: "mathjax", label: "MathJax", type: "toggle" },
];

function paintInspector() {
  const front = parseFrontMatter(state.doc.front);

  ui.inspector.innerHTML = `
    <h2 class="ed-inspector-title">${escapeHTML(t("front_matter", "Front matter"))}</h2>
    <div class="ed-fields">
      ${FRONT_FIELDS.map((field) => renderField(field, front[field.key])).join("")}
    </div>
    <details class="ed-front-raw">
      <summary>${escapeHTML(t("raw_front", "Raw front matter"))}</summary>
      <textarea spellcheck="false">${escapeHTML(state.doc.front)}</textarea>
    </details>`;

  ui.inspector.querySelectorAll("[data-field]").forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.dataset.field;
      const value =
        input.dataset.type === "list"
          ? input.value.split(",").map((s) => s.trim()).filter(Boolean)
          : input.type === "checkbox"
            ? String(input.checked)
            : input.value;
      state.doc.front = setFrontMatterKey(state.doc.front, key, value);
      state.doc.frontDirty = true;
      markDirty();
      if (key === "title") paintHeader();
    });
  });

  const raw = ui.inspector.querySelector(".ed-front-raw textarea");
  raw.addEventListener("input", () => {
    state.doc.front = raw.value;
    state.doc.frontDirty = true;
    markDirty();
  });

  ui.inspector.querySelectorAll("[data-pick-asset]").forEach((button) => {
    button.addEventListener("click", async (e) => {
      e.preventDefault();
      const picked = await pickImage();
      if (!picked) return;
      const input = ui.inspector.querySelector(`[data-field="${button.dataset.pickAsset}"]`);
      input.value = picked.site;
      input.dispatchEvent(new Event("input"));
    });
  });
}

function renderField(field, value) {
  const label = escapeHTML(t("f_" + field.key, field.label));
  const id = "ed-f-" + field.key;

  if (field.type === "area") {
    return `<label class="ed-field" for="${id}"><span>${label}</span>
      <textarea id="${id}" data-field="${field.key}" rows="3">${escapeHTML(value || "")}</textarea></label>`;
  }
  if (field.type === "list") {
    const text = Array.isArray(value) ? value.join(", ") : value || "";
    return `<label class="ed-field" for="${id}"><span>${label}</span>
      <input id="${id}" data-field="${field.key}" data-type="list" value="${escapeHTML(text)}" placeholder="${escapeHTML(t("comma_separated", "comma separated"))}"></label>`;
  }
  if (field.type === "toggle") {
    const on = String(value) === "true";
    return `<label class="ed-field ed-field-toggle" for="${id}"><span>${label}</span>
      <input id="${id}" type="checkbox" data-field="${field.key}"${on ? " checked" : ""}></label>`;
  }
  if (field.type === "asset") {
    return `<label class="ed-field ed-field-asset" for="${id}"><span>${label}</span>
      <span class="ed-field-row">
        <input id="${id}" data-field="${field.key}" value="${escapeHTML(value || "")}">
        <button type="button" data-pick-asset="${field.key}" title="${escapeHTML(t("choose", "Choose"))}"><i class="fa-solid fa-image"></i></button>
      </span></label>`;
  }
  return `<label class="ed-field" for="${id}"><span>${label}</span>
    <input id="${id}" data-field="${field.key}" value="${escapeHTML(value || "")}"></label>`;
}

/* ─── assets ───────────────────────────────────────────────────────────────── */

/**
 * Where a picture lives while the editor shows it.
 *
 * The build transcodes every bitmap to AVIF and withdraws the original's route,
 * so `/images/x.png` is not published — `/build/images/x.avif` is. An image
 * added in this session has neither, and rides a blob URL until its commit.
 */
function resolveAsset(src) {
  const value = String(src || "");
  if (!value) return "";
  if (/^(blob:|data:|https?:)/i.test(value)) return value;

  const pending = state.pending.find((a) => a.site === value || a.path === value);
  if (pending) return pending.url;

  const root = String((window.config && window.config.root) || "/").replace(/\/+$/, "");
  const rel = value.replace(/^\//, "").replace(/^source\//, "");
  if (/\.(png|jpe?g|gif|webp)$/i.test(rel)) {
    return `${root}/build/${rel.replace(/\.[^.]+$/, ".avif")}`;
  }
  return `${root}/${rel}`;
}

/** Read files off disk, hold them as blobs, and queue them for the next commit. */
function pickImage() {
  return new Promise((resolve) => {
    ui.file.value = "";
    ui.file.onchange = async () => {
      const file = ui.file.files && ui.file.files[0];
      if (!file) return resolve(null);
      resolve(await stageImage(file));
    };
    ui.file.click();
  });
}

async function stageImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const path = await gitea.assetPath(file.name, bytes);
  const site = "/" + path.replace(/^source\//, "");

  const existing = state.pending.find((a) => a.path === path);
  if (existing) return existing;

  const asset = { path, site, bytes, url: URL.createObjectURL(file), name: file.name };
  state.pending.push(asset);
  markDirty();
  return asset;
}

/* ─── dirty / save ─────────────────────────────────────────────────────────── */

function markDirty() {
  state.dirty = true;
  syncActions();
  setStatus("typing", t("unsaved", "Unsaved changes"));

  clearTimeout(state.stashTimer);
  state.stashTimer = setTimeout(() => {
    readAll();
    session.stash(state.doc, state.active && state.active.grant);
  }, AUTOSTASH_MS);
}

function syncActions() {
  const open = !!state.doc;
  ui.save.disabled = !open || !state.dirty || state.saving;
  ui.publish.disabled = !open || state.saving;
  ui.publish.hidden = false;
}

function readAll() {
  for (const view of state.views) if (view.read) view.read();
}

async function doSave(mode) {
  if (!state.doc || state.saving) return;
  readAll();

  state.saving = true;
  syncActions();
  setStatus("saving", t("saving", "Saving"));
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
    setStatus("saved", t("saved", "Saved") + " " + result.short);
    startProgress(result, mode);
    await refreshList(result.path);
  } catch (err) {
    setStatus("error", err.message);
    if (err.kind === "conflict") {
      notice(
        "error",
        `<i class="fa-solid fa-code-branch"></i><div><strong>${escapeHTML(t("conflict", "This file changed in the repository"))}</strong>
         <p>${escapeHTML(t("conflict_hint", "Your text is safe here. Open the post again in a new tab to see what landed, then re-apply your changes."))}</p></div>`
      );
    } else {
      notice("error", `<i class="fa-solid fa-circle-exclamation"></i>${escapeHTML(err.message)}`);
    }
  } finally {
    state.saving = false;
    syncActions();
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

function startProgress(result, mode) {
  clearInterval(progressTimer);
  ui.progress.hidden = false;
  ui.progress.innerHTML = STAGES.map(
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
    ticks += 1;
    if (ticks > 100) return clearInterval(progressTimer);

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
      // Vercel is downstream of a push this Worker never sees, so the last
      // stage is optimistic by design: the artifact is out of our hands.
      setTimeout(() => mark("deployed", "done"), 20000);
    } else if (run.conclusion === "failure" || run.conclusion === "cancelled") {
      mark("building", "fail");
      clearInterval(progressTimer);
      notice("error", `<i class="fa-solid fa-triangle-exclamation"></i>${escapeHTML(t("build_failed", "The build failed. The post is committed; nothing published has changed."))}`);
    }
  }, 6000);
}

/* ─── wiring ───────────────────────────────────────────────────────────────── */

function wire() {
  ui.list.addEventListener("click", (e) => {
    const row = e.target.closest(".ed-doc");
    if (!row) return;
    const entry = state.entries.find((x) => x.path === row.dataset.path);
    if (entry) openEntry(entry);
  });

  ui.filter.addEventListener("input", paintList);

  ui.outline.addEventListener("click", (e) => {
    const row = e.target.closest("[data-id]");
    if (!row) return;
    const view = state.views[indexOf(row.dataset.id)];
    if (view) view.el.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  ui.newBtn.addEventListener("click", async () => {
    const title = window.prompt(t("new_post_title", "Title for the new post"));
    if (!title) return;
    setStatus("saving", t("creating", "Creating"));
    try {
      const result = await session.create(title.trim());
      setStatus("saved", result.short);
      await refreshList(result.path);
    } catch (err) {
      setStatus("error", err.message);
      notice("error", `<i class="fa-solid fa-circle-exclamation"></i>${escapeHTML(err.message)}`);
    }
  });

  ui.save.addEventListener("click", () => doSave("draft"));

  ui.publish.addEventListener("click", () => {
    const entry = state.active || {};
    const question = entry.draft
      ? t("publish_draft", "Publish this draft over the post it replaces?")
      : t("publish_direct", "Commit this straight to the published post?");
    if (window.confirm(question)) doSave("publish");
  });

  ui.canvas.addEventListener("paste", async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      e.preventDefault();
      const asset = await stageImage(item.getAsFile());
      const target = state.focused ? state.focused.block.id : null;
      insertBlock(makeBlock("image", { src: asset.site, alt: "" }), target, false);
      return;
    }
  });

  ui.canvas.addEventListener("dragover", (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
  });
  ui.canvas.addEventListener("drop", async (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    e.preventDefault();
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const asset = await stageImage(file);
      insertBlock(makeBlock("image", { src: asset.site, alt: "" }), null, false);
    }
  });

  // Named, not inline: the editor re-initialises on every Swup arrival, and
  // addEventListener only de-duplicates a listener it can compare by identity.
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("beforeunload", onLeave);
  wireDrop();
}

function onSelectionChange() {
  if (!ui || !ui.toolbar || !ui.canvas.isConnected) return;
  if (ui.canvas.contains(document.activeElement)) ui.toolbar.sync();
}

function onKey(e) {
  if (!state.root || !document.body.contains(state.root)) return;

  if (ui.slash && ui.slash.key(e)) return;

  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;

  if (e.key === "s") {
    e.preventDefault();
    return void doSave("draft");
  }
  if (!ui.canvas.contains(document.activeElement)) return;

  if (e.key === "b") {
    e.preventDefault();
    return void ui.toolbar.applyMark("strong");
  }
  if (e.key === "i") {
    e.preventDefault();
    return void ui.toolbar.applyMark("em");
  }
  if (e.key === "k") {
    e.preventDefault();
    return void ui.toolbar.applyMark("link");
  }
}

function onLeave(e) {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = "";
}

/* ─── boot ─────────────────────────────────────────────────────────────────── */

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

export async function initEditor() {
  const root = document.getElementById("blog-editor");
  if (!root) return;

  // A Swup arrival brings a fresh #blog-editor but leaves whatever the last
  // visit put on document.body.
  teardownEditor();

  state.root = root;
  ui = paintShell(root);

  const ctx = {
    t,
    onInsert: (key) => insertFromCatalogue(key, null),
    onPick: (item, host) => insertFromCatalogue(item.key, host),
    onMore: (anchor) => openMoreMenu(anchor, { t, onInsert: (key) => insertFromCatalogue(key, null) }),
    onMarked: () => {
      if (state.focused) {
        state.focused.touch();
        state.focused.read();
      }
    },
    ownsSelection: (sel) => ui.canvas.contains(sel.anchorNode),
    link_url: t("link_url", "Link URL"),
  };

  ui.toolbar = createToolbar(ctx);
  ui.slash = createSlashMenu(ctx);
  root.querySelector(".ed-main").insertBefore(ui.toolbar.el, root.querySelector(".ed-progress"));

  wire();
  setStatus("saving", t("checking", "Checking your session"));

  try {
    await gitea.getTicket(true);
  } catch (err) {
    root.dataset.phase = err.message === "forbidden" ? "denied" : "error";
    setStatus("error", err.message);
    notice(
      "error",
      `<i class="fa-solid fa-lock"></i>${escapeHTML(
        err.message === "forbidden"
          ? t("denied", "This page is for the blog's administrator.")
          : t("unreachable", "Could not reach the backend.")
      )}`
    );
    return;
  }

  // The emitters have to be in hand before the first block paints, or a note
  // would render once as its fallback and again as itself.
  await loadComponents();

  root.dataset.phase = "ready";
  setStatus("idle");
  await refreshList();
}

export function teardownEditor() {
  clearInterval(progressTimer);
  clearTimeout(state.stashTimer);
  document.removeEventListener("selectionchange", onSelectionChange);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("beforeunload", onLeave);
  for (const asset of state.pending) URL.revokeObjectURL(asset.url);
  state.pending = [];
  document.querySelectorAll(".ed-slash, .ed-more-menu, .ed-icon-picker").forEach((el) => el.remove());
  state.root = null;
  state.doc = null;
  state.views = [];
  state.focused = null;
  state.dirty = false;
}
