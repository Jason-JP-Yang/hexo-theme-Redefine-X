/**
 * Guide — motion primitives.
 *
 * Everything the cursor, the callout and the tour scenes move with: a spring,
 * the easing curves, the arc a flight follows, the drift that keeps a resting
 * cursor alive, and the frame loop that drives all of it.
 *
 * The loop is NOT the scroll scheduler, on purpose. A cursor that drifts has to
 * move every frame whether or not the page scrolls, and asking the scheduler for
 * a pass each frame would run every scroll subscriber in the theme 60×/s for as
 * long as a tip is on screen. The loop keeps the scheduler's contract instead:
 * every item measures first, then every item writes, and it only runs while
 * something it owns is visible.
 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const ease = {
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  in: (t) => t * t * t,
};

export function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// Fitts-shaped: a long flight is slower, but not proportionally so — a hand
// crossing the screen does not take three times as long as one crossing a third.
export function flightMs(distance) {
  return clamp(340 + 125 * Math.log2(1 + distance / 28), 340, 1150);
}

// Two incommensurate sines per axis never visibly repeat, so a cursor waiting on
// a target reads as held by a hand rather than as a looping animation.
export function drift(t) {
  return {
    x: 2.0 * Math.sin(t * 0.0019) + 1.0 * Math.sin(t * 0.0047 + 1.3),
    y: 1.6 * Math.sin(t * 0.0016 + 0.7) + 1.1 * Math.sin(t * 0.0041 + 2.1),
  };
}

export function reducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export class Spring {
  constructor(value = 0, stiffness = 170, damping = 26) {
    this.x = value;
    this.v = 0;
    this.k = stiffness;
    this.c = damping;
  }

  // Semi-implicit Euler in fixed sub-steps: stable at any frame rate, including
  // the first frame after a background tab wakes up.
  step(target, dt) {
    const n = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.k * (this.x - target) - this.c * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }

  settled(target, eps = 0.02) {
    return Math.abs(this.x - target) < eps && Math.abs(this.v) < eps * 20;
  }

  snap(value) {
    this.x = value;
    this.v = 0;
  }
}

export class Loop {
  constructor() {
    this.items = new Set();
    this.raf = 0;
    this.last = 0;
    this.tick = this.tick.bind(this);
  }

  add(item) {
    this.items.add(item);
    this.wake();
  }

  delete(item) {
    this.items.delete(item);
  }

  wake() {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  tick(now) {
    this.raf = 0;
    const dt = this.last && now - this.last < 100 ? (now - this.last) / 1000 : 1 / 60;
    this.last = now;
    for (const item of this.items) item.measure(now);
    let again = false;
    for (const item of this.items) if (item.render(now, dt)) again = true;
    if (again) this.wake();
    else this.last = 0;
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  }
}

/**
 * A cancellable sequence. Every await inside one goes through wait() or guard(),
 * so kill() stops a script at its next step instead of letting it run on over a
 * page it no longer belongs to.
 */
export const CANCELLED = Symbol("guide-cancelled");
export const isCancel = (e) => e === CANCELLED;

export class Run {
  constructor() {
    this.dead = false;
    this.stops = new Set();
  }

  wait(ms) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(CANCELLED);
      const stop = () => {
        clearTimeout(id);
        reject(CANCELLED);
      };
      const id = setTimeout(() => {
        this.stops.delete(stop);
        resolve();
      }, ms);
      this.stops.add(stop);
    });
  }

  guard(promise) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(CANCELLED);
      const stop = () => reject(CANCELLED);
      this.stops.add(stop);
      promise.then(
        (v) => {
          this.stops.delete(stop);
          resolve(v);
        },
        (e) => {
          this.stops.delete(stop);
          reject(e);
        },
      );
    });
  }

  kill() {
    if (this.dead) return;
    this.dead = true;
    for (const stop of this.stops) stop();
    this.stops.clear();
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
