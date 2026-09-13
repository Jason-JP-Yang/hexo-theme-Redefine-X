/**
 * The activity card's calendar.
 *
 * Weeks across, weekdays down, and it FILLS THE CARD: seven rows are sized to
 * consume the whole height the row hands this cell, and the number of weeks is
 * then whatever the width allows. So the cell size is a function of the height
 * and the day count a function of the width — neither is a setting, and the
 * number of days fetched is decided by the measurement rather than the other way
 * round.
 *
 * Two things this file is careful about:
 *
 *   IT MUST NOT GROW THE ROW. bentoFit.js pins the furniture row to the tallest
 *   card in it. If the calendar set this card's height, the card would win that
 *   comparison and stretch the row. So the grid is sized DOWN into the box it is
 *   given (the stylesheet's `min-height 0` / `overflow hidden` do the clamping)
 *   and never reported upwards.
 *
 *   ONE FETCH PER SHAPE. The days the solver asks for are fetched once and kept;
 *   a resize that needs no more days re-draws from what is already in hand.
 */

import { analyticsReady, analyticsConfig, dailyViews } from "../tools/analytics.js";

const ROWS = 7;
const MAX_WEEKS = 53;
const CELL_MIN = 6;
const CELL_MAX = 40;
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
 * Seven rows to the height, then as many columns as the width takes.
 *
 * The gap is derived from the cell rather than fixed, so a card that gets a
 * 30px cell does not wear the 2px gutter a 8px cell needs — and the cell is
 * re-derived once the gap is known, so the seven rows land on the height
 * exactly rather than a gutter short of it.
 */
function solve(width, height) {
  let cell = Math.floor(height / ROWS);
  if (cell < CELL_MIN) return null;

  let gap = Math.max(2, Math.min(6, Math.round(cell * 0.16)));
  cell = Math.floor((height - (ROWS - 1) * gap) / ROWS);
  if (cell < CELL_MIN) {
    gap = 2;
    cell = Math.floor((height - (ROWS - 1) * gap) / ROWS);
  }
  if (cell < CELL_MIN) return null;
  cell = Math.min(cell, CELL_MAX);

  const weeks = Math.max(1, Math.min(MAX_WEEKS, Math.floor((width + gap) / (cell + gap))));
  return { cell, gap, weeks };
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

/** Monday-first weekday index, which is the order the rows are drawn in. */
const weekdayIndex = (date) => (date.getDay() + 6) % 7;

function parseKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function locale() {
  return (window.config && window.config.language) || document.documentElement.lang || undefined;
}

/** How many days a grid of `weeks` columns ending on today actually shows. */
function daysFor(weeks) {
  const today = new Date();
  return weeks * ROWS - (6 - weekdayIndex(today));
}

/* ─── paint ───────────────────────────────────────────────────────────────── */

function paint(fit) {
  const grid = card.querySelector("[data-pulse-grid]");
  if (!grid || !series || !series.length) return;

  // The last column is the current week, so the grid ends on today and the days
  // after it in that column are drawn as future rather than as quiet.
  const today = parseKey(series[series.length - 1].date);
  const trailing = 6 - weekdayIndex(today);
  const cells = fit.weeks * ROWS;
  const slice = series.slice(Math.max(0, series.length - (cells - trailing)));

  const values = slice.map((d) => d.value);
  const level = scale(values);
  const total = values.reduce((a, b) => a + b, 0);

  card.style.setProperty("--pulse-cell", fit.cell + "px");
  card.style.setProperty("--pulse-gap", fit.gap + "px");

  // One string, one reflow. Rebuilding hundreds of nodes with the DOM API costs
  // more than the parse does, and this runs on every resize step.
  const lead = cells - trailing - slice.length;
  const html = [];
  for (let i = 0; i < lead; i++) {
    html.push('<span class="pulse-day is-future" style="--pulse-col:0"></span>');
  }
  slice.forEach((day, i) => {
    const col = Math.floor((lead + i) / ROWS);
    html.push(
      `<span class="pulse-day l${level(day.value)}" style="--pulse-col:${col}"></span>`,
    );
  });
  for (let i = 0; i < trailing; i++) {
    html.push(`<span class="pulse-day is-future" style="--pulse-col:${fit.weeks - 1}"></span>`);
  }
  grid.innerHTML = html.join("");

  card.classList.remove("is-blank");
  // The card shows no numbers, so the reading has to live somewhere: this is the
  // only place the total and the span are still said out loud.
  const title = card.getAttribute("data-l-title") || "Activity";
  grid.setAttribute(
    "aria-label",
    `${title}: ${total.toLocaleString(locale())} (${slice.length}d)`,
  );

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
  if (shape && shape.cell === fit.cell && shape.gap === fit.gap && shape.weeks === fit.weeks) {
    return;
  }
  shape = fit;

  const days = daysFor(fit.weeks);
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
  entered = false;
  if (!card || !analyticsReady() || !analyticsConfig().pulse) return;

  card.classList.add("is-blank");

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
