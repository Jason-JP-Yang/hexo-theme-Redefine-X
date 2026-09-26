/**
 * Guide — the virtual cursor.
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
 *     frame, so the cursor still lands exactly on a button the page scrolls
 *     under it.
 *   • At rest it follows its target on a spring and its label follows it on a
 *     softer one, so a scrolling page carries both with a little weight.
 *   • The label hangs off one corner of the arrow — below right by default,
 *     turned left near the right edge and up near the bottom, the arrow
 *     mirroring to match. That corner stays put while the label grows away
 *     from it, and the finished label never leaves the view.
 * Reduced motion turns all of that off: it appears in place.
 */

import { Spring, bezier, ease, flightMs, drift, clamp, reducedMotion } from "./motion.js";

// A rounded arrow on a 24-unit grid, its tip at (3, 3).
const ARROW =
  '<svg class="gd-arrow" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M4.75 3.34 18.5 8.48Q21.5 9.6 18.51 10.75L14.95 12.11Q12.9 12.9 12.11 14.95L10.75 18.51Q9.6 21.5 8.48 18.5L3.34 4.75Q2.5 2.5 4.75 3.34Z"/>' +
  "</svg>";

// Label geometry of the page cursor; a scene's smaller cursor scales it by `k`.
const DX = 10; // the tip to the label's near corner, across
const DY = 19; // and down: clear of the arrow even when the label slides under it
const EDGE = 8; // kept clear of the view's edges
const SLACK = 6; // how far a label must overflow before it turns at rest

// How much of `a` a box at (left, top) of size w × h covers.
function cover(a, left, top, w, h) {
  const x = Math.min(left + w, a.right) - Math.max(left, a.left);
  const y = Math.min(top + h, a.bottom) - Math.max(top, a.top);
  return x > 0 && y > 0 ? x * y : 0;
}

// The shift that brings [start, start + size] inside [lo, hi], or pins it to lo.
const inside = (start, size, lo, hi) =>
  size > hi - lo || start < lo ? lo - start : start + size > hi ? hi - size - start : 0;

export class Cursor {
  /**
   * @param {object} o
   * @param {HTMLElement} o.layer   what the cursor is drawn into
   * @param {import("./motion.js").Loop} o.loop
   * @param {string} [o.label]      text of the label that follows it
   * @param {() => {w:number,h:number}} o.bounds   the visible area, in the layer's coordinates
   * @param {string} [o.variant]    extra class, e.g. "is-local" inside a scene
   */
  constructor({ layer, loop, label = "", bounds, variant = "" }) {
    this.layer = layer;
    this.loop = loop;
    this.bounds = bounds;
    this.k = variant === "is-local" ? 0.675 : 1;

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
      this.pill.innerHTML =
        '<div class="gd-pill-box"><div class="gd-say-text"><div class="gd-say-line"><b class="gd-say-name"></b></div></div></div>';
      this.box = this.pill.firstElementChild;
      this.line = this.pill.querySelector(".gd-say-line");
      this.name = this.pill.querySelector(".gd-say-name");
      this.name.textContent = label;
      layer.appendChild(this.pill);
    }
    // The page cursor's Callout attaches itself here and sizes the label.
    this.speech = null;
    this.label = null;

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

    this.rx = new Spring(0, 600, 46);
    this.ry = new Spring(0, 600, 46);
    this.lx = new Spring(0, 300, 30);
    this.ly = new Spring(0, 300, 30);
    this.turnX = new Spring(0, 320, 34);
    this.turnY = new Spring(0, 320, 34);
    this.tilt = new Spring(0, 220, 20);
    this.pop = new Spring(1, 520, 30);
    this.left = false;
    this.up = false;
    this.fresh = true;
    this.sx = 0;
    this.sy = 0;
    this.shape = "";

    loop.add(this);
  }

  setLabel(text) {
    if (!this.name || this.name.textContent === text) return;
    this.name.textContent = text;
    this.label = null;
  }

  // ─── frame ─────────────────────────────────────────────────
  measure(now) {
    this.point = this.visible && this.anchor ? this.anchor() : null;
    if (!this.pill || !this.visible) return;
    // Read off the name rather than the box, which has a set size while it speaks.
    if (!this.label) {
      const cs = getComputedStyle(this.box);
      const px = parseFloat(cs.paddingLeft) || 0;
      const pt = parseFloat(cs.paddingTop) || 0;
      const pb = parseFloat(cs.paddingBottom) || 0;
      const lh = parseFloat(getComputedStyle(this.line).lineHeight) || this.name.offsetHeight;
      this.label = { w: this.name.offsetWidth + 2 * px, h: lh + pt + pb, px, pt, pb, lh };
    }
    if (this.speech) this.speech.measure(now);
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
        this.rx.snap(x);
        this.ry.snap(y);
        if (f.exit) this.hideNow();
        f.done(true);
      }
    } else if (this.point) {
      x = this.point.x;
      y = this.point.y;
      if (this.alive) {
        // Eased in from the landing, so settling and drifting are one motion.
        const k = Math.min(1, (now - this.restAt) / 700);
        const d = drift(now + this.seed);
        x = this.rx.step(x + d.x * k, dt);
        y = this.ry.step(y + d.y * k, dt);
      }
    }

    const inv = dt > 0 ? 1 / dt : 60;
    this.vx = this.vx * 0.6 + (x - this.x) * inv * 0.4;
    this.vy = this.vy * 0.6 + (y - this.y) * inv * 0.4;
    this.x = x;
    this.y = y;

    this.el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;

    if (this.pill) this.place(x, y, now, dt);
    if (this.alive) {
      const tilt = this.tilt.step(clamp(this.vx / 90, -13, 13), dt);
      const pop = this.pop.step(1, dt);
      const speed = Math.hypot(this.vx, this.vy);
      const s = clamp(speed / 14000, 0, 0.075);
      let tf = `rotate(${tilt.toFixed(2)}deg)`;
      if (s > 0.004) {
        const a = (Math.atan2(this.vy, this.vx) * 180) / Math.PI;
        tf +=
          ` rotate(${a.toFixed(1)}deg) scale(${(1 + s).toFixed(3)}, ${(1 - s * 0.55).toFixed(3)})` +
          ` rotate(${(-a).toFixed(1)}deg)`;
      }
      // Turning to face the label is a mirror through the tip, on either axis.
      const fx = (1 - 2 * clamp(this.turnX.x, 0, 1)) * pop;
      const fy = (1 - 2 * clamp(this.turnY.x, 0, 1)) * pop;
      this.body.style.transform = `${tf} scale(${fx.toFixed(3)}, ${fy.toFixed(3)})`;
    } else {
      this.body.style.transform = `scale(${this.left ? -1 : 1}, ${this.up ? -1 : 1})`;
    }

    return this.visible;
  }

  /** Hang the label off the arrow's corner. */
  place(x, y, now, dt) {
    const L = this.label;
    if (!L) return;
    const g = this.speech && this.speech.active ? this.speech.frame(now, dt, L) : null;
    const w = g ? g.w : L.w;
    const h = g ? g.h : L.h;
    const fw = g ? g.fw : L.w;
    const fh = g ? g.fh : L.h;
    const k = this.k;
    const dx = DX * k;
    const dy = DY * k;
    const m = EDGE * k;
    const lx = this.alive ? this.lx.step(x, dt) : x;
    const ly = this.alive ? this.ly.step(y, dt) : y;
    const { w: vw, h: vh } = this.bounds();
    const f = this.flight;
    // Leaving, the label goes with the arrow instead of being held in view.
    const leaving = !!(f && f.exit);

    // Decided for where the cursor is going, then kept. In flight nothing is
    // re-decided; at rest a side changes only once the other one fits and this
    // one clearly does not, so nothing flips back and forth on a boundary.
    const decide = this.fresh || !!(g && g.decide);
    if (!leaving && (decide || !f)) {
      this.orient(decide, f ? f.last : { x, y }, g ? g.sw : L.w, g ? g.sh : L.h, g && g.avoid, vw, vh, dx, dy, m);
    }
    const snap = this.fresh || !this.alive;
    this.fresh = false;
    if (snap) {
      this.turnX.snap(this.left ? 1 : 0);
      this.turnY.snap(this.up ? 1 : 0);
    } else {
      this.turnX.step(this.left ? 1 : 0, dt);
      this.turnY.step(this.up ? 1 : 0, dt);
    }
    const tx = clamp(this.turnX.x, 0, 1);
    const ty = clamp(this.turnY.x, 0, 1);

    // The corner by the arrow stays put and the label grows away from it; the
    // finished label is kept inside the view.
    const cx = lx + dx - 2 * dx * tx;
    const cy = ly + dy - 2 * dy * ty;
    if (!leaving) {
      this.sx = inside(cx - fw * tx, fw, m, vw - m);
      this.sy = inside(cy - fh * ty, fh, m, vh - m);
    }
    const bx = cx - w * tx + this.sx;
    const by = cy - h * ty + this.sy;
    this.pill.style.transform = `translate3d(${bx.toFixed(2)}px, ${by.toFixed(2)}px, 0)`;

    // The corner by the arrow is the bubble's tail, unless it was pushed away.
    const free = Math.abs(this.sx) > dx || Math.abs(this.sy) > dy;
    const shape = free ? "is-free" : (this.up ? "is-u" : "is-d") + (this.left ? "l" : "r");
    if (shape !== this.shape) {
      if (this.shape) this.pill.classList.remove(this.shape);
      this.pill.classList.add(shape);
      this.shape = shape;
    }
  }

  /**
   * Choose the corner. Below and to the right unless the finished label does not
   * fit there; a new tip prefers the side covering less of what it is about.
   */
  orient(decide, p, sw, sh, avoid, vw, vh, dx, dy, m) {
    const r = vw - m - p.x - dx;
    const l = p.x - dx - m;
    const d = vh - m - p.y - dy;
    const u = p.y - dy - m;
    if (decide) {
      this.up = d < sh && (u >= sh || u > d);
      if (r >= sw && l >= sw) {
        const top = this.up ? p.y - dy - sh : p.y + dy;
        this.left = !!avoid && cover(avoid, p.x - dx - sw, top, sw, sh) < cover(avoid, p.x + dx, top, sw, sh);
      } else this.left = r >= sw ? false : l >= sw ? true : l > r;
      return;
    }
    if (this.left ? l < sw - SLACK && r >= sw : r < sw - SLACK && l >= sw) this.left = !this.left;
    if (this.up ? u < sh - SLACK && d >= sh : d < sh - SLACK && u >= sh) this.up = !this.up;
  }

  // ─── visibility ────────────────────────────────────────────
  show(x, y) {
    this.visible = true;
    this.x = x;
    this.y = y;
    this.vx = this.vy = 0;
    this.rx.snap(x);
    this.ry.snap(y);
    this.lx.snap(x);
    this.ly.snap(y);
    this.tilt.snap(0);
    this.pop.snap(this.alive ? 0.5 : 1);
    this.fresh = true;
    this.label = null;
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
    if (this.speech) this.speech.drop();
  }

  /** Fade out where it is — for a page that is being navigated away from. */
  vanish() {
    if (this.flight) this.flight.done(false);
    this.flight = null;
    this.hideNow();
  }

  /** Rest at a point without a flight, e.g. the starting spot of a freshly built scene. */
  park(x, y) {
    if (this.flight) this.flight.done(false);
    this.flight = null;
    this.anchor = () => ({ x, y });
    this.restAt = performance.now();
    if (!this.visible) this.show(x, y);
    this.loop.wake();
  }

  // ─── flights ───────────────────────────────────────────────
  entryPoint(p) {
    const { w, h } = this.bounds();
    // Close by — a short arc up from below, on the side with more room — so the
    // cursor is seen arriving rather than found already there.
    const dir = p.x < w / 2 ? 1 : -1;
    return { x: clamp(p.x + dir * 120, 12, w - 12), y: clamp(p.y + 150, 12, h - 12) };
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
      const over = exit ? 0 : Math.min(6, dist * 0.025);
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
    return this.flyTo(() => out, { exit: true, duration: 420 });
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
      this.rx.v += 150;
      this.ry.v += 190;
    }
    setTimeout(() => this.press(), 150);
    this.loop.wake();
  }

  destroy() {
    if (this.flight) this.flight.done(false);
    this.loop.delete(this);
    this.el.remove();
    if (this.pill) this.pill.remove();
  }
}
