/**
 * The picture browser.
 *
 * Every way of naming an image — a block's address, a replacement, the cover,
 * the thumbnail, the banner — used to be its own control, and two of them were
 * a text field you had to type a repository path into from memory. They are one
 * control now: a file manager over `source/images`, with the tree on the left
 * and the picture on the right, which is the shape everybody already knows.
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
 * The preview is the article's own preloader, so a picture is fetched and shown
 * here exactly as the page fetches and shows it — compressed where the build
 * compressed it, original where it did not.
 */

import { escapeHTML } from "./markdown.js";
import * as gitea from "./gitea.js";
import { buildPreloader, siteRoot } from "./assets.js";
import { pop } from "./motion.js";

const ROOT = "source/images";
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;

/** `source/images/a/b.png` → `/images/a/b.png`, which is what markdown wants. */
export function siteAddress(path) {
  return "/" + String(path || "").replace(/^source\//, "");
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
    folder(path) {
      if (path) folders.add(path);
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

/* ─── the dialogue ─────────────────────────────────────────────────────────── */

function parentOf(path) {
  const cut = String(path).lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

function nameOf(path) {
  return String(path).split("/").pop();
}

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
        <div class="ed-picker-body">
          <div class="ed-picker-side">
            <label class="ed-picker-find">
              <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
              <input class="ed-picker-search" spellcheck="false" placeholder="${escapeHTML(t("pick_search", "Search every folder"))}">
            </label>
            <div class="ed-picker-tree" role="tree"></div>
          </div>
          <div class="ed-picker-view">
            <div class="ed-picker-shot"></div>
            <div class="ed-picker-meta"></div>
          </div>
        </div>
        <footer class="ed-picker-foot">
          <code class="ed-picker-path"></code>
          <button type="button" class="ed-act ed-act-primary ed-picker-ok" disabled>
            <i class="fa-solid fa-check" aria-hidden="true"></i><span>${escapeHTML(t("pick_use", "Use this picture"))}</span>
          </button>
        </footer>
      </section>`;

    const tree = mask.querySelector(".ed-picker-tree");
    const shot = mask.querySelector(".ed-picker-shot");
    const meta = mask.querySelector(".ed-picker-meta");
    const foot = mask.querySelector(".ed-picker-path");
    const ok = mask.querySelector(".ed-picker-ok");
    const search = mask.querySelector(".ed-picker-search");

    const open = new Set([ROOT]);
    let rows = [];
    let chosen = opts.current ? String(opts.current).replace(/^\//, "source/") : "";
    let query = "";
    let done = false;

    /* ─── the model, with the staged tidy-up applied ───────────────────── */

    function model() {
      const seen = new Map();
      for (const row of rows) {
        const path = ctx.stage.resolve(row.path);
        seen.set(path, Object.assign({}, row, { path }));
      }
      for (const folder of ctx.stage.folders) {
        if (!seen.has(folder)) seen.set(folder, { path: folder, type: "dir", fresh: true });
      }
      // A picture added in this session is real to the author the moment it is
      // added, whatever the repository still says.
      for (const asset of ctx.pending || []) {
        const path = ctx.stage.resolve(asset.path);
        if (!seen.has(path)) seen.set(path, { path, type: "file", staged: true, size: asset.bytes ? asset.bytes.byteLength : 0 });
      }
      return Array.from(seen.values()).sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.path.localeCompare(b.path);
      });
    }

    /** Which rows to draw: the open branches, or every match while searching. */
    function visible() {
      const all = model();
      if (query) {
        const q = query.toLowerCase();
        return all.filter((row) => row.type === "file" && row.path.toLowerCase().includes(q)).slice(0, 400);
      }
      return all.filter((row) => {
        if (row.path === ROOT) return false;
        const parent = parentOf(row.path);
        return open.has(parent);
      });
    }

    function paintTree() {
      const list = visible();
      tree.innerHTML = list.length
        ? list
            .map((row) => {
              const depth = query ? 0 : row.path.split("/").length - ROOT.split("/").length - 1;
              const isDir = row.type === "dir";
              const icon = isDir
                ? open.has(row.path)
                  ? "fa-folder-open"
                  : "fa-folder"
                : "fa-image";
              const label = query ? row.path.replace(ROOT + "/", "") : nameOf(row.path);
              return `<div class="ed-picker-row" role="treeitem" draggable="true"
                        data-path="${escapeHTML(row.path)}" data-type="${row.type}"
                        data-on="${row.path === chosen ? "1" : "0"}"
                        style="padding-left:${8 + depth * 14}px">
                        <i class="fa-solid ${icon}" aria-hidden="true"></i>
                        <span>${escapeHTML(label)}</span>
                        ${row.staged ? `<em class="ed-picker-flag">${escapeHTML(t("pick_new", "new"))}</em>` : ""}
                        ${row.fresh ? `<em class="ed-picker-flag">${escapeHTML(t("pick_unsaved", "unsaved"))}</em>` : ""}
                      </div>`;
            })
            .join("")
        : `<p class="ed-picker-empty">${escapeHTML(t("pick_none", "Nothing here yet"))}</p>`;
    }

    function paintPreview() {
      foot.textContent = chosen ? siteAddress(chosen) : "";
      ok.disabled = !chosen || !IMAGE.test(chosen);
      shot.innerHTML = "";
      meta.textContent = "";

      if (!chosen || !IMAGE.test(chosen)) {
        meta.textContent = t("pick_hint", "Choose a picture, or drag one onto a folder to move it.");
        return;
      }
      // The article's own preloader, so what is shown here is what the page
      // would fetch — the compressed product where there is one.
      shot.appendChild(buildPreloader(siteAddress(chosen), "", ctx.pending));
      if (ctx.observeImages) ctx.observeImages();

      const origin = ctx.stage.origin(chosen);
      meta.textContent = origin === chosen ? chosen : `${origin}  →  ${chosen}`;
    }

    function paint() {
      paintTree();
      paintPreview();
    }

    /* ─── acting on it ─────────────────────────────────────────────────── */

    async function ask(kind, current) {
      // The dialogue owns the screen, so its own prompt is a plain one.
      const value = window.prompt(t("ask_" + kind, kind === "mkdir" ? "Folder name" : "New name"), current || "");
      return value == null ? null : value.trim();
    }

    async function onAct(act) {
      if (act === "close") return finish(null);

      if (act === "upload") {
        const file = await pickFile();
        if (!file) return;
        const asset = await ctx.upload(file, chosen && !IMAGE.test(chosen) ? chosen : parentOf(chosen) || ROOT);
        if (!asset) return;
        chosen = ctx.stage.resolve(asset.path);
        return paint();
      }

      if (act === "mkdir") {
        const base = chosen && !IMAGE.test(chosen) ? chosen : parentOf(chosen) || ROOT;
        const name = await ask("mkdir", "");
        if (!name) return;
        ctx.stage.folder(`${base}/${name.replace(/[/\\]/g, "-")}`);
        open.add(base);
        return paint();
      }

      if (act === "rename") {
        if (!chosen || chosen === ROOT) return;
        const name = await ask("rename", nameOf(chosen));
        if (!name || name === nameOf(chosen)) return;
        const to = `${parentOf(chosen)}/${name.replace(/[/\\]/g, "-")}`;
        ctx.stage.move(chosen, to);
        chosen = to;
        return paint();
      }
    }

    function pickFile() {
      return new Promise((res) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.hidden = true;
        document.body.appendChild(input);
        input.addEventListener("change", () => {
          const file = input.files && input.files[0];
          input.remove();
          res(file || null);
        });
        input.click();
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
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    }

    /* ─── wiring ───────────────────────────────────────────────────────── */

    mask.addEventListener("click", (e) => {
      if (e.target === mask) return finish(null);
      const act = e.target.closest("[data-act]");
      if (act) {
        e.preventDefault();
        return void onAct(act.dataset.act);
      }
      const row = e.target.closest(".ed-picker-row");
      if (row) {
        e.preventDefault();
        const path = row.dataset.path;
        if (row.dataset.type === "dir") {
          if (open.has(path)) open.delete(path);
          else open.add(path);
        }
        chosen = path;
        return paint();
      }
    });

    mask.addEventListener("dblclick", (e) => {
      const row = e.target.closest(".ed-picker-row");
      if (row && row.dataset.type === "file") finish({ path: row.dataset.path, site: siteAddress(row.dataset.path) });
    });

    ok.addEventListener("click", () => {
      if (!chosen || !IMAGE.test(chosen)) return;
      finish({ path: chosen, site: siteAddress(chosen) });
    });

    search.addEventListener("input", () => {
      query = search.value.trim();
      paint();
    });

    /* Dragging a row onto a folder is a staged move. */
    let dragging = "";
    tree.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".ed-picker-row");
      if (!row) return;
      dragging = row.dataset.path;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragging);
    });
    tree.addEventListener("dragover", (e) => {
      const row = e.target.closest('.ed-picker-row[data-type="dir"]');
      if (!row || !dragging || row.dataset.path === dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      row.dataset.drop = "1";
    });
    tree.addEventListener("dragleave", (e) => {
      const row = e.target.closest(".ed-picker-row");
      if (row) delete row.dataset.drop;
    });
    tree.addEventListener("drop", (e) => {
      const row = e.target.closest('.ed-picker-row[data-type="dir"]');
      if (!row || !dragging) return;
      e.preventDefault();
      delete row.dataset.drop;
      // A folder cannot be dropped inside itself.
      if (!(row.dataset.path + "/").startsWith(dragging + "/")) {
        const to = `${row.dataset.path}/${nameOf(dragging)}`;
        ctx.stage.move(dragging, to);
        if (chosen === dragging) chosen = to;
      }
      dragging = "";
      open.add(row.dataset.path);
      paint();
    });
    tree.addEventListener("dragend", () => {
      dragging = "";
      for (const row of tree.querySelectorAll("[data-drop]")) delete row.dataset.drop;
    });

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(mask);
    pop(mask.querySelector(".ed-picker"));

    tree.innerHTML = `<p class="ed-picker-empty">${escapeHTML(t("pick_loading", "Reading the repository…"))}</p>`;
    paintPreview();

    loadTree().then((loaded) => {
      rows = loaded;
      // Open every branch on the way to what is already chosen.
      let cur = parentOf(chosen);
      while (cur && cur.startsWith(ROOT)) {
        open.add(cur);
        cur = parentOf(cur);
      }
      paint();
      search.focus();
    });
  });
}
