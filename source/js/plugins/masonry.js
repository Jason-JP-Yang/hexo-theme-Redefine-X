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

  const css = getComputedStyle(container);
  const cols = Math.max(1, parseInt(css.getPropertyValue("--masonry-cols"), 10) || 1);
  const gap = parseFloat(css.getPropertyValue("--masonry-gap")) || 0;
  const padL = parseFloat(css.paddingLeft) || 0;
  const padT = parseFloat(css.paddingTop) || 0;
  const padY = padT + (parseFloat(css.paddingBottom) || 0);
  const inner = container.clientWidth - padL - (parseFloat(css.paddingRight) || 0);
  const width = Math.max(0, (inner - gap * (cols - 1)) / cols);

  container.classList.add("masonry-packed");
  const w = width + "px";
  for (const el of tiles) if (el.style.width !== w) el.style.width = w;

  // offsetHeight, not the client rect: a tile mid-FLIP is scaled, and its
  // transformed box is not the room it takes.
  const heights = tiles.map((el) => el.offsetHeight);
  const bottoms = new Array(cols).fill(0);
  tiles.forEach((el, i) => {
    let col = 0;
    for (let c = 1; c < cols; c++) if (bottoms[c] < bottoms[col] - 0.5) col = c;
    const left = padL + col * (width + gap) + "px";
    const top = padT + bottoms[col] + "px";
    if (el.style.left !== left) el.style.left = left;
    if (el.style.top !== top) el.style.top = top;
    bottoms[col] += heights[i] + gap;
  });

  const content = Math.max(0, Math.max(...bottoms) - gap);
  container.style.height = (css.boxSizing === "border-box" ? content + padY : content) + "px";
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
