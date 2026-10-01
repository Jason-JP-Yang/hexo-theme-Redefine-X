/**
 * A table SERIOUSLY too narrow for its column scrolls instead of being crushed.
 *
 * ── When ────────────────────────────────────────────────────────────────────
 *
 * Wrapping is not a problem. A column given a few more lines than it would
 * like is still read line by line, and cutting the table off at the column's
 * edge to spare it those lines hides content to fix nothing. So a table
 * scrolls only when it has stopped being readable:
 *
 *   · it is WIDER than its column at its narrowest — an unbreakable word, a
 *     URL, a picture — so the page would be pushed sideways; or
 *   · a cell has been squeezed under `SEVERE` ems while its content wants
 *     more: two or three characters a line, which is a column of letters
 *     stacked on top of one another rather than text.
 *
 * Measured, never guessed: the natural layout gives each cell's width, and one
 * pass at `max-content` gives what each one wanted. In a table that has not
 * overflowed every column is already as wide as its narrowest content, so only
 * cells under the severe width need that second pass at all.
 *
 * ── How wide, then ──────────────────────────────────────────────────────────
 *
 * Once it scrolls anyway, wide enough that no cell is under a readable line —
 * `COMFORT` ems, or less where the content itself is shorter — with every
 * column keeping its share: the natural width scaled by the worst shortfall,
 * and never wider than a table in which nothing wraps. A table given a size or
 * fitted to its content first grows into the room its column has.
 *
 * The content fades at an edge with more beyond it (a mask, `fade-l`/`fade-r`
 * on the container) under a caret like a display equation's.
 *
 * Every table is read in one pass and written in the next — three layouts for
 * the whole page, whatever it holds.
 */

const COMFORT = 7;
const SEVERE = 3;
const SETTLE = 300; // ms after the last resize event
const TABLE = ".table-container[data-table]";

let observer = null;
let wired = false;
const queue = new Set();
let frame = 0;
let settle = 0;

function parts(box) {
  const scroll = box.querySelector(":scope > .table-scroll");
  const table = scroll && scroll.querySelector(":scope > table");
  return table ? { box, scroll, table } : null;
}

function hints(job) {
  const { box, scroll } = job;
  const on = box.classList.contains("is-scroll");
  const max = scroll.scrollWidth - scroll.clientWidth;
  box.classList.toggle("fade-l", on && scroll.scrollLeft > 4);
  box.classList.toggle("fade-r", on && scroll.scrollLeft < max - 4);
  if (!on || box.querySelector(":scope > .table-hint")) return;
  for (const side of ["left", "right"]) {
    const hint = document.createElement("div");
    hint.className = "table-hint is-" + side;
    hint.setAttribute("aria-hidden", "true");
    hint.innerHTML = `<i class="fa-solid fa-caret-${side}"></i>`;
    box.appendChild(hint);
  }
}

function onScroll(e) {
  const box = e.currentTarget.parentElement;
  if (box) hints({ box, scroll: e.currentTarget });
}

function run() {
  frame = 0;
  const jobs = Array.from(queue)
    .filter((box) => box.isConnected)
    .map(parts)
    .filter(Boolean);
  queue.clear();
  if (!jobs.length) return;

  // Where each scroller stands. Taken back to its natural width, a table that
  // fits for a moment has nowhere to scroll, the browser puts it back at the
  // start, and a re-fit after every edit threw the author back to column one.
  for (const job of jobs) job.left = job.scroll.scrollLeft;

  // Write: back to the natural layout.
  for (const job of jobs) {
    job.table.style.width = "";
    job.table.style.minWidth = "";
    delete job.table.dataset.fitWidth;
    job.box.style.width = "";
    job.box.classList.remove("is-scroll");
  }

  // Read: the natural layout.
  for (const job of jobs) {
    job.C = job.scroll.clientWidth;
    if (!job.C) continue;
    job.T = job.table.offsetWidth;
    // Cells are read on screen, for their fractions of a pixel; a transformed
    // ancestor (an entrance animation, a zoomed preview) scales that, and every
    // width here is compared with layout ones.
    job.k = (job.T && job.table.getBoundingClientRect().width / job.T) || 1;
    job.cells = Array.from(job.table.querySelectorAll(":scope > * > tr > *"));
    job.a = job.cells.map((cell) => cell.getBoundingClientRect().width / job.k);
    const em = parseFloat(getComputedStyle(job.table).fontSize) || 16;
    job.K = COMFORT * em;
    job.S = SEVERE * em;
    job.frame = job.box.offsetWidth - job.C;
    const parent = job.box.parentElement;
    const pad = parent ? getComputedStyle(parent) : null;
    job.room = parent
      ? parent.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight)
      : job.C;
    job.overflow = job.T > job.C + 1;
    job.narrow = job.overflow || job.a.some((w) => w < job.S - 0.5);
  }

  const measured = jobs.filter((job) => job.C && job.narrow);

  // Write, then read: what every cell wanted.
  for (const job of measured) job.table.style.width = "max-content";
  for (const job of measured) {
    job.M = job.cells.map((cell) => cell.getBoundingClientRect().width / job.k);
    job.Tmax = job.table.offsetWidth;
  }

  // Write: the decision.
  for (const job of jobs) {
    if (!job.C) continue;
    job.table.style.width = "";
    if (!job.narrow) continue;

    const crushed = job.a.some((has, i) => has < job.S - 0.5 && job.M[i] > has + 1);
    if (!job.overflow && !crushed) continue;

    let need = 1;
    for (let i = 0; i < job.cells.length; i++) {
      const has = job.a[i];
      if (has >= job.K - 0.5 || job.M[i] <= has + 0.5) continue;
      need = Math.max(need, Math.min(job.M[i], job.K) / Math.max(1, has));
    }
    const want = Math.ceil(Math.min(Math.max(job.T, job.T * need), Math.max(job.Tmax, job.T)));
    const grows = job.box.classList.contains("is-sized") || job.box.classList.contains("is-fit");

    if (want <= job.C + 1 && !job.overflow) {
      job.table.style.width = want + "px";
      continue;
    }
    if (grows && want + job.frame <= job.room) {
      job.box.style.width = want + job.frame + "px";
      job.table.style.width = want + "px";
      continue;
    }
    if (grows) job.box.style.width = "100%";
    job.box.classList.add("is-scroll");
    job.table.style.width = want + "px";
    job.table.style.minWidth = want + "px";
    job.table.dataset.fitWidth = "";
  }

  // Read and write once more, for the fades: where each scroller now stands.
  for (const job of jobs) {
    job.sb = job.scroll.offsetHeight - job.scroll.clientHeight;
  }
  for (const job of jobs) {
    job.box.style.setProperty("--table-sb", Math.max(0, job.sb) + "px");
    if (job.left && job.box.classList.contains("is-scroll")) job.scroll.scrollLeft = job.left;
    hints(job);
  }
}

function schedule(box) {
  if (!box) return;
  queue.add(box);
  if (!frame) frame = requestAnimationFrame(run);
}

/** Re-measure these tables — the editor calls this after it redraws one. */
export function fitTables(boxes) {
  for (const box of boxes || []) schedule(box);
}

/**
 * The COLUMN is watched, not the table: a table given room to grow changes its
 * own width, and watching that would answer every decision with another one.
 * Only a change of width counts — the column grows taller with every table in
 * it, and that is not a reason to measure again.
 */
function watch(box) {
  const column = box.parentElement;
  if (!column) return;
  if (!observer) {
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = Math.round(entry.contentRect.width);
        if (entry.target.__tableFitW === width) continue;
        entry.target.__tableFitW = width;
        for (const child of entry.target.children) if (child.matches(TABLE)) schedule(child);
      }
    });
  }
  observer.observe(column);
  const scroll = box.querySelector(":scope > .table-scroll");
  if (scroll && !scroll.__tableFit) {
    scroll.__tableFit = true;
    scroll.addEventListener("scroll", onScroll, { passive: true });
  }
}

/**
 * Every table under `root`, or on the page. The page's own call starts the
 * watch list over — the last page's columns are gone.
 */
export default function initTableFit(root) {
  if (!wired) {
    wired = true;
    // A picture arriving in a cell is content the last measurement never saw.
    window.addEventListener("redefine:image-loaded", (e) => {
      const img = e.detail && e.detail.img;
      schedule(img && img.closest && img.closest(TABLE));
    });
    // And every table once more when the window has settled, from scratch, as
    // a reload would. The column's observer answers the first frame of a
    // resize, but the page is still moving then — the article eases to its new
    // width, pictures and equations in cells re-lay themselves out on their own
    // resize handlers — and a table measured mid-way kept a decision made for
    // content that had since changed: scrolling, and still crushed.
    const refitAll = (delay) => {
      clearTimeout(settle);
      settle = setTimeout(() => fitTables(document.querySelectorAll(TABLE)), delay);
    };
    window.addEventListener("resize", () => refitAll(SETTLE), { passive: true });
    // Likewise when the site's fonts arrive: a table measured in the fallback
    // font kept that font's widths.
    if (document.fonts) document.fonts.addEventListener("loadingdone", () => refitAll(60));
  }
  if (!root && observer) observer.disconnect();
  for (const box of (root || document).querySelectorAll(TABLE)) {
    watch(box);
    schedule(box);
  }
}
