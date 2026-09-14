/**
 * The activity card's calendar.
 *
 * It FILLS THE CARD. The column height decides the cell size, the cell size
 * decides how many rows fit in a column, and the width then decides how many
 * columns — so the number of days fetched is a result of the measurement rather
 * than a setting, and the grid lands on the card's box exactly.
 *
 * The rows are NOT weekdays. A seven-row calendar can only ever be as tall as
 * seven cells allow, which on a card this shape means either a stubby grid or
 * cells the size of buttons; letting the column run to whatever length the
 * height affords keeps the cells small and the card full at any size. The price
 * is that a column is not a week — which costs nothing here, because the reading
 * this card offers is the shape of a year, and the month rule along the top is
 * what carries the dates.
 *
 * Three things this file is careful about:
 *
 *   IT MUST NOT GROW THE CARD. bentoFit.js pins the furniture row to the tallest
 *   card in it, so a calendar that set its own card's height would stretch the
 *   whole row — and the row it stretched would re-measure and stretch it again.
 *   The grid is therefore ABSOLUTELY POSITIONED inside the plot: it is sized
 *   down into the box it is given and contributes no height at all.
 *
 *   ONE FETCH PER SHAPE. The days the solver asks for are fetched once and kept
 *   in module state, so a resize that needs no more days re-draws from what is
 *   already in hand — and so does a page turn, which replaces the card's node
 *   but not the series behind it.
 *
 *   IT SURVIVES A PAGE TURN. The home paginator swaps the entire article list,
 *   the card included, so this runs again after every turn. The entrance
 *   animation does not: it belongs to the first arrival, not to every page.
 */

import { analyticsReady, analyticsConfig, dailyViews } from "../tools/analytics.js";

const GAP = 3;
const CELL_MIN = 7;
const CELL_MAX = 15;
const ROWS_MIN = 5;
const ROWS_MAX = 16;
const MAX_DAYS = 730;
const MONTH_ROW = 15;
const LEVELS = 5;

let observer = null;
let card = null;
let series = null;
let fetched = 0;
let pending = 0;
let shape = null;
let entered = false;

/* ─── geometry ────────────────────────────────────────────────────────────── */

/**
 * As many rows as the height takes at no more than a fifteen-pixel cell, then as
 * many columns as the width takes.
 *
 * The cell ceiling is the point of the exercise: without it a tall card
 * produces a grid of seven fat tiles, which says nothing a number could not
 * have said in less space.
 */
function solve(width, height) {
  const box = height - MONTH_ROW - GAP;
  if (box < CELL_MIN) return null;

  let rows = Math.max(ROWS_MIN, Math.min(ROWS_MAX, Math.round((box + GAP) / (CELL_MAX + GAP))));
  let cell = Math.floor((box - (rows - 1) * GAP) / rows);
  while (cell < CELL_MIN && rows > ROWS_MIN) {
    rows -= 1;
    cell = Math.floor((box - (rows - 1) * GAP) / rows);
  }
  if (cell < CELL_MIN) return null;
  cell = Math.min(cell, CELL_MAX);

  const cols = Math.max(1, Math.floor((width + GAP) / (cell + GAP)));
  const capped = Math.min(cols, Math.floor(MAX_DAYS / rows));
  return { cell, rows, cols: Math.max(1, capped) };
}

/* ─── colour scale ────────────────────────────────────────────────────────── */

/**
 * Counts to levels, logarithmically, against the 98th percentile rather than the
 * maximum. Both halves matter: the log keeps a quiet day from reading as nothing
 * beside a busy one, and the percentile stops a single viral day from defining
 * the top of the scale and flattening the other eleven months into level 1.
 */
function scale(values) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return () => 0;

  const cap = Math.max(1, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))]);
  const denom = Math.log1p(cap);

  return (v) => {
    if (v <= 0) return 0;
    const t = Math.log1p(Math.min(v, cap)) / denom;
    return Math.max(1, Math.min(LEVELS, Math.ceil(LEVELS * t)));
  };
}

/* ─── dates ───────────────────────────────────────────────────────────────── */

function parseKey(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function locale() {
  return (window.config && window.config.language) || document.documentElement.lang || undefined;
}

const monthName = (date) => {
  try {
    return date.toLocaleDateString(locale(), { month: "short" });
  } catch {
    return String(date.getMonth() + 1);
  }
};

/* ─── paint ───────────────────────────────────────────────────────────────── */

function paint(fit) {
  const grid = card.querySelector("[data-pulse-grid]");
  const months = card.querySelector("[data-pulse-months]");
  if (!grid || !series || !series.length) return;

  const cells = fit.rows * fit.cols;
  const slice = series.slice(Math.max(0, series.length - cells));
  // A short series is padded at the FRONT, so the last cell is still today.
  const lead = cells - slice.length;

  const values = slice.map((d) => d.value);
  const level = scale(values);
  const total = values.reduce((a, b) => a + b, 0);

  card.style.setProperty("--pulse-cell", fit.cell + "px");
  card.style.setProperty("--pulse-gap", GAP + "px");

  // The track list is written here rather than through a custom property: a
  // `repeat()` count is the one place a var() is not worth betting the layout on.
  grid.style.gridTemplateRows = `repeat(${fit.rows}, ${fit.cell}px)`;
  grid.style.gridAutoColumns = fit.cell + "px";
  grid.style.gap = GAP + "px";

  // One string, one reflow. Rebuilding hundreds of nodes with the DOM API costs
  // more than the parse does, and this runs on every resize step.
  const html = [];
  for (let i = 0; i < lead; i++) {
    html.push('<span class="pulse-day is-empty" style="--pulse-col:0"></span>');
  }
  slice.forEach((day, i) => {
    const col = Math.floor((lead + i) / fit.rows);
    html.push(`<span class="pulse-day l${level(day.value)}" style="--pulse-col:${col}"></span>`);
  });
  grid.innerHTML = html.join("");

  // The month rule. A column is not a week, so a label marks the column its
  // month BEGINS in — and the last two columns are skipped, because a label
  // that starts there is clipped by the card rather than read.
  if (months) {
    const step = fit.cell + GAP;
    const marks = [];
    let last = -1;
    for (let c = 0; c < fit.cols - 2; c++) {
      const day = slice[c * fit.rows - lead];
      if (!day) continue;
      const date = parseKey(day.date);
      const key = date.getFullYear() * 12 + date.getMonth();
      if (key === last) continue;
      // Two labels closer together than four columns collide.
      if (last >= 0 && marks.length && c - marks[marks.length - 1].col < 4) continue;
      last = key;
      marks.push({ col: c, text: monthName(date) });
    }
    months.style.width = fit.cols * step - GAP + "px";
    months.innerHTML = marks
      .map((m) => `<span style="left:${m.col * step}px">${m.text}</span>`)
      .join("");
  }

  card.classList.remove("is-blank");
  // The card shows no numbers, so the reading has to live somewhere: this is the
  // only place the total and the span are still said out loud.
  const title = card.getAttribute("data-l-title") || "Activity";
  grid.setAttribute("aria-label", `${title}: ${total.toLocaleString(locale())} (${slice.length}d)`);

  if (!entered && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    entered = true;
    grid.classList.add("is-entering");
    setTimeout(() => grid.classList.remove("is-entering"), 900);
  }
}

/* ─── run ─────────────────────────────────────────────────────────────────── */

function load(days) {
  if (days <= fetched || days <= pending) return;
  pending = days;
  dailyViews(days).then((rows) => {
    pending = 0;
    if (!rows || !rows.length || !card) return;
    series = rows;
    fetched = rows.length;
    if (shape) paint(shape);
  });
}

function measure() {
  const plot = card && card.querySelector("[data-pulse-plot]");
  if (!plot) return;

  const width = plot.clientWidth;
  const height = plot.clientHeight;
  if (width < 40 || height < 40) return;

  const fit = solve(width, height);
  if (!fit) return;
  if (shape && shape.cell === fit.cell && shape.rows === fit.rows && shape.cols === fit.cols) {
    return;
  }
  shape = fit;

  const days = fit.rows * fit.cols;
  if (days > fetched) load(days);
  if (series && series.length) paint(fit);
}

export default function initPulseCard() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  card = document.querySelector("[data-pulse]");
  shape = null;
  if (!card || !analyticsReady() || !analyticsConfig().pulse) return;

  // Only until the first paint, and only when there is nothing held over from
  // before — a page turn redraws from the series already in hand, so the card
  // must not flash empty on the way.
  if (!series || !series.length) card.classList.add("is-blank");

  const plot = card.querySelector("[data-pulse-plot]");
  if (plot && typeof ResizeObserver !== "undefined") {
    // Re-solving on the card's own box rather than on the window covers every
    // reason it can change size: the breakpoint, the row settling after
    // bentoFit, and the reader dragging the window.
    observer = new ResizeObserver(() => measure());
    observer.observe(plot);
  }

  measure();
}
