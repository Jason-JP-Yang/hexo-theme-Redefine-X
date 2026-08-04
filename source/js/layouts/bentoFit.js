/**
 * Redefine-X — home bento fit pass.
 *
 * Four numbers come out of this file. None of them is a preference: every one is
 * read off the tiles that are actually on the page.
 *
 *   --bento-rows    ONE HEIGHT PER ROW, written as the grid's whole
 *                   `grid-template-rows`. Each row is sized by what stands in
 *                   it, so a band of two-line notes closes up while the band of
 *                   long-form pieces under it stays open, and the row carrying
 *                   the two site cards is exactly as tall as the cards are.
 *                   The stylesheet fixes the range each answer may land in.
 *
 *   --tile-chrome   Per tile, everything in it that is NOT the cover: its title,
 *                   its meta row, the padding and gaps around them, and the
 *                   summary it has to show. The cover takes what is left, which
 *                   is what lets a tile with three words to say hand the room to
 *                   its picture instead of leaving it blank.
 *
 *   --tile-furniture  The same thing minus the summary — the part of a tile that
 *                   may not be clipped whatever happens to its row. It is what
 *                   the cover's own floor gives way to.
 *
 *   --fit-lines     Per tile, how many lines of summary fit in the space the
 *                   tile has left. The stylesheet has already cut the box to a
 *                   whole number of lines with `round()`; this is the same
 *                   number arrived at from the other side, and its only effect
 *                   is to put a "…" on the last line. Nothing moves when it
 *                   lands.
 *
 * ── What a tile asks its row for ─────────────────────────────────────────────
 *
 * One height, built from three measured parts and one declared want:
 *
 *   furniture   title + meta row + padding + gaps, measured, never negotiable
 *   summary     what the excerpt wants, capped at the room the tile would have
 *               at the top of the range once its cover has taken its crop —
 *               past that a summary is not short of space, it is a summary that
 *               needs truncating
 *   cover       the tile's width at `--bento-cover-target`, or `--bento-cover-
 *               share` of the tile where the tile is too wide for that crop to
 *               fit inside the share at any height
 *
 * A row then takes a quantile of what its tiles ask, so one long piece cannot
 * stretch a band on its own and one note cannot flatten it.
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
 * Two forced layouts per pass, and a pass runs only when the column's width
 * actually changed — writing the three properties does not change it, so it
 * cannot chase itself. Reads and writes are in separate loops. The home banner
 * is a full viewport tall, so on first load the grid this measures is entirely
 * below the fold.
 */

// Which tile in a row gets its summary shown in full. The max would let one
// 3000-word post stretch a band to the ceiling on its own, and the median
// truncates as often as it fits — two thirds satisfied is where a row stops
// looking either sparse or clipped.
const FIT_QUANTILE = 0.65;

let list = null;
let observer = null;
let frame = 0;
let signature = "";

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
 * inserts the new list, and the row heights decide how tall those covers are —
 * a frame later is a frame after the covers were measured against the old ones.
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

  // The width of the column decides how many characters are on a line and how
  // wide every cover is. Nothing else this pass depends on can change without it
  // changing too — and in particular none of the properties it writes can.
  const now = String(list.clientWidth);
  if (now === signature) return;
  signature = now;

  fit();
}

/** Linear-interpolated, so a row of two tiles lands between them rather than on
 *  the greedier one. */
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function fit() {
  const listStyle = getComputedStyle(list);
  const row = parseFloat(listStyle.gridAutoRows);
  const gap = parseFloat(listStyle.rowGap) || 0;
  // The stylesheet owns every one of these; reading them back is what keeps the
  // two ends of the same rule from drifting apart. See the bento block in
  // common/variables.styl.
  const min = parseFloat(listStyle.getPropertyValue("--bento-row-min"));
  const max = parseFloat(listStyle.getPropertyValue("--bento-row-max"));
  const share = parseFloat(listStyle.getPropertyValue("--bento-cover-share"));
  const target = parseFloat(listStyle.getPropertyValue("--bento-cover-target"));

  // One column with rows as tall as their content: there is no leftover to
  // divide up and no heights to pick, so everything is handed back to the
  // stylesheet.
  if (!(row > 0 && min > 0 && max >= min && share > 0 && target > 0)) {
    clear();
    return;
  }

  // ── Read ───────────────────────────────────────────────────────────────────
  // With the clamp and the cut lifted, so `scrollHeight` reports the height the
  // summary wants rather than the height it was allowed, and with the site cards
  // cut loose from their track so they report the height they want rather than
  // the one the row is giving them.
  list.classList.add("is-measuring");

  const tiles = [];
  const fixed = [];
  let rows = 0;

  for (const el of list.children) {
    const placement = getComputedStyle(el);
    // Written out by the planner rather than left to auto-placement, precisely
    // so this is answerable: a row cannot be sized from its tiles unless it is
    // known which tiles are in it.
    const rs = parseInt(placement.gridRowStart, 10);
    const rn = parseInt(String(placement.gridRowEnd).replace(/[^0-9]/g, ""), 10) || 1;
    if (!(rs > 0)) continue;
    rows = Math.max(rows, rs + rn - 1);

    // The site cards are furniture with a fixed amount in them: their row is
    // not a negotiation, it is their own height.
    if (el.classList.contains("home-feature-tile")) {
      fixed[rs] = Math.max(fixed[rs] || 0, el.offsetHeight);
      continue;
    }

    const text = el.querySelector(".home-article-content");
    if (!text) continue;

    const height = el.clientHeight;
    if (!height) continue;

    // Only a cover ABOVE the text takes a share of the tile's HEIGHT. A cover
    // beside the text is a column, and one that has been dropped for a
    // text-forward composition is not there at all.
    const cover = el.querySelector(".home-article-thumbnail");
    const coverHeight = cover ? cover.clientHeight : 0;
    const coverWidth = cover ? cover.clientWidth : 0;
    const above = coverHeight > 0 && coverWidth >= el.clientWidth - 1;

    // Everything the tile has to hold whatever else happens. Derived by
    // subtraction rather than by adding up boxes, so nothing has to know which
    // parts a tier happens to print.
    const furniture = height - (above ? coverHeight : 0) - text.clientHeight;

    // The tallest this tile is allowed to become, and from that the most
    // summary it may ask for: what is left at that height once the cover has
    // taken the crop it wants. A summary longer than that is not short of room,
    // it is a summary the tile is meant to truncate.
    const roof = max * rn + gap * (rn - 1);
    const crop = above ? Math.min(coverWidth / target, share * roof) : 0;
    const summary = Math.min(text.scrollHeight, Math.max(0, roof - furniture - crop));

    // What the tile asks its rows for: what it has to hold, plus a cover.
    //
    // A fixed point, not a sum, because the cover is BOTH a crop and a share of
    // a height it is itself part of. Solve `T = chrome + min(width / target,
    // share * T)`: either the crop fits inside the share, and the tile is its
    // contents plus that crop, or the tile is so wide that the crop cannot fit
    // in the share at any height — and then asking for it would push every wide
    // tile to the ceiling, so the share is what the cover gets and the crop
    // comes out flatter than the target. Which is the right answer for a wide
    // tile: 3:1 across 1000px is a cinematic band, and across 380px it is a
    // hairline, so a ratio alone was never the whole question.
    const chrome = furniture + summary;
    let desired = chrome;
    if (above) {
      desired = chrome + coverWidth / target;
      if (share * desired < coverWidth / target) desired = chrome / (1 - share);
    }

    tiles.push({ el, text, rs, rn, chrome, furniture, desired });
  }

  list.classList.remove("is-measuring");
  if (!tiles.length || !rows) return;

  // ── The row heights ────────────────────────────────────────────────────────
  // A tile spanning several rows asks each of them for its share, so a 1x3 with
  // a lot to say lifts three rows a little rather than one row a lot.
  const votes = [];
  for (const t of tiles) {
    const each = (t.desired - gap * (t.rn - 1)) / t.rn;
    for (let r = t.rs; r < t.rs + t.rn; r++) (votes[r] || (votes[r] = [])).push(each);
  }

  const heights = [];
  for (let r = 1; r <= rows; r++) {
    if (fixed[r] > 0) {
      heights[r] = fixed[r];
      continue;
    }
    const asked = votes[r];
    if (!asked || !asked.length) {
      heights[r] = max;
      continue;
    }
    asked.sort((a, b) => a - b);
    heights[r] = Math.min(max, Math.max(min, quantile(asked, FIT_QUANTILE)));
  }

  // ── Write, then read again ─────────────────────────────────────────────────
  const track = [];
  for (let r = 1; r <= rows; r++) track.push(Math.round(heights[r]) + "px");
  list.style.setProperty("--bento-rows", track.join(" "));

  for (const t of tiles) {
    let height = gap * (t.rn - 1);
    for (let r = t.rs; r < t.rs + t.rn; r++) height += heights[r];
    // Read by the split composition, which sizes its cover COLUMN off the
    // tile's height — those tiles are one row tall, so this is that row.
    t.el.style.setProperty("--tile-height", Math.round(height) + "px");
    t.el.style.setProperty("--tile-chrome", Math.round(t.chrome) + "px");
    // What the cover may never take, however flat that leaves it. A row can
    // come out shorter than a tile asked for — it is shared with the tiles
    // beside it — and when it does the summary is what gives, not the meta row.
    t.el.style.setProperty("--tile-furniture", Math.round(t.furniture) + "px");
  }

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
  list.style.removeProperty("--bento-rows");
  for (const tile of list.querySelectorAll(".home-article-item")) {
    tile.style.removeProperty("--tile-height");
    tile.style.removeProperty("--tile-chrome");
    tile.style.removeProperty("--tile-furniture");
  }
  for (const text of list.querySelectorAll(".home-article-content")) {
    text.style.removeProperty("--fit-lines");
  }
}
