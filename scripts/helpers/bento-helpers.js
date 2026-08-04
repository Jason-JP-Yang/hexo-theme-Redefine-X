"use strict";

/**
 * Redefine-X — home bento planner.
 *
 * ── The model ────────────────────────────────────────────────────────────────
 *
 * The home page is a grid of CELLS: three columns across, and ONE row height
 * shared by every row (see `--bento-row` in layout/home-content.styl). A tile
 * covers a whole number of cells — 1x1, 1x2, 1x3, 2x1, 2x2, 3x1 — and the page
 * is those tiles packed together without gaps.
 *
 * Every row is the same height on purpose. A row sized by whatever happens to be
 * in it changes from page to page, so the two site cards in the first row would
 * be a different height on every page, and no two tiles on the page would agree
 * on anything. What that shared height IS gets picked from the content by
 * layouts/bentoFit.js, inside a narrow range — tight enough that a page of notes
 * does not leave half its tiles empty, loose enough that a page of long-form
 * pieces is not all ellipsis.
 *
 * How much summary a tile prints is not decided here, or anywhere else in the
 * build. The excerpt takes the space its tile has left over and stops on the last
 * line that fits; the plan's only job is to hand each post a shape whose leftover
 * suits it.
 *
 * Which shape that is comes from a WEIGHT: a 0..1 score built from the signals in
 * `SIGNALS` — pinned, has a cover, how long the piece is, how long its excerpt
 * is, how recent it is, how many tags and categories it carries, how long its
 * title is. Each shape declares the weight it wants, and movements are chosen by
 * matching the two. Adding a signal later is one entry in that table.
 *
 * A weight alone would be enough if every shape of the same area were equally
 * easy to fill, and they are not. What a tile actually has to fill is whatever
 * its cover does not, and a 16:9 picture takes half the height of a 2x2 and a
 * quarter of a 1x3 — so the same thin summary is a discreet gap under the one and
 * a column of white beside the other. `fitCost` therefore scores two things at
 * once: how close the shape's size is to the post's weight, and how much of the
 * tile a summary that short would leave blank (`fill` and `hole` on each shape).
 * A pinned post with two lines of summary is the case that needs both — the pin
 * says show it large, and only the wide shapes can be large without being empty.
 *
 * ── Why the packing is done here and not by `grid-auto-flow: dense` ──────────
 *
 * `dense` produces irregularity by BACKFILLING: it places items in source order,
 * notices a hole, and pulls a later item back into it. Reordering is the price,
 * and the tiles carry a running number, so a backfilled tile puts 7 to the left
 * of 5 — the one artefact that must not happen.
 *
 * So the page is composed out of MOVEMENTS: hand-authored rectangles, three
 * columns wide and one to three rows tall, tiled completely by their shapes. A
 * page is a vertical stack of movements, so it has no holes anywhere including
 * its last row, and DOM order is reading order.
 *
 * ── The two rules a movement has to obey ─────────────────────────────────────
 *
 * 1. Its shapes tile its rectangle exactly.
 * 2. They are written in the order CSS will place them, which is NOT always
 *    reading order. Sparse auto-placement carries a cursor that only ever moves
 *    forward: a shape whose column start is left of the cursor's column pushes
 *    the cursor down a row, and a later shape can then never reach a row above
 *    it.
 */

const COLUMNS = 3;
const COLUMNS_MD = 2;

const FEATURES = ["info", "links"];

/* ─── Weight ───────────────────────────────────────────────────────────────── */

/** 0 at `lo`, 1 at `hi`, clamped; reversed when `lo` is the larger number. */
function ramp(value, lo, hi) {
  if (hi === lo) return 0;
  const t = (value - lo) / (hi - lo);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Two measures of the same text, because two different questions are asked of it.
 *
 * `words` is how much there is to READ: a CJK glyph is a word and so is a run of
 * Latin letters, which is the only way a Chinese post and an English one can be
 * compared at all — a character count would make every Chinese post look
 * enormous.
 *
 * `ems` is how much ROOM it takes: a CJK glyph is about one em wide and an
 * English word about three, counting the space after it. That is the measure
 * that decides whether a summary can fill the tile it is put in.
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

const countWords = (html) => measureText(html).words;

/**
 * The signals a tile's size is built from. Each returns 0..1 and is worth its
 * `weight`; the weights sum to 1, so the result is directly comparable with a
 * shape's declared size. To add a signal, add a row — nothing else needs to
 * know it exists.
 */
const SIGNALS = [
  { name: "sticky", weight: 0.2, score: (m) => (m.sticky ? 1 : 0) },
  { name: "cover", weight: 0.1, score: (m) => (m.cover ? 1 : 0) },
  // The two that matter most, because they are the two the tile actually has to
  // hold: how much there is to read, and how much of it the excerpt shows.
  { name: "length", weight: 0.26, score: (m) => ramp(m.words, 250, 2400) },
  { name: "excerpt", weight: 0.18, score: (m) => ramp(m.excerptWords, 25, 260) },
  { name: "recency", weight: 0.12, score: (m) => ramp(m.ageDays, 730, 0) },
  { name: "taxonomy", weight: 0.08, score: (m) => ramp(m.terms, 1, 7) },
  // A long title needs the room whether or not the piece behind it is long.
  { name: "title", weight: 0.06, score: (m) => ramp(m.titleWords, 4, 16) },
];

const DAY = 24 * 60 * 60 * 1000;

function measure(post, now) {
  const excerpt = post.excerpt && post.excerpt !== "false" ? post.excerpt : "";
  const date = post.date ? new Date(post.date).getTime() : now;
  const tags = post.tags && post.tags.length ? post.tags.length : 0;
  const cats = post.categories && post.categories.length ? post.categories.length : 0;
  const summary = measureText(excerpt);
  const body = measureText(post.content);

  return {
    sticky: !!post.sticky,
    cover: post.thumbnail !== false && !!(post.thumbnail || post.cover || post.banner),
    words: body.words,
    excerptWords: excerpt ? summary.words : Math.min(260, body.words),
    // How much text the tile will actually have to fill. A post with no excerpt
    // of its own gets one generated from its body, so the supply is the body —
    // capped, because nothing beyond the largest tile's capacity can be shown
    // and the surplus would otherwise read as "fills anything".
    excerptEms: excerpt ? summary.ems : Math.min(MAX_FILL, body.ems),
    ageDays: Math.max(0, (now - date) / DAY),
    terms: tags + cats,
    titleWords: countWords(post.title),
  };
}

function weigh(m) {
  let total = 0;
  for (const signal of SIGNALS) total += signal.weight * signal.score(m);
  return total < 0 ? 0 : total > 1 ? 1 : total;
}

/* ─── Shapes ───────────────────────────────────────────────────────────────── */

/**
 * Every tile is one of these: `cn` columns by `rn` rows, and `size` is the weight
 * the shape wants. Nothing here says how much summary the tile PRINTS — the
 * excerpt fills whatever the tile has left after its cover, title and meta row,
 * and stops on the last line that fits.
 *
 * `size` is therefore not proportional to area. It says which posts this shape
 * FLATTERS, and a shape's leftover is not its area: `tall` is three cells with no
 * cover competing for them, so it holds far more text than `wide`, which is four.
 *
 * ── `fill` and `hole`, and why a shape needs to declare them ─────────────────
 *
 * They exist because emptiness is the failure a weight cannot see. A pinned,
 * long, heavily tagged post scores high and is handed the biggest shape on the
 * page — and if its excerpt is eight characters, that shape is two thirds white
 * space, because the only thing that can fill a tall tile is text. The cover
 * cannot: it is a fraction of the height, and the title and meta row are a fixed
 * few lines. So a shape says what a short summary costs it, and `fitCost` charges
 * for the shortfall.
 *
 * It takes two numbers, because "how short" and "how much that shows" are
 * different questions:
 *
 *   fill   how much summary the shape can SHOW, in em-lengths of text — its line
 *          count times its column width in ems. How short of full a post leaves
 *          it is `1 - supply / fill`.
 *   hole   what being short LOOKS like: the excerpt's share of the tile's HEIGHT,
 *          which is the share that turns into white space. Multiply the two and
 *          the answer is the fraction of the tile left blank.
 *
 * `hole` is what tells the two kinds of big tile apart, and the reason is the
 * cover. A 16:9 picture across a 2x2 takes nearly half its height, so the text
 * under it is a fifth of the tile and a thin summary barely shows; across a 1x3
 * the same picture is a quarter of the height and leaves a column of text half
 * the tile tall, which a thin summary cannot fill at any width. Judging emptiness
 * by capacity alone hid that completely — it called 2x2 the emptier of the two,
 * because it can show more text, when it is visibly the fuller.
 *
 * Both are measured, not chosen: they come from running the box arithmetic over
 * every shape at the reference column width with the cell height in the middle of
 * its range. Only their ratios matter, which is why one reference width is enough.
 *
 * `tight` marks the one shape whose leftover disappears once a cover is in it. A
 * single cell holds a cover, a title and the meta row and little else — a
 * composition rather than a truncation, but a cramped one, and a cover in it gets
 * the flattest crop on the page. Shapes are preferred that do not do this.
 *
 * The two one-row shapes (`duo`, `band`) put their cover BESIDE the text rather
 * than above it; there is no room for a band across the top of a tile one cell
 * tall. Whether they actually get to is a width question, answered in the
 * stylesheet — see $bento-split-min-tile.
 */
const SHAPES = {
  small: { cn: 1, rn: 1, size: 0.22, fill: 22, hole: 0.08, fillBare: 129, holeBare: 0.46, tight: true },
  standard: { cn: 1, rn: 2, size: 0.42, fill: 172, hole: 0.29, fillBare: 409, holeBare: 0.69 },
  tall: { cn: 1, rn: 3, size: 0.74, fill: 495, hole: 0.55, fillBare: 711, holeBare: 0.79 },
  duo: { cn: 2, rn: 1, size: 0.44, fill: 69, hole: 0.38, fillBare: 186, holeBare: 0.3 },
  wide: { cn: 2, rn: 2, size: 0.62, fill: 233, hole: 0.18, fillBare: 839, holeBare: 0.66 },
  band: { cn: 3, rn: 1, size: 0.56, fill: 147, hole: 0.3, fillBare: 289, holeBare: 0.3 },
};

/** Nothing beyond this can be shown by any tile, so nothing beyond it counts. */
const MAX_FILL = Math.max(...Object.values(SHAPES).map((s) => s.fillBare));

const slot = (shape, cs) => ({ shape, cs });
const feature = (name, cs) => ({ shape: name, cs, isFeature: true });

/* ─── The movement library ─────────────────────────────────────────────────── */

const MOVEMENTS = {
  // The site cards and the lead post, in the grid's first row. Rendered on every
  // page, at the top left, and never animated by the paginator — they are
  // furniture, not content, and furniture that flips over when you turn a page
  // reads as the page having lost its place. One cell each: the smallest tile
  // there is, which is all either card has ever needed.
  opening: {
    slots: [feature("info", 1), feature("links", 2), slot("small", 3)],
  },
  // 3x2. The lead post takes a full-height tile — chosen when the first post of
  // the page is heavy, so a pinned flagship is not handed the smallest tile on
  // the page just because the site cards occupy the row it opens on.
  openingTall: {
    slots: [
      feature("info", 1),
      feature("links", 2),
      slot("standard", 3),
      slot("small", 1),
      slot("small", 2),
    ],
  },
  // 3x2. The lead post runs the width of the page underneath the cards.
  openingBand: {
    slots: [feature("info", 1), feature("links", 2), slot("small", 3), slot("band", 1)],
  },
  // 3x3. The lead post runs the full height of the opening — the arrangement a
  // pinned flagship pulls towards itself.
  openingLead: {
    slots: [
      feature("info", 1),
      feature("links", 2),
      slot("tall", 3),
      slot("standard", 1),
      slot("standard", 2),
    ],
  },
  // 3x2. The row under the cards is one wide tile and one small — the opening
  // for a page whose second post carries a cover worth showing large.
  openingDuo: {
    slots: [feature("info", 1), feature("links", 2), slot("small", 3), slot("duo", 1), slot("small", 3)],
  },
  // 3x2. The lead post runs down the right of the cards and a wide tile fills the
  // row under them. The site cards take two thirds of the first row, so a lead
  // post can only be given room by growing DOWNWARDS — without this the lead's
  // whole choice is one cell, two, or three stacked, and a post with a summary
  // too short for a 1x3 and too good for a 1x1 has nowhere to go.
  openingWide: {
    slots: [feature("info", 1), feature("links", 2), slot("standard", 3), slot("duo", 1)],
  },

  // 3x1 — three small tiles, one band, or a wide tile and a small one.
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

  // 3x2 — three standard tiles side by side.
  trioTall: {
    slots: [slot("standard", 1), slot("standard", 2), slot("standard", 3)],
  },

  // 3x2 — a two-column tile with two small ones stacked beside it.
  bigLeft: {
    slots: [slot("wide", 1), slot("small", 3), slot("small", 3)],
  },
  bigRight: {
    slots: [slot("small", 1), slot("wide", 2), slot("small", 1)],
  },

  // 3x2 — a two-column tile beside a standard one.
  pairLeft: {
    slots: [slot("wide", 1), slot("standard", 3)],
  },
  pairRight: {
    slots: [slot("standard", 1), slot("wide", 2)],
  },

  // 3x2 — two standard tiles and two small ones.
  mixLeft: {
    slots: [slot("standard", 1), slot("standard", 2), slot("small", 3), slot("small", 3)],
  },
  mixRight: {
    slots: [slot("small", 1), slot("standard", 2), slot("standard", 3), slot("small", 1)],
  },

  // 3x2 — two wide tiles, mirrored, each with a small one beside it. Four posts
  // in two bands, and the only arrangement on the page where a cover sits beside
  // its text twice running.
  duoPair: {
    slots: [slot("duo", 1), slot("small", 3), slot("small", 1), slot("duo", 2)],
  },
  duoPairAlt: {
    slots: [slot("small", 1), slot("duo", 2), slot("duo", 1), slot("small", 3)],
  },

  // 3x2 — a wide tile and a small one over a full-width band, or the reverse.
  duoBand: {
    slots: [slot("duo", 1), slot("small", 3), slot("band", 1)],
  },
  bandDuo: {
    slots: [slot("band", 1), slot("duo", 1), slot("small", 3)],
  },

  // 3x3 — the tallest arrangements: a full-height tile beside a two-column one,
  // or beside a stack of wide ones.
  tallStack: {
    slots: [slot("tall", 1), slot("small", 2), slot("small", 3), slot("wide", 2)],
  },
  tallBig: {
    slots: [slot("tall", 1), slot("wide", 2), slot("small", 2), slot("small", 3)],
  },
  tallDuos: {
    slots: [slot("tall", 1), slot("duo", 2), slot("duo", 2), slot("duo", 2)],
  },
};

/**
 * The row each slot lands in, run through CSS grid's own sparse auto-placement
 * (CSS Grid §8.5): the cursor only ever moves forward, so a slot whose column
 * start is left of the cursor drops a row, and a slot that would overlap
 * something already placed drops until it does not.
 *
 * Derived rather than declared because a movement's rectangle is already fully
 * described by its slots — a hand-written row number is a second copy of the
 * same fact, and the two would drift the first time a movement was edited.
 */
function placeRows(slots) {
  const grid = [];
  const cells = (r) => grid[r] || (grid[r] = new Array(COLUMNS).fill(false));
  const rows = [];
  let row = 0;
  let col = 0;

  for (const s of slots) {
    const shape = s.isFeature ? SHAPES.small : SHAPES[s.shape];
    const start = s.cs - 1;
    if (start < col) row++;

    for (;;) {
      let clash = false;
      for (let r = row; r < row + shape.rn && !clash; r++) {
        for (let c = start; c < start + shape.cn; c++) if (cells(r)[c]) clash = true;
      }
      if (!clash) break;
      row++;
    }

    for (let r = row; r < row + shape.rn; r++) {
      for (let c = start; c < start + shape.cn; c++) cells(r)[c] = true;
    }
    rows.push(row);
    col = start + shape.cn;
  }

  return rows;
}

// Post count, whether the movement carries the site cards, and the row each of
// its posts lands in — all derived, so none of them can disagree with the slots.
for (const movement of Object.values(MOVEMENTS)) {
  const rows = placeRows(movement.slots);
  movement.size = movement.slots.filter((s) => !s.isFeature).length;
  movement.opens = movement.slots.some((s) => s.isFeature);
  // Aligned with the order fitCost walks the post slots, features skipped.
  movement.rows = rows.filter((r, i) => !movement.slots[i].isFeature);
}

const OPENINGS = ["opening", "openingTall", "openingBand", "openingLead", "openingDuo", "openingWide"];

const CANDIDATES = [
  "tallStack",
  "tallBig",
  "tallDuos",
  "mixLeft",
  "mixRight",
  "bigLeft",
  "bigRight",
  "duoPair",
  "duoPairAlt",
  "duoBand",
  "bandDuo",
  "trioTall",
  "trio",
  "pairLeft",
  "pairRight",
  "duoLeft",
  "duoRight",
  "bandFull",
];

/* ─── Choosing ─────────────────────────────────────────────────────────────── */

// A tile left half blank is not a near miss, it is a hole in the page, so
// emptiness outweighs every size distance in the table — all of which are
// fractions of one. Not much more than that, though: past about two it stops
// rejecting holes and starts rejecting size, and every page collapses onto the
// smallest shapes that nothing can be short of.
const EMPTINESS = 1.5;

// What a cover in a one-cell tile costs. It is the only shape whose picture is
// short of room — the crop comes out flatter there than anywhere else on the
// page, and a page carrying one has to ask the grid for a taller cell to get
// even that — so a roomier shape wins wherever there is a choice.
const TIGHT_COVER = 0.3;
// And a summary worth reading thrown away along with it.
const TIGHT_SUMMARY = 0.3;

// In the FIRST row it stops being a preference. The two site cards are in that
// row, laid out to be read rather than stretched, so it is the one row on the
// page whose height cannot be raised — and the composition that only works with
// a taller cell is exactly the one that must not go there. Far larger than any
// other term, so an opening that does this loses to every opening that does not,
// but still finite: a one-post page has nowhere else to put it.
const FIXED_ROW_COVER = 2;

// A pinned post in the smallest tile on the page contradicts the pin. Charged
// against the tile rather than the weight, because a pin says "look at this"
// about a post whose summary may be two lines, and it is the shape rather than
// the score that has to answer for that.
const PINNED_SMALL = 0.5;

/**
 * How badly a movement's shapes fit the posts that would fill them, over two
 * channels that do not mix.
 *
 * Size distance is AVERAGED and squared: it is a soft, whole-arrangement
 * quality, and one shape a little larger than its post wanted is not a fault.
 *
 * Everything else is charged at its WORST. A movement of four tiles, three well
 * judged and one two thirds white space, is not three quarters of a good
 * arrangement — it is the arrangement with the hole in it, and an average is
 * exactly what lets that hole hide behind its neighbours.
 *
 * `take` caps how many slots are used, for the truncated movement that finishes
 * a page.
 */
function fitCost(movement, weights, metrics, offset, take) {
  let miss = 0;
  let worst = 0;
  let used = 0;

  for (const s of movement.slots) {
    if (s.isFeature) continue;
    if (used >= take) break;
    const shape = SHAPES[s.shape];
    const m = metrics[offset + used];
    const off = weights[offset + used] - shape.size;
    miss += off * off;

    // Only a SHORTFALL costs. A post with more to say than the tile can show is
    // merely truncated, which is what the ellipsis is for; a post with less is
    // white space, which nothing fixes.
    //
    // To the FOURTH, not squared. A tile two thirds full is a little loose and
    // reads as composed; a tile a twentieth full is a hole in the page. Squaring
    // separates those two by less than a factor of two, which is not enough to
    // stop the second — the whole page collapses onto the smallest shapes to
    // avoid a looseness that was never a problem.
    const capacity = m.cover ? shape.fill : shape.fillBare;
    const short = Math.max(0, (capacity - m.excerptEms) / capacity);
    let fault = short * short * short * short * (m.cover ? shape.hole : shape.holeBare) * EMPTINESS;

    if (shape.tight) {
      if (m.cover) {
        fault += movement.opens && movement.rows[used] === 0 ? FIXED_ROW_COVER : TIGHT_COVER;
        if (m.excerptWords > 60) fault += TIGHT_SUMMARY;
      }
      if (m.sticky) fault += PINNED_SMALL;
    }

    if (fault > worst) worst = fault;
    used++;
  }

  return used ? miss / used + worst : Infinity;
}

function chooseMovement(weights, metrics, offset, remaining, previous, pool) {
  let best = "";
  let bestCost = Infinity;

  for (const name of pool) {
    const movement = MOVEMENTS[name];
    if (movement.size > remaining) continue;

    let cost = fitCost(movement, weights, metrics, offset, movement.size);
    // Repeating a movement is not wrong, only dull, so it costs a little rather
    // than being forbidden.
    if (name === previous) cost += 0.05;
    if (cost < bestCost) {
      bestCost = cost;
      best = name;
    }
  }

  return { name: best, cost: bestCost };
}

/* ─── Tablet ───────────────────────────────────────────────────────────────── */

/**
 * Two columns. A one-column shape stays one column, anything wider takes the
 * row; consecutive narrow shapes pair up and share the taller one's row span,
 * which is what keeps the result hole-free.
 */
function packMd(slots) {
  const out = [];
  const posts = slots.filter(() => true);
  let i = 0;

  while (i < posts.length) {
    const a = SHAPES[posts[i].shape];
    const aNarrow = !a || a.cn === 1;
    const next = i + 1 < posts.length ? SHAPES[posts[i + 1].shape] : null;
    const nextNarrow = i + 1 < posts.length && (!next || next.cn === 1);

    if (aNarrow && nextNarrow) {
      const rn = Math.max(a ? a.rn : 1, next ? next.rn : 1);
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
  const weights = metrics.map(weigh);

  const sequence = [];
  let placed = 0;

  if (opts.features && list.length) {
    const opening = chooseMovement(weights, metrics, 0, list.length, "", OPENINGS);
    const name = opening.name || "opening";
    // A page with fewer posts than the opening needs still gets the site cards;
    // the row simply ends early.
    const take = Math.min(MOVEMENTS[name].size, list.length);
    sequence.push({ name, take });
    placed += take;
  }

  // Every page is filled to its last cell. The library carries movements of one,
  // two, three and four posts, so whatever is left over at any point can always
  // be finished off exactly — there is never a reason to leave the bottom row
  // half built.
  let previous = "";
  while (placed < list.length) {
    const remaining = list.length - placed;
    const exact = chooseMovement(weights, metrics, placed, remaining, previous, CANDIDATES);
    const name = exact.name || "bandFull";
    sequence.push({ name, take: MOVEMENTS[name].size });
    placed += MOVEMENTS[name].size;
    previous = name;
  }

  const tiles = [];
  let postIndex = 0;
  // Counted over split tiles alone, so the mirroring survives any number of
  // ordinary tiles landing between them.
  let splitCount = 0;

  for (const step of sequence) {
    const movement = MOVEMENTS[step.name];
    const md = packMd(movement.slots.filter((s) => !s.isFeature));
    let used = 0;
    let mdIndex = 0;
    let featureIndex = 0;

    for (const s of movement.slots) {
      if (s.isFeature) {
        tiles.push({
          kind: "feature",
          name: s.shape,
          movement: step.name,
          lg: { cs: s.cs, cn: 1, rn: 1 },
          md: { cs: featureIndex + 1, cn: 1, rn: 1 },
        });
        featureIndex++;
        continue;
      }

      if (used >= step.take) break;
      const shape = SHAPES[s.shape];
      const place = md[mdIndex] || { cs: 1, cn: COLUMNS_MD, rn: shape.rn };

      tiles.push({
        kind: "post",
        name: "",
        tier: s.shape,
        postIndex: postIndex,
        movement: step.name,
        lg: { cs: s.cs, cn: shape.cn, rn: shape.rn },
        md: { cs: place.cs, cn: place.cn, rn: place.rn },
        // Wide and only one row tall: no room for a cover above the text, so it
        // goes beside it. Derived rather than declared, so a shape can never
        // disagree with its own dimensions.
        lgSplit: shape.cn > 1 && shape.rn === 1,
        mdSplit: place.cn > 1 && place.rn === 1,
        coverRight: shape.cn > 1 && shape.rn === 1 && splitCount++ % 2 === 1,
      });

      postIndex++;
      used++;
      mdIndex++;
    }
  }

  return tiles;
}

hexo.extend.helper.register("bentoPlan", function (posts, options) {
  return planHomeGrid(posts, options);
});

/** Placement, carried as custom properties. */
hexo.extend.helper.register("bentoStyle", function (tile) {
  return [
    "--lg-cs:" + tile.lg.cs,
    "--lg-cn:" + tile.lg.cn,
    "--lg-rn:" + tile.lg.rn,
    "--md-cs:" + tile.md.cs,
    "--md-cn:" + tile.md.cn,
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
