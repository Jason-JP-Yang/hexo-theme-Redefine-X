/**
 * Redefine-X — home bento fit pass.
 *
 * Sizes every grid row from the tiles standing in it, writes the list back as
 * `--bento-rows`, and hands each tile the numbers the stylesheet needs. Nothing
 * here is a preference; every one is measured off the page.
 *
 * ── The rule a row height obeys ─────────────────────────────────────────────
 *
 * A row GROWS while anything standing in it is still cut short, and SHRINKS only
 * while every one of them has blank space left over. Its resting place is
 * therefore the height at which the most demanding tile in it shows its whole
 * summary: one tile still truncated is reason to grow even if the others are
 * already full, and one tile still full is reason not to shrink.
 *
 * Blank space on the tiles that wanted less is then a property of the PAIRING,
 * not of the row — and the planner is what answers for it, by not putting a
 * two-line post in a row with a twelve-line one
 * (scripts/helpers/bento-helpers.js).
 *
 * As a cost in the height `s` its rows add up to, that is:
 *
 *   s < need        impossible: the picture would leave its crop band, or the
 *                   summary would fall below TEXT_LINES_MIN and stop being one
 *   need <= s < lo  the summary is cut short — CLIP per pixel, every pixel
 *   lo <= s <= hi   nothing cut and nothing blank; the cover took the slack
 *   s > hi          white space — BLANK per pixel
 *   s > max         impossible: a split tile's crop would pass `tallest`
 *
 * CLIP is several times BLANK, and that ratio is the rule above: with at most
 * three tiles across a row, out-pricing every one of them at once is what makes
 * "somebody is still cut" always win over "somebody now has space".
 *
 * `lo`..`hi` is a RANGE rather than a point because a cover may be cropped
 * anywhere inside `--bento-cover-tallest`..`--bento-cover-flattest`: leftover
 * height goes to the PICTURE before any of it is left blank. The whole thing is
 * convex in `s` and `s` is a sum of row heights, so sweeping one row at a time
 * across the breakpoints of the tiles standing in it lands ON the resting place
 * rather than near it.
 *
 * MIRRORED in scripts/helpers/bento-helpers.js, which solves the same rule at
 * build time to choose which shapes a run of posts gets. Any drift between the
 * two files is a bug in both of them.
 *
 * Measured rather than computed because the title is never clamped — one line on
 * one tile and three on the next, and no build-time arithmetic knows which. The
 * pass is skipped unless the column's width moved or something invalidated it;
 * nothing written here can move that width, so it cannot chase itself.
 */

let list = null;
let observer = null;
let frame = 0;
let signature = "";
let wired = false;

export default function initBentoFit() {
  const next = document.querySelector(".home-article-list.bento");

  if (observer) observer.disconnect();
  list = next;
  // A new list means new tiles, and a page turn does not change the column
  // width — the one thing the pass checks before doing any work.
  signature = "";
  if (!list) return;

  if (!observer) observer = new ResizeObserver(schedule);
  observer.observe(list);
  schedule();

  if (wired) return;
  wired = true;

  // The line box is a font metric, and the site cards' row is their own height:
  // a fit measured before either has settled is a fit against the wrong numbers,
  // and neither changes the column width the pass keys off.
  window.addEventListener("redefine:content-resized", invalidate);
  if (document.fonts) document.fonts.ready.then(invalidate);
}

/**
 * Now rather than next frame, for the one caller that needs it: pagination
 * measures every cover for its parallax in the same task it inserts the new list,
 * and the row heights decide how tall those covers are.
 */
export function syncBentoFit() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  run();
}

function invalidate() {
  signature = "";
  schedule();
}

function schedule() {
  if (frame || !list) return;
  frame = requestAnimationFrame(run);
}

function run() {
  frame = 0;
  if (!list || !list.isConnected) return;

  // The width of the column decides how many characters are on a line and how
  // wide every cover is. Nothing else this pass depends on can change without it
  // changing too — and in particular none of the properties it writes can.
  const now = String(list.clientWidth);
  if (now === signature) return;
  signature = now;

  fit();
}

/* ─── The cost of a height ─────────────────────────────────────────────────── */

// Both charged where they SHOW — in the text column — so a split tile, whose
// picture fills the height whatever the text does, is not blamed for the width it
// does not use. CLIP outweighs BLANK by more than the widest row holds tiles,
// which is what makes a row grow for one truncated tile even when every other
// tile in it is already full. Mirrors W.BLANK and W.CLIP in
// scripts/helpers/bento-helpers.js.
const BLANK = 1;
const CLIP = 6;
// Steep enough that a sweep always climbs out of an impossible height, and finite
// so that it can.
const IMPOSSIBLE = 40;

// The summary a tile is worth GROWING for. Past this the tile is not too small —
// the excerpt is simply long, and an ellipsis is the right answer.
const TEXT_LINES_MAX = 12;
// And the least that reads as a summary rather than as a clipped word. This is
// part of `need`, not a weight: a row that cannot show two lines is as wrong as
// one that crops the picture out of its band, and the row has to grow. Mirrors
// W.TEXT_LINES_MIN in scripts/helpers/bento-helpers.js.
const TEXT_LINES_MIN = 2;

const SWEEPS = 8;
const SETTLED = 0.5;

function tileCost(t, s) {
  if (s < t.need) return IMPOSSIBLE * (t.need - s) * t.share;
  if (s > t.max) return IMPOSSIBLE * (s - t.max) * t.share;
  // Every pixel of a cut summary, with no saturation: a cut that stops counting
  // is a row that stops growing, and that is the one thing this may not do.
  if (s < t.lo) return CLIP * (t.lo - s) * t.share;
  if (s > t.hi) return BLANK * (s - t.hi) * t.share;
  return 0;
}

function span(rows, gap, t) {
  let height = gap * (t.rn - 1);
  for (let r = t.rs; r < t.rs + t.rn; r++) height += rows[r] || 0;
  return height;
}

function solveRows(tiles, rowCount, fixed, gap) {
  const standing = [];
  for (let r = 0; r <= rowCount; r++) standing.push([]);
  for (const t of tiles) {
    for (let r = t.rs; r < t.rs + t.rn && r <= rowCount; r++) standing[r].push(t);
  }

  // A first guess in the right neighbourhood — as tall as the tallest thing in
  // the row needs, or as the shortest thing wants — and then the sweep. The site
  // cards' row is not a guess and not a variable: it is their own height, and
  // nothing on the page may stretch or compress it.
  const rows = [];
  for (let r = 1; r <= rowCount; r++) {
    if (fixed[r] > 0) {
      rows[r] = fixed[r];
      continue;
    }
    let start = 0;
    let want = Infinity;
    for (const t of standing[r]) {
      start = Math.max(start, (t.need - gap * (t.rn - 1)) / t.rn);
      want = Math.min(want, (t.lo - gap * (t.rn - 1)) / t.rn);
    }
    rows[r] = want === Infinity ? start : Math.max(start, want);
  }

  for (let pass = 0; pass < SWEEPS; pass++) {
    let moved = 0;

    for (let r = 1; r <= rowCount; r++) {
      const here = standing[r];
      if (!here.length || fixed[r] > 0) continue;

      // Every height at which one of these tiles changes what it charges. A
      // piecewise-linear function of one variable takes its minimum at a
      // breakpoint or at a bound, so this list is the whole search.
      const tries = [0, rows[r]];
      for (const t of here) {
        const rest = span(rows, gap, t) - rows[r];
        for (const edge of [t.need, t.lo, t.hi, t.max]) {
          const h = edge - rest;
          if (h > 0 && h < Infinity) tries.push(h);
        }
      }

      let best = rows[r];
      let bestCost = Infinity;
      for (const h of tries) {
        rows[r] = h;
        let cost = 0;
        for (const t of here) cost += tileCost(t, span(rows, gap, t));
        if (cost < bestCost - 1e-6) {
          bestCost = cost;
          best = h;
        }
      }

      if (Math.abs(best - rows[r]) > SETTLED) moved++;
      rows[r] = best;
    }

    if (!moved) break;
  }

  return rows;
}

/* ─── Reading a tile ───────────────────────────────────────────────────────── */

/**
 * The height the summary TAKES, off a Range over its own contents rather than off
 * the box holding it. `scrollHeight` never goes below `clientHeight`, so a box
 * filling a `1fr` track answers "how tall is your text?" with its own size and the
 * solver reproduces whatever height the page already had. A Range reports the
 * union of the line boxes, which no amount of stretching can inflate.
 */
function textHeight(text) {
  if (!text.textContent || !text.textContent.trim()) return 0;
  const range = document.createRange();
  range.selectNodeContents(text);
  const rect = range.getBoundingClientRect();
  if (rect && rect.height > 0) return rect.height;
  // A Range cannot be inflated by a stretched box, but a composition it does not
  // lay out rects for would report nothing at all — and a summary measured at
  // zero is a tile with no summary in it. `scrollHeight` is the fallback, and it
  // is safe HERE only: the body is `max-content` for the length of this read, so
  // the box it reports is not the one the grid was stretching.
  return text.scrollHeight;
}

/**
 * Everything about a tile that its row height does not decide. Called again for
 * the split tiles once their real row is known, because their cover column — and
 * therefore the width their text and title are set in — follows that row.
 */
function measure(t, geom, line) {
  const width = t.el.clientWidth;
  const style = getComputedStyle(t.body);
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const gap = parseFloat(style.rowGap) || 0;

  // SUMMED, never subtracted from the body's own height: the head and the meta
  // row are `auto` tracks and are exactly their contents whatever the grid is
  // doing to the body, while the body's height is the grid's answer, not theirs.
  t.chrome =
    padding + gap * 2 + (t.head ? t.head.offsetHeight : 0) + (t.meta ? t.meta.offsetHeight : 0);

  const coverWidth = t.cover ? t.cover.clientWidth : 0;
  // Only a cover ABOVE the text takes a share of the tile's HEIGHT: one beside
  // the text is a column, and a text-forward tile has no box at all.
  t.stacked = coverWidth > 0 && coverWidth >= width - 1;
  const beside = coverWidth > 0 && !t.stacked;

  t.coverMin = t.stacked ? width / geom.flattest : 0;
  t.coverMax = t.stacked ? width / geom.tallest : 0;

  const raw = textHeight(t.text);
  t.blocks = Math.max(0, t.text.children.length - 1);
  t.textLines = line > 0 ? Math.max(0, Math.round(raw / line) - t.blocks) : 0;
  t.summary = Math.min(raw, (TEXT_LINES_MAX + t.blocks) * line);

  // The floor carries the least summary that still IS one. A tile whose row
  // cannot hold the picture and two lines is not cramped, it is the wrong tile
  // for this post — so the row grows, and if it cannot grow the planner is told
  // this shape does not work here rather than the summary being deleted.
  t.need = t.chrome + t.coverMin + Math.min(t.summary, TEXT_LINES_MIN * line);
  // The tallest this tile may be before a cover BESIDE the text is cropped past
  // `tallest`: that column is the tile's height at the target ratio until one of
  // its two ceilings stops it, and past that the crop only tightens. Never below
  // the floor — at the narrowest tile the composition is allowed on at all the
  // two are within a few pixels, and a ceiling under the floor is not a height.
  const column = Math.min(width - geom.textMin, width * geom.coverMax);
  t.max = beside ? Math.max(t.need, column / geom.tallest) : Infinity;

  t.lo = t.chrome + t.coverMin + t.summary;
  t.hi = t.chrome + t.coverMax + t.summary;
  t.share = width > 0 ? t.text.clientWidth / width : 1;
}

/* ─── The pass ─────────────────────────────────────────────────────────────── */

function fit() {
  const listStyle = getComputedStyle(list);
  const auto = parseFloat(listStyle.gridAutoRows);
  const gap = parseFloat(listStyle.rowGap) || 0;
  // The stylesheet owns all of these; reading them back is what keeps the two
  // ends of the same rule from drifting apart. See the bento block in
  // common/variables.styl.
  const geom = {
    target: parseFloat(listStyle.getPropertyValue("--bento-cover-target")),
    tallest: parseFloat(listStyle.getPropertyValue("--bento-cover-tallest")),
    flattest: parseFloat(listStyle.getPropertyValue("--bento-cover-flattest")),
    textMin: parseFloat(listStyle.getPropertyValue("--bento-split-text-min")),
    coverMax: parseFloat(listStyle.getPropertyValue("--bento-split-cover-max")) || 1,
  };

  // One column with rows as tall as their content: there is no leftover to divide
  // up and no heights to pick, so everything is handed back to the stylesheet.
  if (!(auto > 0 && geom.target > 0 && geom.tallest > 0 && geom.flattest > 0)) {
    clear();
    return;
  }

  const tiles = [];
  const cards = [];
  const fixed = [];
  let rowCount = 0;

  for (const el of list.children) {
    const placement = getComputedStyle(el);
    // Written out by the planner rather than left to auto-placement, precisely so
    // this is answerable: a row cannot be sized from tiles it does not know about.
    const rs = parseInt(placement.gridRowStart, 10);
    const rn = parseInt(String(placement.gridRowEnd).replace(/[^0-9]/g, ""), 10) || 1;
    if (!(rs > 0)) continue;
    rowCount = Math.max(rowCount, rs + rn - 1);

    // The site cards are furniture with a fixed amount in them: their row is not
    // a negotiation, it is their own height, and nothing on the page may stretch
    // or compress it. Read below rather than here — a card in its track is
    // already the height of the row, so measuring it now would hand the row back
    // its own answer and it could only ever grow.
    if (el.classList.contains("home-feature-tile")) {
      cards.push({ el, rs });
      continue;
    }

    const body = el.querySelector(".home-article-body");
    const text = el.querySelector(".home-article-content");
    if (!body || !text || !el.clientWidth) continue;

    tiles.push({
      el,
      body,
      text,
      head: el.querySelector(".home-article-head"),
      meta: el.querySelector(".home-article-meta-info-container"),
      cover: el.querySelector(".home-article-thumbnail"),
      rs,
      rn,
    });
  }

  if (!tiles.length || !rowCount) return;

  const line = parseFloat(getComputedStyle(tiles[0].text).lineHeight);
  if (!(line > 0)) return;

  // ── Read ───────────────────────────────────────────────────────────────────
  // The clamp and the cut come off so the summary reports the height it wants
  // rather than the height it was allowed, and the site cards come loose from
  // their track so they report their own height rather than the row's. One class
  // on the list rather than a write per tile, and it never survives the frame.
  list.classList.add("is-measuring");
  for (const card of cards) fixed[card.rs] = Math.max(fixed[card.rs] || 0, card.el.offsetHeight);
  for (const t of tiles) measure(t, geom, line);
  list.classList.remove("is-measuring");

  let rows = solveRows(tiles, rowCount, fixed, gap);
  apply(tiles, rows, gap, line);

  // A split tile's cover column is its own height at the cover ratio, so the row
  // just written is what decides how wide its text is set — and that is what
  // decides how tall the text is. One correction, never more: the second answer
  // is written from a layout that already has the first one in it.
  const split = tiles.filter((t) => t.cover && !t.stacked);
  if (split.length) {
    list.classList.add("is-measuring");
    for (const t of split) measure(t, geom, line);
    list.classList.remove("is-measuring");
    rows = solveRows(tiles, rowCount, fixed, gap);
    apply(tiles, rows, gap, line);
  }
}

function apply(tiles, rows, gap, line) {
  const track = [];
  for (let r = 1; r < rows.length; r++) track.push(Math.round(rows[r] || 0) + "px");
  list.style.setProperty("--bento-rows", track.join(" "));

  for (const t of tiles) {
    const height = span(rows, gap, t);

    // Leftover height goes to the PICTURE first, as far as the crop band allows,
    // and only what is left over after that reads as white space. Written out
    // rather than expressed in CSS because the summary's height is the one term
    // in it the stylesheet cannot see.
    const cover = t.stacked
      ? Math.min(t.coverMax, Math.max(t.coverMin, height - t.chrome - t.summary))
      : 0;

    // Read by the split composition, which sizes its cover COLUMN off the tile's
    // height — those tiles are one row tall, so this is that row.
    t.el.style.setProperty("--tile-height", Math.round(height) + "px");
    if (t.stacked) t.el.style.setProperty("--tile-cover", Math.round(cover) + "px");
    else t.el.style.removeProperty("--tile-cover");

    // And the clamp comes OFF, so the box below is read at the size the row just
    // gave it. A clamp left over from the previous pass is a smaller box, and a
    // line count taken through one could only ever shrink.
    t.text.style.setProperty("--fit-lines", "none");
  }

  // ── The ellipsis ───────────────────────────────────────────────────────────
  // MEASURED, not predicted. `round(down, 100%, 1lh)` has already cut the box to
  // a whole number of lines, so this is a division — but of the box the page
  // actually built, not of the height this pass believes it asked for. A clamp
  // one line larger than the box shows no ellipsis at all: `overflow` cuts the
  // text off mid-sentence and nothing marks that it was cut.
  //
  // Paragraphs after the first carry a one-line top margin, and a margin is not
  // a line.
  for (const t of tiles) {
    t.lines = Math.floor(t.text.clientHeight / line + 0.01) - t.blocks;
  }
  for (const t of tiles) {
    t.text.style.setProperty("--fit-lines", t.lines > 0 ? String(t.lines) : "none");
  }
}

function clear() {
  list.style.removeProperty("--bento-rows");
  for (const tile of list.querySelectorAll(".home-article-item")) {
    tile.style.removeProperty("--tile-height");
    tile.style.removeProperty("--tile-cover");
  }
  for (const text of list.querySelectorAll(".home-article-content")) {
    text.style.removeProperty("--fit-lines");
  }
}
