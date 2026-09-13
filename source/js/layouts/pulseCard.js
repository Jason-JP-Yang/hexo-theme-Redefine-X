/**
 * The activity card's calendar.
 *
 * Weeks across, weekdays down. The card is one cell of the home grid's furniture
 * row, so its height belongs to the two cards beside it and only its WIDTH is
 * ours to spend — which makes "how many days fit" a measurement, not a setting.
 *
 * Two things this file is careful about:
 *
 *   IT MUST NOT GROW THE ROW. bentoFit.js pins the furniture row to the tallest
 *   card in it. If the calendar set this card's height, the card would win that
 *   comparison and stretch the row. So the grid is sized DOWN into the box it is
 *   given (the stylesheet's `min-height 0` / `overflow hidden` do the clamping)
 *   and never reported upwards.
 *
 *   ONE FETCH, WHATEVER THE SIZE. A full year is requested once and cached; the
 *   solver then draws the slice that fits. Resizing the window, rotating a
 *   phone, or crossing a breakpoint re-solves from data already in hand.
 */

import { analyticsReady, analyticsConfig, dailyViews } from "../tools/analytics.js";

const ROWS = 7;
const MAX_WEEKS = 53;
const SPAN = MAX_WEEKS * 7; // what we ask Umami for, once
const CELL_MIN = 7;
const CELL_MAX = 14;
const LEVELS = 5;

let observer = null;
let card = null;
let series = null;
let shape = null;
let entered = false;

/* ─── geometry ────────────────────────────────────────────────────────────── */

const gapFor = (cell) => (cell >= 11 ? 3 : 2);

/**
 * The largest cell that still shows the most days.
 *
 * Weeks fall as the cell grows, so the smallest cell always wins on days — until
 * the year is complete, after which extra width is better spent on legibility
 * than on dates that do not exist. Hence: most weeks first, biggest cell to break
 * the tie, which is only ever broken once the full year fits.
 */
function solve(width, height) {
  let best = null;

  for (let cell = CELL_MIN; cell <= CELL_MAX; cell++) {
    const gap = gapFor(cell);
    if (ROWS * cell + (ROWS - 1) * gap > height) break;

    const weeks = Math.min(MAX_WEEKS, Math.floor((width + gap) / (cell + gap)));
    if (weeks < 6) continue;

    if (!best || weeks > best.weeks || (weeks === best.weeks && cell > best.cell)) {
      best = { cell, gap, weeks };
    }
  }

  return best;
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

function formatDate(date, locale) {
  try {
    return date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function formatMonth(date, locale) {
  try {
    return date.toLocaleDateString(locale, { month: "short" });
  } catch {
    return String(date.getMonth() + 1);
  }
}

function locale() {
  return (window.config && window.config.language) || document.documentElement.lang || undefined;
}

/* ─── paint ───────────────────────────────────────────────────────────────── */

function text(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function label(name, fallback) {
  const v = card && card.getAttribute("data-l-" + name);
  return v || fallback;
}

function paint(fit) {
  const grid = card.querySelector("[data-pulse-grid]");
  const months = card.querySelector("[data-pulse-months]");
  if (!grid || !series || !series.length) return;

  // The last column is the current week, so the grid ends on today and the days
  // after it in that column are drawn as future rather than as quiet.
  const today = parseKey(series[series.length - 1].date);
  const trailing = 6 - weekdayIndex(today);
  const cells = fit.weeks * ROWS;
  const needed = cells - trailing;
  const slice = series.slice(Math.max(0, series.length - needed));

  const values = slice.map((d) => d.value);
  const level = scale(values);
  const total = values.reduce((a, b) => a + b, 0);

  card.style.setProperty("--pulse-cell", fit.cell + "px");
  card.style.setProperty("--pulse-gap", fit.gap + "px");

  // One string, one reflow. Rebuilding ~370 nodes with the DOM API costs more
  // than the parse does, and this runs on every resize step.
  const lead = cells - trailing - slice.length;
  const html = [];
  for (let i = 0; i < lead; i++) {
    html.push('<span class="pulse-day is-future" style="--pulse-col:0"></span>');
  }
  slice.forEach((day, i) => {
    const col = Math.floor((lead + i) / ROWS);
    html.push(
      `<span class="pulse-day l${level(day.value)}" style="--pulse-col:${col}"` +
        ` data-d="${day.date}" data-v="${day.value}"></span>`,
    );
  });
  for (let i = 0; i < trailing; i++) {
    const col = fit.weeks - 1;
    html.push(`<span class="pulse-day is-future" style="--pulse-col:${col}"></span>`);
  }
  grid.innerHTML = html.join("");

  // Month ticks, placed against the same track the grid uses. Skipped when a
  // month would land on top of the one before it.
  if (months) {
    const pitch = fit.cell + fit.gap;
    const ticks = [];
    let lastMonth = -1;
    let lastCol = -99;
    for (let col = 0; col < fit.weeks; col++) {
      const index = col * ROWS - lead;
      if (index < 0 || index >= slice.length) continue;
      const date = parseKey(slice[index].date);
      if (date.getMonth() === lastMonth || col - lastCol < 3) continue;
      lastMonth = date.getMonth();
      lastCol = col;
      ticks.push(
        `<span style="left:${col * pitch}px">${formatMonth(date, locale())}</span>`,
      );
    }
    // The grid centres itself in the card, so the ticks have to start where it
    // does or they drift by half the slack.
    const gridWidth = fit.weeks * pitch - fit.gap;
    months.style.paddingLeft = "";
    months.innerHTML = ticks.join("");
    months.style.width = gridWidth + "px";
    months.style.marginInline = "auto";
  }

  const totalEl = card.querySelector("[data-pulse-total]");
  if (totalEl) {
    text(totalEl, total.toLocaleString(locale()) + " " + label("views", "views"));
    totalEl.classList.add("is-on");
  }

  const rangeEl = card.querySelector("[data-pulse-range]");
  if (rangeEl) {
    text(rangeEl, fit.weeks + " " + label("weeks", "weeks"));
  }

  const scaleEl = card.querySelector("[data-pulse-scale]");
  if (scaleEl && !scaleEl.childElementCount) {
    let swatches = "";
    for (let i = 0; i <= LEVELS; i++) swatches += `<i class="l${i}"></i>`;
    scaleEl.innerHTML =
      `${label("less", "less")}${swatches}${label("more", "more")}`;
  }

  card.classList.remove("is-blank");
  grid.setAttribute(
    "aria-label",
    `${label("title", "Activity")}: ${total.toLocaleString(locale())} ${label("views", "views")}`,
  );

  if (!entered && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    entered = true;
    grid.classList.add("is-entering");
    setTimeout(() => grid.classList.remove("is-entering"), 900);
  }
}

/* ─── tooltip ─────────────────────────────────────────────────────────────── */

function wireTip() {
  const plot = card.querySelector("[data-pulse-plot]");
  const tip = card.querySelector("[data-pulse-tip]");
  const grid = card.querySelector("[data-pulse-grid]");
  if (!plot || !tip || !grid) return;

  let active = null;

  const hide = () => {
    if (active) active.classList.remove("is-on");
    active = null;
    tip.classList.remove("is-on");
  };

  const show = (cell) => {
    const date = cell.getAttribute("data-d");
    if (!date) return hide();

    if (active && active !== cell) active.classList.remove("is-on");
    active = cell;
    cell.classList.add("is-on");

    const value = Number(cell.getAttribute("data-v") || 0);
    const when = formatDate(parseKey(date), locale());
    tip.innerHTML = value
      ? `<b>${value.toLocaleString(locale())}</b> ${label("views", "views")} · ${when}`
      : `${label("empty", "No views")} · ${when}`;

    // Positioned against the plot, then pulled back inside it: a tooltip on the
    // first or last column would otherwise hang outside a card that clips.
    const box = plot.getBoundingClientRect();
    const rect = cell.getBoundingClientRect();
    tip.classList.add("is-on");
    const half = tip.offsetWidth / 2;
    const x = Math.min(
      Math.max(rect.left - box.left + rect.width / 2, half + 2),
      box.width - half - 2,
    );
    tip.style.left = x + "px";
    tip.style.top = rect.top - box.top + "px";
  };

  grid.addEventListener("pointerover", (e) => {
    const cell = e.target.closest(".pulse-day");
    if (cell && !cell.classList.contains("is-future")) show(cell);
    else hide();
  });
  grid.addEventListener("pointerleave", hide);
  plot.addEventListener("pointerleave", hide);
  // A touch reads as a tap rather than a hover; scrolling away must clear it.
  window.addEventListener("scroll", hide, { passive: true });
}

/* ─── run ─────────────────────────────────────────────────────────────────── */

function measure() {
  const plot = card && card.querySelector("[data-pulse-plot]");
  if (!plot) return;

  const width = plot.clientWidth;
  const months = card.querySelector("[data-pulse-months]");
  const chrome = months ? months.offsetHeight + 4 : 0;
  const height = plot.clientHeight - chrome;
  if (width < 40 || height < 40) return;

  const fit = solve(width, height);
  if (!fit) return;
  if (shape && shape.cell === fit.cell && shape.gap === fit.gap && shape.weeks === fit.weeks) {
    return;
  }
  shape = fit;
  paint(fit);
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
  wireTip();

  const plot = card.querySelector("[data-pulse-plot]");
  if (plot && typeof ResizeObserver !== "undefined") {
    // Re-solving on the card's own box rather than on the window covers every
    // reason it can change size: the breakpoint, the row settling after
    // bentoFit, and the reader dragging the window.
    observer = new ResizeObserver(() => measure());
    observer.observe(plot);
  }

  dailyViews(SPAN).then((rows) => {
    if (!rows || !rows.length) return;
    series = rows;
    shape = null;
    measure();
  });
}
