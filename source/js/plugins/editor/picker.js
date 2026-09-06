/**
 * The picture browser.
 *
 * Every way of naming an image — a block's address, a replacement, the cover,
 * the thumbnail, the banner — is this one control: a file manager over
 * `source/images`, tree on the left, the picture on the right, and along the
 * bottom the one field that is both "what is chosen" and "search for something
 * else".
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
 * A rename rewrites the addresses in the post being edited. Every OTHER post
 * that referenced the old path is rewritten by the build: `save` leaves a note
 * in `source/_data/image-moves.json` and scripts/events/image-moves.js reads it
 * on the next generate, rewrites what it names and deletes it. Doing it here
 * would mean pulling every post in the site into the browser to find out.
 *
 * Nothing here is a browser prompt. A name is typed where the name is read.
 */

import { escapeHTML } from "./markdown.js";
import * as gitea from "./gitea.js";
import { imageSize, previewImage } from "./assets.js";
import { pop } from "./motion.js";

const ROOT = "source/images";
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const MENU_MAX = 40;

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

async function walk(dir, out, depth) {
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
  // Serial rather than parallel: a browser-held token is one token, and forty
  // simultaneous listings is how it gets rate-limited.
  for (const child of dirs) await walk(child, out, depth + 1);
  return out;
}

export async function loadTree(force) {
  if (treeCache && !force) return treeCache;
  treeCache = await walk(ROOT, [{ path: ROOT, type: "dir" }], 0);
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
 * to one move, because what the commit needs is a from and a to.
 */
export function createStage() {
  const moves = [];
  const folders = new Set();

  return {
    moves,
    folders,
    get dirty() {
      return moves.length > 0;
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
      if (existing) existing.to = to;
      else moves.push({ from: start, to });
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
    const side = mask.querySelector(".ed-pick-side");
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
    let previewToken = 0;

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
      seen.set(ROOT, { path: ROOT, type: "dir" });
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
        if (row.type !== "dir" || row.path === ROOT || seen.has(row.path)) continue;
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
      el.dataset.open = isDir && entry.path === ROOT ? "1" : "0";

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
      if (!path || path === ROOT || !path.startsWith(ROOT + "/") || nodes.has(path)) return;
      ensureBranch(parentOf(path));
      makeNode({ path, type: "dir" });
      place(path);
    }

    function mount() {
      nodes.clear();
      side.innerHTML = "";

      const root = makeNode({ path: ROOT, type: "dir" });
      side.appendChild(root.el);
      root.row.classList.add("is-root");
      root.label.textContent = t("pick_root", "images");

      for (const entry of model().sort((a, b) => a.path.localeCompare(b.path))) {
        if (entry.path === ROOT) continue;
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
      while (cur && cur.startsWith(ROOT)) {
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

    function metaRow(label, value) {
      return value ? `<dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd>` : "";
    }

    function paintPreview() {
      const token = ++previewToken;
      ok.disabled = !chosen || !IMAGE.test(chosen);
      stage.innerHTML = "";
      meta.innerHTML = "";

      if (!chosen || !IMAGE.test(chosen)) {
        stage.innerHTML = `<p class="ed-pick-blank"><i class="fa-solid fa-images" aria-hidden="true"></i>${escapeHTML(
          t("pick_hint", "Choose a picture, or drag one onto a folder to move it.")
        )}</p>`;
        return;
      }

      const node = nodes.get(chosen);
      const origin = ctx.stage.origin(chosen);
      const known = imageSize(siteAddress(chosen));

      const shot = previewImage(siteAddress(chosen), ctx.pending);
      stage.appendChild(shot.el);

      const describe = (dims) => {
        if (token !== previewToken) return;
        const size = dims || known;
        meta.innerHTML =
          metaRow(t("pick_name", "Name"), nameOf(chosen)) +
          metaRow(t("pick_where", "Folder"), parentOf(chosen).replace(/^source\//, "/")) +
          metaRow(t("pick_dims", "Size"), size ? `${size.width} × ${size.height}` : "") +
          metaRow(t("pick_bytes", "File"), readableSize(node && node.size)) +
          (origin === chosen ? "" : metaRow(t("pick_moved", "Moving from"), siteAddress(origin)));
      };

      describe(null);
      shot.ready.then(describe);
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
      if (!node || path === ROOT || renaming) return;
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
      if (node) return node.type === "dir" ? chosen : parentOf(chosen) || ROOT;
      const posts = ROOT + "/posts";
      return nodes.has(posts) ? posts : ROOT;
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
        if (chosen && chosen !== ROOT) beginRename(chosen);
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
      mask.remove();
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

    /* Dragging a row onto a folder is a staged move. */
    let dragging = "";

    side.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".ed-pick-row");
      if (!row || row.dataset.editing) return;
      dragging = row.parentElement.dataset.path;
      if (dragging === ROOT) return void (dragging = "");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragging);
      row.dataset.carry = "1";
    });

    /** Which folder the pointer is over: a file means the folder holding it. */
    function dropFolder(e) {
      const row = e.target.closest(".ed-pick-row");
      if (!row) return ROOT;
      const path = row.parentElement.dataset.path;
      const node = nodes.get(path);
      return node && node.type === "dir" ? path : parentOf(path) || ROOT;
    }

    function canDrop(target) {
      if (!dragging || !target) return false;
      if (target === dragging) return false;
      if ((target + "/").startsWith(dragging + "/")) return false;
      return parentOf(dragging) !== target;
    }

    side.addEventListener("dragover", (e) => {
      const target = dropFolder(e);
      if (!canDrop(target)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      for (const el of side.querySelectorAll("[data-drop]")) delete el.dataset.drop;
      const holder = nodes.get(target);
      if (holder) holder.row.dataset.drop = "1";
    });

    side.addEventListener("drop", (e) => {
      const target = dropFolder(e);
      for (const el of side.querySelectorAll("[data-drop]")) delete el.dataset.drop;
      if (!canDrop(target)) return;
      e.preventDefault();
      applyMove(dragging, `${target}/${nameOf(dragging)}`);
      dragging = "";
    });

    side.addEventListener("dragend", () => {
      dragging = "";
      for (const el of side.querySelectorAll("[data-drop], [data-carry]")) {
        delete el.dataset.drop;
        delete el.dataset.carry;
      }
    });

    /* ─── open ─────────────────────────────────────────────────────────── */

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(mask);
    pop(card);

    side.innerHTML = `<p class="ed-pick-blank">${escapeHTML(t("pick_loading", "Reading the repository…"))}</p>`;
    paintPreview();

    loadTree().then((loaded) => {
      rows = loaded;
      mount();
      if (chosen && nodes.has(chosen)) {
        reveal(chosen);
        select(chosen, false);
      } else {
        chosen = "";
        open(ROOT, true);
        paintPath(false);
      }
    });
  });
}
