/**
 * Tables, edited the way a spreadsheet is.
 *
 * ── A cell, and what is in it ───────────────────────────────────────────────
 *
 * A cell is a box of real blocks, edited the way every box inside a component
 * is: a press on its WORDS puts the caret there, a press on its PICTURE selects
 * the picture, and the block being edited floats its gutter above itself. What
 * decides is what the pointer is actually on (`onContent`) — a glyph, a picture,
 * a rendered block — not merely which element it is inside, since a paragraph
 * spans the whole cell and most of it is empty.
 *
 * A press anywhere ELSE in a cell — its padding, the space beside a short line,
 * an empty cell — selects the cell itself, and from there the table is a
 * spreadsheet: Shift and Ctrl extend and add, a drag frames a range, the arrows
 * and Tab walk it, Delete clears it, typing continues the active cell at its
 * END, F2 and a double click open it, and Esc from anything inside a cell hands
 * back to the cell.
 *
 * With a cell selected, dragging its side moves that cell's edge in its own
 * rows only (the grid is split underneath and the other rows span the split);
 * otherwise an edge moves the whole column line.
 *
 * ── One table, two spellings ────────────────────────────────────────────────
 *
 * Everything works on the `{% table %}` model from tools/components.js — the
 * same one the build renders from — and a table that came from markdown is
 * written back as markdown for as long as markdown can say it. The first thing
 * it cannot (a merge, a width, a fill, a line, a second paragraph in a cell)
 * rewrites it as the tag, and it stays one.
 *
 * ── Nothing here takes room on the article ──────────────────────────────────
 *
 * The table on the canvas is the published table: same container, same frame,
 * same cells, laid out by the same layouts/tableFit.js — the scroller holds the
 * table and nothing else, so nothing the editor draws can make it scroll. What
 * the editor adds is one layer beside it that takes no room: the selection,
 * clipped to the frame and following its scroll but drawn OVER the frame, then
 * the grips, the handles and the floating gutter over that.
 */

import { escapeHTML, parseBlocks } from "./markdown.js";
import { renderMarkdown } from "./render.js";
import { richToMarkdown, sanitizePaste } from "./rich.js";
import * as caret from "./caret.js";
import { contentChanged, floatBadge, morphHeight } from "./motion.js";
import initTableFit, { fitTables } from "../../layouts/tableFit.js";

const MIN_COL = 28;     // px — the narrowest a column may be dragged
const EDGE_HIT = 5;     // px either side of a line that grabs it
const BAND_HIT = 5;     // px of a selection's rim that carries it
const AUTO_EDGE = 40;   // px from a scroller's side where a drag scrolls it
const DRAG_START = 4;   // px a grip travels before it is a drag, not a click
const GLYPH_SLACK = 6;  // px beside a glyph that still count as pressing on it
const ZWSP = 0x200b;    // the editor's own caret anchors, never the author's words

const LINES = ["thin", "medium", "thick", "dashed", "dotted", "double", "none"];
const RUNTIME = ["is-scroll", "has-sel", "fade-l", "fade-r"];
const SHELL_PROPS = ["--table-size", "--tf-t", "--tf-r", "--tf-b", "--tf-l"];
const GFM_ALIGN = { left: "l", center: "c", right: "r" };
const ALIGN_NAMES = { l: "left", c: "center", r: "right" };

const api = () => window.RedefineComponents;

export function isTableBlock(block) {
  return (
    !!block &&
    (block.type === "table" ||
      (block.type === "component" && String(block.name || "").toLowerCase() === "table" && !!api()))
  );
}

/* ─── the model, both spellings ────────────────────────────────────────────── */

function fromGfm(block) {
  const A = api();
  const width = Math.max(1, (block.header || []).length);
  const cell = (text, i) =>
    A.tableCell({
      align: GFM_ALIGN[(block.align || [])[i]] ? "m" + GFM_ALIGN[block.align[i]] : "",
      body: String(text == null ? "" : text).trim(),
    });
  const rows = [{ cells: (block.header || [""]).map(cell) }].concat(
    (block.rows || []).map((row) => ({ cells: row.map(cell) }))
  );
  return A.tableNormalize({ size: 0, head: 1, hcol: 0, band: true, cols: new Array(width).fill(null), rows });
}

function modelOf(block) {
  if (block.type === "table") return fromGfm(block);
  return api().tableModel(block.args || "", block.body || "");
}

/**
 * The same table as markdown, or null when markdown cannot say it.
 *
 * A markdown table is one header row, banded, full width, columns the content
 * decides, one line of inline text per cell and one horizontal alignment per
 * column — everything else is the tag's to say.
 */
function asGfm(model) {
  if (model.head !== 1 || model.hcol || !model.band || model.size || model.cols.some((w) => w != null)) return null;
  const W = model.cols.length;
  const align = new Array(W).fill(null);
  const out = [];
  for (let r = 0; r < model.slots.length; r++) {
    const row = [];
    for (let c = 0; c < W; c++) {
      const cell = model.slots[r][c];
      if (cell.cs !== 1 || cell.rs !== 1 || cell.bg || cell.border.some(Boolean)) return null;
      if (cell.align && cell.align[0] !== "m") return null;
      const h = cell.align ? cell.align[1] : "";
      if (align[c] === null) align[c] = h;
      else if (align[c] !== h) return null;
      const body = cell.body.trim();
      if (/\n/.test(body)) return null;
      if (body) {
        const blocks = parseBlocks(body);
        if (blocks.length !== 1 || blocks[0].type !== "paragraph") return null;
      }
      row.push(body.replace(/(?<!\\)\|/g, "\\|"));
    }
    out.push(row);
  }
  return {
    header: out[0],
    rows: out.slice(1),
    align: align.map((h) => ALIGN_NAMES[h] || ""),
  };
}

/** Every anchored cell, in reading order. */
function cellsOf(model) {
  return model.rows.flatMap((row) => row.cells);
}

/** Grow a range until no cell crosses its edge. */
function expand(model, range) {
  let { r0, c0, r1, c1 } = range;
  let moved = true;
  while (moved) {
    moved = false;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = model.slots[r][c];
        if (cell.r < r0) (r0 = cell.r), (moved = true);
        if (cell.c < c0) (c0 = cell.c), (moved = true);
        if (cell.r + cell.rs - 1 > r1) (r1 = cell.r + cell.rs - 1), (moved = true);
        if (cell.c + cell.cs - 1 > c1) (c1 = cell.c + cell.cs - 1), (moved = true);
      }
    }
  }
  return Object.assign({}, range, { r0, c0, r1, c1 });
}

function within(range, r, c) {
  return r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;
}

/** Cells anchored in or crossing any of `ranges`, each once. */
function cellsIn(model, ranges) {
  const out = new Set();
  for (const range of ranges) {
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) out.add(model.slots[r][c]);
    }
  }
  return Array.from(out);
}

/** A merge crossing the range's edge — which is what refuses a move or a paste. */
function crossed(model, range) {
  return cellsIn(model, [range]).some(
    (cell) => cell.r < range.r0 || cell.c < range.c0 || cell.r + cell.rs - 1 > range.r1 || cell.c + cell.cs - 1 > range.c1
  );
}

function hasMerge(model, range) {
  return cellsIn(model, [range]).some((cell) => cell.cs > 1 || cell.rs > 1);
}

/* ─── clipboard ────────────────────────────────────────────────────────────── */

function encode(value) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

function decode(text) {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(text))));
  } catch (err) {
    return null;
  }
}

/** Tab-separated values the way Excel and Sheets write them, quotes and all. */
function parseTSV(text) {
  const s = String(text).replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function tsvCell(text) {
  return /[\t\n"]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

const escapeMd = (text) => String(text).replace(/([\\`*_[\]~|])/g, "\\$1");

/** What a cell reads as, as plain text — for a spreadsheet on the other end. */
function plainOf(body) {
  const holder = document.createElement("div");
  holder.innerHTML = renderMarkdown(body || "");
  const parts = [];
  for (const node of holder.children) {
    const text = node.textContent.replace(/\s+\n/g, "\n").trim();
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

/** A cell copied out of another program, as markdown. */
function markdownOf(html) {
  const holder = document.createElement("div");
  holder.innerHTML = sanitizePaste(html);
  return richToMarkdown(holder).trim();
}

/**
 * Anything on the clipboard, as a grid of cells: this editor's own copy (with
 * its spans and formats), an HTML table from a spreadsheet or a page, or TSV.
 */
function clipOf(data) {
  const html = data.getData("text/html");
  const text = data.getData("text/plain");
  if (html) {
    const own = html.match(/data-redefine-table="([^"]+)"/);
    if (own) {
      const clip = decode(own[1]);
      if (clip && Array.isArray(clip.cells)) return clip;
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const table = doc.querySelector("table");
    if (table) {
      const grid = [];
      Array.from(table.rows).forEach((tr, r) => {
        grid[r] = grid[r] || [];
        let c = 0;
        for (const td of tr.cells) {
          while (grid[r][c] !== undefined) c += 1;
          const cs = Math.max(1, td.colSpan || 1);
          const rs = Math.max(1, td.rowSpan || 1);
          const cell = { body: markdownOf(td.innerHTML), cs, rs };
          for (let y = 0; y < rs; y++) {
            grid[r + y] = grid[r + y] || [];
            for (let x = 0; x < cs; x++) grid[r + y][c + x] = x || y ? 0 : cell;
          }
          c += cs;
        }
      });
      const w = Math.max(...grid.map((row) => row.length));
      for (const row of grid) for (let c = 0; c < w; c++) if (row[c] === undefined) row[c] = { body: "", cs: 1, rs: 1 };
      return { cells: grid, h: grid.length, w };
    }
    const body = markdownOf(html);
    if (body && !text.includes("\t")) return { cells: [[{ body, cs: 1, rs: 1 }]], h: 1, w: 1 };
  }
  if (!text) return null;
  const rows = parseTSV(text);
  const w = Math.max(...rows.map((row) => row.length));
  const cells = rows.map((row) =>
    Array.from({ length: w }, (_, c) => ({ body: escapeMd(row[c] || "").trim(), cs: 1, rs: 1 }))
  );
  return { cells, h: cells.length, w };
}

/* ─── the view ─────────────────────────────────────────────────────────────── */

export function mountTableView(view, helpers) {
  const { block, ctx } = view;
  const A = api();
  const t = ctx.t;

  const T = {
    model: modelOf(block),
    origin: block.type === "table" ? "gfm" : "tag",
    mode: "none", // none | cells | edit
    sel: null, // { ranges: [{r0,c0,r1,c1,kind}], anchor:{r,c}, active:{r,c} }
    editing: null,
    pen: { style: "thin", colour: "" },
    flat: false,
  };

  const els = new Map(); // cell → its element
  const boxes = new Map(); // cell → the box of blocks it holds

  const wrap = document.createElement("div");
  wrap.className = "ed-table-block";
  wrap.innerHTML = `
    <div class="table-container rich-table" data-table>
      <div class="table-scroll">
        <table><colgroup></colgroup><thead></thead><tbody></tbody></table>
      </div>
    </div>
    <div class="ed-tfloat">
      <div class="ed-tsel" aria-hidden="true">
        <div class="ed-tsel-track">
          <div class="ed-tsel-ranges"></div>
          <div class="ed-tsel-active"></div>
          <div class="ed-tsel-guide"></div>
          <div class="ed-tsel-ghost"></div>
          <div class="ed-tsel-drop"></div>
          <div class="ed-tsel-pic"></div>
        </div>
      </div>
      <button type="button" class="ed-tgrip is-col" tabindex="-1"><i class="fa-solid fa-grip-dots" aria-hidden="true"></i></button>
      <button type="button" class="ed-tgrip is-row" tabindex="-1"><i class="fa-solid fa-grip-dots-vertical" aria-hidden="true"></i></button>
      <button type="button" class="ed-tgrip is-all" tabindex="-1"><i class="fa-solid fa-table-cells" aria-hidden="true"></i></button>
      <div class="ed-tsel-fill"></div>
      <div class="ed-tedge is-l"></div>
      <div class="ed-tedge is-r"></div>
    </div>
    <textarea class="ed-tkeys" readonly inputmode="none" tabindex="-1" aria-label="${escapeHTML(t("t_cells", "Table cells"))}"></textarea>`;
  view.body.appendChild(wrap);
  view.el.classList.add("is-table");

  const container = wrap.querySelector(".table-container");
  const scroll = wrap.querySelector(".table-scroll");
  const table = scroll.querySelector("table");
  const colgroup = table.querySelector("colgroup");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  const floatEl = wrap.querySelector(".ed-tfloat");
  const overlay = floatEl.querySelector(".ed-tsel");
  const trackEl = overlay.querySelector(".ed-tsel-track");
  const rangesEl = overlay.querySelector(".ed-tsel-ranges");
  const activeEl = overlay.querySelector(".ed-tsel-active");
  const fillEl = floatEl.querySelector(".ed-tsel-fill");
  const edgeL = floatEl.querySelector(".ed-tedge.is-l");
  const edgeR = floatEl.querySelector(".ed-tedge.is-r");
  const guideEl = overlay.querySelector(".ed-tsel-guide");
  const ghostEl = overlay.querySelector(".ed-tsel-ghost");
  const dropEl = overlay.querySelector(".ed-tsel-drop");
  const picEl = overlay.querySelector(".ed-tsel-pic");
  const colGrip = floatEl.querySelector(".ed-tgrip.is-col");
  const rowGrip = floatEl.querySelector(".ed-tgrip.is-row");
  const allGrip = floatEl.querySelector(".ed-tgrip.is-all");
  const keys = wrap.querySelector(".ed-tkeys");
  const badge = floatBadge();

  colGrip.title = t("t_sel_col", "Select column");
  rowGrip.title = t("t_sel_row", "Select row");
  allGrip.title = t("t_sel_all", "Select table");

  /* ─── writing back ─────────────────────────────────────────────────────── */

  /**
   * The model into the block's fields, in whichever spelling it can still take.
   * Upgrading rewrites the block IN PLACE — same id, same view — because the
   * view and every step that names this block are bound to that object.
   */
  function writeBlock() {
    if (T.origin === "gfm") {
      const gfm = asGfm(T.model);
      if (gfm) {
        block.header = gfm.header;
        block.align = gfm.align;
        block.rows = gfm.rows;
        return;
      }
      T.origin = "tag";
      block.type = "component";
      block.name = "table";
      delete block.header;
      delete block.align;
      delete block.rows;
      view.el.dataset.type = "component";
    }
    block.args = A.tableArgsText(T.model);
    block.body = A.tableBodyText(T.model);
  }

  let fitTimer = 0;
  const refit = () => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => fitTables([container]), 180);
  };

  function commit(kind) {
    stale();
    writeBlock();
    view.touch(kind);
    refit();
    ctx.onOptionsChanged();
  }

  /* ─── cells ────────────────────────────────────────────────────────────── */

  /**
   * A cell holds a box of blocks — the same blocks the article holds, minus
   * the ones that open a box of their own. A table already inside a note has no
   * level left to give its cells, and they are edited as rich text instead.
   */
  function mountCell(cell, el) {
    if (!T.flat) {
      const box = ctx.nest(el, cell.body, {
        cell: {
          table: view,
          select: () => selectCell(cell),
          focus: (inner) => onBlockFocus(cell, inner),
          blur: (inner, next) => onBlockBlur(cell, inner, next),
        },
        write: (text) => {
          if (cell.body === text) return;
          cell.body = text;
          commit();
          drawSoon();
        },
        onEmpty: () => {
          const box = boxes.get(cell);
          if (!box) return;
          ctx.fillBox(box, "");
          ctx.writeBox(box);
          const first = box.views[0];
          if (first && first.focus) first.focus("end");
        },
        edge: (delta) => walkEdit(cell, delta),
      });
      if (box) {
        el.classList.add("ed-cell");
        boxes.set(cell, box);
        return;
      }
      T.flat = true;
    }
    el.classList.add("ed-cell-flat");
    showFlat(el, cell.body);
  }

  /**
   * A flat cell's contents. Its pictures keep the address the markdown gives
   * them: this markup is also what is read back, and a resolved address would
   * be written into the post.
   */
  function showFlat(el, body) {
    el.innerHTML = A.cellHTML(renderMarkdown(body));
  }

  function dropCell(cell) {
    const box = boxes.get(cell);
    if (box) ctx.unnest(box);
    boxes.delete(cell);
    const el = els.get(cell);
    if (el) el.remove();
    els.delete(cell);
    if (T.editing === cell) T.editing = null;
  }

  function cellEl(cell, tag) {
    const held = els.get(cell);
    if (held && held.tagName.toLowerCase() === tag) return held;
    const el = document.createElement(tag);
    if (held) {
      // A cell becoming a header cell, or leaving one, is another element with
      // the same contents: they are carried across, box and all.
      while (held.firstChild) el.appendChild(held.firstChild);
      const box = boxes.get(cell);
      if (box) box.el = el;
      if (held.classList.contains("ed-cell-flat")) el.classList.add("ed-cell-flat");
      held.remove();
    } else {
      mountCell(cell, el);
    }
    els.set(cell, el);
    return el;
  }

  function flatRender(cell) {
    const el = els.get(cell);
    if (el && T.flat && T.editing !== cell) showFlat(el, cell.body);
  }

  /* ─── painting ─────────────────────────────────────────────────────────── */

  function paint() {
    stale();
    const model = T.model;
    const shell = A.tableShell(model);
    // What layouts/tableFit.js and the selection put there survives: taking
    // `is-scroll` away with a repaint took the fades with it, and a table that
    // still overflowed showed its content running out under the frame.
    const kept = RUNTIME.filter((cls) => container.classList.contains(cls));
    container.className = shell.cls.concat(kept).join(" ");
    for (const prop of SHELL_PROPS) container.style.removeProperty(prop);
    for (const decl of shell.style) {
      const at = decl.indexOf(":");
      container.style.setProperty(decl.slice(0, at), decl.slice(at + 1));
    }

    colgroup.innerHTML = model.cols
      .map((w) => (w == null ? "<col>" : `<col style="width:${Math.round(w * 10) / 10}%">`))
      .join("");

    const live = new Set();
    const head = [];
    const body = [];
    model.rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      for (const cell of row.cells) {
        const v = A.tableCellView(model, cell, shell.frame);
        const el = cellEl(cell, v.tag);
        const mark = T.flat ? "ed-cell-flat" : "ed-cell";
        const editing = T.editing === cell;
        el.className = v.cls.concat(mark, editing ? "is-editing" : "", editing && T.flat ? "ed-rich" : "").filter(Boolean).join(" ");
        el.colSpan = v.colspan;
        el.rowSpan = v.rowspan;
        if (v.scope) el.setAttribute("scope", v.scope);
        else el.removeAttribute("scope");
        if (v.style) el.setAttribute("style", v.style);
        else el.removeAttribute("style");
        tr.appendChild(el);
        live.add(cell);
      }
      (r < model.head ? head : body).push(tr);
    });
    thead.replaceChildren(...head);
    tbody.replaceChildren(...body);
    thead.hidden = !head.length;

    for (const cell of Array.from(els.keys())) if (!live.has(cell)) dropCell(cell);
    view.nests = !T.flat;
    drawSoon();
  }

  /**
   * Restructure, with the table's height travelling to wherever it lands. The
   * change itself — and the step it makes — happens now; only the motion is
   * awaited.
   */
  function restructure(mutate, kind) {
    return morphHeight(wrap, () => {
      mutate();
      paint();
      if (T.sel) clampSelection();
      commit(kind || "table");
    }).then(() => contentChanged());
  }

  /* ─── geometry ─────────────────────────────────────────────────────────── */

  /**
   * Where every grid line is, in the scroller's content coordinates — the
   * selection track's too — so they hold while it scrolls. Read off the cells: in a
   * collapsed table two neighbours meet on the middle of the line between them.
   */
  // The lines are read once per layout, not per pointer move: a table of a
  // thousand cells is a thousand rectangles. Anything that can move a line
  // throws them away.
  let lines = null;
  const stale = () => {
    lines = null;
  };

  function geometry() {
    const frame = scroll.getBoundingClientRect();
    const ox = frame.left + scroll.clientLeft - scroll.scrollLeft;
    const oy = frame.top + scroll.clientTop - scroll.scrollTop;
    if (!lines || lines.model !== T.model) lines = measureLines(ox, oy);
    return Object.assign({ ox, oy }, lines);
  }

  function measureLines(ox, oy) {
    const model = T.model;
    const W = model.cols.length;
    const H = model.slots.length;
    const xs = new Array(W + 1).fill(null);
    const ys = new Array(H + 1).fill(null);

    for (const cell of cellsOf(model)) {
      const el = els.get(cell);
      if (!el || !el.isConnected) continue;
      const b = el.getBoundingClientRect();
      if (xs[cell.c] == null) xs[cell.c] = b.left - ox;
      if (xs[cell.c + cell.cs] == null) xs[cell.c + cell.cs] = b.right - ox;
      if (ys[cell.r] == null) ys[cell.r] = b.top - oy;
      if (ys[cell.r + cell.rs] == null) ys[cell.r + cell.rs] = b.bottom - oy;
    }
    const trs = Array.from(table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr"));
    for (let r = 0; r < H; r++) if (ys[r] == null && trs[r]) ys[r] = trs[r].getBoundingClientRect().top - oy;
    const fill = (list) => {
      for (let i = 0; i < list.length; i++) {
        if (list[i] != null) continue;
        let j = i + 1;
        while (j < list.length && list[j] == null) j++;
        const lo = i > 0 ? list[i - 1] : 0;
        const hi = j < list.length ? list[j] : lo;
        for (let k = i; k < j; k++) list[k] = lo + ((hi - lo) * (k - i + 1)) / (j - i + 1);
      }
    };
    fill(xs);
    fill(ys);
    return { xs, ys, W, H, model };
  }

  function point(e, geo) {
    return { x: e.clientX - geo.ox, y: e.clientY - geo.oy };
  }

  function indexIn(list, v) {
    if (v < list[0] || v > list[list.length - 1]) return -1;
    for (let i = 0; i < list.length - 1; i++) if (v < list[i + 1]) return i;
    return list.length - 2;
  }

  function slotAt(p, geo) {
    const r = indexIn(geo.ys, p.y);
    const c = indexIn(geo.xs, p.x);
    return r < 0 || c < 0 ? null : { r, c };
  }

  const rectOf = (range, geo) => ({
    x: geo.xs[range.c0],
    y: geo.ys[range.r0],
    w: geo.xs[range.c1 + 1] - geo.xs[range.c0],
    h: geo.ys[range.r1 + 1] - geo.ys[range.r0],
  });

  function place(el, rect) {
    el.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    el.style.width = Math.max(0, rect.w) + "px";
    el.style.height = Math.max(0, rect.h) + "px";
  }

  /* ─── the selection ────────────────────────────────────────────────────── */

  const activeCell = () => (T.sel ? T.model.slots[T.sel.active.r][T.sel.active.c] : null);
  const mainRange = () => (T.sel ? T.sel.ranges[T.sel.ranges.length - 1] : null);
  const selectedCells = () => (T.sel ? cellsIn(T.model, T.sel.ranges) : []);

  function cellRange(cell) {
    return { r0: cell.r, c0: cell.c, r1: cell.r + cell.rs - 1, c1: cell.c + cell.cs - 1 };
  }

  function setSel(sel) {
    T.sel = sel;
    if (T.mode === "none") T.mode = "cells";
    markSel();
    draw();
    ctx.onOptionsChanged();
  }

  function selectCell(cell, keep) {
    if (T.mode === "edit") leaveEdit();
    T.mode = "cells";
    setSel({ ranges: [cellRange(cell)], anchor: { r: cell.r, c: cell.c }, active: { r: cell.r, c: cell.c } });
    if (!keep) focusKeys();
  }

  function selectAt(slot, how) {
    const cell = T.model.slots[slot.r][slot.c];
    if (!T.sel || how === "one") return selectCell(cell);
    if (how === "extend") {
      const a = T.sel.anchor;
      const range = expand(T.model, {
        r0: Math.min(a.r, slot.r),
        c0: Math.min(a.c, slot.c),
        r1: Math.max(a.r, slot.r),
        c1: Math.max(a.c, slot.c),
      });
      const ranges = T.sel.ranges.slice(0, -1).concat(range);
      return setSel({ ranges, anchor: a, active: T.sel.active });
    }
    if (how === "add") {
      const range = cellRange(cell);
      return setSel({
        ranges: T.sel.ranges.concat(range),
        anchor: { r: cell.r, c: cell.c },
        active: { r: cell.r, c: cell.c },
      });
    }
  }

  function selectLines(kind, from, to, add) {
    const model = T.model;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const range =
      kind === "cols"
        ? { r0: 0, r1: model.slots.length - 1, c0: lo, c1: hi, kind }
        : kind === "rows"
          ? { r0: lo, r1: hi, c0: 0, c1: model.cols.length - 1, kind }
          : { r0: 0, r1: model.slots.length - 1, c0: 0, c1: model.cols.length - 1, kind: "all" };
    if (T.mode === "edit") leaveEdit();
    T.mode = "cells";
    const first = model.slots[range.r0][range.c0];
    setSel({
      ranges: add && T.sel ? T.sel.ranges.concat(range) : [range],
      anchor: { r: range.r0, c: range.c0 },
      active: { r: first.r, c: first.c },
    });
    focusKeys();
  }

  function clampSelection() {
    if (!T.sel) return;
    const H = T.model.slots.length;
    const W = T.model.cols.length;
    const clamp = (range) => {
      const r0 = Math.min(range.r0, H - 1);
      const c0 = Math.min(range.c0, W - 1);
      const whole = range.kind === "all";
      const next = {
        r0: range.kind === "cols" || whole ? 0 : r0,
        c0: range.kind === "rows" || whole ? 0 : c0,
        r1: range.kind === "cols" || whole ? H - 1 : Math.max(r0, Math.min(range.r1, H - 1)),
        c1: range.kind === "rows" || whole ? W - 1 : Math.max(c0, Math.min(range.c1, W - 1)),
        kind: range.kind,
      };
      // Whole rows and columns are exactly those lines; a range of cells grows
      // to take in any merge it cuts.
      return range.kind ? next : expand(T.model, next);
    };
    const ranges = T.sel.ranges.map(clamp);
    const a = T.model.slots[Math.min(T.sel.active.r, H - 1)][Math.min(T.sel.active.c, W - 1)];
    T.sel = {
      ranges,
      anchor: { r: Math.min(T.sel.anchor.r, H - 1), c: Math.min(T.sel.anchor.c, W - 1) },
      active: { r: a.r, c: a.c },
    };
    draw();
  }

  function clearSel() {
    if (T.mode === "edit") leaveEdit(true);
    T.sel = null;
    T.mode = "none";
    markSel();
    draw();
  }

  let drawFrame = 0;
  function drawSoon() {
    if (drawFrame) return;
    drawFrame = requestAnimationFrame(() => {
      drawFrame = 0;
      draw();
    });
  }

  function draw() {
    if (!wrap.isConnected) return;
    const geo = geometry();
    placeLayer();
    const sel = T.sel;
    overlay.classList.toggle("is-on", !!sel);
    overlay.classList.toggle("is-editing", T.mode === "edit");
    // A block that left — deleted, or dragged out of the table — takes its
    // gutter back with it.
    if (lifted && !wrap.contains(lifted.view.el)) drop();
    if (!sel) {
      rangesEl.replaceChildren();
      placeGrips(geo);
      return void placeLifted();
    }

    const many = sel.ranges.length > 1 || !cellIsWhole(sel.ranges[0]);
    const kids = sel.ranges.map((range, i) => {
      const el = rangesEl.children[i] || document.createElement("div");
      el.className = "ed-tsel-range" + (i === sel.ranges.length - 1 ? " is-main" : "") + (many ? " is-many" : "");
      ring(el, rectOf(range, geo), geo);
      return el;
    });
    rangesEl.replaceChildren(...kids);
    ring(activeEl, rectOf(cellRange(activeCell()), geo), geo);
    placeGrips(geo);
    placeLifted();
  }

  /**
   * The selection layer over the frame's viewport, its track under the frame's
   * scroll. Over the frame, not in it: in the scroller the ring on an edge cell
   * sat under the frame's line, was cut by its rounded corner and faded with
   * its mask, and anything it drew past the table widened what the frame
   * scrolls.
   */
  function placeLayer() {
    const box = wrap.getBoundingClientRect();
    const frame = scroll.getBoundingClientRect();
    overlay.style.transform = `translate(${frame.left - box.left + scroll.clientLeft}px, ${frame.top - box.top + scroll.clientTop}px)`;
    overlay.style.width = scroll.clientWidth + "px";
    overlay.style.height = scroll.clientHeight + "px";
    overlay.classList.toggle("has-bar", scroll.offsetHeight - scroll.clientHeight > 1);
    trackEl.style.transform = `translate(${-scroll.scrollLeft}px, ${-scroll.scrollTop}px)`;
  }

  let radius = -1;

  /** A ring on the table's corner takes the frame's rounding there. */
  function ring(el, rect, geo) {
    if (radius < 0) radius = parseFloat(getComputedStyle(container).borderTopLeftRadius) || 0;
    const bar = overlay.classList.contains("has-bar");
    const lf = rect.x <= geo.xs[0] + 1;
    const rt = rect.x + rect.w >= geo.xs[geo.W] - 1;
    const tp = rect.y <= geo.ys[0] + 1;
    const bt = !bar && rect.y + rect.h >= geo.ys[geo.H] - 1;
    const at = (v, h) => (v && h ? radius : 2) + "px";
    place(el, rect);
    el.style.borderRadius = `${at(tp, lf)} ${at(tp, rt)} ${at(bt, rt)} ${at(bt, lf)}`;
  }

  function cellIsWhole(range) {
    const cell = T.model.slots[range.r0][range.c0];
    return cell.r === range.r0 && cell.c === range.c0 && cell.rs === range.r1 - range.r0 + 1 && cell.cs === range.c1 - range.c0 + 1;
  }

  function markSel() {
    container.classList.toggle("has-sel", !!T.sel);
    wrap.classList.toggle("has-sel", !!T.sel);
  }

  /* ─── grips ────────────────────────────────────────────────────────────── */

  // The spreadsheet's headers, where they are reached for: one grip for the
  // column under the pointer (or the active cell's), straddling the top of the
  // frame, one for its row, straddling the left, and the whole table's inside
  // the top-left corner. Where a row's or a column's would overlap the corner
  // one, one of them steps aside for the moment: the corner's, unless the
  // pointer is IN the corner — otherwise it could never be reached past the
  // first row's grip. The hover lasts until the pointer leaves the block, not
  // the frame, so a grip half outside the frame can be reached at all.
  const GRIP = 18;
  const CORNER = 5;
  const CLEAR = 4;
  let hoverSlot = null;
  let inCorner = false;

  function placeGrips(geo) {
    const g = geo || geometry();
    const box = wrap.getBoundingClientRect();
    const frame = scroll.getBoundingClientRect();
    const dx = g.ox - box.left;
    const dy = g.oy - box.top;
    const left = frame.left - box.left;
    const right = frame.right - box.left;
    const top = frame.top - box.top;
    const main = mainRange();

    let col = null;
    let row = null;
    if (hoverSlot) ({ r: row, c: col } = hoverSlot);
    else if (main && main.kind === "cols") col = main.c0;
    else if (main && main.kind === "rows") row = main.r0;
    else if (main && !main.kind) ({ r: row, c: col } = T.sel.active);

    const cx = col == null ? 0 : (g.xs[col] + g.xs[col + 1]) / 2 + dx;
    const cy = row == null ? 0 : (g.ys[row] + g.ys[row + 1]) / 2 + dy;
    colGrip.hidden = col == null || cx < left + 8 || cx > right - 8;
    if (!colGrip.hidden) {
      colGrip.style.transform = `translate(${cx}px, ${top}px)`;
      colGrip.dataset.at = col;
      colGrip.dataset.on = main && main.kind === "cols" && col >= main.c0 && col <= main.c1 ? "1" : "0";
    }
    rowGrip.hidden = row == null;
    if (row != null) {
      rowGrip.style.transform = `translate(${left}px, ${cy}px)`;
      rowGrip.dataset.at = row;
      rowGrip.dataset.on = main && main.kind === "rows" && row >= main.r0 && row <= main.r1 ? "1" : "0";
    }
    allGrip.style.transform = `translate(${left + CORNER}px, ${top + CORNER}px)`;
    allGrip.dataset.on = main && main.kind === "all" ? "1" : "0";

    const reach = CORNER + GRIP + CLEAR + GRIP / 2;
    const colClash = !colGrip.hidden && cx < left + reach;
    const rowClash = !rowGrip.hidden && cy < top + reach;
    allGrip.classList.toggle("is-away", !inCorner && (colClash || rowClash));
    colGrip.classList.toggle("is-away", inCorner && colClash);
    rowGrip.classList.toggle("is-away", inCorner && rowClash);

    // The corner that extends the selection, and — for a finger, which cannot
    // find a one-pixel line — a handle on each side of it that drags that edge.
    if (T.sel && T.mode === "cells") {
      const m = rectOf(main, g);
      const fx = m.x + m.w + dx;
      const lx = m.x + dx;
      const my = m.y + m.h / 2 + dy;
      fillEl.hidden = fx < left - 1 || fx > right + 1;
      fillEl.style.transform = `translate(${fx}px, ${m.y + m.h + dy}px)`;
      edgeL.hidden = main.c0 === 0 || lx < left - 1 || lx > right + 1;
      edgeR.hidden = fx < left - 1 || fx > right + 1;
      edgeL.style.transform = `translate(${lx}px, ${my}px)`;
      edgeR.style.transform = `translate(${fx}px, ${my}px)`;
    } else {
      fillEl.hidden = true;
      edgeL.hidden = true;
      edgeR.hidden = true;
    }
  }

  /* ─── the gutter of the block being edited in a cell ───────────────────── */

  // A block in a cell floats its gutter above itself like a block in any other
  // box — but a cell is inside the frame, and the frame clips. So the gutter is
  // lifted out into the layer beside the grips while its block is being
  // edited, placed over the block from there, and handed back after. A
  // picture's ring goes the same way, into the selection layer: its own
  // outline, in the scroller, was cut at the frame's edge and faded under its
  // mask wherever the picture neared the side of a scrolling table.
  let lifted = null;
  const picWatch = new ResizeObserver(() => placeLifted());

  function lift(inner) {
    if (lifted && lifted.view === inner) return void placeLifted();
    drop();
    const gutter = inner.el.querySelector(":scope > .ed-gutter");
    if (!gutter) return;
    lifted = { view: inner, gutter, pic: inner.block.type === "image" };
    gutter.classList.add("is-lifted");
    floatEl.appendChild(gutter);
    if (lifted.pic) {
      inner.el.classList.add("is-ringed");
      picWatch.observe(inner.el);
    }
    placeLifted();
  }

  function drop() {
    if (!lifted) return;
    const { view: inner, gutter } = lifted;
    lifted = null;
    gutter.classList.remove("is-lifted");
    gutter.style.transform = "";
    gutter.style.visibility = "";
    inner.el.insertBefore(gutter, inner.el.firstChild);
    inner.el.classList.remove("is-ringed");
    picWatch.disconnect();
    picEl.classList.remove("is-on");
  }

  function placePic() {
    const node = lifted.view.el.querySelector(".ed-figure .img-preloader, .ed-figure img");
    picEl.classList.toggle("is-on", !!node);
    if (!node) return;
    const geo = geometry();
    const at = node.getBoundingClientRect();
    place(picEl, { x: at.left - geo.ox, y: at.top - geo.oy, w: at.width, h: at.height });
    picEl.style.borderRadius = getComputedStyle(node).borderRadius;
  }

  function placeLifted() {
    if (!lifted) return;
    if (lifted.pic) placePic();
    const { view: inner, gutter } = lifted;
    const box = wrap.getBoundingClientRect();
    const frame = scroll.getBoundingClientRect();
    const at = inner.el.getBoundingClientRect();
    const high = gutter.offsetHeight;
    gutter.style.visibility = at.left < frame.left - 2 || at.left > frame.right - 24 ? "hidden" : "";
    gutter.style.transform = `translate(${at.left - box.left}px, ${at.top - box.top - high - 6}px)`;
  }

  /* ─── editing a cell ───────────────────────────────────────────────────── */

  function focusKeys() {
    if (document.activeElement !== keys) keys.focus({ preventScroll: true });
    ctx.onFocus(view);
  }

  function caretFrom(x, y) {
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (!pos) return null;
      const range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
      return range;
    }
    return document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  }

  function markEditing(cell, on) {
    const el = els.get(cell);
    if (el) el.classList.toggle("is-editing", on);
  }

  /**
   * Is the pointer ON something the cell holds — a glyph, a picture, a block
   * that draws itself — or only inside the cell, around it? A paragraph spans
   * the whole cell, so being inside one says nothing; being beside a glyph does.
   */
  function onContent(e, cell) {
    const el = els.get(cell);
    const target = e.target;
    if (!el || target === el || !el.contains(target)) return false;
    if (T.flat) return T.editing === cell || overText(e.clientX, e.clientY, el);
    const blockEl = target.closest(".ed-block");
    if (!blockEl || !el.contains(blockEl)) return false;
    if (target.closest(".img-preloader, img, figcaption, .image-exif-info-card, .ed-img-grip, .ed-source-block, .ed-component, .ed-rule, .ed-raw")) {
      return true;
    }
    const host = target.closest("[contenteditable=true]");
    return !!host && overText(e.clientX, e.clientY, host);
  }

  function overText(x, y, host) {
    const hit = document.elementFromPoint(x, y);
    // An element standing in a line — an equation, a button, a picture.
    if (hit && hit !== host && host.contains(hit) && hit.closest(".ed-math, img, a.button")) return true;
    const range = caretFrom(x, y);
    if (!range || !host.contains(range.startContainer)) return false;
    const node = range.startContainer;
    if (node.nodeType !== 3) return false;
    const text = node.nodeValue;
    const at = range.startOffset;
    for (const [a, b] of [[at - 1, at], [at, at + 1]]) {
      if (a < 0 || b > text.length || text.charCodeAt(a) === ZWSP) continue;
      const probe = document.createRange();
      probe.setStart(node, a);
      probe.setEnd(node, b);
      for (const r of probe.getClientRects()) {
        if (x >= r.left - GLYPH_SLACK && x <= r.right + GLYPH_SLACK && y >= r.top - 2 && y <= r.bottom + 2) return true;
      }
    }
    return false;
  }

  /** A block inside a cell was taken up: that cell is being edited. */
  function onBlockFocus(cell, inner) {
    if (T.editing && T.editing !== cell) markEditing(T.editing, false);
    T.mode = "edit";
    T.editing = cell;
    markEditing(cell, true);
    T.sel = { ranges: [cellRange(cell)], anchor: { r: cell.r, c: cell.c }, active: { r: cell.r, c: cell.c } };
    markSel();
    lift(inner);
    // A picture holds no caret. The table's keys hold the focus for it, so Esc
    // still means "back to the cell" and not "leave the editor".
    const el = els.get(cell);
    if (!inner.editable && !(el && el.contains(document.activeElement))) keys.focus({ preventScroll: true });
    draw();
    ctx.onOptionsChanged();
  }

  /** …and put down again — for another block, the cell itself, or elsewhere. */
  function onBlockBlur(cell, inner, next) {
    if (lifted && lifted.view === inner) drop();
    if (next === view || (next && view.el.contains(next.el))) return;
    if (T.sel || T.editing) clearSel();
  }

  /**
   * Put a caret in a cell: at a point, at its start, or at its END — which is
   * where typing into a selected cell goes, so nothing it held is replaced. A
   * cell ending in a picture gets a paragraph after it to type into.
   */
  function enterEdit(cell, where) {
    if (T.editing && T.editing !== cell) leaveEdit();
    T.mode = "edit";
    T.editing = cell;
    if (!T.sel || activeCell() !== cell) {
      T.sel = { ranges: [cellRange(cell)], anchor: { r: cell.r, c: cell.c }, active: { r: cell.r, c: cell.c } };
    }
    markSel();
    const el = els.get(cell);
    markEditing(cell, true);
    draw();

    if (T.flat) {
      el.contentEditable = "true";
      el.classList.add("ed-rich");
      if (where && where.x != null) {
        const range = caretFrom(where.x, where.y);
        el.focus({ preventScroll: true });
        if (range && el.contains(range.startContainer)) {
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(range);
          return;
        }
      }
      return void (where === "start" ? caret.focusStart(el) : caret.focusEnd(el));
    }

    const box = boxes.get(cell);
    if (!box || !box.views.length) return;
    const views = box.views;
    const target = where === "start" ? views[0] : views[views.length - 1];
    const typed = target.block.type === "paragraph" || target.block.type === "heading" || target.block.type === "quote" || target.block.type === "list";
    if (typed || (where === "start" && target.focus)) return void target.focus(where === "start" ? "start" : "end");
    ctx.onSplit(target.block.id, "");
  }

  /** Out of a cell, back to it selected — or, `quiet`, out of it altogether. */
  function leaveEdit(quiet) {
    const cell = T.editing;
    if (!cell) return;
    T.editing = null;
    markEditing(cell, false);
    drop();
    const el = els.get(cell);
    if (T.flat && el) {
      el.contentEditable = "false";
      el.classList.remove("ed-rich");
      cell.body = richToMarkdown(el);
      flatRender(cell);
    }
    const box = boxes.get(cell);
    if (box) ctx.writeBox(box);
    if (!quiet) T.mode = "cells";
  }

  /** Arrow keys off the top or bottom of a cell carry on in the next one. */
  function walkEdit(cell, delta) {
    const model = T.model;
    const r = delta > 0 ? cell.r + cell.rs : cell.r - 1;
    if (r < 0 || r >= model.slots.length) return;
    const next = model.slots[r][cell.c];
    enterEdit(next, delta > 0 ? "start" : "end");
  }

  /* ─── moving the selection ─────────────────────────────────────────────── */

  /**
   * One step from the active cell — past a merged cell, not into it — or, with
   * Shift, one step of the range's far corner, the anchor staying put.
   */
  function step(dr, dc, extend, jump) {
    if (!T.sel) return;
    const model = T.model;
    const H = model.slots.length;
    const W = model.cols.length;
    const from = extend ? T.sel.edge || T.sel.active : T.sel.active;
    const here = model.slots[from.r][from.c];
    let { r, c } = from;
    if (jump) {
      if (dr) r = dr > 0 ? H - 1 : 0;
      if (dc) c = dc > 0 ? W - 1 : 0;
    } else {
      if (dr > 0) r = here.r + here.rs;
      if (dr < 0) r = here.r - 1;
      if (dc > 0) c = here.c + here.cs;
      if (dc < 0) c = here.c - 1;
    }
    r = Math.max(0, Math.min(H - 1, r));
    c = Math.max(0, Math.min(W - 1, c));
    if (extend) {
      selectAt({ r, c }, "extend");
      T.sel.edge = { r, c };
      return;
    }
    selectCell(model.slots[r][c]);
    reveal();
  }

  function tabStep(back) {
    if (!T.sel) return;
    const model = T.model;
    const cells = cellsOf(model);
    const at = cells.indexOf(activeCell());
    const next = cells[at + (back ? -1 : 1)];
    if (next) {
      selectCell(next);
      reveal();
    }
  }

  /** Keep the active cell in view, sideways inside the scroller. */
  function reveal() {
    const el = els.get(activeCell());
    if (!el) return;
    const box = el.getBoundingClientRect();
    const frame = scroll.getBoundingClientRect();
    if (box.left < frame.left) scroll.scrollLeft -= frame.left - box.left + 12;
    else if (box.right > frame.right) scroll.scrollLeft += box.right - frame.right + 12;
    if (box.top < 80 || box.bottom > window.innerHeight - 40) el.scrollIntoView({ block: "nearest" });
  }

  /* ─── operations ───────────────────────────────────────────────────────── */

  const slotsCopy = () => T.model.slots.map((row) => row.slice());

  function rebuild(slots, patch) {
    T.model = A.tableFromSlots(Object.assign({}, T.model, patch || {}), slots);
  }

  /** Bounds of everything selected, as rows and columns. */
  function span(kind) {
    const ranges = T.sel ? T.sel.ranges : [];
    if (!ranges.length) return null;
    const lo = Math.min(...ranges.map((r) => (kind === "rows" ? r.r0 : r.c0)));
    const hi = Math.max(...ranges.map((r) => (kind === "rows" ? r.r1 : r.c1)));
    return { lo, hi };
  }

  function blankLike(cell) {
    return A.tableCell(cell ? { align: cell.align, bg: cell.bg } : {});
  }

  /** New rows at `at`. A cell spanning the line they go in simply grows. */
  function insertRows(at, count) {
    const slots = slotsCopy();
    const W = T.model.cols.length;
    for (let n = 0; n < count; n++) {
      const row = [];
      for (let c = 0; c < W; c++) {
        const above = at > 0 ? slots[at - 1][c] : null;
        const below = at < slots.length ? slots[at][c] : null;
        row.push(above && above === below ? above : blankLike(above || below));
      }
      slots.splice(at, 0, row);
    }
    rebuild(slots, { head: at < T.model.head ? T.model.head + count : T.model.head });
  }

  function insertCols(at, count) {
    const slots = slotsCopy();
    const cols = T.model.cols.slice();
    for (let n = 0; n < count; n++) {
      for (const row of slots) {
        const left = at > 0 ? row[at - 1] : null;
        const right = at < row.length ? row[at] : null;
        row.splice(at, 0, left && left === right ? left : blankLike(left || right));
      }
      cols.splice(at, 0, null);
    }
    // A table of fixed columns gives the new ones the average share and makes
    // room for them out of every other column alike; a table whose widths the
    // content decides simply has more content.
    const manual = cols.filter((w) => w != null);
    if (manual.length) {
      const share = manual.reduce((a, b) => a + b, 0) / manual.length;
      for (let i = at; i < at + count; i++) cols[i] = share;
      normaliseCols(cols);
    }
    rebuild(slots, { cols });
  }

  function deleteRows(r0, r1) {
    const H = T.model.slots.length;
    if (r1 - r0 + 1 >= H) return false;
    const slots = slotsCopy();
    slots.splice(r0, r1 - r0 + 1);
    const head = T.model.head - Math.max(0, Math.min(T.model.head, r1 + 1) - r0);
    rebuild(slots, { head: Math.max(0, head) });
    return true;
  }

  function deleteCols(c0, c1) {
    const W = T.model.cols.length;
    if (c1 - c0 + 1 >= W) return false;
    const slots = slotsCopy();
    for (const row of slots) row.splice(c0, c1 - c0 + 1);
    const cols = T.model.cols.slice();
    cols.splice(c0, c1 - c0 + 1);
    if (cols.every((w) => w != null)) normaliseCols(cols);
    rebuild(slots, { cols });
    return true;
  }

  /** Fixed shares add up to the table; beside content-sized columns, to less. */
  function normaliseCols(cols) {
    const manual = cols.filter((w) => w != null);
    if (!manual.length) return cols;
    const sum = manual.reduce((a, b) => a + b, 0);
    const autos = cols.length - manual.length;
    const room = autos ? Math.min(sum, 100 - autos * 6) : 100;
    const k = room / sum;
    for (let i = 0; i < cols.length; i++) if (cols[i] != null) cols[i] = Math.max(1, cols[i] * k);
    return cols;
  }

  /**
   * Merge: one cell over the whole range, holding what every cell in it held,
   * in reading order — a table cell can hold more than a spreadsheet's can, so
   * nothing needs to be thrown away.
   */
  function merge(range) {
    const r = expand(T.model, range);
    const cells = cellsIn(T.model, [r]).sort((a, b) => a.r - b.r || a.c - b.c);
    if (cells.length < 2) return false;
    const keep = cells[0];
    keep.body = cells.map((cell) => cell.body.trim()).filter(Boolean).join("\n\n");
    const slots = slotsCopy();
    for (let y = r.r0; y <= r.r1; y++) for (let x = r.c0; x <= r.c1; x++) slots[y][x] = keep;
    rebuild(slots);
    const box = boxes.get(keep);
    if (box) ctx.fillBox(box, keep.body);
    flatRender(keep);
    return true;
  }

  function unmerge(ranges) {
    const slots = slotsCopy();
    let did = false;
    for (const cell of cellsIn(T.model, ranges)) {
      if (cell.cs === 1 && cell.rs === 1) continue;
      did = true;
      const [top, right, bottom, left] = cell.border;
      for (let y = cell.r; y < cell.r + cell.rs; y++) {
        for (let x = cell.c; x < cell.c + cell.cs; x++) {
          const edge = [
            y === cell.r ? top : "",
            x === cell.c + cell.cs - 1 ? right : "",
            y === cell.r + cell.rs - 1 ? bottom : "",
            x === cell.c ? left : "",
          ];
          if (y === cell.r && x === cell.c) cell.border = edge;
          else slots[y][x] = A.tableCell({ align: cell.align, bg: cell.bg, border: edge });
        }
      }
    }
    if (did) rebuild(slots);
    return did;
  }

  /** Move rows `r0..r1` so they start at insertion line `to`. */
  function moveRows(r0, r1, to) {
    const model = T.model;
    const n = r1 - r0 + 1;
    if (to >= r0 && to <= r1 + 1) return "same";
    const whole = { r0, r1, c0: 0, c1: model.cols.length - 1 };
    if (crossed(model, whole)) return "merged";
    if (to > 0 && to < model.slots.length && model.slots[to - 1].some((cell, c) => cell === model.slots[to][c])) return "merged";
    const slots = slotsCopy();
    const block = slots.splice(r0, n);
    slots.splice(to > r0 ? to - n : to, 0, ...block);
    rebuild(slots);
    return "ok";
  }

  function moveCols(c0, c1, to) {
    const model = T.model;
    const n = c1 - c0 + 1;
    if (to >= c0 && to <= c1 + 1) return "same";
    const whole = { r0: 0, r1: model.slots.length - 1, c0, c1 };
    if (crossed(model, whole)) return "merged";
    if (to > 0 && to < model.cols.length && model.slots.some((row) => row[to - 1] === row[to])) return "merged";
    const slots = slotsCopy();
    for (const row of slots) {
      const part = row.splice(c0, n);
      row.splice(to > c0 ? to - n : to, 0, ...part);
    }
    const cols = model.cols.slice();
    const part = cols.splice(c0, n);
    cols.splice(to > c0 ? to - n : to, 0, ...part);
    rebuild(slots, { cols });
    return "ok";
  }

  /** Grow the grid to hold `h × w` cells from (r, c). */
  function room(r, c, h, w) {
    const H = T.model.slots.length;
    const W = T.model.cols.length;
    if (r + h > H) insertRows(H, r + h - H);
    if (c + w > W) insertCols(W, c + w - W);
  }

  const snapshot = (cell) => ({ body: cell.body, align: cell.align, bg: cell.bg, border: cell.border.slice(), cs: cell.cs, rs: cell.rs });

  function setBody(cell, body) {
    if (cell.body === body) return;
    cell.body = body;
    const box = boxes.get(cell);
    if (box) {
      ctx.fillBox(box, body);
      ctx.writeBox(box);
    }
    flatRender(cell);
  }

  /**
   * Cells from `clip` into the table at (r, c). Spans come across when the
   * place they land holds no merge of its own; otherwise only what each cell
   * says lands, in the cells that are there.
   */
  function pasteClip(clip, r, c) {
    const model = () => T.model;
    const h = clip.h || clip.cells.length;
    const w = clip.w || clip.cells[0].length;
    const format = !!clip.own;

    // One value over a larger selection fills every selected cell, as a
    // spreadsheet does.
    if (h === 1 && w === 1 && T.sel && selectedCells().length > 1) {
      const one = clip.cells[0][0];
      for (const cell of selectedCells()) {
        setBody(cell, one.body || "");
        if (format) Object.assign(cell, { align: one.align || "", bg: one.bg || "" });
      }
      return true;
    }

    room(r, c, h, w);
    const area = { r0: r, c0: c, r1: r + h - 1, c1: c + w - 1 };
    const spans = clip.cells.some((row) => row.some((cell) => cell && (cell.cs > 1 || cell.rs > 1)));

    if (spans && !hasMerge(model(), area) && !crossed(model(), area)) {
      const slots = slotsCopy();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const src = clip.cells[y][x];
          if (!src) continue;
          const cell = A.tableCell(
            format ? { align: src.align || "", bg: src.bg || "", border: (src.border || ["", "", "", ""]).slice(), body: src.body || "" } : { body: src.body || "" }
          );
          for (let yy = 0; yy < (src.rs || 1); yy++) for (let xx = 0; xx < (src.cs || 1); xx++) {
            if (y + yy < h && x + xx < w) slots[r + y + yy][c + x + xx] = cell;
          }
        }
      }
      rebuild(slots);
      return true;
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = clip.cells[y][x];
        if (!src) continue;
        const cell = model().slots[r + y][c + x];
        if (cell.r !== r + y || cell.c !== c + x) continue;
        setBody(cell, src.body || "");
        if (format) Object.assign(cell, { align: src.align || "", bg: src.bg || "", border: (src.border || ["", "", "", ""]).slice() });
      }
    }
    return true;
  }

  /**
   * The range as a grid of cells: each one once, where its first slot inside
   * the range is, with its span cut to the range; the slots it covers are 0.
   */
  function copyClip(range) {
    const model = T.model;
    const seen = new Set();
    const cells = [];
    for (let r = range.r0; r <= range.r1; r++) {
      const row = [];
      for (let c = range.c0; c <= range.c1; c++) {
        const cell = model.slots[r][c];
        if (seen.has(cell)) {
          row.push(0);
          continue;
        }
        seen.add(cell);
        row.push(
          Object.assign(snapshot(cell), {
            cs: Math.min(cell.c + cell.cs, range.c1 + 1) - c,
            rs: Math.min(cell.r + cell.rs, range.r1 + 1) - r,
          })
        );
      }
      cells.push(row);
    }
    return { own: true, cells, h: range.r1 - range.r0 + 1, w: range.c1 - range.c0 + 1 };
  }

  function writeClipboard(data, range) {
    const clip = copyClip(range);
    const model = T.model;
    const tsv = [];
    let html = "";
    for (let r = range.r0; r <= range.r1; r++) {
      const line = [];
      let tr = "";
      for (let c = range.c0; c <= range.c1; c++) {
        const cell = model.slots[r][c];
        const anchored = cell.r === r && cell.c === c;
        line.push(tsvCell(anchored ? plainOf(cell.body) : ""));
        if (anchored) {
          const cs = Math.min(cell.cs, range.c1 - c + 1);
          const rs = Math.min(cell.rs, range.r1 - r + 1);
          tr += `<td${cs > 1 ? ` colspan="${cs}"` : ""}${rs > 1 ? ` rowspan="${rs}"` : ""}>${renderMarkdown(cell.body)}</td>`;
        }
      }
      tsv.push(line.join("\t"));
      html += `<tr>${tr}</tr>`;
    }
    data.setData("text/plain", tsv.join("\n"));
    data.setData("text/html", `<table data-redefine-table="${encode(clip)}">${html}</table>`);
    T.clip = clip;
  }

  function clearContents(cells) {
    for (const cell of cells) setBody(cell, "");
  }

  /* ─── alignment, fills, lines ──────────────────────────────────────────── */

  const alignOf = (cell) => cell.align || (cell.r < T.model.head || (T.model.hcol && cell.c === 0) ? "mc" : "ml");

  function applyAlign(value) {
    for (const cell of selectedCells()) cell.align = value;
  }

  function applyFill(value) {
    for (const cell of selectedCells()) cell.bg = value;
  }

  /**
   * Lines, the way a spreadsheet draws them: onto the RANGE — its outside, its
   * inside, one side of it — with the pen chosen in the same row. The cell
   * across an outside edge is cleared on that side, so the line drawn is the
   * one that shows.
   */
  function applyLines(preset) {
    const model = T.model;
    const pen = preset === "clear" ? "" : preset === "none" ? "none" : T.pen.style + (T.pen.colour && T.pen.style !== "none" ? "/" + T.pen.colour : "");
    const penFor = (p) => (p === "thickbox" ? "thick" + (T.pen.colour ? "/" + T.pen.colour : "") : pen);
    for (const range of T.sel.ranges) {
      for (const cell of cellsIn(model, [range])) {
        const top = cell.r <= range.r0;
        const left = cell.c <= range.c0;
        const bottom = cell.r + cell.rs - 1 >= range.r1;
        const right = cell.c + cell.cs - 1 >= range.c1;
        const outer = [top, right, bottom, left];
        for (let side = 0; side < 4; side++) {
          let set = false;
          if (preset === "all" || preset === "clear" || preset === "none") set = true;
          else if (preset === "outside" || preset === "thickbox") set = outer[side];
          else if (preset === "inside") set = !outer[side];
          else if (preset === "top") set = side === 0 && top;
          else if (preset === "right") set = side === 1 && right;
          else if (preset === "bottom") set = side === 2 && bottom;
          else if (preset === "left") set = side === 3 && left;
          if (!set) continue;
          cell.border[side] = penFor(preset);
          if (outer[side]) for (const other of facing(cell, side)) other.border[(side + 2) % 4] = "";
        }
      }
    }
  }

  function facing(cell, side) {
    const { slots } = T.model;
    const out = new Set();
    const H = slots.length;
    const W = T.model.cols.length;
    if (side === 0 && cell.r > 0) for (let x = 0; x < cell.cs; x++) out.add(slots[cell.r - 1][cell.c + x]);
    if (side === 2 && cell.r + cell.rs < H) for (let x = 0; x < cell.cs; x++) out.add(slots[cell.r + cell.rs][cell.c + x]);
    if (side === 3 && cell.c > 0) for (let y = 0; y < cell.rs; y++) out.add(slots[cell.r + y][cell.c - 1]);
    if (side === 1 && cell.c + cell.cs < W) for (let y = 0; y < cell.rs; y++) out.add(slots[cell.r + y][cell.c + cell.cs]);
    return Array.from(out);
  }

  /* ─── widths ───────────────────────────────────────────────────────────── */

  /** Every column's current share of the table, measured. */
  function measuredShares(geo) {
    const g = geo || geometry();
    const total = g.xs[g.W] - g.xs[0] || 1;
    return T.model.cols.map((_, c) => ((g.xs[c + 1] - g.xs[c]) / total) * 100);
  }

  function setAuto(c0, c1) {
    const cols = T.model.cols.slice();
    for (let c = c0; c <= c1; c++) cols[c] = null;
    normaliseCols(cols);
    T.model.cols = cols;
  }

  function setFixed(c0, c1) {
    const shares = measuredShares();
    const cols = T.model.cols.slice();
    for (let c = c0; c <= c1; c++) cols[c] = shares[c];
    normaliseCols(cols);
    T.model.cols = cols;
  }

  function distribute(c0, c1) {
    const shares = measuredShares();
    const cols = T.model.cols.slice();
    let sum = 0;
    for (let c = c0; c <= c1; c++) sum += cols[c] != null ? cols[c] : shares[c];
    for (let c = c0; c <= c1; c++) cols[c] = sum / (c1 - c0 + 1);
    normaliseCols(cols);
    T.model.cols = cols;
  }

  /**
   * One cell's edge, in its own rows. The grid gains a line where the edge
   * lands — unless one is already within a pixel — every other row spans the
   * split, and a line nothing ends on any more is taken away again.
   */
  function moveCellEdge(k, rows, at) {
    const model = T.model;
    const geo = geometry();
    const total = geo.xs[geo.W] - geo.xs[0];
    const fr = geo.xs.map((x) => (x - geo.xs[0]) / total);
    const want = (at - geo.xs[0]) / total;
    let slots = slotsCopy();
    let cols = measuredShares(geo);

    let line = fr.findIndex((f) => Math.abs(f - want) * total < 1.5);
    if (line < 0) {
      const j = fr.findIndex((f, i) => i < fr.length - 1 && want > f && want < fr[i + 1]);
      if (j < 0) return false;
      for (const row of slots) row.splice(j + 1, 0, row[j]);
      const left = (want - fr[j]) * 100;
      const right = (fr[j + 1] - want) * 100;
      cols.splice(j, 1, left, right);
      fr.splice(j + 1, 0, want);
      line = j + 1;
      if (k > j) k += 1;
    }
    if (line === k) return false;

    for (const r of rows) {
      const row = slots[r];
      if (line < k) for (let x = line; x < k; x++) row[x] = row[k];
      else for (let x = k; x < line; x++) row[x] = row[k - 1];
    }

    // Lines no cell has an edge on any more.
    for (let x = slots[0].length - 1; x >= 1; x--) {
      if (slots.every((row) => row[x] === row[x - 1])) {
        for (const row of slots) row.splice(x, 1);
        cols[x - 1] += cols[x];
        cols.splice(x, 1);
      }
    }
    rebuild(slots, { cols: normaliseCols(cols) });
    return true;
  }

  /** The rows whose edge on line `k` moves with these cells, closed over spans. */
  function edgeRows(k, seed) {
    const model = T.model;
    const rows = new Set(seed);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of Array.from(rows)) {
        for (const cell of [model.slots[r][k - 1], model.slots[r][k]]) {
          if (!cell) continue;
          for (let y = cell.r; y < cell.r + cell.rs; y++) {
            if (!rows.has(y)) {
              rows.add(y);
              grew = true;
            }
          }
        }
      }
    }
    return Array.from(rows).sort((a, b) => a - b);
  }

  /** Line `k` under the pointer, where it is really an edge in this row. */
  function lineAt(p, geo) {
    const r = indexIn(geo.ys, p.y);
    if (r < 0) return null;
    let best = null;
    for (let k = 1; k <= geo.W; k++) {
      const d = Math.abs(p.x - geo.xs[k]);
      if (d > EDGE_HIT || (best && d >= best.d)) continue;
      if (k < geo.W && T.model.slots[r][k - 1] === T.model.slots[r][k]) continue;
      best = { k, r, d };
    }
    return best;
  }

  function onRim(p, geo) {
    if (T.mode !== "cells" || !T.sel) return false;
    const rect = rectOf(mainRange(), geo);
    const inside = p.x > rect.x - BAND_HIT && p.x < rect.x + rect.w + BAND_HIT && p.y > rect.y - BAND_HIT && p.y < rect.y + rect.h + BAND_HIT;
    const core = p.x > rect.x + BAND_HIT && p.x < rect.x + rect.w - BAND_HIT && p.y > rect.y + BAND_HIT && p.y < rect.y + rect.h - BAND_HIT;
    return inside && !core;
  }

  const hideBadge = () => badge.hide();
  const badgeAt = (e, text) => badge.show(escapeHTML(text), e.clientX + 12, e.clientY - 30);

  /* ─── pointer ──────────────────────────────────────────────────────────── */

  let swallow = false;
  let tap = null;

  /** A drag that follows the pointer and scrolls the frame near its sides. */
  function track(e, onMove, onUp) {
    const target = e.currentTarget && e.currentTarget.setPointerCapture ? e.currentTarget : scroll;
    try {
      target.setPointerCapture(e.pointerId);
    } catch (err) {
      /* moves still arrive while over the table */
    }
    let last = e;
    let raf = 0;
    const edge = () => {
      raf = 0;
      const frame = scroll.getBoundingClientRect();
      let dx = 0;
      if (last.clientX < frame.left + AUTO_EDGE) dx = -Math.ceil((frame.left + AUTO_EDGE - last.clientX) / 4);
      else if (last.clientX > frame.right - AUTO_EDGE) dx = Math.ceil((last.clientX - frame.right + AUTO_EDGE) / 4);
      if (dx && scroll.scrollWidth > scroll.clientWidth) {
        scroll.scrollLeft += dx;
        onMove(last);
        raf = requestAnimationFrame(edge);
      }
    };
    const move = (ev) => {
      last = ev;
      onMove(ev);
      if (!raf) raf = requestAnimationFrame(edge);
    };
    const up = (ev) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      if (raf) cancelAnimationFrame(raf);
      onUp(ev, ev.type === "pointercancel");
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  function onPointerDown(e) {
    swallow = false;
    tap = null;
    // The grips have their own hands — and so does a picture's size grip, which
    // must work on a picture in a cell whether or not the cell is being edited.
    if (e.target.closest(".ed-tgrip, .ed-tsel-fill, .ed-img-grip")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const geo = geometry();
    const p = point(e, geo);
    const slot = slotAt(p, geo);
    const line = e.pointerType === "mouse" ? lineAt(p, geo) : null;
    if (!slot && !line) return;

    if (line) {
      e.preventDefault();
      e.stopPropagation();
      swallow = true;
      return void startResize(e, line, geo);
    }

    if (e.pointerType === "mouse" && onRim(p, geo)) {
      e.preventDefault();
      e.stopPropagation();
      swallow = true;
      return void startMove(e, geo, p);
    }

    const cell = T.model.slots[slot.r][slot.c];
    const ranging = e.shiftKey || e.ctrlKey || e.metaKey;

    // On what the cell holds, a press edits that — the caret lands in the
    // words, the picture is selected — exactly as it would in any other box.
    if (!ranging && onContent(e, cell)) return;

    if (e.pointerType !== "mouse") {
      // A finger may be scrolling; only a tap that ends where it began decides.
      const again = T.mode === "cells" && selectedCells().length === 1 && activeCell() === cell;
      tap = { cell, edit: again, x: e.clientX, y: e.clientY };
      return;
    }

    e.stopPropagation();
    swallow = true;
    if (e.shiftKey && T.sel) selectAt(slot, "extend");
    else if ((e.ctrlKey || e.metaKey) && T.sel) selectAt(slot, "add");
    else selectAt(slot, "one");

    track(
      e,
      (ev) => {
        const g = geometry();
        const s = slotAt(point(ev, g), g);
        if (s) selectAt(s, "extend");
      },
      () => {}
    );
  }

  function onMouseDown(e) {
    if (!swallow && !(tap && !tap.edit)) return;
    if (e.target.closest(".ed-tgrip, .ed-tsel-fill, .ed-img-grip")) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onClick(e) {
    if (tap) {
      const t0 = tap;
      tap = null;
      if (Math.hypot(e.clientX - t0.x, e.clientY - t0.y) > 12) return;
      e.preventDefault();
      e.stopPropagation();
      if (t0.edit) enterEdit(t0.cell, "end");
      else selectCell(t0.cell);
      return;
    }
    if (!swallow) return;
    swallow = false;
    e.preventDefault();
    e.stopPropagation();
  }

  function onDblClick(e) {
    const geo = geometry();
    const p = point(e, geo);
    const line = lineAt(p, geo);
    if (line && line.k < geo.W) {
      // A spreadsheet's double click on a column edge fits it to its content.
      e.preventDefault();
      setAuto(line.k - 1, line.k - 1);
      return void restructure(() => {});
    }
    const slot = slotAt(p, geo);
    if (!slot) return;
    const cell = T.model.slots[slot.r][slot.c];
    // A word double-clicked is a word selected, as anywhere else.
    if ((T.mode === "edit" && T.editing === cell) || onContent(e, cell)) return;
    e.preventDefault();
    enterEdit(cell, "end");
  }

  function onHover(e) {
    if (e.buttons) return;
    const geo = geometry();
    const p = point(e, geo);
    const mouse = e.pointerType === "mouse";
    const line = mouse ? lineAt(p, geo) : null;
    const rim = !line && mouse && onRim(p, geo);
    const slot = slotAt(p, geo);
    let cursor = line ? "resize" : rim ? (e.ctrlKey || e.metaKey ? "copy" : "move") : "";
    // The spreadsheet's cross where a press selects the cell; the ordinary
    // pointer — a text beam over words — where it edits what the cell holds.
    if (!cursor && mouse && slot) {
      const cell = T.model.slots[slot.r][slot.c];
      if (T.editing !== cell && !onContent(e, cell)) cursor = "cell";
    }
    if (scroll.dataset.cursor !== cursor) scroll.dataset.cursor = cursor;
    const frame = scroll.getBoundingClientRect();
    const corner = e.clientX - frame.left < CORNER + GRIP + CLEAR && e.clientY - frame.top < CORNER + GRIP + CLEAR;
    if (corner !== inCorner || (slot && (!hoverSlot || hoverSlot.r !== slot.r || hoverSlot.c !== slot.c))) {
      inCorner = corner;
      if (slot) hoverSlot = slot;
      placeGrips(geo);
    }
    if (line) {
      guideEl.classList.add("is-hover");
      // The last line's guide stays inside the frame, which clips it.
      place(guideEl, { x: geo.xs[line.k] - (line.k === geo.W ? 2 : 1), y: geo.ys[0], w: 2, h: geo.ys[geo.H] - geo.ys[0] });
    } else guideEl.classList.remove("is-hover");
  }

  function onLeave() {
    scroll.dataset.cursor = "";
    guideEl.classList.remove("is-hover");
  }

  function onLeaveBlock() {
    hoverSlot = null;
    inCorner = false;
    placeGrips();
  }

  /* ─── resizing ─────────────────────────────────────────────────────────── */

  function startResize(e, line, geo) {
    const model = T.model;
    const W = geo.W;
    const k = line.k;
    const tableW = geo.xs[W] - geo.xs[0];

    // The table's own right edge is the LAST column's, as in any table editor:
    // dragging it in narrows that column and the table with it, every other
    // column keeping its width. The table's width then goes on the frame a
    // picture's size uses — a share of the widest column — so a table made
    // narrower on a desktop is still the full column on a phone.
    if (k === W) {
      const column = container.parentElement.getBoundingClientRect().width;
      const reference = parseFloat(getComputedStyle(container).getPropertyValue("--img-ref")) || 1000;
      const widths = geo.xs.slice(1).map((x, i) => x - geo.xs[i]);
      const before = widths.slice(0, W - 1).reduce((a, b) => a + b, 0);
      const colEls = Array.from(colgroup.children);
      const shares = (total) => widths.map((w, i) => ((i < W - 1 ? w : total - before) / total) * 100);
      const sizeOf = (total) => (total >= column - 2 ? 0 : Math.max(10, Math.min(99, Math.round((100 * total) / reference))));
      let total = tableW;
      let moved = false;
      track(
        e,
        (ev) => {
          const g = geometry();
          total = Math.max(before + MIN_COL, Math.min(column, point(ev, g).x - g.xs[0]));
          if (Math.abs(total - tableW) > 0.5) moved = true;
          const size = sizeOf(total);
          container.classList.toggle("is-sized", !!size);
          container.classList.remove("is-fit");
          container.style.setProperty("--table-size", String(size ? total / reference : 1));
          shares(total).forEach((w, i) => (colEls[i].style.width = w.toFixed(3) + "%"));
          stale();
          badgeAt(ev, size ? size + "%" : t("t_full", "Full width"));
          drawSoon();
        },
        (ev, cancelled) => {
          hideBadge();
          if (cancelled || !moved) return void paint();
          T.model.size = sizeOf(total);
          T.model.cols = shares(total);
          restructure(() => {});
        }
      );
      return;
    }

    // With cells selected on this edge, only their rows move; otherwise the
    // whole line does.
    const kind = T.sel && mainRange().kind;
    const selected = T.mode === "cells" && T.sel && kind !== "cols" && kind !== "all" ? new Set(selectedCells()) : null;
    const seed = [];
    if (selected) {
      for (const cell of selected) {
        if (cell.c === k || cell.c + cell.cs === k) for (let y = cell.r; y < cell.r + cell.rs; y++) seed.push(y);
      }
    }
    const rows = seed.length ? edgeRows(k, seed) : null;

    // How far the edge may travel: never past the next edge of any cell it
    // moves with, less a column's width.
    let lo = geo.xs[0] + MIN_COL;
    let hi = geo.xs[W] - MIN_COL;
    const rowsFor = rows || Array.from({ length: geo.H }, (_, i) => i);
    for (const r of rowsFor) {
      const left = model.slots[r][k - 1];
      const right = model.slots[r][k];
      if (left) lo = Math.max(lo, geo.xs[left.c] + MIN_COL);
      if (right) hi = Math.min(hi, geo.xs[right.c + right.cs] - MIN_COL);
    }
    if (!rows) {
      lo = Math.max(lo, geo.xs[k - 1] + MIN_COL);
      hi = Math.min(hi, geo.xs[k + 1] - MIN_COL);
    }

    const shares = measuredShares(geo);
    const cols = model.cols.slice();
    const colEls = Array.from(colgroup.children);
    let at = geo.xs[k];
    let moved = false;
    guideEl.classList.add("is-live");
    guideEl.classList.toggle("is-cells", !!rows);

    track(
      e,
      (ev) => {
        const g = geometry();
        at = Math.max(lo, Math.min(hi, point(ev, g).x));
        if (Math.abs(at - geo.xs[k]) > 0.5) moved = true;
        const top = rows ? g.ys[rows[0]] : g.ys[0];
        const bottom = rows ? g.ys[rows[rows.length - 1] + 1] : g.ys[g.H];
        place(guideEl, { x: at - 1, y: top, w: 2, h: bottom - top });
        if (!rows) {
          // The whole line moves live: the two columns either side of it trade
          // width, every other column keeps what it had.
          const a = ((at - geo.xs[k - 1]) / tableW) * 100;
          const b = ((geo.xs[k + 1] - at) / tableW) * 100;
          cols[k - 1] = a;
          cols[k] = b;
          colEls[k - 1].style.width = a.toFixed(2) + "%";
          colEls[k].style.width = b.toFixed(2) + "%";
          stale();
          badgeAt(ev, `${Math.round(a)}% · ${Math.round(b)}%`);
          drawSoon();
        } else {
          badgeAt(ev, `${Math.round(((at - geo.xs[0]) / tableW) * 100)}%`);
        }
      },
      (ev, cancelled) => {
        guideEl.classList.remove("is-live", "is-cells");
        hideBadge();
        if (cancelled || !moved) return void paint();
        if (!rows) {
          // Every column the line touched is fixed from here; the rest keep
          // whatever they were.
          for (let c = 0; c < cols.length; c++) if (cols[c] == null && (c === k - 1 || c === k)) cols[c] = shares[c];
          T.model.cols = normaliseCols(cols);
          return void restructure(() => {});
        }
        restructure(() => moveCellEdge(k, rows, at));
      }
    );
  }

  /* ─── carrying cells ───────────────────────────────────────────────────── */

  function startMove(e, geo, p) {
    const src = mainRange();
    const h = src.r1 - src.r0 + 1;
    const w = src.c1 - src.c0 + 1;
    const grab = slotAt(p, geo) || { r: src.r0, c: src.c0 };
    const dr = Math.max(0, Math.min(h - 1, grab.r - src.r0));
    const dc = Math.max(0, Math.min(w - 1, grab.c - src.c0));
    let to = { r: src.r0, c: src.c0 };
    ghostEl.classList.add("is-on");
    place(ghostEl, rectOf(src, geo));

    track(
      e,
      (ev) => {
        const g = geometry();
        const s = slotAt(point(ev, g), g);
        if (!s) return;
        to = { r: Math.max(0, s.r - dr), c: Math.max(0, s.c - dc) };
        const r1 = Math.min(g.H - 1, to.r + h - 1);
        const c1 = Math.min(g.W - 1, to.c + w - 1);
        ghostEl.dataset.copy = ev.ctrlKey || ev.metaKey || ev.altKey ? "1" : "0";
        place(ghostEl, rectOf({ r0: to.r, c0: to.c, r1, c1 }, g));
      },
      (ev, cancelled) => {
        ghostEl.classList.remove("is-on");
        if (cancelled || (to.r === src.r0 && to.c === src.c0)) return;
        const copy = ev.ctrlKey || ev.metaKey || ev.altKey;
        transfer(src, to, copy);
      }
    );
  }

  /** Cells, contents and formats, from one place to another — or copied there. */
  function transfer(src, to, copy) {
    const model = T.model;
    if (crossed(model, src)) return void refuse();
    const clip = copyClip(src);
    const h = clip.h;
    const w = clip.w;
    restructure(() => {
      room(to.r, to.c, h, w);
      const area = { r0: to.r, c0: to.c, r1: to.r + h - 1, c1: to.c + w - 1 };
      if (crossed(T.model, area)) return;
      if (!copy) {
        for (const cell of cellsIn(T.model, [src])) {
          if (within(area, cell.r, cell.c)) continue;
          setBody(cell, "");
          Object.assign(cell, { align: "", bg: "", border: ["", "", "", ""] });
        }
        if (hasMerge(T.model, src)) unmerge([src]);
      }
      pasteClip(clip, to.r, to.c);
      const end = T.model.slots[to.r][to.c];
      T.sel = { ranges: [expand(T.model, area)], anchor: { r: end.r, c: end.c }, active: { r: end.r, c: end.c } };
    });
  }

  function refuse() {
    if (ctx.notice) ctx.notice("warn", t("t_merged_refuse", "Part of a merged cell cannot move on its own - unmerge it first."));
    wrap.classList.remove("is-refused");
    void wrap.offsetWidth;
    wrap.classList.add("is-refused");
  }

  /* ─── grips: select, and drag to reorder ───────────────────────────────── */

  function wireGrip(grip, kind) {
    grip.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const at = Number(grip.dataset.at) || 0;
      if (kind === "all") return void selectLines("all", 0, 0);

      const main = mainRange();
      const axis = kind === "cols" ? "c" : "r";
      const already = main && main.kind === kind && at >= main[axis + "0"] && at <= main[axis + "1"];
      if (!already) {
        if (e.shiftKey && main && main.kind === kind) selectLines(kind, main[axis + "0"], at);
        else selectLines(kind, at, at, e.ctrlKey || e.metaKey);
      } else focusKeys();

      const range = mainRange();
      const lo = range[axis + "0"];
      const hi = range[axis + "1"];
      const x0 = e.clientX;
      const y0 = e.clientY;
      let dragging = false;
      let to = -1;

      track(
        e,
        (ev) => {
          if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START) return;
          dragging = true;
          const g = geometry();
          const p = point(ev, g);
          const list = kind === "cols" ? g.xs : g.ys;
          const v = kind === "cols" ? p.x : p.y;
          let best = 0;
          for (let i = 1; i < list.length; i++) if (Math.abs(list[i] - v) < Math.abs(list[best] - v)) best = i;
          to = best;
          dropEl.classList.add("is-on");
          dropEl.dataset.kind = kind;
          if (kind === "cols") place(dropEl, { x: list[best] - 2, y: g.ys[0], w: 4, h: g.ys[g.H] - g.ys[0] });
          else place(dropEl, { x: g.xs[0], y: list[best] - 2, w: g.xs[g.W] - g.xs[0], h: 4 });
          const band = kind === "cols" ? { x: g.xs[lo] + (p.x - (g.xs[lo] + g.xs[hi + 1]) / 2), y: g.ys[0], w: g.xs[hi + 1] - g.xs[lo], h: g.ys[g.H] - g.ys[0] } : { x: g.xs[0], y: g.ys[lo] + (p.y - (g.ys[lo] + g.ys[hi + 1]) / 2), w: g.xs[g.W] - g.xs[0], h: g.ys[hi + 1] - g.ys[lo] };
          ghostEl.classList.add("is-on", "is-lift");
          place(ghostEl, band);
        },
        (ev, cancelled) => {
          dropEl.classList.remove("is-on");
          ghostEl.classList.remove("is-on", "is-lift");
          if (!dragging || cancelled || to < 0) return;
          const moved = kind === "cols" ? moveCols : moveRows;
          let result = "same";
          restructure(() => {
            result = moved(lo, hi, to);
            if (result !== "ok") return;
            const n = hi - lo + 1;
            const start = to > lo ? to - n : to;
            const model = T.model;
            T.sel = kind === "cols"
              ? { ranges: [{ r0: 0, r1: model.slots.length - 1, c0: start, c1: start + n - 1, kind }], anchor: { r: 0, c: start }, active: { r: model.slots[0][start].r, c: model.slots[0][start].c } }
              : { ranges: [{ r0: start, r1: start + n - 1, c0: 0, c1: model.cols.length - 1, kind }], anchor: { r: start, c: 0 }, active: { r: model.slots[start][0].r, c: model.slots[start][0].c } };
          }).then(() => {
            if (result === "merged") refuse();
          });
        }
      );
    });
  }

  wireGrip(colGrip, "cols");
  wireGrip(rowGrip, "rows");
  wireGrip(allGrip, "all");

  for (const [handle, side] of [[edgeL, "l"], [edgeR, "r"]]) {
    handle.addEventListener("pointerdown", (e) => {
      const range = mainRange();
      if (!range || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      e.stopPropagation();
      startResize(e, { k: side === "l" ? range.c0 : range.c1 + 1, r: range.r0 }, geometry());
    });
  }

  // The corner of the selection extends it — a finger's Shift.
  fillEl.addEventListener("pointerdown", (e) => {
    if (!T.sel) return;
    e.preventDefault();
    e.stopPropagation();
    focusKeys();
    track(
      e,
      (ev) => {
        const g = geometry();
        const s = slotAt(point(ev, g), g);
        if (s) selectAt(s, "extend");
      },
      () => {}
    );
  });

  // A flat cell is one editable; what is typed in it is read on every input.
  table.addEventListener("input", (e) => {
    if (!T.flat) return;
    const td = e.target.closest && e.target.closest(".ed-cell-flat");
    const hit = td && Array.from(els.entries()).find(([, el]) => el === td);
    if (!hit) return;
    hit[0].body = richToMarkdown(td);
    commit();
    drawSoon();
  });

  scroll.addEventListener("pointerdown", onPointerDown, true);
  scroll.addEventListener("mousedown", onMouseDown, true);
  scroll.addEventListener("click", onClick, true);
  scroll.addEventListener("dblclick", onDblClick, true);
  scroll.addEventListener("pointermove", onHover);
  scroll.addEventListener("pointerleave", onLeave);
  wrap.addEventListener("pointerleave", onLeaveBlock);
  scroll.addEventListener(
    "scroll",
    () => {
      placeLayer();
      placeGrips();
      placeLifted();
    },
    { passive: true }
  );

  /* ─── keys ─────────────────────────────────────────────────────────────── */

  keys.addEventListener("keydown", (e) => {
    if (T.mode === "edit" && e.key === "Escape") {
      // A picture selected inside a cell hands back to the cell.
      e.preventDefault();
      leaveEdit();
      return void selectCell(activeCell());
    }
    if (T.mode !== "cells" || !T.sel) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;

    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[key]) {
      e.preventDefault();
      return void step(arrows[key][0], arrows[key][1], e.shiftKey, mod);
    }
    if (key === "Tab") {
      e.preventDefault();
      return void tabStep(e.shiftKey);
    }
    if (key === "Enter") {
      e.preventDefault();
      return void step(e.shiftKey ? -1 : 1, 0, false, false);
    }
    if (key === "Home" || key === "End") {
      e.preventDefault();
      const model = T.model;
      const r = mod ? (key === "Home" ? 0 : model.slots.length - 1) : T.sel.active.r;
      const c = key === "Home" ? 0 : model.cols.length - 1;
      return void selectCell(model.slots[r][c]);
    }
    if (key === "F2") {
      e.preventDefault();
      return void enterEdit(activeCell(), "end");
    }
    if (key === "Escape") {
      e.preventDefault();
      return void clearSel();
    }
    if (key === "Delete" || key === "Backspace") {
      e.preventDefault();
      clearContents(selectedCells());
      return void commit("table");
    }
    if (mod && (key === "a" || key === "A")) {
      e.preventDefault();
      return void selectLines("all", 0, 0);
    }
    if (key === " " && (mod || e.shiftKey)) {
      e.preventDefault();
      const range = mainRange();
      return void (mod ? selectLines("cols", range.c0, range.c1) : selectLines("rows", range.r0, range.r1));
    }
    if (mod || e.altKey) return;
    // Anything that types — including the first key of an input method, which
    // reports itself as "Process" — starts editing the active cell at its end,
    // and the key lands there because the caret is moved before the browser
    // decides where it goes.
    if (key.length === 1 || key === "Process" || key === "Unidentified") enterEdit(activeCell(), "end");
  });

  keys.addEventListener("copy", (e) => {
    if (T.mode !== "cells" || !T.sel) return;
    e.preventDefault();
    writeClipboard(e.clipboardData, mainRange());
  });

  keys.addEventListener("cut", (e) => {
    if (T.mode !== "cells" || !T.sel) return;
    e.preventDefault();
    writeClipboard(e.clipboardData, mainRange());
    clearContents(selectedCells());
    commit("table");
  });

  keys.addEventListener("paste", (e) => {
    if (T.mode !== "cells" || !T.sel || !e.clipboardData) return;
    // A picture on the clipboard goes INTO the active cell; the canvas's own
    // paste handler does that, through `pasteBox`.
    if (Array.from(e.clipboardData.items || []).some((item) => item.kind === "file")) return;
    e.preventDefault();
    const clip = clipOf(e.clipboardData);
    if (!clip) return;
    const range = mainRange();
    restructure(() => {
      pasteClip(clip, range.r0, range.c0);
      const h = clip.h || clip.cells.length;
      const w = clip.w || clip.cells[0].length;
      const area = expand(T.model, { r0: range.r0, c0: range.c0, r1: range.r0 + h - 1, c1: range.c0 + w - 1 });
      if (!(h === 1 && w === 1 && selectedCells().length > 1)) {
        T.sel = { ranges: [area], anchor: { r: area.r0, c: area.c0 }, active: { r: area.r0, c: area.c0 } };
      }
    });
  });

  // Edit mode: Esc and Tab hand back to the grid, and are the grid's first.
  wrap.addEventListener(
    "keydown",
    (e) => {
      if (T.mode !== "edit" || !T.editing || e.target === keys) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const cell = T.editing;
        leaveEdit();
        return void selectCell(cell);
      }
      if (e.key === "Tab") {
        const host = e.target.closest && e.target.closest("ul, ol");
        if (host && !e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation();
        const cell = T.editing;
        leaveEdit();
        selectCell(cell);
        tabStep(e.shiftKey);
      }
    },
    true
  );

  // Focus leaving the table for anywhere that is not the editor's own chrome
  // ends the selection. A cell of blocks reports its editing through those
  // blocks (`onBlockFocus`); a flat cell has none, and is followed here.
  const onFocusIn = (e) => {
    const target = e.target;
    if (!wrap.isConnected) return;
    if (wrap.contains(target)) {
      if (!T.flat || target === keys) return;
      const td = target.closest && target.closest(".ed-cell-flat");
      const hit = td && Array.from(els.entries()).find(([, el]) => el === td);
      if (!hit || T.editing === hit[0]) return;
      if (T.editing) leaveEdit(true);
      T.mode = "edit";
      T.editing = hit[0];
      markEditing(hit[0], true);
      T.sel = { ranges: [cellRange(hit[0])], anchor: { r: hit[0].r, c: hit[0].c }, active: { r: hit[0].r, c: hit[0].c } };
      markSel();
      return void draw();
    }
    if (target.closest && target.closest(".ed-toolbar, .ed-ask, .ed-picker-mask, .ed-sheet-mask, .ed-sheet, .ed-slash")) return;
    if (T.sel || T.editing) clearSel();
  };
  document.addEventListener("focusin", onFocusIn, true);

  const watcher = new ResizeObserver(() => {
    stale();
    drawSoon();
  });
  watcher.observe(table);
  watcher.observe(scroll);
  const onImage = (e) => {
    if (!e.detail || !e.detail.img || !table.contains(e.detail.img)) return;
    stale();
    drawSoon();
  };
  window.addEventListener("redefine:image-loaded", onImage);

  /* ─── the toolbar ──────────────────────────────────────────────────────── */

  const COLOURS = A.BOX_COLORS;

  function rangeOf(kind) {
    return span(kind) || { lo: 0, hi: kind === "rows" ? T.model.slots.length - 1 : T.model.cols.length - 1 };
  }

  view.options = (open) => {
    const cells = T.sel ? selectedCells() : [];
    const active = T.sel ? activeCell() : null;
    const merged = !!active && cells.length === 1 && (active.cs > 1 || active.rs > 1);
    const settings = [
      { kind: "btn", act: "sub", arg: "t-table", icon: "fa-table-layout", label: "Table", tt: "t_table", open: open === "t-table" },
      { kind: "btn", act: "sub", arg: "t-width", icon: "fa-arrows-left-right-to-line", label: "Widths", tt: "t_width", open: open === "t-width" },
    ];
    if (!T.sel) {
      return [{ kind: "btn", act: "t-select", arg: "all", icon: "fa-table-cells", label: "Select table", tt: "t_sel_all" }, { kind: "sep" }, ...settings];
    }
    return [
      { kind: "btn", act: "t-select", arg: "row", icon: "fa-grip-lines", label: "Select row", tt: "t_sel_row" },
      { kind: "btn", act: "t-select", arg: "col", icon: "fa-grip-lines-vertical", label: "Select column", tt: "t_sel_col" },
      { kind: "btn", act: "t-select", arg: "all", icon: "fa-table-cells", label: "Select table", tt: "t_sel_all" },
      { kind: "sep" },
      { kind: "btn", act: "sub", arg: "t-ins", icon: "fa-table-rows", label: "Insert", tt: "t_insert", open: open === "t-ins" },
      { kind: "btn", act: "sub", arg: "t-del", icon: "fa-trash-can", label: "Delete", tt: "t_delete", open: open === "t-del" },
      {
        kind: "btn",
        act: merged ? "t-unmerge" : "t-merge",
        icon: merged ? "fa-object-ungroup" : "fa-object-group",
        label: merged ? "Unmerge" : "Merge cells",
        tt: merged ? "t_unmerge" : "t_merge",
        on: merged,
        disabled: !merged && cells.length < 2,
      },
      { kind: "sep" },
      { kind: "btn", act: "sub", arg: "t-align", icon: alignIcon(active), label: "Alignment", tt: "t_align", open: open === "t-align" },
      { kind: "btn", act: "sub", arg: "t-fill", icon: "fa-fill-drip", label: "Fill", tt: "t_fill", open: open === "t-fill", on: cells.some((cell) => cell.bg) },
      { kind: "btn", act: "sub", arg: "t-lines", icon: "fa-border-all", label: "Borders", tt: "t_border", open: open === "t-lines", on: cells.some((cell) => cell.border.some(Boolean)) },
      { kind: "sep" },
      ...settings,
    ];
  };

  function alignIcon(cell) {
    const h = cell ? alignOf(cell)[1] : "l";
    return h === "c" ? "fa-align-center" : h === "r" ? "fa-align-right" : "fa-align-left";
  }

  view.subOptions = (key) => {
    const cells = T.sel ? selectedCells() : [];
    const active = T.sel ? activeCell() : null;
    if (key === "t-ins") {
      return [
        { kind: "btn", act: "t-ins", arg: "above", icon: "fa-arrow-up-to-line", label: "Row above", tt: "t_row_above", wide: true },
        { kind: "btn", act: "t-ins", arg: "below", icon: "fa-arrow-down-to-line", label: "Row below", tt: "t_row_below", wide: true },
        { kind: "btn", act: "t-ins", arg: "left", icon: "fa-arrow-left-to-line", label: "Column left", tt: "t_col_left", wide: true },
        { kind: "btn", act: "t-ins", arg: "right", icon: "fa-arrow-right-to-line", label: "Column right", tt: "t_col_right", wide: true },
      ];
    }
    if (key === "t-del") {
      const rows = rangeOf("rows");
      const cols = rangeOf("cols");
      return [
        { kind: "btn", act: "t-del", arg: "rows", icon: "fa-diagram-next", label: "Delete rows", tt: "t_del_rows", wide: true, disabled: rows.hi - rows.lo + 1 >= T.model.slots.length },
        { kind: "btn", act: "t-del", arg: "cols", icon: "fa-line-columns", label: "Delete columns", tt: "t_del_cols", wide: true, disabled: cols.hi - cols.lo + 1 >= T.model.cols.length },
        { kind: "btn", act: "t-del", arg: "clear", icon: "fa-eraser", label: "Clear contents", tt: "t_clear", wide: true },
        { kind: "sep" },
        { kind: "btn", act: "t-clip", arg: "copy", icon: "fa-copy", label: "Copy", tt: "t_copy" },
        { kind: "btn", act: "t-clip", arg: "cut", icon: "fa-scissors", label: "Cut", tt: "t_cut" },
        { kind: "btn", act: "t-clip", arg: "paste", icon: "fa-paste", label: "Paste", tt: "t_paste", disabled: !T.clip && !(navigator.clipboard && navigator.clipboard.read) },
      ];
    }
    if (key === "t-align") {
      const now = active ? alignOf(active) : "";
      return [
        { kind: "label", label: "Alignment", tt: "t_align" },
        ...A.TABLE_ALIGNS.map((a) => ({
          kind: "grid9",
          act: "t-align",
          arg: a,
          label: "Align " + a,
          tt: "t_a_" + a,
          on: cells.length ? cells.every((cell) => alignOf(cell) === a) : now === a,
        })),
      ];
    }
    if (key === "t-fill") {
      const now = cells.length && cells.every((cell) => cell.bg === cells[0].bg) ? cells[0].bg : null;
      return [
        { kind: "btn", act: "t-fill", arg: "", icon: "fa-droplet-slash", label: "No fill", tt: "t_no_fill", on: now === "" },
        { kind: "label", label: "Soft", tt: "t_soft" },
        ...COLOURS.map((c) => ({ kind: "swatch", act: "t-fill", arg: c, cls: "ed-fill-dot bg-" + c, label: c, on: now === c })),
        { kind: "label", label: "Solid", tt: "t_solid" },
        ...COLOURS.map((c) => ({ kind: "swatch", act: "t-fill", arg: c + "-solid", cls: "ed-fill-dot bg-" + c + "-solid", label: c, on: now === c + "-solid" })),
      ];
    }
    if (key === "t-lines") {
      return [
        { kind: "btn", act: "t-lines", arg: "all", icon: "fa-border-all", label: "All borders", tt: "t_b_all" },
        { kind: "btn", act: "t-lines", arg: "outside", icon: "fa-border-outer", label: "Outside borders", tt: "t_b_out" },
        { kind: "btn", act: "t-lines", arg: "inside", icon: "fa-border-inner", label: "Inside borders", tt: "t_b_in" },
        { kind: "btn", act: "t-lines", arg: "top", icon: "fa-border-top", label: "Top border", tt: "t_b_top" },
        { kind: "btn", act: "t-lines", arg: "bottom", icon: "fa-border-bottom", label: "Bottom border", tt: "t_b_bottom" },
        { kind: "btn", act: "t-lines", arg: "left", icon: "fa-border-left", label: "Left border", tt: "t_b_left" },
        { kind: "btn", act: "t-lines", arg: "right", icon: "fa-border-right", label: "Right border", tt: "t_b_right" },
        { kind: "btn", act: "t-lines", arg: "thickbox", icon: "fa-square", label: "Thick outside border", tt: "t_b_thick" },
        { kind: "btn", act: "t-lines", arg: "none", icon: "fa-border-none", label: "No border", tt: "t_b_none" },
        { kind: "btn", act: "t-lines", arg: "clear", icon: "fa-eraser", label: "Reset borders", tt: "t_b_clear" },
        { kind: "sep" },
        { kind: "label", label: "Line", tt: "t_line" },
        ...LINES.filter((s) => s !== "none").map((s) => ({ kind: "line", act: "t-pen", arg: s, label: s, tt: "t_l_" + s, on: T.pen.style === s })),
        { kind: "sep" },
        { kind: "label", label: "Colour", tt: "t_colour" },
        { kind: "swatch", act: "t-ink", arg: "", cls: "ed-ink-dot is-default", label: "Default", tt: "t_ink_default", on: !T.pen.colour },
        { kind: "swatch", act: "t-ink", arg: "accent", cls: "ed-ink-dot is-accent", label: "Accent", tt: "t_ink_accent", on: T.pen.colour === "accent" },
        ...COLOURS.map((c) => ({ kind: "swatch", act: "t-ink", arg: c, cls: "ed-ink-dot ink-" + c, label: c, on: T.pen.colour === c })),
      ];
    }
    if (key === "t-width") {
      const cols = rangeOf("cols");
      const fixed = T.model.cols.slice(cols.lo, cols.hi + 1);
      return [
        { kind: "label", label: "Columns", tt: "t_columns" },
        { kind: "btn", act: "t-width", arg: "auto", icon: "fa-wand-magic-sparkles", label: "Fit to content", tt: "t_auto", wide: true, on: fixed.every((w) => w == null) },
        { kind: "btn", act: "t-width", arg: "fixed", icon: "fa-lock", label: "Fixed ratio", tt: "t_fixed", wide: true, on: fixed.every((w) => w != null) },
        { kind: "btn", act: "t-width", arg: "even", icon: "fa-distribute-spacing-horizontal", label: "Distribute evenly", tt: "t_even", wide: true, disabled: cols.hi <= cols.lo },
        { kind: "sep" },
        { kind: "label", label: "Table", tt: "t_table" },
        { kind: "btn", act: "t-size", arg: "full", icon: "fa-arrows-left-right", label: "Full width", tt: "t_full", wide: true, on: !T.model.size },
        { kind: "btn", act: "t-size", arg: "fit", icon: "fa-down-left-and-up-right-to-center", label: "Fit content", tt: "t_fit", wide: true, on: T.model.size === "fit" },
      ];
    }
    if (key === "t-table") {
      return [
        { kind: "btn", act: "t-flag", arg: "head", icon: "fa-table-rows", label: "Header row", tt: "t_head_row", wide: true, on: T.model.head > 0 },
        { kind: "btn", act: "t-flag", arg: "hcol", icon: "fa-table-columns", label: "Header column", tt: "t_head_col", wide: true, on: !!T.model.hcol },
        { kind: "btn", act: "t-flag", arg: "band", icon: "fa-bars", label: "Banded rows", tt: "t_band", wide: true, on: !!T.model.band },
      ];
    }
    return [];
  };

  view.act = async (act, arg) => {
    const model = T.model;

    if (act === "t-select") {
      if (arg === "all" || !T.sel) return void selectLines("all", 0, 0);
      const range = mainRange();
      return void (arg === "row" ? selectLines("rows", range.r0, range.r1) : selectLines("cols", range.c0, range.c1));
    }
    if (!T.sel && !["t-flag", "t-size", "t-width"].includes(act)) return;

    if (act === "t-ins") {
      const rows = rangeOf("rows");
      const cols = rangeOf("cols");
      return void restructure(() => {
        if (arg === "above") insertRows(rows.lo, rows.hi - rows.lo + 1);
        else if (arg === "below") insertRows(rows.hi + 1, rows.hi - rows.lo + 1);
        else if (arg === "left") insertCols(cols.lo, cols.hi - cols.lo + 1);
        else if (arg === "right") insertCols(cols.hi + 1, cols.hi - cols.lo + 1);
      });
    }
    if (act === "t-del") {
      if (arg === "clear") {
        clearContents(selectedCells());
        return void commit("table");
      }
      const s = rangeOf(arg);
      let done = false;
      await restructure(() => {
        done = arg === "rows" ? deleteRows(s.lo, s.hi) : deleteCols(s.lo, s.hi);
      });
      if (done) {
        const at = arg === "rows" ? { r: Math.min(s.lo, T.model.slots.length - 1), c: 0 } : { r: 0, c: Math.min(s.lo, T.model.cols.length - 1) };
        selectCell(T.model.slots[at.r][at.c]);
      }
      return;
    }
    if (act === "t-merge") {
      const range = expand(model, mainRange());
      return void restructure(() => {
        if (merge(range)) {
          const keep = T.model.slots[range.r0][range.c0];
          T.sel = { ranges: [cellRange(keep)], anchor: { r: keep.r, c: keep.c }, active: { r: keep.r, c: keep.c } };
        }
      });
    }
    if (act === "t-unmerge") {
      const range = mainRange();
      return void restructure(() => {
        unmerge(T.sel.ranges);
        T.sel = { ranges: [range], anchor: T.sel.anchor, active: T.sel.active };
      });
    }
    if (act === "t-align") {
      applyAlign(arg);
      paint();
      return void commit("table");
    }
    if (act === "t-fill") {
      applyFill(arg);
      paint();
      return void commit("table");
    }
    if (act === "t-pen") {
      T.pen.style = arg;
      return void ctx.onOptionsChanged();
    }
    if (act === "t-ink") {
      T.pen.colour = arg;
      return void ctx.onOptionsChanged();
    }
    if (act === "t-lines") {
      applyLines(arg);
      paint();
      return void commit("table");
    }
    if (act === "t-width") {
      const cols = rangeOf("cols");
      if (arg === "auto") setAuto(cols.lo, cols.hi);
      else if (arg === "fixed") setFixed(cols.lo, cols.hi);
      else if (arg === "even") distribute(cols.lo, cols.hi);
      if (T.model.size === "fit" && arg !== "auto") T.model.size = 0;
      return void restructure(() => {});
    }
    if (act === "t-size") {
      if (arg === "fit") {
        T.model.size = "fit";
        T.model.cols = T.model.cols.map(() => null);
      } else T.model.size = 0;
      return void restructure(() => {});
    }
    if (act === "t-flag") {
      if (arg === "head") T.model.head = T.model.head ? 0 : 1;
      else if (arg === "hcol") T.model.hcol = T.model.hcol ? 0 : 1;
      else if (arg === "band") T.model.band = !T.model.band;
      return void restructure(() => rebuild(slotsCopy()));
    }
    if (act === "t-clip") {
      const range = mainRange();
      if (arg === "paste") {
        let clip = null;
        try {
          const items = navigator.clipboard && navigator.clipboard.read ? await navigator.clipboard.read() : [];
          for (const item of items) {
            const html = item.types.includes("text/html") ? await (await item.getType("text/html")).text() : "";
            const text = item.types.includes("text/plain") ? await (await item.getType("text/plain")).text() : "";
            clip = clipOf({ getData: (type) => (type === "text/html" ? html : type === "text/plain" ? text : "") });
            if (clip) break;
          }
        } catch (err) {
          clip = null;
        }
        clip = clip || T.clip;
        if (!clip) return;
        return void restructure(() => pasteClip(clip, range.r0, range.c0));
      }
      const store = new Map();
      const data = { setData: (type, value) => store.set(type, value) };
      writeClipboard(data, range);
      try {
        if (navigator.clipboard && window.ClipboardItem) {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": new Blob([store.get("text/plain")], { type: "text/plain" }),
              "text/html": new Blob([store.get("text/html")], { type: "text/html" }),
            }),
          ]);
        } else if (navigator.clipboard) await navigator.clipboard.writeText(store.get("text/plain"));
      } catch (err) {
        /* the editor's own copy still pastes back inside this table */
      }
      if (arg === "cut") {
        clearContents(selectedCells());
        commit("table");
      }
    }
  };

  /* ─── the block's contract ─────────────────────────────────────────────── */

  view.read = () => {
    if (!T.flat || !T.editing) return;
    const el = els.get(T.editing);
    if (el) T.editing.body = richToMarkdown(el);
    writeBlock();
  };
  view.editable = null;
  view.isEmpty = () => false;
  view.focus = (where) => {
    const cells = cellsOf(T.model);
    const cell = where === "end" ? cells[cells.length - 1] : cells[0];
    if (cell) selectCell(cell);
  };
  view.pasteBox = () => (T.sel && !T.flat ? boxes.get(activeCell()) || null : null);

  /** Another block took the focus: the selection goes, unless it went into a cell. */
  view.defocus = (next) => {
    if (next && next.el && wrap.contains(next.el)) return;
    if (T.sel || T.editing) clearSel();
  };

  /**
   * A step landing on the table. Cells that are still the same cell — the same
   * place and span — keep their element and their box and take the words they
   * are given, so undoing one word in one cell redraws that cell; anything that
   * changed shape is rebuilt around them.
   */
  view.patch = (next, dry) => {
    if (!isTableBlock(next)) return false;
    if (dry) return true;
    helpers.absorb(block, next);
    view.el.dataset.type = block.type;
    T.origin = block.type === "table" ? "gfm" : "tag";
    view.touched = !!block.dirty;

    const incoming = modelOf(block);
    const old = new Map();
    for (const cell of cellsOf(T.model)) old.set(`${cell.r},${cell.c},${cell.cs},${cell.rs}`, cell);
    const slots = incoming.slots.map((row) => row.slice());
    const swap = new Map();
    for (const cell of cellsOf(incoming)) {
      const kept = old.get(`${cell.r},${cell.c},${cell.cs},${cell.rs}`);
      if (!kept) continue;
      old.delete(`${cell.r},${cell.c},${cell.cs},${cell.rs}`);
      Object.assign(kept, { align: cell.align, bg: cell.bg, border: cell.border.slice() });
      if (kept.body !== cell.body) {
        kept.body = cell.body;
        const box = boxes.get(kept);
        if (box) {
          const ready = ctx.fillBox(box, cell.body);
          box.ready = ready;
        }
        flatRender(kept);
      }
      swap.set(cell, kept);
    }
    for (const row of slots) for (let c = 0; c < row.length; c++) if (swap.has(row[c])) row[c] = swap.get(row[c]);
    T.model = A.tableFromSlots(incoming, slots);
    if (T.editing && !cellsOf(T.model).includes(T.editing)) T.editing = null;
    paint();
    if (T.sel) clampSelection();
    refit();
    return true;
  };

  view.release = () => {
    document.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("redefine:image-loaded", onImage);
    watcher.disconnect();
    picWatch.disconnect();
    clearTimeout(fitTimer);
    badge.hide();
  };

  paint();
  view.nests = !T.flat;
  view.ready = Promise.all(Array.from(boxes.values()).map((box) => box.ready).filter(Boolean)).then(() => {
    initTableFit(wrap);
    drawSoon();
  });
}
