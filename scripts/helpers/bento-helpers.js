"use strict";

/**
 * Redefine-X — home bento planner.
 *
 * Three columns of CELLS whose row heights are picked at runtime
 * (layouts/bentoFit.js). A tile covers a whole number of cells, and a PAGE is a
 * vertical stack of MOVEMENTS: hand-authored rectangles, three columns wide,
 * tiled completely by their shapes. Stacked rectangles are what keep the page
 * hole-free without `grid-auto-flow: dense`, whose backfilling would pull a later
 * tile into an earlier gap and put 7 to the left of 5.
 *
 * ── What decides which movement a run of posts gets ──────────────────────────
 *
 * The runtime row solver is SIMULATED over every movement at every position, and
 * what comes out is judged in two stages:
 *
 *   FEASIBLE   a hard yes/no. A cover is shown at a crop inside its band, a
 *              summary shows at least two lines, a pin gets at least two cells.
 *              A movement that cannot do this for these posts is not "a bit
 *              worse" — it is not an arrangement of them at all, and it is
 *              dropped from the search.
 *   COST       among the arrangements that work: blank space first, truncation
 *              second, then strip-shaped tiles and unaccented pins.
 *
 * The search over the whole page is a DP rather than a greedy walk, so a
 * movement that fits this run perfectly but leaves an impossible remainder loses
 * to one that does not. Both ends optimise the same number in the same units.
 *
 * A movement has to obey two rules: its shapes tile its rectangle exactly, and
 * they are written in the order CSS will place them — sparse auto-placement
 * carries a cursor that only moves forward, so a shape starting left of the
 * cursor drops a row and nothing after it can reach a row above.
 */

/* ═══ TUNING ═══════════════════════════════════════════════════════════════════
 *
 * Every number that expresses a PREFERENCE lives here and nowhere else; the rest
 * of this file is geometry and search. All of them are in the same currency —
 * pixels of tile, weighted by the share of the tile its text occupies — so they
 * can be compared with each other directly, and one of them is a line of summary
 * (24px) whichever way you read it.
 *
 * Raising a weight makes the planner work harder to avoid that fault, which it
 * pays for with one of the others. Nothing here can produce a broken layout: the
 * hard rules are the three `_MIN` entries, and they are yes/no, not weights.
 */
const W = {
  // ── Hard rules ───────────────────────────────────────────────────────────
  // Not weights. A pairing that breaks one of these is dropped from the search:
  // it is not a worse arrangement of these posts, it is not an arrangement.
  TEXT_LINES_MIN: 2, // least summary that reads as a summary
  STICKY_CELLS_MIN: 2, // least a pinned post may be given
  TEXT_LINES_MAX: 12, // most summary a tile is worth GROWING for; past it, ellipsis

  // ── Faults, per pixel of tile ────────────────────────────────────────────
  // CLIP outweighs BLANK by more than the widest row holds tiles, and that ratio
  // IS the row rule: a row grows while anything in it is still cut short, and
  // shrinks only while every one of them has space left over.
  BLANK: 1, // white space
  CLIP: 6, // summary cut short, per pixel, with no saturation

  // ── Emphasis ─────────────────────────────────────────────────────────────
  // Charged against the SHAPE, never against the height a post asks for: a pin
  // does not give a post more to say, so it may not move a row.
  EMPHASIS: 0.6, // per unit of shortfall, as a fraction of the tile
  STICKY_CELLS_WANT: 6, // a pin reads best at 2x2 or 3x1
  RECENT_CELLS_WANT: 2, // a fresh post gets a nudge, not a promotion
  RECENT_DAYS: 31, // how long "recent" lasts, fading the whole way

  // ── Composition ──────────────────────────────────────────────────────────
  PROPORTION: 0.5, // per pixel a tile is short of reading as a card
  PROPORTION_MAX: 3.2, // width over height past which a tile is a strip
  // A single cell carrying a cover is the worst tile on the grid: the picture
  // takes over half of it before a word is set, so the row has to grow tall to
  // fit two lines under it and every other tile in that row is dragged along.
  // Priced so the search goes a long way round to avoid one.
  SMALL_COVER: 1.2,
  // A split tile's cover column is its own HEIGHT at the cover ratio, so a tall
  // row squeezes the text beside it. Charged as the column narrows, because the
  // hard floor alone (270px) is a column nothing reads well in.
  SPLIT_TEXT: 0.8,
  SPLIT_TEXT_WANT: 430,
  // The opening that gives the site cards the whole first row. Only worth it
  // when no other opening works, so it carries a flat charge of its own.
  SOLO_OPENING: 420,
  // Repeating an arrangement is dull rather than wrong, so it costs. As a
  // fraction of the movement's own weight, one entry per movement looked back.
  REPEAT: [0.28, 0.14],
  // A page is more interesting for using the whole range of tile sizes. Charged
  // ONCE, at the end of the page, per size never used — an encouragement and not
  // a rule, and scaled down on a page too short to hold the range.
  VARIETY: 110,
  VARIETY_POSTS: 10,
};

/* ══════════════════════════════════════════════════════════════════════════════ */

const COLUMNS = 3;
const COLUMNS_MD = 2;

/* ─── Geometry ─────────────────────────────────────────────────────────────── */

// The grid at its widest, which is the one width shapes are judged at: only the
// RATIOS between the numbers below decide anything, so one reference is enough.
// These mirror source/css/common/variables.styl, and they are an ESTIMATE — the
// runtime measures every tile for real. A drift here costs a slightly worse
// arrangement, never a broken layout.
const GAP = 28;
const GRID = 1560;
const TRACK = (GRID - (COLUMNS - 1) * GAP) / COLUMNS;

// The crop band, mirroring $bento-cover-target and its tolerance. A cover's
// HEIGHT is its width over one of these, so `flattest` is the shortest picture
// the band allows and `tallest` the deepest. Leftover height in a tile goes to
// the picture — up to `tallest` — before any of it is left blank.
const COVER = 16 / 9;
const COVER_TOLERANCE = 0.1;
const COVER_FLATTEST = COVER * (1 + COVER_TOLERANCE);
const COVER_TALLEST = COVER * (1 - COVER_TOLERANCE);

// The tile's own furniture at that width: the body's padding and two gaps and the
// meta row, plus a line of title per line of title. $bento-tile-chrome-min is the
// worst case of the same thing.
const PADDING = 45;
const SPLIT_PADDING = 48;
const CHROME = 118;
const TITLE_LINE = 26;
const TITLE_EM = 19;
const LINE = 24;
const EM = 16;

// A split tile's text column may not fall below this; its cover column takes what
// is left of the width, and never more than SPLIT_COVER_MAX of the tile. Mirrors
// $bento-split-text-min and $bento-split-cover-max, whose comment explains the
// loop the second one exists to break.
const SPLIT_TEXT_MIN = 270;
const SPLIT_COVER_MAX = 0.58;

// The site cards are furniture and their row is exactly their own height —
// neither stretched nor compressed by anything standing beside it. The build can
// only guess at that height; the runtime measures it. A drift here costs a
// slightly worse arrangement, never a broken one, because no tile is SIZED from
// this row: the openings put only multi-row tiles across it, so a tile sharing it
// takes what it needs from the free rows underneath.
const FEATURE_ROW = TRACK / COVER + 180;

// What a split tile's row is guessed at before the first solve has produced a
// real one. Only its cover column, and therefore its text width, depends on it.
const START_ROW = TRACK / COVER + 180;

/* ─── Shapes ───────────────────────────────────────────────────────────────── */

// Every tile is one of these, and a shape says only how many cells it covers.
// What a tile PRINTS is decided at runtime, from the height its rows came out at.
const SHAPES = {
  small: { cn: 1, rn: 1 },
  standard: { cn: 1, rn: 2 },
  tall: { cn: 1, rn: 3 },
  duo: { cn: 2, rn: 1 },
  wide: { cn: 2, rn: 2 },
  band: { cn: 3, rn: 1 },
};

// Wide and one row tall: no room for a band above the text, so the cover goes
// beside it and takes WIDTH instead of height. Derived, so a shape can never
// disagree with its own dimensions — the stylesheet derives the same rule.
let shapeBit = 1;
for (const shape of Object.values(SHAPES)) {
  shape.width = shape.cn * TRACK + (shape.cn - 1) * GAP;
  shape.split = shape.cn > 1 && shape.rn === 1;
  shape.cells = shape.cn * shape.rn;
  // One bit each, so "which sizes has this page used" is a number the search can
  // carry in its state rather than a set it has to rebuild.
  shape.bit = shapeBit;
  shapeBit <<= 1;
}
const SHAPES_ALL = shapeBit - 1;

/* ─── What a post asks for ─────────────────────────────────────────────────── */

/**
 * Two measures of the same text, because two different questions are asked of it.
 * `words` is how much there is to READ — a CJK glyph is a word and so is a run of
 * Latin letters, the only way a Chinese post and an English one compare at all.
 * `ems` is how much ROOM it takes: a CJK glyph is about one em wide, an English
 * word about three counting the space after it.
 */
function measureText(html) {
  if (!html) return { words: 0, ems: 0 };
  const text = String(html).replace(/<[^>]*>/g, " ");
  const cjk = text.match(/[㐀-鿿豈-﫿぀-ヿ]/g);
  const latin = text.match(/[A-Za-z0-9]+/g);
  const glyphs = cjk ? cjk.length : 0;
  const words = latin ? latin.length : 0;
  return { words: glyphs + words, ems: glyphs + words * 3 };
}

/** Lines a run of text takes in a column this many ems wide. */
function lines(ems, perLine) {
  if (!(ems > 0) || !(perLine > 0)) return 0;
  return Math.ceil(ems / perLine);
}

/** 0 at `lo`, 1 at `hi`, clamped; reversed when `lo` is the larger number. */
function ramp(value, lo, hi) {
  if (hi === lo) return 0;
  const t = (value - lo) / (hi - lo);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

const DAY = 24 * 60 * 60 * 1000;

function measure(post, now) {
  const excerpt = post.excerpt && post.excerpt !== "false" ? post.excerpt : "";
  const silent = post.excerpt === "false";
  const date = post.date ? new Date(post.date).getTime() : now;
  const body = measureText(post.content);
  const summary = excerpt ? measureText(excerpt) : null;

  return {
    sticky: !!post.sticky,
    cover: post.thumbnail !== false && !!(post.thumbnail || post.cover || post.banner),
    // A post with no excerpt of its own gets one generated from its body, so the
    // body is the supply; one that asked for silence has nothing to show at all.
    textEms: silent ? 0 : summary ? summary.ems : body.ems,
    titleEms: measureText(post.title).ems,
    ageDays: Math.max(0, (now - date) / DAY),
  };
}

/**
 * What a post asks of one shape, in the units the row solver works in.
 *
 *   need  chrome + the cover at its FLATTEST allowed crop. Below this either the
 *         title clips or the picture leaves its band; there is no such tile.
 *   lo    need + the whole summary: the shortest height that cuts nothing.
 *   hi    the same with the cover at its TALLEST allowed crop: the tallest height
 *         that leaves nothing blank, because the picture takes the slack first.
 *   max   a split tile's cover column widens with the tile's height, so past this
 *         the crop passes `tallest` and the picture stops being the one composed.
 *
 * `height` matters only to a split tile: its cover column is its own height at the
 * cover ratio, so what is left for the text — and therefore how far the summary
 * runs — is not knowable until the row is.
 */
function ask(m, shape, height) {
  const pad = shape.split ? SPLIT_PADDING : PADDING;
  // The stylesheet's own rule: `min(tile-height x target, 100% - text-min)`, and
  // `100%` there is the TILE, so the body's padding comes off the text side.
  const room = Math.min(shape.width - SPLIT_TEXT_MIN, shape.width * SPLIT_COVER_MAX);
  const column = shape.split && m.cover ? Math.min(Math.max(0, height) * COVER, room) : 0;
  const width = shape.width - pad - column;
  const chrome = CHROME + Math.max(1, lines(m.titleEms, width / TITLE_EM)) * TITLE_LINE;

  // Only a cover ABOVE the text takes a share of the tile's HEIGHT.
  const stacked = m.cover && !shape.split;
  const coverMin = stacked ? shape.width / COVER_FLATTEST : 0;
  const coverMax = stacked ? shape.width / COVER_TALLEST : 0;

  const textLines = Math.min(W.TEXT_LINES_MAX, lines(m.textEms, width / EM));
  const text = textLines * LINE;
  // The floor carries the least summary that still IS one. A tile whose row
  // cannot hold the picture and two lines is not cramped, it is the wrong tile
  // for this post — so the row grows, and where it cannot grow (only the site
  // cards' row is pinned) the shape is reported as not working here.
  const need = chrome + coverMin + Math.min(text, W.TEXT_LINES_MIN * LINE);

  return {
    width,
    share: width / shape.width,
    textLines,
    chrome,
    coverMin,
    need,
    lo: chrome + coverMin + text,
    hi: chrome + coverMax + text,
    // Never below the floor: at the narrowest tile the composition is allowed on
    // at all, the two are within a few pixels of each other, and a ceiling under
    // the floor would ask the solver for a height that does not exist.
    max: shape.split && m.cover ? Math.max(need, room / COVER_TALLEST) : Infinity,
  };
}

/* ─── The row solver ───────────────────────────────────────────────────────── */

/**
 * MIRRORED in source/js/layouts/bentoFit.js — same rule, same units, same answer.
 * The build plans against the numbers it can estimate; the runtime re-solves
 * against the numbers it can measure. Any drift between the two files is a bug in
 * both of them.
 *
 * A row GROWS while anything standing in it is still cut short, and SHRINKS only
 * while every one of them has blank space left over. Its resting place is the
 * height at which the most demanding tile shows its whole summary. Blank space on
 * the tiles that wanted less is then a property of the PAIRING, which is what
 * this file answers for: it is charged below, and the arrangement that produced
 * it loses to one that did not.
 *
 * As a cost in the height `s` a tile's rows add up to:
 *
 *   s < need        impossible: the picture would leave its crop band, or the
 *                   summary would fall below TEXT_LINES_MIN and stop being one
 *   need <= s < lo  the summary is cut short — CLIP per pixel, every pixel
 *   lo <= s <= hi   nothing cut and nothing blank; the cover took the slack
 *   s > hi          white space — BLANK per pixel
 *   s > max         impossible: a split tile's crop would pass `tallest`
 *
 * `lo`..`hi` is a RANGE rather than a point precisely because a cover may be
 * cropped anywhere inside the tolerance band: leftover height goes to the picture
 * before it is left blank.
 *
 * The whole thing is convex in `s` and `s` is a sum of row heights, so sweeping
 * one row at a time across the breakpoints of the tiles standing in it lands ON
 * the resting place rather than near it.
 */

// Blank and clip are charged where they SHOW — in the text column — so a split
// tile, whose picture fills the height whatever the text does, is not blamed for
// the width it does not use. IMPOSSIBLE is steep enough that a sweep always
// climbs out of a height that cannot exist, and finite so that it can: an
// Infinity would strand a first guess outside the bounds with nowhere to go.
const IMPOSSIBLE = 40;

function tileCost(t, s) {
  if (s < t.need) return IMPOSSIBLE * (t.need - s) * t.share;
  if (s > t.max) return IMPOSSIBLE * (s - t.max) * t.share;
  // Every pixel of a cut summary, with no saturation: a cut that stops counting
  // is a row that stops growing, and that is the one thing this may not do.
  if (s < t.lo) return W.CLIP * (t.lo - s) * t.share;
  if (s > t.hi) return W.BLANK * (s - t.hi) * t.share;
  return 0;
}

const SWEEPS = 8;
const SETTLED = 0.5;

function span(rows, it) {
  let height = GAP * (it.rn - 1);
  for (let r = it.rs; r < it.rs + it.rn; r++) height += rows[r] || 0;
  return height;
}

function solveRows(items, rowCount, fixed) {
  const standing = [];
  for (let r = 0; r < rowCount; r++) standing.push([]);
  for (const it of items) {
    for (let r = it.rs; r < it.rs + it.rn && r < rowCount; r++) standing[r].push(it);
  }

  // A first guess in the right neighbourhood — as tall as the tallest thing in
  // the row needs, or as the shortest thing wants — and then the sweep. The site
  // cards' row is neither: it is their own height, and it is not a variable.
  const rows = [];
  for (let r = 0; r < rowCount; r++) {
    if (fixed[r] > 0) {
      rows[r] = fixed[r];
      continue;
    }
    let start = 0;
    let want = Infinity;
    for (const it of standing[r]) {
      start = Math.max(start, (it.need - GAP * (it.rn - 1)) / it.rn);
      want = Math.min(want, (it.lo - GAP * (it.rn - 1)) / it.rn);
    }
    rows[r] = want === Infinity ? start : Math.max(start, want);
  }

  for (let pass = 0; pass < SWEEPS; pass++) {
    let moved = 0;

    for (let r = 0; r < rowCount; r++) {
      const here = standing[r];
      if (!here.length || fixed[r] > 0) continue;

      // Every height at which one of these tiles changes what it charges. A
      // piecewise-linear function of one variable takes its minimum at a
      // breakpoint or at a bound, so this list is the whole search.
      const tries = [0, rows[r]];
      for (const it of here) {
        const rest = span(rows, it) - rows[r];
        for (const edge of [it.need, it.lo, it.hi, it.max]) {
          const h = edge - rest;
          if (h > 0 && h < Infinity) tries.push(h);
        }
      }

      let best = rows[r];
      let bestCost = Infinity;
      for (const h of tries) {
        rows[r] = h;
        let cost = 0;
        for (const it of here) cost += tileCost(it, span(rows, it));
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

/* ─── Judging an arrangement ───────────────────────────────────────────────── */

/** Lines of summary a tile actually prints at this height. */
function shownLines(it, supply) {
  const room = supply - it.chrome - it.coverMin;
  return Math.min(it.textLines, Math.max(0, Math.floor(room / LINE)));
}

/**
 * The hard rules. Not weights — a pairing that breaks one of these is not a worse
 * arrangement of these posts, it is not an arrangement of them: the cover is gone,
 * or the summary is, or a pin reads as an ordinary post.
 */
function feasible(it, supply) {
  if (supply < it.need - 1) return false;
  if (supply > it.max + 1) return false;
  if (it.m.sticky && it.shape.cells < W.STICKY_CELLS_MIN) return false;
  if (it.textLines > 0 && shownLines(it, supply) < Math.min(it.textLines, W.TEXT_LINES_MIN)) {
    return false;
  }
  return true;
}

function fitCost(movement, metrics, offset) {
  const items = [];
  for (let k = 0; k < movement.size; k++) {
    const m = metrics[offset + k];
    if (!m) break;
    const shape = SHAPES[movement.postShapes[k]];
    items.push(
      Object.assign({ m, shape, rs: movement.rows[k], rn: shape.rn }, ask(m, shape, START_ROW)),
    );
  }
  // An opening that holds nothing but the site cards: no post to judge, and the
  // flat charge on it is what keeps it a last resort.
  if (!items.length) {
    return movement.size === 0
      ? { fault: movement.penalty || 0, weight: 0, ok: true, shapes: 0 }
      : null;
  }

  let rows = solveRows(items, movement.rowCount, movement.fixed);

  // One correction, for the split tiles alone: they were asked at a guessed row
  // and their real one is a different width of text column. The second solve
  // moves the rows it was computed from by less than a line.
  if (items.some((it) => it.shape.split && it.m.cover)) {
    for (const it of items) {
      if (it.shape.split && it.m.cover) Object.assign(it, ask(it.m, it.shape, span(rows, it)));
    }
    rows = solveRows(items, movement.rowCount, movement.fixed);
  }

  let fault = 0;
  let weight = 0;
  let ok = true;
  let shapes = 0;

  for (const it of items) {
    const supply = span(rows, it);
    if (!feasible(it, supply)) ok = false;
    shapes |= it.shape.bit;

    fault += tileCost(it, supply);

    // A pin, or a post recent enough to be worth a nudge, that landed on a shape
    // smaller than it asked for. In CELLS, because that is what "large" means on
    // a grid: a 3x1 band is the biggest tile on the page and one of the shortest,
    // so height cannot be the measure.
    const wantCells = Math.max(
      it.m.sticky ? W.STICKY_CELLS_WANT : 0,
      ramp(it.m.ageDays, W.RECENT_DAYS, 0) * W.RECENT_CELLS_WANT,
    );
    if (wantCells > it.shape.cells) {
      fault += W.EMPHASIS * ((wantCells - it.shape.cells) / wantCells) * supply * it.share;
    }

    // And the height this tile would have to reach to stop reading as a strip
    // rather than a card. This is what keeps the page off a stack of full-width
    // bands: a band suits a post with enough to say to make it deep, and is a
    // letterbox for one without.
    const square = it.shape.width / W.PROPORTION_MAX - supply;
    if (square > 0) fault += W.PROPORTION * square * it.share;

    // The two shapes a cover is expensive on. A single cell has to grow tall
    // before two lines fit under the picture, and drags its whole row with it; a
    // split tile hands the picture its own height in WIDTH, so the taller the row
    // the less there is left to set the text in.
    if (it.m.cover && it.shape.cells === 1) fault += W.SMALL_COVER * supply * it.share;
    if (it.m.cover && it.shape.split) {
      const narrow = W.SPLIT_TEXT_WANT - it.width;
      if (narrow > 0) {
        fault += W.SPLIT_TEXT * (narrow / W.SPLIT_TEXT_WANT) * supply * it.share;
      }
    }

    weight += supply * it.share;
  }

  fault += movement.penalty || 0;
  return { fault, weight, ok, shapes };
}

/* ─── The movement library ─────────────────────────────────────────────────── */

const slot = (shape, cs) => ({ shape, cs });
const feature = (name, cs, cn) => ({ shape: name, cs, cn: cn || 1, isFeature: true });

const MOVEMENTS = {
  // The site cards open every page, at the top left, one cell each, and the
  // paginator never flips them — they are furniture, and furniture that turns
  // over reads as the page having lost its place.
  //
  // Their row is PINNED to their own height and nothing may stretch or compress
  // it. So the third cell of that row never holds a one-row tile: every opening
  // below puts a tile that also reaches the free rows underneath, which is what
  // lets it take the height its cover and summary need without touching the
  // cards. And when none of them works — a page with one post, or one whose
  // opening posts fit nothing — the links card takes the third cell itself and
  // the row is furniture end to end, which is the only arrangement in which the
  // pinned row provably cannot starve anything.
  openingSolo: {
    slots: [feature("info", 1), feature("links", 2, 2)],
    penalty: W.SOLO_OPENING,
  },
  // 3x2 — a double-height tile beside the cards, and a wide one under them.
  openingPair: {
    slots: [feature("info", 1), feature("links", 2), slot("standard", 3), slot("duo", 1)],
  },
  // 3x2 — the same, with two single cells instead.
  openingTrio: {
    slots: [
      feature("info", 1),
      feature("links", 2),
      slot("standard", 3),
      slot("small", 1),
      slot("small", 2),
    ],
  },
  // 3x3 — a wide tile under the cards and a full-width band closing the opening.
  openingBand: {
    slots: [
      feature("info", 1),
      feature("links", 2),
      slot("standard", 3),
      slot("duo", 1),
      slot("band", 1),
    ],
  },
  // 3x3 — the lead arrangements, for a page whose opening posts are heavy.
  openingLead: {
    slots: [feature("info", 1), feature("links", 2), slot("tall", 3), slot("wide", 1)],
  },
  openingStack: {
    slots: [
      feature("info", 1),
      feature("links", 2),
      slot("tall", 3),
      slot("standard", 1),
      slot("standard", 2),
    ],
  },
  // 3x3 — a full-height tile beside the cards, with two wide ones under them.
  openingTall: {
    slots: [feature("info", 1), feature("links", 2), slot("tall", 3), slot("duo", 1), slot("duo", 1)],
  },
  // 3x3 — the widest opening: a wide tile, then a row of singles.
  openingMix: {
    slots: [
      feature("info", 1),
      feature("links", 2),
      slot("standard", 3),
      slot("duo", 1),
      slot("small", 1),
      slot("small", 2),
      slot("small", 3),
    ],
  },

  // 3x1 — three single cells, one band, or a two-column tile and a single.
  trio: {
    slots: [slot("small", 1), slot("small", 2), slot("small", 3)],
  },
  bandFull: {
    slots: [slot("band", 1)],
  },
  duoLeft: {
    slots: [slot("duo", 1), slot("small", 3)],
  },
  duoRight: {
    slots: [slot("small", 1), slot("duo", 2)],
  },

  // 3x2 — three double-height tiles side by side.
  trioTall: {
    slots: [slot("standard", 1), slot("standard", 2), slot("standard", 3)],
  },

  // 3x2 — two two-column tiles stacked beside a double-height one. No single cell
  // anywhere in it, which is what makes it the workhorse for a run of posts that
  // all carry covers.
  duoStack: {
    slots: [slot("duo", 1), slot("standard", 3), slot("duo", 1)],
  },
  duoStackAlt: {
    slots: [slot("standard", 1), slot("duo", 2), slot("duo", 2)],
  },

  // 3x2 — a two-by-two with two singles stacked beside it.
  bigLeft: {
    slots: [slot("wide", 1), slot("small", 3), slot("small", 3)],
  },
  bigRight: {
    slots: [slot("small", 1), slot("wide", 2), slot("small", 1)],
  },

  // 3x2 — a two-by-two beside a double-height tile.
  pairLeft: {
    slots: [slot("wide", 1), slot("standard", 3)],
  },
  pairRight: {
    slots: [slot("standard", 1), slot("wide", 2)],
  },

  // 3x2 — two double-height tiles and two singles.
  mixLeft: {
    slots: [slot("standard", 1), slot("standard", 2), slot("small", 3), slot("small", 3)],
  },
  mixRight: {
    slots: [slot("small", 1), slot("standard", 2), slot("standard", 3), slot("small", 1)],
  },

  // 3x2 — two wide tiles mirrored, each with a single beside it. The only
  // arrangement where a cover sits beside its text twice running.
  duoPair: {
    slots: [slot("duo", 1), slot("small", 3), slot("small", 1), slot("duo", 2)],
  },
  duoPairAlt: {
    slots: [slot("small", 1), slot("duo", 2), slot("duo", 1), slot("small", 3)],
  },

  // 3x2 — a wide tile and a single over a full-width band, or the reverse.
  duoBand: {
    slots: [slot("duo", 1), slot("small", 3), slot("band", 1)],
  },
  bandDuo: {
    slots: [slot("band", 1), slot("duo", 1), slot("small", 3)],
  },

  // 3x2 — a band over or under three single cells.
  bandTrio: {
    slots: [slot("band", 1), slot("small", 1), slot("small", 2), slot("small", 3)],
  },
  trioBand: {
    slots: [slot("small", 1), slot("small", 2), slot("small", 3), slot("band", 1)],
  },

  // 3x3 — the tallest arrangements, all built round a full-height tile.
  tallStack: {
    slots: [slot("tall", 1), slot("small", 2), slot("small", 3), slot("wide", 2)],
  },
  tallBig: {
    slots: [slot("tall", 1), slot("wide", 2), slot("small", 2), slot("small", 3)],
  },
  tallDuos: {
    slots: [slot("tall", 1), slot("duo", 2), slot("duo", 2), slot("duo", 2)],
  },
  // The same three rows with no single cell in them.
  tallWide: {
    slots: [slot("tall", 1), slot("wide", 2), slot("duo", 2)],
  },
  wideTall: {
    slots: [slot("wide", 1), slot("tall", 3), slot("duo", 1)],
  },
};

const OPENINGS = [
  "openingMix",
  "openingBand",
  "openingTall",
  "openingStack",
  "openingLead",
  "openingTrio",
  "openingPair",
  "openingSolo",
];

const CANDIDATES = [
  "tallStack",
  "tallBig",
  "tallDuos",
  "tallWide",
  "wideTall",
  "mixLeft",
  "mixRight",
  "bigLeft",
  "bigRight",
  "duoPair",
  "duoPairAlt",
  "duoStack",
  "duoStackAlt",
  "duoBand",
  "bandDuo",
  "bandTrio",
  "trioBand",
  "trioTall",
  "trio",
  "pairLeft",
  "pairRight",
  "duoLeft",
  "duoRight",
  "bandFull",
];

/**
 * The row each item lands in, run through CSS grid's own sparse auto-placement
 * (CSS Grid §8.5): the cursor only moves forward, so an item starting left of it
 * drops a row, and one that would overlap something already placed drops until it
 * does not. Derived rather than declared, because a movement's rectangle is fully
 * described by its slots and a hand-written row number is a second copy of the
 * same fact. `items` are `{ cs, cn, rn }` — what both grids have in common.
 */
function placeRows(items, columns) {
  const grid = [];
  const cells = (r) => grid[r] || (grid[r] = new Array(columns).fill(false));
  const rows = [];
  let row = 0;
  let col = 0;

  for (const item of items) {
    const start = item.cs - 1;
    if (start < col) row++;

    for (;;) {
      let clash = false;
      for (let r = row; r < row + item.rn && !clash; r++) {
        for (let c = start; c < start + item.cn; c++) if (cells(r)[c]) clash = true;
      }
      if (!clash) break;
      row++;
    }

    for (let r = row; r < row + item.rn; r++) {
      for (let c = start; c < start + item.cn; c++) cells(r)[c] = true;
    }
    rows.push(row);
    col = start + item.cn;
  }

  return rows;
}

/** A slot's box on the three-column grid. Features are one row tall, always. */
function slotBox(s) {
  if (s.isFeature) return { cs: s.cs, cn: s.cn, rn: 1 };
  const shape = SHAPES[s.shape];
  return { cs: s.cs, cn: shape.cn, rn: shape.rn };
}

/** How many rows a placed set covers — the offset the next movement starts at. */
function rowsUsed(items, rows) {
  let used = 0;
  for (let i = 0; i < items.length; i++) used = Math.max(used, rows[i] + items[i].rn);
  return used;
}

// Post count, row count, shapes and which rows carry the site cards — all
// derived, so none of them can disagree with the slots. Every movement is also
// checked to TILE its rectangle: a hole here would be a hole on the page, and it
// is cheaper to fail the build than to find it in a screenshot.
for (const [name, movement] of Object.entries(MOVEMENTS)) {
  const boxes = movement.slots.map(slotBox);
  const rows = placeRows(boxes, COLUMNS);
  movement.size = movement.slots.filter((s) => !s.isFeature).length;
  movement.rowCount = rowsUsed(boxes, rows);
  movement.fixed = [];
  rows.forEach((r, i) => {
    if (movement.slots[i].isFeature) movement.fixed[r] = FEATURE_ROW;
  });
  // Both aligned with the order fitCost walks the post slots, features skipped.
  movement.rows = rows.filter((r, i) => !movement.slots[i].isFeature);
  movement.postShapes = movement.slots.filter((s) => !s.isFeature).map((s) => s.shape);

  let covered = 0;
  for (let i = 0; i < boxes.length; i++) covered += boxes[i].cn * boxes[i].rn;
  if (covered !== COLUMNS * movement.rowCount) {
    throw new Error(
      "bento: movement '" + name + "' does not tile its " + COLUMNS + "x" + movement.rowCount + " rectangle",
    );
  }
}

/* ─── The search ───────────────────────────────────────────────────────────── */

function repeatCost(name, last) {
  return name === last ? W.REPEAT[0] : 0;
}

/**
 * The cheapest way to spend the WHOLE page, not the cheapest next step. A greedy
 * walk takes the movement that suits the posts in front of it and hands the rest
 * a remainder nothing fits; this looks at what the remainder costs before
 * committing, which is the difference between "this arrangement is right" and
 * "this arrangement was first".
 *
 * The state is the position, the movement before it, and which tile SIZES the
 * page has used so far — the last of those because using the whole range is a
 * property of the finished page and cannot be judged one movement at a time. It
 * is charged at the end, so nothing local is distorted by it.
 */
function planSequence(metrics, features) {
  const count = metrics.length;
  if (!count) return [];

  // `first` rather than `i === 0`: an opening may hold no posts at all, and then
  // the movement after it also starts at zero. It is what stops that being an
  // infinite loop as well as what keeps openings off the middle of the page.
  const pool = (first) => (first && features ? OPENINGS : CANDIDATES);

  // Every movement's fit at every position, solved once: the row solve does not
  // depend on what came before it, so the search is arithmetic on this table.
  const fits = [];
  for (let i = 0; i < count; i++) {
    const at = {};
    for (const name of OPENINGS.concat(CANDIDATES)) {
      if (at[name] || MOVEMENTS[name].size > count - i) continue;
      at[name] = fitCost(MOVEMENTS[name], metrics, i);
    }
    fits.push(at);
  }

  // A page too short to hold the range is not asked to: at ten posts the whole
  // set is expected, and below that proportionally less of it.
  const variety = W.VARIETY * Math.min(1, count / W.VARIETY_POSTS);
  const memo = new Map();

  function best(i, last, used, first) {
    if (i >= count) {
      let missing = 0;
      for (let bit = 1; bit <= SHAPES_ALL; bit <<= 1) if (!(used & bit)) missing++;
      return { cost: variety * missing, pick: "" };
    }

    const key = i + "|" + last + "|" + used + "|" + (first ? 1 : 0);
    const hit = memo.get(key);
    if (hit) return hit;

    let chosen = null;
    // Two rounds: the arrangements that work, and — only if none does — the least
    // bad of the rest, so the page always finishes.
    for (const strict of [true, false]) {
      for (const name of pool(first)) {
        const fit = fits[i][name];
        if (!fit) continue;
        if (strict && !fit.ok) continue;
        const rest = best(i + MOVEMENTS[name].size, name, used | fit.shapes, false);
        const cost = fit.fault + repeatCost(name, last) * fit.weight + rest.cost;
        if (!chosen || cost < chosen.cost) chosen = { cost, pick: name };
      }
      if (chosen) break;
    }

    if (!chosen) chosen = { cost: 0, pick: pool(first)[pool(first).length - 1] };
    memo.set(key, chosen);
    return chosen;
  }

  const sequence = [];
  let i = 0;
  let last = "";
  let used = 0;
  let first = features;
  while (i < count) {
    const name = best(i, last, used, first).pick;
    const movement = MOVEMENTS[name];
    // A page with fewer posts than the opening needs still gets the site cards;
    // the row simply ends early.
    const take = Math.min(movement.size, count - i);
    sequence.push({ name, take });
    used |= (fits[i][name] || { shapes: 0 }).shapes;
    i += take;
    last = name;
    first = false;
  }

  return sequence;
}

/* ─── Tablet ───────────────────────────────────────────────────────────────── */

/**
 * Two columns. A one-column shape stays one column, anything wider takes the row;
 * consecutive narrow shapes pair up and share the taller one's row span, which is
 * what keeps the result hole-free.
 */
function packMd(slots) {
  const out = [];
  let i = 0;

  while (i < slots.length) {
    const a = SHAPES[slots[i].shape];
    const next = i + 1 < slots.length ? SHAPES[slots[i + 1].shape] : null;

    if ((!a || a.cn === 1) && next && next.cn === 1) {
      const rn = Math.max(a ? a.rn : 1, next.rn);
      out.push({ cs: 1, cn: 1, rn });
      out.push({ cs: 2, cn: 1, rn });
      i += 2;
      continue;
    }

    out.push({ cs: 1, cn: COLUMNS_MD, rn: a ? a.rn : 1 });
    i += 1;
  }

  return out;
}

/* ─── The plan ─────────────────────────────────────────────────────────────── */

function planHomeGrid(posts, options) {
  const opts = options || {};
  const list = posts && posts.toArray ? posts.toArray() : posts || [];
  const now = Date.now();
  const metrics = list.map((post) => measure(post, now));
  const sequence = planSequence(metrics, !!(opts.features && list.length));

  const tiles = [];
  let postIndex = 0;
  // Counted over split tiles alone, so the mirroring survives any number of
  // ordinary tiles landing between them.
  let splitCount = 0;
  // Movements are full-width rectangles stacked in order, so one's rows start
  // where the previous one's ended — on each grid separately, since the same
  // movement is a different number of rows tall on the two of them.
  let lgOffset = 0;
  let mdOffset = 0;

  for (const step of sequence) {
    const movement = MOVEMENTS[step.name];

    // The slots this step actually renders: every feature, and posts until the
    // allowance runs out. The same walk as the emit loop below, so a truncated
    // opening at the end of a short page is a smaller rectangle rather than the
    // whole one with holes in it.
    const drawn = [];
    let allowed = step.take;
    for (const s of movement.slots) {
      if (!s.isFeature) {
        if (allowed <= 0) break;
        allowed--;
      }
      drawn.push(s);
    }

    const postSlots = drawn.filter((s) => !s.isFeature);
    const features = drawn.filter((s) => s.isFeature);
    const md = packMd(postSlots);

    const lgBoxes = drawn.map(slotBox);
    const lgRows = placeRows(lgBoxes, COLUMNS);

    // The two site cards open the tablet grid the same way they open the wide
    // one — one cell each, side by side — and the packed posts follow.
    const mdBoxes = features.map((s, i) => ({ cs: i + 1, cn: 1, rn: 1 })).concat(md);
    const mdRows = placeRows(mdBoxes, COLUMNS_MD);

    let mdIndex = 0;
    let featureIndex = 0;
    let drawnIndex = 0;

    for (const s of drawn) {
      const lgRow = lgOffset + lgRows[drawnIndex] + 1;
      drawnIndex++;

      if (s.isFeature) {
        tiles.push({
          kind: "feature",
          name: s.shape,
          movement: step.name,
          lg: { cs: s.cs, cn: s.cn, rn: 1, rs: lgRow },
          md: { cs: featureIndex + 1, cn: 1, rn: 1, rs: mdOffset + mdRows[featureIndex] + 1 },
        });
        featureIndex++;
        continue;
      }

      const shape = SHAPES[s.shape];
      const place = md[mdIndex] || { cs: 1, cn: COLUMNS_MD, rn: shape.rn };
      const mdRow = mdOffset + (mdRows[features.length + mdIndex] || 0) + 1;

      tiles.push({
        kind: "post",
        name: "",
        tier: s.shape,
        postIndex: postIndex,
        movement: step.name,
        lg: { cs: s.cs, cn: shape.cn, rn: shape.rn, rs: lgRow },
        md: { cs: place.cs, cn: place.cn, rn: place.rn, rs: mdRow },
        lgSplit: shape.split,
        mdSplit: place.cn > 1 && place.rn === 1,
        coverRight: shape.split && splitCount++ % 2 === 1,
      });

      postIndex++;
      mdIndex++;
    }

    lgOffset += rowsUsed(lgBoxes, lgRows);
    mdOffset += rowsUsed(mdBoxes, mdRows);
  }

  return tiles;
}

hexo.extend.helper.register("bentoPlan", function (posts, options) {
  return planHomeGrid(posts, options);
});

/**
 * How many rows the page comes to on each grid. The list carries both, because
 * load-more appends the next page's tiles into this same grid and their rows have
 * to be shifted past these (layouts/homePagination.js).
 */
hexo.extend.helper.register("bentoRows", function (tiles, key) {
  let rows = 0;
  for (const tile of tiles) {
    const box = tile[key];
    if (box && box.rs) rows = Math.max(rows, box.rs + box.rn - 1);
  }
  return rows;
});

/** Placement, carried as custom properties. */
hexo.extend.helper.register("bentoStyle", function (tile) {
  return [
    "--lg-cs:" + tile.lg.cs,
    "--lg-cn:" + tile.lg.cn,
    "--lg-rs:" + tile.lg.rs,
    "--lg-rn:" + tile.lg.rn,
    "--md-cs:" + tile.md.cs,
    "--md-cn:" + tile.md.cn,
    "--md-rs:" + tile.md.rs,
    "--md-rn:" + tile.md.rn,
  ].join(";");
});

/** Composition classes: which grid splits this tile, and which way round. */
hexo.extend.helper.register("bentoClasses", function (tile) {
  let out = "";
  if (tile.lgSplit) out += " lg-split";
  if (tile.mdSplit) out += " md-split";
  if (tile.coverRight) out += " cover-right";
  return out;
});
