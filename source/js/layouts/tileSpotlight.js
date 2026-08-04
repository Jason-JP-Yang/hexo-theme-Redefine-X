/**
 * Redefine-X — bento tile rim light.
 *
 * Writes the pointer's position, in the tile's own coordinates, into two custom
 * properties the stylesheet uses to place a highlight on the tile's border. The
 * colour comes from `--tile-accent`, extracted from that post's cover at build
 * time, so a tile lights up in the colour of its own image.
 *
 * One listener for the page, not one per tile: the home list is replaced
 * wholesale by pagination and by Swup, so per-tile listeners would either leak
 * or need rebinding on every swap. Delegation costs one `closest()` per pointer
 * event and survives both.
 *
 * Writes are batched into a single rAF and only ever touch two custom properties
 * and one class, so a fast sweep across a full grid produces one style write per
 * frame rather than one per event.
 */

const TILE_SELECTOR = ".home-article-item, .home-feature-tile";

let wired = false;
let enabled = false;
let lit = null;
let pending = null;
let frame = 0;

export default function initTileSpotlight() {
  if (wired) {
    // The list may have been swapped out from under us; a tile that is no
    // longer in the document can never be unlit by a pointer event.
    if (lit && !lit.isConnected) lit = null;
    return;
  }
  wired = true;

  // A rim light that tracks the pointer has nothing to say on a touch screen,
  // where there is no pointer to track between taps.
  try {
    enabled = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  } catch (e) {
    enabled = true;
  }
  if (!enabled) return;

  document.addEventListener("pointermove", onPointerMove, { passive: true });
  // `pointerleave` on the document fires when the pointer leaves the window
  // entirely, which `pointermove` alone would never tell us about.
  document.addEventListener("pointerleave", onPointerLeave, { passive: true });
}

function onPointerMove(event) {
  const tile = event.target && event.target.closest ? event.target.closest(TILE_SELECTOR) : null;

  if (!tile) {
    if (lit) schedule(null, 0, 0);
    return;
  }

  const rect = tile.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  schedule(
    tile,
    ((event.clientX - rect.left) / rect.width) * 100,
    ((event.clientY - rect.top) / rect.height) * 100,
  );
}

function onPointerLeave() {
  if (lit) schedule(null, 0, 0);
}

function schedule(tile, x, y) {
  pending = { tile, x, y };
  if (frame) return;
  frame = requestAnimationFrame(flush);
}

function flush() {
  frame = 0;
  const next = pending;
  pending = null;
  if (!next) return;

  const { tile, x, y } = next;

  if (lit && lit !== tile) {
    lit.classList.remove("is-lit");
    // The coordinates are deliberately left behind: the highlight fades out
    // from where the pointer left it instead of jumping to the tile's centre
    // for the length of the fade.
    lit = null;
  }

  if (!tile) return;

  tile.style.setProperty("--tile-px", x.toFixed(2) + "%");
  tile.style.setProperty("--tile-py", y.toFixed(2) + "%");
  if (lit !== tile) {
    tile.classList.add("is-lit");
    lit = tile;
  }
}
