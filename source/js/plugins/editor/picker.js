/**
 * The picture browser.
 *
 * Every way of naming an image — a block's address, a replacement, the cover,
 * the thumbnail, the banner — is this one control: a file manager over the
 * repository's picture roots, tree on the left, the picture on the right, and
 * along the bottom the one field that is both "what is chosen" and "search for
 * something else".
 *
 * ── Why the tree is built once and then mutated ─────────────────────────────
 *
 * A tree that re-renders on every click cannot animate: the node that was
 * opening is a different element by the time the frame lands, so the transition
 * restarts from nothing and the whole panel flickers. So the DOM is built once
 * from the listing and every action after that MOVES nodes — a rename rewrites
 * one label, a drag re-parents one subtree, a new folder inserts one node. Open
 * and closed is a `grid-template-rows: 0fr → 1fr` transition on the child
 * container, which needs no measurement and stays smooth however deep it nests.
 *
 * The dialogue is a FIXED size. A panel that resizes as its contents change is
 * a panel that jumps under the pointer between one click and the next, and the
 * two things inside it that vary most — a deep tree and a tall picture — are
 * exactly the two that would do it.
 *
 * ── Where the tree comes from, and when a change is real ────────────────────
 *
 * The listing is Gitea's, read live, so it is the truth rather than a cache of
 * it. Tidying is NOT: a rename, a move or a new folder is held here and travels
 * with the post's own commit, so one save is one commit and nothing is half
 * done if you close the tab. Git has no empty directories, so a new folder is
 * local until a picture lands in it — which is also the only moment it could
 * have been committed.
 *
 * A rename rewrites the addresses in the post being edited, and nothing else.
 * The file itself is not moved by the commit and no other post is touched by
 * it: `save` writes `source/_data/image-moves.json`, and the build moves the
 * pictures and rewrites the rest of the site from it. Both halves of that are
 * about size — finding every post that used the old name would mean pulling the
 * whole site into the browser, and moving the files here would mean pushing
 * every one of them back up as base64.
 *
 * Nothing here is a browser prompt. A name is typed where the name is read.
 */

import { escapeHTML } from "./markdown.js";
import * as gitea from "./gitea.js";
import { EASE, MORPH_MS, createEdgeScroll, pop, setDragImage } from "./motion.js";

// Every place in the repository that holds pictures. Two trees, side by side in
// one sidebar: an album's photographs are pictures the author owns exactly as
// much as an article's, and a browser that could not see them meant the only way
// to put one in a post was to type its path.
const ROOTS = ["source/images", "source/masonry"];
const isRoot = (path) => ROOTS.includes(path);

/** Which root this path lives under, or "" when it is outside all of them. */
function rootOf(path) {
  const value = String(path || "");
  return ROOTS.find((root) => value === root || value.startsWith(root + "/")) || "";
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const MENU_MAX = 40;
const SPLIT_KEY = "rdfx.picker.split";
// The width the panel stops being two columns, matching $media-max-width.
const STACK_AT = 768;

/* ─── the page behind a dialogue does not scroll ───────────────────────────── */

/**
 * The image viewer's own lock, verbatim: `documentElement.style.overflow`, set
 * on open and cleared on close. Counted, because the property sheet can open
 * over the browser and closing the inner one must not unlock the page under the
 * outer one.
 */
let locks = 0;

function lockPage() {
  if (locks++ === 0) document.documentElement.style.overflow = "hidden";
}

function unlockPage() {
  if (locks > 0 && --locks === 0) document.documentElement.style.overflow = "";
}

/** `source/images/a/b.png` → `/images/a/b.png`, which is what markdown wants. */
export function siteAddress(path) {
  return "/" + String(path || "").replace(/^source\//, "");
}

function parentOf(path) {
  const cut = String(path).lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

function nameOf(path) {
  return String(path).split("/").pop();
}

function safeName(name) {
  return String(name).replace(/[\\/]/g, "-").replace(/^\.+/, "").trim();
}

function readableSize(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

/* ─── what the repository holds, read once per session ─────────────────────── */

let treeCache = null;

async function walk(dir, out, depth, step) {
  if (depth > 6) return out;
  let rows = [];
  try {
    rows = await gitea.list(dir);
  } catch (err) {
    return out;
  }
  const dirs = [];
  for (const row of rows) {
    if (row.type === "dir") {
      out.push({ path: row.path, type: "dir" });
      dirs.push(row.path);
    } else if (IMAGE.test(row.name)) {
      out.push({ path: row.path, type: "file", size: row.size || 0, sha: row.sha });
    }
  }
  if (step) step(out.length);
  // Serial rather than parallel: a browser-held token is one token, and forty
  // simultaneous listings is how it gets rate-limited.
  for (const child of dirs) await walk(child, out, depth + 1, step);
  return out;
}

/** @param {function} step called after each listing, with the count so far */
export async function loadTree(force, step) {
  if (treeCache && !force) return treeCache;
  const out = [];
  for (const root of ROOTS) {
    out.push({ path: root, type: "dir" });
    await walk(root, out, 0, step);
  }
  treeCache = out;
  return treeCache;
}

export function forgetTree() {
  treeCache = null;
}

/* ─── the staged tidy-up ───────────────────────────────────────────────────── */

/**
 * Renames, moves and new folders, held until the post is saved.
 *
 * `moves` is ordered and each entry is `{ from, to }`; applying them in order to
 * a repository path gives where that file will be. A file moved twice collapses
 * to one move, because what the note needs is a from and a to.
 *
 * A saved move is NOT forgotten — it is marked `noted`. The commit carried the
 * request, not the file; the build is what renames it, and until that build has
 * run the repository still answers to the old name. So the mapping has to
 * outlive the save: it is what keeps the tree showing the names the author gave
 * and what lets `liveAddress` fetch a picture from where its bytes still are.
 * `dirty` therefore counts only what has not been noted yet.
 */
export function createStage() {
  const moves = [];
  const folders = new Set();

  return {
    moves,
    folders,
    get dirty() {
      return moves.some((move) => !move.noted);
    },
    /** Everything staged is now in the build's note. Kept, never committed twice. */
    settle() {
      for (const move of moves) move.noted = true;
    },
    /** Where `path` ends up once everything staged has been applied. */
    resolve(path) {
      let now = String(path || "");
      for (const move of moves) {
        if (now === move.from) now = move.to;
        else if (now.startsWith(move.from + "/")) now = move.to + now.slice(move.from.length);
      }
      return now;
    },
    /** Where the file now at `path` STARTED, which is what git has to be told. */
    origin(path) {
      let now = String(path || "");
      for (let i = moves.length - 1; i >= 0; i--) {
        const move = moves[i];
        if (now === move.to) now = move.from;
        else if (now.startsWith(move.to + "/")) now = move.from + now.slice(move.to.length);
      }
      return now;
    },
    move(from, to) {
      if (!from || !to || from === to) return;
      const start = this.origin(from);
      const existing = moves.find((m) => m.from === start);
      // A noted move has already been asked for and cannot be edited after the
      // fact — the build will carry it out from where it left off. Moving the
      // same picture again is a SECOND leg, from where the first one put it.
      if (existing && !existing.noted) existing.to = to;
      else moves.push({ from: existing ? existing.to : start, to });
      folders.delete(to.replace(/\/[^/]+$/, ""));
    },
    /** A folder that exists only here. Renaming one re-keys it in place. */
    folder(path) {
      if (path) folders.add(path);
    },
    renameFolder(from, to) {
      if (!folders.has(from)) return false;
      folders.delete(from);
      folders.add(to);
      for (const held of Array.from(folders)) {
        if (held.startsWith(from + "/")) {
          folders.delete(held);
          folders.add(to + held.slice(from.length));
        }
      }
      return true;
    },
    clear() {
      moves.length = 0;
      folders.clear();
    },
  };
}

/* ─── a question ───────────────────────────────────────────────────────────── */

/**
 * The small dialogue: one question, and its answers as buttons.
 *
 * Same frame as the browser and the property sheet, one size down. Everything
 * the editor used to ask through `window.confirm` asks here — which is not a
 * matter of taste: a native confirm has exactly two answers, and "you have
 * unsaved work" has three. Save it as a draft, publish it, or leave it behind.
 *
 * ONE filled button per question, always the last one, always the affirmative.
 * The others are plain. A dialogue with two coloured answers is a dialogue that
 * has not decided what it is recommending, and the editor was showing three.
 *
 * @param {object} opts { icon, title, message, note, actions, enter }
 *   `actions` is `[{ key, label, icon, kind }]`, `kind` being "primary" or
 *   nothing. `enter` names the key Enter answers with, defaulting to the
 *   primary — pass one explicitly wherever the primary is not safe to trigger
 *   with a keystroke.
 * @returns {Promise<string|null>} the chosen key, or null for dismissed
 */
export function openAsk(ctx, opts) {
  const t = ctx.t;
  const actions = opts.actions || [];
  const main = actions.find((a) => a.kind === "primary");
  const enter = opts.enter !== undefined ? opts.enter : main ? main.key : null;

  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "ed-picker-mask";
    mask.innerHTML = `
      <section class="ed-prompt" role="dialog" aria-modal="true">
        <header class="ed-picker-bar">
          <span class="ed-picker-name"><i class="fa-solid ${escapeHTML(opts.icon || "fa-circle-question")}" aria-hidden="true"></i>${escapeHTML(opts.title || "")}</span>
          <span class="ed-picker-acts">
            <button type="button" data-act="close" title="${escapeHTML(t("close", "Close"))}"><i class="fa-solid fa-xmark"></i></button>
          </span>
        </header>
        <div class="ed-prompt-body">
          ${escapeHTML(opts.message || "")}
          ${opts.note ? `<span class="ed-prompt-note">${escapeHTML(opts.note)}</span>` : ""}
        </div>
        <footer class="ed-picker-foot ed-prompt-foot">
          ${actions
            .map(
              (act) => `<button type="button" class="ed-act${act.kind === "primary" ? " ed-act-primary" : ""}" data-key="${escapeHTML(act.key)}">
                ${act.icon ? `<i class="fa-solid ${escapeHTML(act.icon)}" aria-hidden="true"></i>` : ""}<span>${escapeHTML(act.label)}</span>
              </button>`
            )
            .join("")}
        </footer>
      </section>`;

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      mask.remove();
      unlockPage();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        return finish(null);
      }
      if (e.key === "Enter" && enter) {
        e.preventDefault();
        finish(enter);
      }
    };

    mask.addEventListener("click", (e) => {
      if (e.target === mask || e.target.closest('[data-act="close"]')) return finish(null);
      const answer = e.target.closest("[data-key]");
      if (answer) finish(answer.dataset.key);
    });

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(mask);
    lockPage();
    pop(mask.querySelector(".ed-prompt"));
    const focus = (enter && mask.querySelector(`[data-key="${enter}"]`)) || mask.querySelector("[data-key]");
    if (focus) focus.focus();
  });
}

/* ─── waiting ──────────────────────────────────────────────────────────────── */

/**
 * The theme's own waiting card, `layout/components/access-probe.ejs`.
 *
 * The same object the encrypted post, the taxonomy gate and the management
 * console put up while a Worker decides what an identity may see — a breathing
 * badge, a line of text and a sweeping bar. Reading a repository over the
 * network is the same kind of wait, and it was showing a bare grey sentence
 * instead. The markup is repeated rather than imported because this dialogue is
 * built in the browser and that partial is rendered by the build; the styling
 * is shared, so the two cannot drift apart visually.
 */
function probeCard(icon, text) {
  return `
    <div class="access-probe" role="status">
      <div class="access-probe-lock"><i class="fa-solid ${escapeHTML(icon)}" aria-hidden="true"></i></div>
      <p class="access-probe-text">${escapeHTML(text)}</p>
      <div class="access-probe-bar"><span></span></div>
    </div>`;
}

/** Close anything this module has open, and release the page with it. */
export function closeDialogs() {
  const open = document.querySelectorAll(".ed-picker-mask");
  for (const mask of open) mask.remove();
  if (open.length) {
    locks = 0;
    document.documentElement.style.overflow = "";
  }
}

/* ─── a sheet of fields ────────────────────────────────────────────────────── */

/**
 * Everything a picture can be told about itself.
 *
 * Seventeen EXIF fields plus a title and a switch is not a toolbar row, and the
 * toolbar holds no fields anyway — so it is a sheet, opened from one button and
 * closed by one. Leaving every field empty is how a picture goes back to being
 * a plain `![alt](path)`.
 *
 * @param {Array} groups  [{ label, fields: [{key, label, kind}] }]
 * @returns {Promise<object|null>}
 */
export function openSheet(ctx, title, groups, values) {
  const t = ctx.t;

  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "ed-picker-mask";
    mask.innerHTML = `
      <section class="ed-sheet" role="dialog" aria-modal="true">
        <header class="ed-picker-bar">
          <span class="ed-picker-name"><i class="fa-solid fa-sliders" aria-hidden="true"></i>${escapeHTML(title)}</span>
          <span class="ed-picker-acts">
            <button type="button" data-act="close" title="${escapeHTML(t("close", "Close"))}"><i class="fa-solid fa-xmark"></i></button>
          </span>
        </header>
        <div class="ed-sheet-body">
          ${groups
            .map(
              (group) => `
            <div class="ed-sheet-group">
              <h3 class="ed-front-legend">${escapeHTML(group.label)}</h3>
              <div class="ed-front-grid">
                ${group.fields
                  .map((field) => {
                    const value = values[field.key];
                    if (field.kind === "toggle") {
                      return `<label class="ed-f" data-key="${escapeHTML(field.key)}">
                          <span class="ed-f-label">${escapeHTML(field.label)}</span>
                          <button type="button" class="ed-f-toggle${value === false ? "" : " is-on"}"
                            data-toggle="${escapeHTML(field.key)}" role="switch"
                            aria-checked="${value === false ? "false" : "true"}"></button>
                        </label>`;
                    }
                    return `<label class="ed-f${field.wide ? " is-wide" : ""}" data-key="${escapeHTML(field.key)}">
                        <span class="ed-f-label">${escapeHTML(field.label)}</span>
                        <input class="ed-f-input" data-key="${escapeHTML(field.key)}" spellcheck="false"
                          value="${escapeHTML(value == null ? "" : String(value))}">
                      </label>`;
                  })
                  .join("")}
              </div>
            </div>`
            )
            .join("")}
        </div>
        <footer class="ed-picker-foot">
          <span class="ed-picker-hint">${escapeHTML(t("sheet_hint", "Leave everything empty for a plain picture."))}</span>
          <button type="button" class="ed-act ed-act-primary ed-sheet-ok">
            <i class="fa-solid fa-check" aria-hidden="true"></i><span>${escapeHTML(t("apply", "Apply"))}</span>
          </button>
        </footer>
      </section>`;

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      mask.remove();
      unlockPage();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    };

    mask.addEventListener("click", (e) => {
      if (e.target === mask || e.target.closest('[data-act="close"]')) return finish(null);
      const toggle = e.target.closest("[data-toggle]");
      if (toggle) {
        e.preventDefault();
        const on = !toggle.classList.contains("is-on");
        toggle.classList.toggle("is-on", on);
        toggle.setAttribute("aria-checked", on ? "true" : "false");
      }
    });

    mask.querySelector(".ed-sheet-ok").addEventListener("click", () => {
      const out = {};
      for (const input of mask.querySelectorAll(".ed-f-input")) out[input.dataset.key] = input.value.trim();
      for (const toggle of mask.querySelectorAll("[data-toggle]")) {
        out[toggle.dataset.toggle] = toggle.classList.contains("is-on");
      }
      finish(out);
    });

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(mask);
    lockPage();
    pop(mask.querySelector(".ed-sheet"));
    const first = mask.querySelector(".ed-f-input");
    if (first) first.focus();
  });
}

/* ─── the search ───────────────────────────────────────────────────────────── */

/**
 * How well `text` answers `query`, or -1 for not at all.
 *
 * A subsequence match, which is what people expect of a file box — `ipst`
 * finds `images/posts` — with the weight on runs of adjacent characters and on
 * characters that start a word, so an exact fragment always outranks letters
 * scattered across a long path. Shorter paths win ties, and the basename is
 * scored separately because that is usually what is being typed.
 */
function scoreOne(text, query) {
  const hay = text.toLowerCase();
  let at = 0;
  let total = 0;
  let run = 0;

  for (const ch of query) {
    const found = hay.indexOf(ch, at);
    if (found < 0) return -1;
    run = found === at && at > 0 ? run + 1 : 0;
    total += 12 + run * 8;
    const before = found > 0 ? hay[found - 1] : "/";
    if (/[\/\-_. ]/.test(before)) total += 10;
    at = found + 1;
  }
  return total - hay.length * 0.2;
}

function searchScore(path, query) {
  const base = scoreOne(nameOf(path), query);
  const full = scoreOne(path, query);
  if (base < 0 && full < 0) return -1;
  return Math.max(base >= 0 ? base + 24 : -1, full);
}

/* ─── the dialogue ─────────────────────────────────────────────────────────── */

/**
 * @param {object} ctx   { t, stage, pending, upload }
 * @param {object} opts  { current }
 * @returns {Promise<{path: string, site: string} | null>}
 */
export function openPicker(ctx, opts = {}) {
  const t = ctx.t;

  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "ed-picker-mask";
    mask.innerHTML = `
      <section class="ed-picker" role="dialog" aria-modal="true">
        <header class="ed-picker-bar">
          <span class="ed-picker-name"><i class="fa-solid fa-images" aria-hidden="true"></i>${escapeHTML(t("pick_title", "Pictures"))}</span>
          <span class="ed-picker-acts">
            <button type="button" data-act="upload" title="${escapeHTML(t("pick_upload", "Add a picture"))}"><i class="fa-solid fa-arrow-up-from-bracket"></i></button>
            <button type="button" data-act="mkdir" title="${escapeHTML(t("pick_mkdir", "New folder"))}"><i class="fa-solid fa-folder-plus"></i></button>
            <button type="button" data-act="rename" title="${escapeHTML(t("pick_rename", "Rename"))}"><i class="fa-solid fa-i-cursor"></i></button>
            <button type="button" data-act="close" title="${escapeHTML(t("close", "Close"))}"><i class="fa-solid fa-xmark"></i></button>
          </span>
        </header>

        <div class="ed-pick-body">
          <div class="ed-pick-side" role="tree"></div>
          <div class="ed-pick-grip" role="separator" aria-orientation="vertical" tabindex="0"></div>
          <div class="ed-pick-view">
            <div class="ed-pick-stage"></div>
            <dl class="ed-pick-meta"></dl>
          </div>
        </div>

        <footer class="ed-pick-foot">
          <div class="ed-pick-field">
            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
            <input class="ed-pick-input" spellcheck="false" autocomplete="off"
                   placeholder="${escapeHTML(t("pick_search", "Search every folder"))}">
            <div class="ed-pick-menu" hidden></div>
          </div>
          <button type="button" class="ed-act ed-act-primary ed-pick-ok" disabled>
            <i class="fa-solid fa-check" aria-hidden="true"></i><span>${escapeHTML(t("pick_use", "Use this picture"))}</span>
          </button>
        </footer>
      </section>`;

    const card = mask.querySelector(".ed-picker");
    const body = mask.querySelector(".ed-pick-body");
    const side = mask.querySelector(".ed-pick-side");
    const grip = mask.querySelector(".ed-pick-grip");
    const stage = mask.querySelector(".ed-pick-stage");
    const meta = mask.querySelector(".ed-pick-meta");
    const field = mask.querySelector(".ed-pick-field");
    const input = mask.querySelector(".ed-pick-input");
    const menu = mask.querySelector(".ed-pick-menu");
    const ok = mask.querySelector(".ed-pick-ok");

    /** path → { el, row, kids, type, size, staged, fresh } */
    const nodes = new Map();
    let rows = [];
    let chosen = opts.current ? String(opts.current).replace(/^\//, "source/") : "";
    let searching = false;
    let cursor = 0;
    let hits = [];
    let done = false;

    /* ─── the model, with the staged tidy-up applied ───────────────────── */

    /**
     * What the tree holds once the staged tidy-up is applied.
     *
     * Files first, folders after — and a repository folder is kept only if a
     * file still resolves inside it. A folder whose contents were all moved out
     * is a folder git will not have either, and listing it would mean the tree
     * showed a place nothing could be in.
     */
    function model() {
      const seen = new Map();
      for (const root of ROOTS) seen.set(root, { path: root, type: "dir" });
      const here = [];

      for (const row of rows) {
        if (row.type !== "file") continue;
        const path = ctx.stage.resolve(row.path);
        seen.set(path, Object.assign({}, row, { path }));
        here.push(path);
      }
      // A picture added in this session is real to the author the moment it is
      // added, whatever the repository still says.
      for (const asset of ctx.pending || []) {
        const path = ctx.stage.resolve(asset.path);
        if (seen.has(path)) continue;
        seen.set(path, { path, type: "file", staged: true, size: asset.bytes ? asset.bytes.byteLength : 0 });
        here.push(path);
      }
      for (const row of rows) {
        if (row.type !== "dir" || isRoot(row.path) || seen.has(row.path)) continue;
        if (here.some((file) => file.startsWith(row.path + "/"))) seen.set(row.path, { path: row.path, type: "dir" });
      }
      for (const folder of ctx.stage.folders) {
        if (!seen.has(folder)) seen.set(folder, { path: folder, type: "dir", fresh: true });
      }
      return Array.from(seen.values());
    }

    function files() {
      const out = [];
      for (const [path, node] of nodes) if (node.type === "file") out.push(path);
      return out;
    }

    /* ─── building the tree, once ──────────────────────────────────────── */

    function rank(node) {
      return (node.type === "dir" ? "0" : "1") + nameOf(node.path).toLowerCase();
    }

    function makeNode(entry) {
      const isDir = entry.type === "dir";
      const el = document.createElement("div");
      el.className = "ed-pick-node";
      el.dataset.path = entry.path;
      el.dataset.type = entry.type;
      el.dataset.open = isDir && isRoot(entry.path) ? "1" : "0";

      el.innerHTML = `
        <div class="ed-pick-row" draggable="true" role="treeitem" data-on="0">
          ${isDir ? `<button type="button" class="ed-pick-twist" tabindex="-1"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>` : `<span class="ed-pick-twist is-leaf"></span>`}
          <i class="fa-solid ${isDir ? "fa-folder" : "fa-image"} ed-pick-icon" aria-hidden="true"></i>
          <span class="ed-pick-name"></span>
          ${entry.staged ? `<em class="ed-pick-flag">${escapeHTML(t("pick_new", "new"))}</em>` : ""}
          ${entry.fresh ? `<em class="ed-pick-flag">${escapeHTML(t("pick_unsaved", "unsaved"))}</em>` : ""}
        </div>
        ${isDir ? `<div class="ed-pick-kids"><div class="ed-pick-kids-in"></div></div>` : ""}`;

      const node = {
        el,
        row: el.querySelector(".ed-pick-row"),
        label: el.querySelector(".ed-pick-name"),
        kids: isDir ? el.querySelector(".ed-pick-kids-in") : null,
        type: entry.type,
        size: entry.size || 0,
        staged: !!entry.staged,
        fresh: !!entry.fresh,
      };
      node.label.textContent = nameOf(entry.path);
      nodes.set(entry.path, node);
      return node;
    }

    /** Put `node` among its siblings: folders first, then by name. */
    function place(path) {
      const node = nodes.get(path);
      const parent = nodes.get(parentOf(path));
      if (!node || !parent || !parent.kids) return;

      const key = rank({ type: node.type, path });
      const siblings = Array.from(parent.kids.children);
      const before = siblings.find((el) => {
        const other = nodes.get(el.dataset.path);
        return other && rank({ type: other.type, path: el.dataset.path }) > key;
      });
      if (before) parent.kids.insertBefore(node.el, before);
      else parent.kids.appendChild(node.el);
    }

    /** Create every folder on the way to `path` that is not there yet. */
    function ensureBranch(path) {
      if (!path || isRoot(path) || !rootOf(path) || nodes.has(path)) return;
      ensureBranch(parentOf(path));
      makeNode({ path, type: "dir" });
      place(path);
    }

    function mount() {
      nodes.clear();
      side.innerHTML = "";

      for (const path of ROOTS) {
        const root = makeNode({ path, type: "dir" });
        side.appendChild(root.el);
        root.row.classList.add("is-root");
      }

      for (const entry of model().sort((a, b) => a.path.localeCompare(b.path))) {
        if (isRoot(entry.path)) continue;
        ensureBranch(parentOf(entry.path));
        if (!nodes.has(entry.path)) {
          makeNode(entry);
          place(entry.path);
        }
      }
    }

    /* ─── selection, revealing, preview ────────────────────────────────── */

    function open(path, on) {
      const node = nodes.get(path);
      if (node && node.type === "dir") node.el.dataset.open = on ? "1" : "0";
    }

    function reveal(path) {
      let cur = parentOf(path);
      while (cur && rootOf(cur)) {
        open(cur, true);
        cur = parentOf(cur);
      }
      const node = nodes.get(path);
      if (node) node.row.scrollIntoView({ block: "nearest" });
    }

    function paintSelection() {
      for (const [path, node] of nodes) node.row.dataset.on = path === chosen ? "1" : "0";
    }

    function paintPath(animate) {
      if (document.activeElement === input && searching) return;
      input.value = chosen ? siteAddress(chosen) : "";
      if (animate) field.animate(
        [{ opacity: 0.35, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }],
        { duration: 180, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }
      );
    }

    /** `key` keeps the row in place while its value is still being found out. */
    function metaRow(label, value, key) {
      if (!value && !key) return "";
      return `<dt>${escapeHTML(label)}</dt><dd${key ? ` data-field="${key}"` : ""}>${escapeHTML(value || "")}</dd>`;
    }

    /**
     * The preview: one `<img>`, and nothing wrapped around it.
     *
     * It used to mount the article's `.img-preloader` and hand it to the
     * article's lazyload observer, which built an `<img>` inside it — three
     * layers and an IntersectionObserver for a picture the author has just
     * clicked on, with nothing to defer and nothing to be lazy about. The
     * nesting is also what made the size uncontrollable: the caps landed on the
     * wrapper while the picture inside sized itself.
     *
     * Then the wrapper became a grid with a centred item, which is the same bug
     * wearing different clothes — a grid item in an auto-sized row IS the row,
     * so `max-height: 100%` was a percentage of the picture's own height and
     * silently meant nothing. The picture stood full height inside a box that
     * cropped it. It is a flex column now: see `.ed-pick-stage`.
     *
     * `naturalSize` gives the intrinsic pixels, which go on as `width`/`height`
     * attributes so the box is the picture's shape before a byte arrives and as
     * `--shot-w` so a small picture is never blown up; `bindImage` keeps the
     * resolution rules — a staged upload's blob, a sealed image's decrypted
     * bytes, and the repository fallback for a picture committed minutes ago
     * that the site has not published yet.
     */
    let shotSize = null;

    function paintPreview() {
      ok.disabled = !chosen || !IMAGE.test(chosen);
      shotSize = null;
      stage.innerHTML = "";
      stage.style.removeProperty("--shot-w");
      meta.innerHTML = "";

      if (!chosen || !IMAGE.test(chosen)) {
        stage.dataset.empty = "1";
        stage.innerHTML = `<p class="ed-pick-blank"><i class="fa-solid fa-images" aria-hidden="true"></i>${escapeHTML(
          t("pick_hint", "Choose a picture, or drag one onto a folder to move it.")
        )}</p>`;
        return;
      }
      delete stage.dataset.empty;

      const node = nodes.get(chosen);
      const origin = ctx.stage.origin(chosen);
      const address = siteAddress(chosen);

      shotSize = ctx.naturalSize(address);
      const shot = document.createElement("img");
      shot.alt = nameOf(chosen);
      shot.dataset.ready = "0";
      if (shotSize && shotSize.width && shotSize.height) {
        shot.width = shotSize.width;
        shot.height = shotSize.height;
        stage.style.setProperty("--shot-w", shotSize.width + "px");
      } else {
        // The build never measured this one — a picture no page has referenced
        // yet, or one it declined to transcode. Without a box the `<img>` is
        // nothing until the bytes land and then snaps to full height, which on
        // a slow fetch is the whole pane jumping under the pointer. A neutral
        // 3:2 holds the space and the real shape is TRAVELLED to on load.
        shot.dataset.guessed = "1";
        shot.style.width = "100%";
        shot.style.aspectRatio = "3 / 2";
      }
      shot.addEventListener("load", () => {
        shot.dataset.ready = "1";
        if (shot.dataset.guessed !== "1" || !shot.naturalWidth) return;
        const before = shot.offsetHeight;
        shot.style.aspectRatio = `${shot.naturalWidth} / ${shot.naturalHeight}`;
        stage.style.setProperty("--shot-w", shot.naturalWidth + "px");
        const after = shot.offsetHeight;
        if (before && after && before !== after) {
          shot.animate([{ height: before + "px" }, { height: after + "px" }], { duration: MORPH_MS, easing: EASE });
        }
        const row = meta.querySelector('[data-field="dims"]');
        if (row) row.textContent = `${shot.naturalWidth} × ${shot.naturalHeight}`;
      }, { once: true });
      // A picture that cannot be fetched at all stops shimmering rather than
      // promising forever. `bindImage`'s repository retry re-points `src`, and a
      // retry that works fires `load` and puts it back.
      shot.addEventListener("error", () => (shot.dataset.ready = "err"));
      stage.appendChild(shot);
      ctx.bindImage(shot, address);

      meta.innerHTML =
        metaRow(t("pick_name", "Name"), nameOf(chosen)) +
        metaRow(t("pick_where", "Folder"), parentOf(chosen).replace(/^source\//, "/")) +
        metaRow(t("pick_dims", "Size"), shotSize ? `${shotSize.width} × ${shotSize.height}` : "", "dims") +
        metaRow(t("pick_bytes", "File"), readableSize(node && node.size)) +
        (origin === chosen ? "" : metaRow(t("pick_moved", "Moving from"), siteAddress(origin)));
    }

    function select(path, animate) {
      chosen = path;
      paintSelection();
      paintPath(animate !== false);
      paintPreview();
    }

    /* ─── the search menu ──────────────────────────────────────────────── */

    function paintMenu() {
      // The field holds the chosen file's address when nothing has been typed,
      // and that is not a query — it would filter the list down to the one
      // thing already chosen, which is the one thing nobody is looking for.
      const raw = input.value.trim();
      const query = raw && raw !== siteAddress(chosen) ? raw.toLowerCase().replace(/^\//, "") : "";
      const all = files();

      hits = (query
        ? all
            .map((path) => ({ path, score: searchScore(path.replace(/^source\//, ""), query) }))
            .filter((hit) => hit.score >= 0)
            .sort((a, b) => b.score - a.score)
        : all.sort().map((path) => ({ path, score: 0 }))
      ).slice(0, MENU_MAX);

      if (cursor >= hits.length) cursor = Math.max(0, hits.length - 1);

      menu.innerHTML = hits.length
        ? hits
            .map(
              (hit, i) =>
                `<button type="button" class="ed-pick-hit" data-path="${escapeHTML(hit.path)}" data-on="${i === cursor ? "1" : "0"}">
                   <i class="fa-solid fa-image" aria-hidden="true"></i>
                   <span class="ed-pick-hit-name">${escapeHTML(nameOf(hit.path))}</span>
                   <span class="ed-pick-hit-dir">${escapeHTML(parentOf(hit.path).replace(/^source\//, "/"))}</span>
                 </button>`
            )
            .join("")
        : `<p class="ed-pick-blank">${escapeHTML(t("pick_none", "Nothing here yet"))}</p>`;
    }

    function openMenu() {
      searching = true;
      cursor = 0;
      paintMenu();
      if (menu.hidden) {
        menu.hidden = false;
        pop(menu);
      }
    }

    function closeMenu(restore) {
      searching = false;
      menu.hidden = true;
      if (restore !== false) paintPath(false);
    }

    function takeHit() {
      const hit = hits[cursor];
      if (!hit) return;
      closeMenu();
      reveal(hit.path);
      select(hit.path);
    }

    /* ─── renaming, in place ───────────────────────────────────────────── */

    let renaming = "";

    function beginRename(path) {
      const node = nodes.get(path);
      if (!node || isRoot(path) || renaming) return;
      renaming = path;

      const was = nameOf(path);
      node.label.contentEditable = "true";
      node.label.spellcheck = false;
      node.row.dataset.editing = "1";
      node.label.focus();
      document.execCommand("selectAll", false, null);

      const stop = (commit) => {
        if (renaming !== path) return;
        renaming = "";
        node.label.contentEditable = "false";
        delete node.row.dataset.editing;
        node.label.removeEventListener("keydown", onKeys);
        node.label.removeEventListener("blur", onBlur);

        const next = safeName(node.label.textContent);
        if (!commit || !next || next === was) {
          node.label.textContent = was;
          return;
        }
        node.label.textContent = next;
        applyMove(path, parentOf(path) + "/" + next);
      };

      const onKeys = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          stop(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          stop(false);
        }
      };
      const onBlur = () => stop(true);

      node.label.addEventListener("keydown", onKeys);
      node.label.addEventListener("blur", onBlur);
    }

    /* ─── moving, which is also what a rename is ───────────────────────── */

    /**
     * Re-key this node and everything under it, then re-parent the element.
     *
     * A folder move is recorded as its FILES moving, one entry each. Git has no
     * directories to move — a commit that named one would be a commit Gitea
     * refuses — and the address rewriting downstream wants file paths anyway.
     * A folder that exists only in this session has no files to record, so it is
     * simply re-keyed in place.
     */
    function applyMove(from, to) {
      if (!from || !to || from === to || nodes.has(to)) return;

      const node = nodes.get(from);
      if (!node) return;

      const affected = Array.from(nodes.keys()).filter((p) => p === from || p.startsWith(from + "/"));
      ctx.stage.renameFolder(from, to);
      for (const path of affected) {
        const held = nodes.get(path);
        if (held && held.type === "file") ctx.stage.move(path, to + path.slice(from.length));
      }

      const moved = new Map();
      for (const path of affected) {
        moved.set(to + path.slice(from.length), nodes.get(path));
        nodes.delete(path);
      }
      for (const [path, held] of moved) {
        nodes.set(path, held);
        held.el.dataset.path = path;
      }

      node.label.textContent = nameOf(to);
      ensureBranch(parentOf(to));
      place(to);
      open(parentOf(to), true);

      if (chosen === from || chosen.startsWith(from + "/")) select(to + chosen.slice(from.length));
      else paintPath(false);
    }

    /* ─── acting on it ─────────────────────────────────────────────────── */

    /** Where a new picture or folder goes: the selected folder, or the default. */
    function currentDir() {
      const node = chosen && nodes.get(chosen);
      if (node) return node.type === "dir" ? chosen : parentOf(chosen) || ROOTS[0];
      const posts = ROOTS[0] + "/posts";
      return nodes.has(posts) ? posts : ROOTS[0];
    }

    function addNode(entry) {
      ensureBranch(parentOf(entry.path));
      if (!nodes.has(entry.path)) {
        makeNode(entry);
        place(entry.path);
      }
      open(parentOf(entry.path), true);
    }

    async function onAct(act) {
      if (act === "close") return finish(null);

      if (act === "upload") {
        const file = await pickFile();
        if (!file) return;
        const asset = await ctx.upload(file, currentDir());
        if (!asset) return;
        const path = ctx.stage.resolve(asset.path);
        addNode({ path, type: "file", staged: true, size: asset.bytes ? asset.bytes.byteLength : 0 });
        reveal(path);
        return void select(path);
      }

      if (act === "mkdir") {
        const base = currentDir();
        let name = t("pick_folder", "New folder");
        let n = 2;
        while (nodes.has(`${base}/${name}`)) name = `${t("pick_folder", "New folder")} ${n++}`;
        const path = `${base}/${name}`;
        ctx.stage.folder(path);
        addNode({ path, type: "dir", fresh: true });
        reveal(path);
        select(path);
        return void beginRename(path);
      }

      if (act === "rename") {
        if (chosen && !isRoot(chosen)) beginRename(chosen);
      }
    }

    function pickFile() {
      return new Promise((res) => {
        const el = document.createElement("input");
        el.type = "file";
        el.accept = "image/*";
        el.hidden = true;
        document.body.appendChild(el);
        el.addEventListener("change", () => {
          const file = el.files && el.files[0];
          el.remove();
          res(file || null);
        });
        el.click();
      });
    }

    function finish(value) {
      if (done) return;
      done = true;
      scroller.stop();
      mask.remove();
      unlockPage();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    }

    function onKey(e) {
      if (e.key !== "Escape" || renaming) return;
      if (!menu.hidden) {
        e.preventDefault();
        input.blur();
        return void closeMenu();
      }
      e.preventDefault();
      finish(null);
    }

    /* ─── wiring ───────────────────────────────────────────────────────── */

    mask.addEventListener("click", (e) => {
      if (e.target === mask) return finish(null);
      const act = e.target.closest("[data-act]");
      if (act && card.contains(act)) {
        e.preventDefault();
        return void onAct(act.dataset.act);
      }
    });

    side.addEventListener("click", (e) => {
      const row = e.target.closest(".ed-pick-row");
      if (!row || row.dataset.editing) return;
      e.preventDefault();
      const path = row.parentElement.dataset.path;
      const node = nodes.get(path);
      if (node && node.type === "dir") {
        // Clicking the row selects the folder; only the chevron folds it, so a
        // click meant for "put the next picture here" never closes the branch.
        if (e.target.closest(".ed-pick-twist") || path === chosen) {
          open(path, node.el.dataset.open !== "1");
        } else {
          open(path, true);
        }
      }
      select(path);
    });

    side.addEventListener("dblclick", (e) => {
      const row = e.target.closest(".ed-pick-row");
      if (!row) return;
      const path = row.parentElement.dataset.path;
      const node = nodes.get(path);
      if (node && node.type === "file") finish({ path, site: siteAddress(path) });
    });

    ok.addEventListener("click", () => {
      if (!chosen || !IMAGE.test(chosen)) return;
      finish({ path: chosen, site: siteAddress(chosen) });
    });

    /* The one field: what is chosen, and the way to look for something else. */
    input.addEventListener("focus", () => {
      input.select();
      openMenu();
    });
    input.addEventListener("input", openMenu);
    input.addEventListener("blur", () => setTimeout(() => closeMenu(), 120));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (menu.hidden) return void openMenu();
        cursor = Math.max(0, Math.min(hits.length - 1, cursor + (e.key === "ArrowDown" ? 1 : -1)));
        paintMenu();
        const on = menu.querySelector('[data-on="1"]');
        if (on) on.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        takeHit();
      }
    });

    menu.addEventListener("mousedown", (e) => e.preventDefault());
    menu.addEventListener("click", (e) => {
      const hit = e.target.closest("[data-path]");
      if (!hit) return;
      closeMenu();
      reveal(hit.dataset.path);
      select(hit.dataset.path);
    });

    /* ─── dragging, the way a block is dragged ─────────────────────────── */

    /**
     * The same gesture as the canvas: the carried row fades, the browser draws a
     * clipped clone of it, an insertion line says exactly where it will land,
     * and holding near an edge scrolls the tree.
     *
     * A tree has one more thing to say than a list does — WHICH FOLDER — so the
     * folder that will receive it is ringed while the line marks the position
     * inside it. Both are the article's own drop styling; a second visual
     * language for the same gesture is how a control stops feeling like part of
     * the same program.
     */
    let dragging = "";
    let dropAt = "";
    const scroller = createEdgeScroll(side);

    /** Which folder the pointer is over: a file means the folder holding it. */
    function dropFolder(e) {
      const row = e.target.closest(".ed-pick-row");
      if (!row) return ROOTS[0];
      const path = row.parentElement.dataset.path;
      const node = nodes.get(path);
      return node && node.type === "dir" ? path : parentOf(path) || ROOTS[0];
    }

    function canDrop(target) {
      if (!dragging || !target) return false;
      if (target === dragging) return false;
      if ((target + "/").startsWith(dragging + "/")) return false;
      return parentOf(dragging) !== target;
    }

    /** Where inside `target` the carried row will be, once it is sorted in. */
    function landing(target) {
      const holder = nodes.get(target);
      if (!holder || !holder.kids) return null;
      const key = rank({ type: nodes.get(dragging).type, path: dragging });
      const rows = Array.from(holder.kids.children).filter((el) => el.dataset.path !== dragging);
      const before = rows.find((el) => {
        const other = nodes.get(el.dataset.path);
        return other && rank({ type: other.type, path: el.dataset.path }) > key;
      });
      return { holder, before: before || null, last: rows[rows.length - 1] || null };
    }

    function paintDrop(target) {
      const key = target || "";
      if (key === dropAt) return;
      dropAt = key;

      for (const el of side.querySelectorAll("[data-drop], [data-into]")) {
        delete el.dataset.drop;
        delete el.dataset.into;
      }
      if (!target) return;

      const holder = nodes.get(target);
      if (holder) holder.row.dataset.into = "1";

      const spot = landing(target);
      if (!spot) return;
      if (spot.before) spot.before.dataset.drop = "before";
      else if (spot.last) spot.last.dataset.drop = "after";
      else if (holder) holder.row.dataset.drop = "empty";
    }

    side.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".ed-pick-row");
      if (!row || row.dataset.editing) return;
      const path = row.parentElement.dataset.path;
      if (isRoot(path)) return;
      dragging = path;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragging);
      // The clipped clone the blocks use, so the ghost is the row rather than
      // whatever the pointer happened to be over inside it.
      setDragImage(e, row);
      row.dataset.carry = "1";
    });

    side.addEventListener("dragover", (e) => {
      if (!dragging) return;
      const target = dropFolder(e);
      scroller.track(e.clientY);
      if (!canDrop(target)) return void paintDrop("");
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      paintDrop(target);
    });

    side.addEventListener("dragleave", (e) => {
      if (dragging && !side.contains(e.relatedTarget)) paintDrop("");
    });

    side.addEventListener("drop", (e) => {
      if (!dragging) return;
      const target = dropFolder(e);
      paintDrop("");
      scroller.stop();
      if (!canDrop(target)) return;
      e.preventDefault();
      applyMove(dragging, `${target}/${nameOf(dragging)}`);
      dragging = "";
    });

    side.addEventListener("dragend", () => {
      dragging = "";
      scroller.stop();
      paintDrop("");
      for (const el of side.querySelectorAll("[data-carry]")) delete el.dataset.carry;
    });

    /* ─── the splitter ─────────────────────────────────────────────────── */

    /**
     * How much of the width the tree gets, remembered between sessions. A file
     * manager is used differently depending on what is being looked for — a
     * name in a deep folder wants the tree, a picture wants the picture — and
     * the only person who knows which is the one holding the mouse.
     */
    // Side by side above 768px and stacked below it, so the grip resizes a
    // different axis at each width and each axis remembers its own share.
    const stacked = () => window.matchMedia(`(max-width: ${STACK_AT}px)`).matches;
    const axis = () => (stacked() ? { prop: "--ed-pick-vsplit", key: SPLIT_KEY + ".v" } : { prop: "--ed-pick-split", key: SPLIT_KEY });

    function applySplit(fraction) {
      const { prop, key } = axis();
      const value = Math.max(0.2, Math.min(0.75, fraction));
      body.style.setProperty(prop, value);
      try {
        window.localStorage.setItem(key, String(value));
      } catch (err) {
        /* a browser that refuses storage simply forgets */
      }
    }

    for (const { prop, key } of [
      { prop: "--ed-pick-split", key: SPLIT_KEY },
      { prop: "--ed-pick-vsplit", key: SPLIT_KEY + ".v" },
    ]) {
      let held = 0;
      try {
        held = parseFloat(window.localStorage.getItem(key)) || 0;
      } catch (err) {
        held = 0;
      }
      if (held) body.style.setProperty(prop, Math.max(0.2, Math.min(0.75, held)));
    }

    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      grip.dataset.on = "1";

      const box = body.getBoundingClientRect();
      const move = (ev) =>
        applySplit(stacked() ? (ev.clientY - box.top) / box.height : (ev.clientX - box.left) / box.width);
      const up = () => {
        delete grip.dataset.on;
        grip.releasePointerCapture(e.pointerId);
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });

    grip.addEventListener("keydown", (e) => {
      const back = stacked() ? "ArrowUp" : "ArrowLeft";
      const on = stacked() ? "ArrowDown" : "ArrowRight";
      const step = e.key === back ? -0.04 : e.key === on ? 0.04 : 0;
      if (!step) return;
      e.preventDefault();
      const now = parseFloat(getComputedStyle(body).getPropertyValue(axis().prop)) || 0.42;
      applySplit(now + step);
    });

    /* ─── open ─────────────────────────────────────────────────────────── */

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(mask);
    lockPage();
    pop(card);

    // Two phases, because they fail differently and take different amounts of
    // time: reaching the repository at all, then walking it folder by folder.
    side.innerHTML = probeCard("fa-folder-tree", t("pick_loading", "Reading the repository"));
    paintPreview();

    let walked = false;
    const step = () => {
      if (walked) return;
      walked = true;
      const text = side.querySelector(".access-probe-text");
      if (text) text.textContent = t("pick_walking", "Reading the file tree");
    };

    loadTree(false, step).then((loaded) => {
      rows = loaded;
      mount();
      if (chosen && nodes.has(chosen)) {
        reveal(chosen);
        select(chosen, false);
      } else {
        chosen = "";
        for (const root of ROOTS) open(root, true);
        paintPath(false);
      }
    });
  });
}
