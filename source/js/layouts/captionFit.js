/**
 * A floating caption is laid over its picture only while it covers less than a
 * fifth of it.
 *
 * With `articles.style.image_caption: float` a figure's caption is a bubble
 * over the bottom of its picture. A long description, or a picture made small,
 * turned that bubble into a lid over half the photograph — so every figure is
 * measured AS a bubble, and one that would cover `COVER` or more of its picture
 * says its caption under it instead, in small type across the figure
 * (`caption-below`). The picture's size plays no part except through that
 * measurement: a full-size picture with a long description goes below, a small
 * one with a short title stays a bubble.
 *
 * The bubble is placed on the PICTURE rather than the figure — centred on it,
 * no wider than 80% of it (`--cap-x`, `--cap-max`) — since a sized picture no
 * longer fills its figure.
 *
 * Every figure waiting is read in one pass and written in the next, and each
 * is watched for its size, so a column, a picture arriving or a size being
 * dragged in the editor decides again.
 */

const COVER = 0.2;
const FIGURE = "figure.image-caption";

let observer = null;
let wired = false;
const queue = new Set();
let frame = 0;

function floating() {
  const style = window.theme && window.theme.articles && window.theme.articles.style;
  return !!style && style.image_caption === "float";
}

function run() {
  frame = 0;
  const jobs = [];
  for (const fig of queue) {
    // Not on the page yet (the editor draws a figure before mounting it): the
    // watch answers when it is. Off the page for good: let it go.
    if (!fig.isConnected) {
      if (fig.__captionSeen && observer) observer.unobserve(fig);
      continue;
    }
    fig.__captionSeen = true;
    const cap = fig.querySelector(":scope > figcaption");
    const pic = fig.querySelector(":scope > img, :scope > .img-preloader");
    if (cap && pic && cap.textContent.trim()) jobs.push({ fig, cap, pic });
    else fig.classList.remove("caption-below");
  }
  queue.clear();
  if (!jobs.length) return;

  // Write: every one a bubble again, to be measured as one.
  for (const job of jobs) job.fig.classList.remove("caption-below");

  // Read: where each picture stands in its figure.
  for (const job of jobs) {
    const f = job.fig.getBoundingClientRect();
    job.p = job.pic.getBoundingClientRect();
    job.x = job.p.left - f.left + job.p.width / 2;
  }

  // Write: the bubble onto the picture.
  for (const job of jobs) {
    if (!job.p.width || !job.p.height) continue;
    job.fig.style.setProperty("--cap-x", job.x.toFixed(1) + "px");
    job.fig.style.setProperty("--cap-max", (job.p.width * 0.8).toFixed(1) + "px");
  }

  // Read: how much of the picture the bubble covers.
  for (const job of jobs) {
    const p = job.p;
    if (!p.width || !p.height) continue;
    const c = job.cap.getBoundingClientRect();
    const w = Math.max(0, Math.min(c.right, p.right) - Math.max(c.left, p.left));
    const h = Math.max(0, Math.min(c.bottom, p.bottom) - Math.max(c.top, p.top));
    job.below = (w * h) / (p.width * p.height) >= COVER;
  }

  // Write: the decision.
  for (const job of jobs) if (job.below) job.fig.classList.add("caption-below");
}

function schedule(fig) {
  if (!fig) return;
  queue.add(fig);
  if (!frame) frame = requestAnimationFrame(run);
}

/** Decide these figures again — the editor calls this after drawing one. */
export function fitCaptions(figs) {
  if (!floating()) return;
  for (const fig of figs || []) {
    if (!observer) observer = new ResizeObserver((entries) => entries.forEach((entry) => schedule(entry.target)));
    observer.observe(fig);
    schedule(fig);
  }
}

/**
 * Every captioned figure under `root`, or on the page. The page's own call
 * starts the watch list over — the last page's figures are gone.
 */
export default function initCaptionFit(root) {
  if (!floating()) return;
  if (!wired) {
    wired = true;
    window.addEventListener("redefine:image-loaded", (e) => {
      const img = e.detail && e.detail.img;
      schedule(img && img.closest && img.closest(FIGURE));
    });
  }
  if (!root && observer) observer.disconnect();
  fitCaptions((root || document).querySelectorAll(FIGURE));
}
