/**
 * Guide — the virtual cursor, and the ring it draws around a target.
 *
 * One class serves both places a cursor appears: the page itself (a fixed layer,
 * viewport coordinates) and the inside of a tour scene (a scaled stage, the
 * scene's own coordinates). It never dispatches an event. Every "press" it makes
 * is a picture of a press: a squeeze of the arrow and a ripple under the tip.
 *
 * How it moves:
 *   • A flight is an arc, not a line — a cubic Bézier bowed to one side, the
 *     side alternating flight to flight — timed by a Fitts-shaped duration and
 *     eased in and out like a hand.
 *   • The path is expressed RELATIVE to the target, which is re-measured every
 *     frame. A page that scrolls under a flight carries the flight with it, and
 *     the cursor still lands exactly on a moving button.
 *   • It lands a few pixels past the target and springs back, tilts into its
 *     horizontal velocity, stretches slightly along its direction of travel, and
 *     its label trails behind on a softer spring.
 *   • At rest it drifts by a couple of pixels, so it reads as held rather than
 *     parked. Reduced motion turns all of that off: it appears in place.
 */

import { Spring, bezier, ease, flightMs, drift, clamp, reducedMotion } from "./motion.js";

const ARROW =
  '<svg class="gd-arrow" viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
  '<path d="M4.2 2.6 24.2 10.2Q26.2 11 24.3 11.9L14.8 14.8 11.9 24.3Q11 26.2 10.2 24.2L2.6 4.2Q2.1 2.1 4.2 2.6Z"/>' +
  "</svg>";

// Where the label sits relative to the tip, before its spring lags it.
const PILL_DX = 15;
const PILL_DY = 19;

export class Cursor {
  /**
   * @param {object} o
   * @param {HTMLElement} o.layer   what the cursor is drawn into
   * @param {import("./motion.js").Loop} o.loop
   * @param {string} [o.label]      text of the pill that follows it
   * @param {() => {w:number,h:number}} o.bounds   the visible area, in the layer's coordinates
   * @param {string} [o.variant]    extra class, e.g. "is-local" inside a scene
   */
  constructor({ layer, loop, label = "", bounds, variant = "" }) {
    this.layer = layer;
    this.loop = loop;
    this.bounds = bounds;

    this.el = document.createElement("div");
    this.el.className = "gd-cursor" + (variant ? " " + variant : "");
    this.el.innerHTML = `<div class="gd-cursor-body"><div class="gd-cursor-press">${ARROW}</div></div>`;
    this.body = this.el.firstElementChild;
    this.squeeze = this.body.firstElementChild;
    layer.appendChild(this.el);

    this.pill = null;
    if (label) {
      this.pill = document.createElement("div");
      this.pill.className = "gd-pill" + (variant ? " " + variant : "");
      this.pill.textContent = label;
      layer.appendChild(this.pill);
    }

    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.visible = false;
    this.anchor = null;
    this.point = null;
    this.flight = null;
    this.side = 1;
    this.restAt = 0;
    this.seed = Math.random() * 10000;
    this.alive = !reducedMotion();

    this.tilt = new Spring(0, 220, 20);
    this.ox = new Spring(0, 190, 13);
    this.oy = new Spring(0, 190, 13);
    this.lx = new Spring(0, 250, 24);
    this.ly = new Spring(0, 250, 24);

    loop.add(this);
  }

  setLabel(text) {
    if (this.pill) this.pill.textContent = text;
  }

  // ─── frame ─────────────────────────────────────────────────
  measure() {
    if (!this.visible || !this.anchor) {
      this.point = null;
      return;
    }
    this.point = this.anchor();
  }

  render(now, dt) {
    if (!this.visible) return false;

    let x = this.x;
    let y = this.y;
    const f = this.flight;

    if (f) {
      if (this.point) f.last = this.point;
      const p = f.last;
      const t = clamp((now - f.start) / f.dur, 0, 1);
      const e = f.ease(t);
      x = p.x + bezier(f.x0, f.x1, f.x2, f.x3, e);
      y = p.y + bezier(f.y0, f.y1, f.y2, f.y3, e);
      if (t >= 1) {
        this.flight = null;
        this.restAt = now;
        this.ox.snap(f.x3);
        this.oy.snap(f.y3);
        if (f.exit) this.hideNow();
        f.done(true);
      }
    } else if (this.point) {
      const ox = this.ox.step(0, dt);
      const oy = this.oy.step(0, dt);
      let dx = 0;
      let dy = 0;
      if (this.alive) {
        // Eased in from the landing, so settling and drifting are one motion.
        const k = Math.min(1, (now - this.restAt) / 700);
        const d = drift(now + this.seed);
        dx = d.x * k;
        dy = d.y * k;
      }
      x = this.point.x + ox + dx;
      y = this.point.y + oy + dy;
    }

    const inv = dt > 0 ? 1 / dt : 60;
    this.vx = this.vx * 0.6 + (x - this.x) * inv * 0.4;
    this.vy = this.vy * 0.6 + (y - this.y) * inv * 0.4;
    this.x = x;
    this.y = y;

    this.el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;

    if (this.alive) {
      const tilt = this.tilt.step(clamp(this.vx / 90, -13, 13), dt);
      const speed = Math.hypot(this.vx, this.vy);
      const s = clamp(speed / 14000, 0, 0.075);
      if (s > 0.004) {
        const a = (Math.atan2(this.vy, this.vx) * 180) / Math.PI;
        this.body.style.transform =
          `rotate(${tilt.toFixed(2)}deg) rotate(${a.toFixed(1)}deg) ` +
          `scale(${(1 + s).toFixed(3)}, ${(1 - s * 0.55).toFixed(3)}) rotate(${(-a).toFixed(1)}deg)`;
      } else {
        this.body.style.transform = `rotate(${tilt.toFixed(2)}deg)`;
      }
    }

    if (this.pill) {
      const lx = this.alive ? this.lx.step(x + PILL_DX, dt) : x + PILL_DX;
      const ly = this.alive ? this.ly.step(y + PILL_DY, dt) : y + PILL_DY;
      this.pill.style.transform = `translate3d(${lx.toFixed(2)}px, ${ly.toFixed(2)}px, 0)`;
    }

    return this.visible;
  }

  // ─── visibility ────────────────────────────────────────────
  show(x, y) {
    this.visible = true;
    this.x = x;
    this.y = y;
    this.vx = this.vy = 0;
    this.lx.snap(x + PILL_DX);
    this.ly.snap(y + PILL_DY);
    this.tilt.snap(0);
    this.el.classList.add("is-on");
    if (this.pill) this.pill.classList.add("is-on");
    this.loop.add(this);
  }

  hideNow() {
    this.visible = false;
    this.anchor = null;
    this.point = null;
    this.el.classList.remove("is-on");
    if (this.pill) this.pill.classList.remove("is-on");
  }

  /** Fade out where it is — for a page that is being navigated away from. */
  vanish() {
    if (this.flight) this.flight.done(false);
    this.flight = null;
    this.hideNow();
  }

  /** Place without a flight, e.g. the resting spot inside a freshly built scene. */
  park(x, y) {
    if (this.flight) this.flight.done(false);
    this.flight = null;
    this.anchor = () => ({ x, y });
    this.restAt = performance.now();
    this.ox.snap(0);
    this.oy.snap(0);
    if (!this.visible) this.show(x, y);
    this.loop.wake();
  }

  // ─── flights ───────────────────────────────────────────────
  entryPoint(p) {
    const { w, h } = this.bounds();
    // From below for anything in the upper part of the view — the longest, most
    // visible arc — and from the far side for anything low on it.
    if (p.y < h * 0.55) return { x: clamp(p.x + w * 0.16, 24, w - 24), y: h + 44 };
    return p.x > w / 2 ? { x: -44, y: p.y - h * 0.22 } : { x: w + 44, y: p.y - h * 0.22 };
  }

  exitPoint() {
    const { w, h } = this.bounds();
    const right = this.x > w / 2;
    return { x: right ? w + 60 : -60, y: clamp(this.y + h * 0.18, -40, h + 40) };
  }

  /**
   * Fly to a (live) anchor. Resolves true on arrival, false if superseded.
   * @param {() => ({x:number,y:number}|null)} anchor
   */
  flyTo(anchor, { from = null, exit = false, duration = null } = {}) {
    return new Promise((resolve) => {
      if (this.flight) this.flight.done(false);
      this.flight = null;

      const p = anchor();
      if (!p) return resolve(false);

      if (!this.visible) {
        if (exit) return resolve(true);
        const s = from || this.entryPoint(p);
        this.show(s.x, s.y);
      }

      this.anchor = anchor;

      if (!this.alive) {
        if (exit) this.hideNow();
        else {
          this.ox.snap(0);
          this.oy.snap(0);
          this.x = p.x;
          this.y = p.y;
        }
        this.loop.wake();
        return resolve(true);
      }

      const sx = this.x;
      const sy = this.y;
      const dx = p.x - sx;
      const dy = p.y - sy;
      const dist = Math.hypot(dx, dy);
      if (dist < 1.5 && !exit) {
        this.loop.wake();
        return resolve(true);
      }

      const ux = dist ? dx / dist : 0;
      const uy = dist ? dy / dist : 0;
      this.side = -this.side;
      const bend = Math.min(dist * 0.2, 120) * this.side;
      const nx = -uy * bend;
      const ny = ux * bend;
      const over = exit ? 0 : Math.min(9, dist * 0.035);
      const x0 = sx - p.x;
      const y0 = sy - p.y;

      let settled = false;
      this.flight = {
        start: performance.now(),
        dur: duration || flightMs(dist),
        ease: exit ? ease.in : ease.inOut,
        x0,
        y0,
        x1: x0 + dx * 0.3 + nx,
        y1: y0 + dy * 0.3 + ny,
        x2: x0 + dx * 0.78 + nx * 0.35,
        y2: y0 + dy * 0.78 + ny * 0.35,
        x3: ux * over,
        y3: uy * over,
        exit,
        last: p,
        done: (ok) => {
          if (settled) return;
          settled = true;
          resolve(ok);
        },
      };
      this.loop.wake();
    });
  }

  leave() {
    if (!this.visible) return Promise.resolve(true);
    const out = this.exitPoint();
    return this.flyTo(() => out, { exit: true, duration: 560 });
  }

  // ─── gestures (pictures only) ──────────────────────────────
  press() {
    if (!this.visible) return;
    try {
      this.squeeze.animate(
        [{ transform: "scale(1)" }, { transform: "scale(0.8)", offset: 0.35 }, { transform: "scale(1)" }],
        { duration: 380, easing: "cubic-bezier(.3,.7,.3,1)" },
      );
    } catch {}
    this.ripple();
  }

  ripple() {
    const r = document.createElement("div");
    r.className = "gd-ripple";
    r.style.transform = `translate3d(${this.x.toFixed(1)}px, ${this.y.toFixed(1)}px, 0)`;
    r.innerHTML = "<i></i>";
    this.layer.appendChild(r);
    const done = () => r.remove();
    try {
      r.firstChild
        .animate(
          [
            { transform: "translate(-50%, -50%) scale(0.2)", opacity: 0.6 },
            { transform: "translate(-50%, -50%) scale(1)", opacity: 0 },
          ],
          { duration: 680, easing: "cubic-bezier(.2,.7,.3,1)" },
        )
        .addEventListener("finish", done);
    } catch {
      setTimeout(done, 700);
    }
  }

  /** "Over here": a small hop off the target and back, then a press. */
  nudge() {
    if (!this.visible || this.flight) return;
    if (this.alive) {
      this.ox.v += 120;
      this.oy.v += 150;
    }
    setTimeout(() => this.press(), 170);
    this.loop.wake();
  }

  destroy() {
    if (this.flight) this.flight.done(false);
    this.loop.delete(this);
    this.el.remove();
    if (this.pill) this.pill.remove();
  }
}

/**
 * The ring around a target. Page layer only. Measured in the same frame as the
 * cursor so the two never drift apart while the page scrolls.
 */
export class Halo {
  constructor(layer, loop) {
    this.loop = loop;
    this.el = document.createElement("div");
    this.el.className = "gd-halo";
    this.el.innerHTML = "<i></i>";
    layer.appendChild(this.el);
    this.target = null;
    this.rect = null;
    this.w = -1;
    this.h = -1;
    this.radius = 10;
    loop.add(this);
  }

  show(target) {
    this.target = target;
    this.rect = null;
    const r = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
    this.radius = clamp(r, 6, 40);
    this.el.classList.remove("is-on");
    this.pending = true;
    this.loop.wake();
  }

  hide() {
    this.target = null;
    this.pending = false;
    this.el.classList.remove("is-on");
  }

  measure() {
    this.rect = this.target && this.target.isConnected ? this.target.getBoundingClientRect() : null;
  }

  render() {
    const r = this.rect;
    if (!r) return false;
    const pad = 6;
    const w = Math.max(r.width + pad * 2, 40);
    const h = Math.max(r.height + pad * 2, 40);
    const x = r.left + r.width / 2 - w / 2;
    const y = r.top + r.height / 2 - h / 2;
    if (Math.abs(w - this.w) > 0.5 || Math.abs(h - this.h) > 0.5) {
      this.w = w;
      this.h = h;
      this.el.style.width = `${w.toFixed(1)}px`;
      this.el.style.height = `${h.toFixed(1)}px`;
      const small = Math.min(w, h);
      this.el.style.borderRadius = `${Math.min(this.radius + pad, small / 2).toFixed(1)}px`;
    }
    this.el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
    if (this.pending) {
      this.pending = false;
      this.el.classList.add("is-on");
    }
    return !!this.target;
  }
}
