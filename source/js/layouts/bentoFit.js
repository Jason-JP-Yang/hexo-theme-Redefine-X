/**
 * Redefine-X — home bento fit pass.
 *
 * Two numbers come out of this file. Neither is a preference: both are read off
 * the tiles that are actually on the page.
 *
 *   --bento-row-fit   ONE cell height for the whole grid. Every row on the page
 *                     is the same height by design, so the only question is what
 *                     that height should be — and the answer is different for a
 *                     page of two-line notes than for a page of long-form
 *                     pieces. The stylesheet clamps whatever comes out of here
 *                     into a narrow range and against the viewport, so this is a
 *                     preference expressed inside limits it cannot break.
 *
 *   --fit-lines       Per tile, how many lines of summary fit in the space the
 *                     tile has left. The stylesheet has already cut the box to a
 *                     whole number of lines with `round()`; this is the same
 *                     number arrived at from the other side, and its only effect
 *                     is to put a "…" on the last line. Nothing moves when it
 *                     lands.
 *
 * ── Why this is measured and not computed ────────────────────────────────────
 *
 * The space a summary gets is the tile minus its cover, its title and its meta
 * row — and the title is the problem. It is never clamped, so it is one line on
 * one tile and three on the next, and no amount of arithmetic at build time
 * knows which. Every previous attempt at this was a table of line budgets
 * guessed against the worst case, which is why tiles ellipsised with half the
 * card still empty. Two reads of a laid-out grid answer it exactly.
 *
 * ── Cost ─────────────────────────────────────────────────────────────────────
 *
 * Two forced layouts per pass, and a pass runs only when the column's width or
 * the viewport's height actually changed — writing the two properties changes
 * neither, so it cannot chase itself. Reads and writes are in separate loops.
 * The home banner is a full viewport tall, so on first load the grid this
 * measures is entirely below the fold.
 */

// Which tile gets its summary shown in full. Every tile states the cell height
// it would need; the page takes this quantile of them. The max would let one
// 3000-word post stretch every row on the page to the ceiling, and the median
// truncates as often as it fits — two thirds satisfied is where a page stops
// looking either sparse or clipped.
const FIT_QUANTILE = 0.65;

// How much of a tile's growth its cover eats. A cover is a percentage of the
// tile's height until it hits a width cap, and past the cap it stops growing;
// this bounds the correction so a tile at the cap cannot ask for an absurd row.
const COVER_SHARE_MAX = 0.6;

let list = null;
let observer = null;
let frame = 0;
let signature = "";

export default function initBentoFit() {
  const next = document.querySelector(".home-article-list.bento");

  if (observer) observer.disconnect();
  list = next;
  // A new list means new tiles, and a page turn changes neither the column width
  // nor the viewport — the two things the pass checks before doing any work.
  signature = "";
  if (!list) return;

  if (!observer) observer = new ResizeObserver(schedule);
  observer.observe(list);
  schedule();

  // The line box is a font metric. A fit measured while the fallback face is
  // still showing is a fit against the wrong line height.
  if (document.fonts && document.fonts.status !== "loaded") {
    document.fonts.ready.then(() => {
      signature = "";
      schedule();
    });
  }
}

/**
 * Run the pass now rather than on the next frame. For the one caller that has to
 * have it: pagination measures every cover for its parallax in the same task it
 * inserts the new list, and the cell height decides how tall those covers are —
 * a frame later is a frame after the covers were measured against the old one.
 */
export function syncBentoFit() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  run();
}

function schedule() {
  if (frame || !list) return;
  frame = requestAnimationFrame(run);
}

function run() {
  frame = 0;
  if (!list || !list.isConnected) return;

  // The width of the column decides how many characters are on a line, and the
  // height of the viewport is one of the two ceilings on the cell. Nothing else
  // this pass depends on can change without one of them changing too — and in
  // particular neither of the properties it writes can.
  const now = list.clientWidth + "x" + window.innerHeight;
  if (now === signature) return;
  signature = now;

  fit();
}

function fit() {
  const listStyle = getComputedStyle(list);
  const row = parseFloat(listStyle.gridAutoRows);
  const gap = parseFloat(listStyle.rowGap) || 0;
  // The stylesheet owns this number; reading it back is what keeps the two ends
  // of the same rule from drifting apart. See $bento-cover-flattest.
  const flattest = parseFloat(listStyle.getPropertyValue("--bento-cover-flattest")) || 0;

  // One column with rows as tall as their content: there is no leftover to
  // divide up and no shared cell height to pick, so both properties are handed
  // back to the stylesheet.
  if (!(row > 0)) {
    clear();
    return;
  }

  // ── Read ───────────────────────────────────────────────────────────────────
  // With the clamp and the cut lifted, so `scrollHeight` reports the height the
  // summary wants rather than the height it was allowed.
  list.classList.add("is-measuring");

  const tiles = [];
  for (const tile of list.querySelectorAll(".home-article-item")) {
    const text = tile.querySelector(".home-article-content");
    if (!text) continue;

    const tileHeight = tile.clientHeight;
    if (!tileHeight) continue;

    // Only a cover ABOVE the text takes a share of the tile's height, and it is a
    // share rather than a fixed band — a taller row means a taller cover too, and
    // the summary gets what is left of the growth. A cover beside the text, or no
    // cover at all, means every pixel of a taller row reaches the summary.
    const cover = tile.querySelector(".home-article-thumbnail");
    const coverHeight = cover ? cover.clientHeight : 0;
    const above = coverHeight > 0 && cover.clientWidth >= tile.clientWidth - 1;
    const rows = Math.max(1, Math.round((tileHeight + gap) / (row + gap)));

    // How much taller the cell would have to be for this cover to stop being a
    // strip. A cover ABOVE the text is whatever is left of the tile once the
    // title and meta row have been kept back, so on a one-cell tile every pixel
    // the cell grows goes to the picture — which is why a tile like that can ask
    // for a taller cell and get a real crop out of it. Anything already at or
    // past the target asks for nothing.
    const wantsHeight =
      above && flattest > 0 ? (cover.clientWidth / flattest - coverHeight) / rows : 0;

    tiles.push({
      text,
      // Whole rows, from the tile's own height rather than from a custom
      // property, so it is right on either grid without knowing which is live.
      rows,
      // What the tile has spare: the body's `1fr` track, which this element is
      // stretched into.
      spare: text.clientHeight,
      wanted: text.scrollHeight,
      coverShare: above ? Math.min(COVER_SHARE_MAX, coverHeight / tileHeight) : 0,
      coverWant: wantsHeight > 0 ? row + wantsHeight : 0,
    });
  }

  list.classList.remove("is-measuring");
  if (!tiles.length) return;

  // ── The cell height ────────────────────────────────────────────────────────
  // Two demands, answered differently, because they are not the same kind of
  // want.
  //
  // A SUMMARY that does not fit is a vote. Every tile says what row height would
  // show all of it — a taller row grows the tile by `rows`, of which the cover
  // takes its share and the text gets the rest — and a tile with slack asks for a
  // SHORTER row, which is what lets a page of notes close up. The page takes a
  // quantile of those, so no single long post decides for the rest.
  //
  // A COVER that has come out a strip is not a vote, it is a floor. It happens on
  // one shape only — a one-cell tile, the one place a picture is short of room —
  // and it is the whole reason the range reaches as high as it does. Averaged in
  // with the summaries it would be outvoted by every other tile on the page and
  // the tile that needed it would keep its strip, which is the composition the
  // planner is already trying to avoid.
  const wants = tiles
    .map((t) => row + (t.wanted - t.spare) / (t.rows * (1 - t.coverShare)))
    .sort((a, b) => a - b);
  const summary = wants[Math.min(wants.length - 1, Math.floor(wants.length * FIT_QUANTILE))];
  const pick = Math.max(summary, ...tiles.map((t) => t.coverWant));

  // ── Write, then read again ─────────────────────────────────────────────────
  list.style.setProperty("--bento-row-fit", Math.round(pick) + "px");

  const lineHeight = parseFloat(getComputedStyle(tiles[0].text).lineHeight);
  if (!(lineHeight > 0)) return;

  for (const t of tiles) {
    // The box has already been cut to a whole number of lines, so this is a
    // division rather than an estimate. Paragraphs after the first carry a
    // one-line top margin (see the stylesheet), and a margin is not a line.
    const blocks = Math.max(0, t.text.children.length - 1);
    t.lines = Math.floor(t.text.clientHeight / lineHeight + 0.01) - blocks;
  }

  for (const t of tiles) {
    t.text.style.setProperty("--fit-lines", t.lines > 0 ? String(t.lines) : "none");
  }
}

function clear() {
  list.style.removeProperty("--bento-row-fit");
  for (const text of list.querySelectorAll(".home-article-content")) {
    text.style.removeProperty("--fit-lines");
  }
}
