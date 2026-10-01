/**
 * Masonry gallery — row-major, shortest column first.
 *
 * Every photograph goes into whichever column is shortest at that moment (the
 * leftmost on a tie), so the first row reads left to right and no photograph's
 * top edge sits above its predecessor's. The DOM keeps masonry.yml's order, which
 * is also the order the image viewer pages through. CSS columns could not do
 * this: they fill one column top to bottom before starting the next.
 *
 * Column count and gap belong to the stylesheet (`--masonry-cols`,
 * `--masonry-gap` in page-template.styl). Until the first pass the container is a
 * plain grid in the same order and widths, so packing only closes the gaps under
 * short tiles. Heights come from the preloaders' aspect ratios, so nothing waits
 * for a picture to arrive; a ResizeObserver re-packs whenever a tile or the
 * container changes size, and the editor calls `layoutMasonry` synchronously
 * inside its FLIPs.
 *
 * Overlay overflow: a description that overlaps the title or outgrows its
 * picture switches the tile to compact mode (title only, centred at the bottom).
 */

export function checkMasonryOverflow(container) {
  const items = container.querySelectorAll('.image-container');
  items.forEach(item => {
    const desc = item.querySelector('.image-description');
    const title = item.querySelector('.image-title');
    if (!desc || !title) return;

    // Reset compact mode to re-measure
    item.classList.remove('masonry-compact');

    const containerH = item.offsetHeight;
    if (containerH === 0) return; // Not rendered yet

    const titleRect = title.getBoundingClientRect();
    const descRect = desc.getBoundingClientRect();

    // Check if title and description overlap vertically
    const overlaps = titleRect.bottom > descRect.top && titleRect.top < descRect.bottom;

    // Check if description is too tall relative to the image container
    const tooTall = desc.offsetHeight > containerH * 0.3;

    // Check if description exceeds container bounds
    const containerRect = item.getBoundingClientRect();
    const exceeds = descRect.bottom > containerRect.bottom + 2;

    if (overlaps || tooTall || exceeds) {
      item.classList.add('masonry-compact');
    }
  });
}

function tilesOf(container) {
  return Array.from(container.children).filter((el) => el.classList.contains("masonry-item"));
}

function metrics(container) {
  const css = getComputedStyle(container);
  const cols = Math.max(1, parseInt(css.getPropertyValue("--masonry-cols"), 10) || 1);
  const gap = parseFloat(css.getPropertyValue("--masonry-gap")) || 0;
  const padL = parseFloat(css.paddingLeft) || 0;
  const padT = parseFloat(css.paddingTop) || 0;
  const padY = padT + (parseFloat(css.paddingBottom) || 0);
  const inner = container.clientWidth - padL - (parseFloat(css.paddingRight) || 0);
  const width = Math.max(0, (inner - gap * (cols - 1)) / cols);
  return { cols, gap, padL, padT, padY, width, border: css.boxSizing === "border-box" };
}

/** Shortest column first, the leftmost on a tie. */
function pack(m, heights) {
  const bottoms = new Array(m.cols).fill(0);
  const places = heights.map((h) => {
    let col = 0;
    for (let c = 1; c < m.cols; c++) if (bottoms[c] < bottoms[col] - 0.5) col = c;
    const place = { col, top: bottoms[col] };
    bottoms[col] += h + m.gap;
    return place;
  });
  return { places, bottoms };
}

/**
 * Place every tile: widths written, heights read once, positions written — one
 * forced layout per pass however many tiles there are. Idempotent, so calling it
 * again with nothing changed moves nothing.
 */
export function layoutMasonry(container) {
  if (!container || !container.isConnected) return;
  const tiles = tilesOf(container);
  if (!tiles.length) {
    container.classList.remove("masonry-packed");
    container.style.height = "";
    return;
  }

  const m = metrics(container);
  container.classList.add("masonry-packed");
  const w = m.width + "px";
  for (const el of tiles) if (el.style.width !== w) el.style.width = w;

  // offsetHeight, not the client rect: a tile mid-FLIP is scaled, and its
  // transformed box is not the room it takes.
  const { places, bottoms } = pack(m, tiles.map((el) => el.offsetHeight));
  tiles.forEach((el, i) => {
    const left = m.padL + places[i].col * (m.width + m.gap) + "px";
    const top = m.padT + places[i].top + "px";
    if (el.style.left !== left) el.style.left = left;
    if (el.style.top !== top) el.style.top = top;
  });

  const content = Math.max(0, Math.max(...bottoms) - m.gap);
  container.style.height = (m.border ? content + m.padY : content) + "px";
}

/**
 * The gallery as the editor works on it: one entry per column, its tiles top
 * to bottom (`skip` left out) and its horizontal extent in client coordinates,
 * out to the middle of the gap on either side.
 */
export function masonryColumns(container, skip) {
  const m = metrics(container);
  const box = container.getBoundingClientRect();
  const step = m.width + m.gap;
  const columns = Array.from({ length: m.cols }, (_, c) => ({
    tiles: [],
    x0: box.left + m.padL + c * step - m.gap / 2,
    x1: box.left + m.padL + c * step + m.width + m.gap / 2,
  }));
  for (const el of tilesOf(container)) {
    if (el === skip) continue;
    const c = Math.round((parseFloat(el.style.left) - m.padL) / step);
    columns[Math.min(m.cols - 1, Math.max(0, c || 0))].tiles.push(el);
  }
  for (const col of columns) col.tiles.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
  return columns;
}

/**
 * The album order that packs back into `columns` (arrays of entries, top to
 * bottom). Packing fills the shortest column next, so the order is read off
 * that same walk: each time, the next entry of whichever column packing is
 * about to fill. A column that has run out while another still has entries is
 * filled from the FOOT of the tallest one — a single photograph moves over and
 * nothing else does — never with an entry in `keep` while another can go.
 */
export function masonryOrder(container, columns, height, keep) {
  const m = metrics(container);
  const queues = columns.map((entries) => entries.slice());
  const bottoms = new Array(queues.length).fill(0);
  const held = (entry) => !!keep && keep.has(entry);
  const order = [];
  for (let left = queues.reduce((n, q) => n + q.length, 0); left > 0; left--) {
    let col = 0;
    for (let c = 1; c < queues.length; c++) if (bottoms[c] < bottoms[col] - 0.5) col = c;
    let entry;
    if (queues[col].length) entry = queues[col].shift();
    else {
      let from = -1;
      let most = -1;
      const pick = (strict) =>
        queues.forEach((q, c) => {
          if (!q.some((e) => !held(e)) || (strict && q.some(held))) return;
          const rest = q.reduce((sum, e) => sum + height(e) + m.gap, 0);
          if (rest > most) {
            most = rest;
            from = c;
          }
        });
      pick(true);
      if (from < 0) pick(false);
      if (from < 0) entry = queues.find((q) => q.length).shift();
      else {
        const q = queues[from];
        let i = q.length - 1;
        while (held(q[i])) i--;
        entry = q.splice(i, 1)[0];
      }
    }
    order.push(entry);
    bottoms[col] += height(entry) + m.gap;
  }
  return order;
}

/** The column packing gives each entry of `order`. */
export function masonryPack(container, order, height) {
  return pack(metrics(container), order.map(height)).places.map((place) => place.col);
}

/* ─── the gallery on screen ────────────────────────────────────────────────── */

// One gallery per page. Re-packing waits for the next frame rather than running
// inside the observer, where moving the container would be a resize loop.
const live = { container: null, ro: null, mo: null, raf: 0, key: "" };

function unwatch() {
  if (live.ro) live.ro.disconnect();
  if (live.mo) live.mo.disconnect();
  if (live.raf) cancelAnimationFrame(live.raf);
  Object.assign(live, { container: null, ro: null, mo: null, raf: 0, key: "" });
}

function repack() {
  live.raf = 0;
  const container = live.container;
  if (!container || !container.isConnected) return void unwatch();
  layoutMasonry(container);
  // The overlays only care about a tile's width, so they are re-measured when
  // the columns or the set of tiles changed, not on every height settling.
  const key = container.clientWidth + ":" + tilesOf(container).length;
  if (key !== live.key) {
    live.key = key;
    checkMasonryOverflow(container);
  }
}

function schedule() {
  if (!live.raf) live.raf = requestAnimationFrame(repack);
}

function watch(container) {
  if (live.container === container) return;
  unwatch();
  live.container = container;
  live.key = container.clientWidth + ":" + tilesOf(container).length;
  live.ro = new ResizeObserver(schedule);
  live.ro.observe(container);
  for (const el of tilesOf(container)) live.ro.observe(el);
  live.mo = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && node.classList.contains("masonry-item")) live.ro.observe(node);
      }
    }
    schedule();
  });
  live.mo.observe(container, { childList: true });
}

export function initMasonry() {
  const container = document.querySelector("#masonry-container");
  if (!container) return void unwatch();

  layoutMasonry(container);
  watch(container);
  container.classList.add("masonry-ready");

  // The first pass lands where it lands; only later re-packs (a resize, a late
  // picture) travel.
  requestAnimationFrame(() => {
    checkMasonryOverflow(container);
    container.classList.add("is-settled");
  });
}

if (data.masonry) {
  try {
    swup.hooks.on("page:view", initMasonry);
  } catch (e) {}

  document.addEventListener("DOMContentLoaded", initMasonry);
}
