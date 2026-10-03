import { onRawScroll } from "./scrollScheduler.js";

/**
 * Work that restyles a whole tree, spread over frames.
 *
 * A frame takes what fits a few milliseconds, less while the reader touches,
 * types or scrolls. Each step forces the style pass it causes, so the next
 * frame's share is measured, not guessed.
 */

let input = 0;
const touched = () => (input = performance.now());
onRawScroll(touched);
for (const type of ["pointerdown", "pointermove", "touchmove", "wheel", "keydown"]) {
  addEventListener(type, touched, { capture: true, passive: true });
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const allowance = () => (resting() < 300 ? 2 : 5);

/** Milliseconds since the reader last touched, typed or scrolled. */
export const resting = () => performance.now() - input;

/**
 * Calls `step(allow)` once a frame until it reports done. `step` does about
 * `allow` units, forces the style pass they cause and returns [done, used].
 * Resolves false if `alive()` turns false first.
 */
export async function inFrames(step, alive) {
  let rate = 0.01; // ms per unit
  for (;;) {
    await nextFrame();
    if (!alive()) return false;
    const t0 = performance.now();
    const [done, used] = step(Math.max(1, allowance() / rate));
    if (used > 0) rate = Math.min(1, Math.max(0.0005, (rate + (performance.now() - t0) / used) / 2));
    if (done) return true;
  }
}

/** `apply(value, weight)` over `list` ([value, weight] pairs), a share per frame. */
export function inSlices(list, apply, force, alive) {
  let i = 0;
  return inFrames((allow) => {
    let used = 0;
    while (i < list.length && (used === 0 || used + list[i][1] <= allow)) {
      apply(list[i][0], list[i][1]);
      used += list[i++][1];
    }
    if (used) force();
    return [i >= list.length, used];
  }, alive);
}
