import { onScroll, requestScrollPass } from "../tools/scrollScheduler.js";

/**
 * Redefine-X — cover parallax.
 *
 * Every cover frame on the site declares one aspect ratio (see
 * `global.cover_aspect_ratio`) and lets `object-fit: cover` crop whatever does
 * not fit. For an image taller than the frame that means a band is sliced off
 * the top and the bottom and never seen.
 *
 * This makes the frame a window that travels through that band as the card
 * crosses the viewport. The crop that was ALREADY THERE is the entire parallax
 * range: the image is laid out at exactly the size the cover crop was drawing it
 * at (full width, natural height) and translated within the same frame. Nothing
 * is scaled up, no detail is invented, and the travel can never run past the
 * image's own edges.
 *
 * A cover that is wider than the frame loses nothing vertically, so it is left
 * alone — no class, no layer, no per-frame write.
 *
 * Read/write split per the scroll scheduler contract: `read()` only measures,
 * `write()` only mutates, and neither runs for an off-screen frame.
 */

const FRAME_SELECTOR = ".home-article-thumbnail, .article-cover-frame";

// px of crop below which the travel is imperceptible and not worth a layer.
const MIN_RANGE = 2;
// px of movement below which a write would not change a rendered pixel.
const EPSILON = 0.1;

let items = [];
let wired = false;
let motionAllowed = true;

export default function initCoverParallax() {
  // The list is rebuilt on every call rather than diffed: Swup replaces the
  // whole container, so the old nodes are detached and nothing is reusable.
  items = [];

  document.querySelectorAll(FRAME_SELECTOR).forEach((frame) => {
    const img = frame.querySelector("img");
    if (!img) return;

    const item = {
      frame,
      img,
      ratio: 0,
      on: false,
      shift: 0,
      nextOn: false,
      nextShift: 0,
      dirty: false,
    };
    items.push(item);

    // A lazily-loaded cover has no natural size yet; re-read it once it lands.
    if (!captureRatio(item)) {
      img.addEventListener(
        "load",
        () => {
          captureRatio(item);
          requestScrollPass();
        },
        { once: true },
      );
    }
  });

  if (!items.length) return;

  if (!wired) {
    wired = true;
    onScroll(read, write, "coverParallax");
    watchReducedMotion();
    // Frame width decides the crop, so both of these change the travel range.
    window.addEventListener("resize", requestScrollPass, { passive: true });
    window.addEventListener("redefine:content-resized", requestScrollPass);
  }

  requestScrollPass();
}

function captureRatio(item) {
  const w = item.img.naturalWidth;
  const h = item.img.naturalHeight;
  if (!w || !h) return false;
  item.ratio = w / h;
  return true;
}

function watchReducedMotion() {
  let mq;
  try {
    mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  } catch (e) {
    return;
  }
  motionAllowed = !mq.matches;
  const onChange = () => {
    motionAllowed = !mq.matches;
    requestScrollPass();
  };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

// READ phase — measures only.
function read(m) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    it.dirty = false;
    if (!it.ratio) continue;

    const rect = it.frame.getBoundingClientRect();
    // Off-screen frames queue no write at all, so a long archive page costs one
    // rect read per cover and nothing else.
    if (rect.width === 0 || rect.bottom <= 0 || rect.top >= m.viewportH) continue;

    // The height the cover crop is already drawing this image at.
    const drawnHeight = rect.width / it.ratio;
    const range = drawnHeight - rect.height;

    if (!motionAllowed || range <= MIN_RANGE) {
      if (it.on) {
        it.nextOn = false;
        it.nextShift = 0;
        it.dirty = true;
      }
      continue;
    }

    // 0 when the frame's top edge sits on the viewport's bottom edge, 1 when its
    // bottom edge reaches the viewport's top — one full traversal of the crop
    // over the whole time the card is on screen. At 0.5 the image is centred,
    // which is exactly where `object-fit: cover` would have put it.
    let progress = (m.viewportH - rect.top) / (m.viewportH + rect.height);
    if (progress < 0) progress = 0;
    else if (progress > 1) progress = 1;

    // Positive shift moves the image down, revealing progressively higher parts
    // of it as the page scrolls down: the image lags the page, which is what
    // reads as depth.
    const shift = (progress - 0.5) * range;

    if (!it.on || Math.abs(shift - it.shift) >= EPSILON) {
      it.nextOn = true;
      it.nextShift = shift;
      it.dirty = true;
    }
  }
}

// WRITE phase — mutates only, and only what the read phase flagged.
function write() {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.dirty) continue;
    it.dirty = false;

    if (it.nextOn !== it.on) {
      it.frame.classList.toggle("has-parallax", it.nextOn);
      it.on = it.nextOn;
    }

    if (it.on) {
      it.img.style.setProperty("--parallax-shift", it.nextShift.toFixed(2) + "px");
    } else {
      it.img.style.removeProperty("--parallax-shift");
    }
    it.shift = it.nextShift;
  }
}
