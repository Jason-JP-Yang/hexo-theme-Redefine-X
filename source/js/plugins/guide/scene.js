/**
 * Guide — the stage inside the walkthrough card.
 *
 * A scene is a mock of a real screen, acted out by the page's own cursor: the
 * one that was pointing at the page flies into the card, plays every step, and
 * stays one cursor from step to step and loop to loop. If it was not on the
 * page, it simply appears where it is first needed. Nothing is a video: the mock
 * is DOM and CSS, sharp at any size and in either colour scheme.
 *
 * THE CAMERA. A scene is authored in its own pixels (`size`) and a camera frames
 * it with one translate + scale on `.gd-cam`. A shot names what has to be seen —
 * the whole world (`{fit}`), one element or several (`{on, pad}`), a world rect
 * (`{rect}`), or a point at a zoom (`{x, y, zoom}`) — and frames ALL of it,
 * never closer than ZOOM × the fit: a shot is always the whole of something.
 * Before the cursor goes anywhere its target is brought into the frame, taking
 * in what the shot already showed, so the camera moves only when it has to.
 *
 * The camera runs on the guide's frame loop, a critically damped spring in
 * centre and log-zoom, and reads the live layout of what it frames: a sheet
 * still sliding in is framed where it lands. It is solved before the cursor
 * measures (`prepare`), so the cursor, which points at world positions through
 * this frame's camera, stays on its target through every move — and is kept on
 * the stage, arc and label included (`Cursor#setClip`).
 *
 * A scene is a list of BEATS, played on a loop:
 *   shot    frame something (`focus` with a `view` is the same)
 *   press   bring an element into view, fly to it, press it, apply `then`
 *   type    the same at a field, then type `text` (masked if `mask`)
 *   move    bring an element into view and fly to it
 *   scroll  scroll `in` until `to` is in view: dragged on a phone, wheeled on a desk
 *   swipe   press and drag by (dx, dy) world pixels while `then` runs
 *   auto    something happens by itself (a redirect, a notification)
 *   wait    hold
 */

import { Run, Loop, Spring, isCancel, clamp, reducedMotion } from "./motion.js";

const CANVAS = { w: 360, h: 225 };
const ZOOM = 1.75; // the closest a shot comes, as a multiple of the fit
const PAD = 28; // stage pixels kept around what a shot frames
const MARGIN = 14; // a target closer than this to the stage's edge is brought in
const EDGE = 10; // the cursor's tip stays this far inside the stage

const unite = (a, b) => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

export class Scene {
  /** @param {HTMLElement} stage  @param {{cursor?: import("./cursor.js").Cursor}} o */
  constructor(stage, { cursor = null } = {}) {
    this.stage = stage;
    this.view = stage.querySelector(".gd-view");
    this.cam = stage.querySelector(".gd-cam");
    this.cursor = cursor;
    this.loop = cursor ? cursor.loop : new Loop();
    this.alive = !reducedMotion();
    this.spec = null;
    this.run = null;
    this.playing = false;
    this.world = null;
    this.size = CANVAS;

    this.shot = null;
    this.goal = null;
    this.tracking = false;
    this.dirty = true;
    this.snapNext = true;
    this.quiet = 0;
    this.W = 0;
    this.H = 0;
    this.box = null;
    this.cur = null;
    this.written = "";
    this.cx = new Spring(0, 90, 19);
    this.cy = new Spring(0, 90, 19);
    this.cz = new Spring(0, 90, 19);

    this.clipFn = () => this.box && { left: this.box.left, top: this.box.top, right: this.box.right, bottom: this.box.bottom };
    this.ro = new ResizeObserver(() => {
      this.dirty = true;
      this.loop.wake();
    });
    this.ro.observe(stage);
  }

  load(spec) {
    this.spec = spec;
    this.play();
  }

  stop() {
    if (this.run) this.run.kill();
    this.run = null;
    this.playing = false;
  }

  destroy() {
    this.stop();
    this.ro.disconnect();
    this.loop.delete(this);
    if (this.cursor && this.cursor.clip === this.clipFn) this.cursor.setClip(null);
  }

  // ─── building ──────────────────────────────────────────────
  build() {
    const spec = this.spec;
    this.size = spec.size || CANVAS;
    const world = document.createElement("div");
    world.className = "gd-world" + (spec.canvas ? " is-canvas" : "") + (spec.cls ? " " + spec.cls : "");
    world.style.width = `${this.size.w}px`;
    world.style.height = `${this.size.h}px`;
    world.innerHTML = typeof spec.html === "function" ? spec.html() : spec.html;
    this.cam.replaceChildren(world);
    this.world = world;
    this.cam.style.width = `${this.size.w}px`;
    this.cam.style.height = `${this.size.h}px`;
    if (spec.setup) spec.setup(this);
    // Framed before the first paint, so a scene never opens on the wrong shot.
    this.shoot(spec.view || { fit: true }, true);
    this.prepare(performance.now(), 0);
    this.render();
  }

  q(sel) {
    if (typeof sel !== "string") return sel;
    return this.world.matches(sel) ? this.world : this.world.querySelector(sel);
  }

  set(sel, cls, on = true) {
    const el = this.q(sel);
    if (el) el.classList.toggle(cls, on);
  }

  text(sel, value) {
    const el = this.q(sel);
    if (el) el.textContent = value;
  }

  /**
   * An element's box in world pixels, whatever the camera is doing: the world
   * scales as one. Null for anything not laid out — a hidden element has no
   * place, and pointing at its (0, 0) sends the cursor to the stage's corner.
   */
  rectOf(sel) {
    const el = this.world && this.q(sel);
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    const c = this.world.getBoundingClientRect();
    const k = c.width / this.size.w || 1;
    return { x: (r.left - c.left) / k, y: (r.top - c.top) / k, w: r.width / k, h: r.height / k };
  }

  /** Several elements' boxes as one. */
  rectAll(sels) {
    let u = null;
    for (const s of [].concat(sels)) {
      const r = this.rectOf(s);
      if (r && (r.w || r.h)) u = u ? unite(u, r) : r;
    }
    return u;
  }

  /** A world point on screen, through this frame's camera, kept on the stage. */
  toScreen(x, y) {
    const b = this.box;
    const c = this.cur;
    if (!b || !c) return null;
    return {
      x: clamp(b.left + (c.tx + x * c.z) * c.s, b.left + EDGE, b.right - EDGE),
      y: clamp(b.top + (c.ty + y * c.z) * c.s, b.top + EDGE, b.bottom - EDGE),
    };
  }

  /** A live point on an element — what the page cursor flies to. */
  anchor(sel, fx = 0.5, fy = 0.5) {
    return () => {
      const r = this.rectOf(sel);
      return r ? this.toScreen(r.x + r.w * fx, r.y + r.h * fy) : null;
    };
  }

  /** A world point. */
  at(x, y) {
    return () => this.toScreen(x, y);
  }

  flash(sel) {
    const el = this.q(sel);
    if (!el || !el.animate) return;
    el.animate([{ filter: "brightness(1)" }, { filter: "brightness(0.85)" }, { filter: "brightness(1)" }], {
      duration: 260,
      easing: "ease-out",
    });
  }

  // ─── the camera ────────────────────────────────────────────
  fit() {
    const { w, h } = this.spec && this.spec.canvas ? CANVAS : this.size;
    return Math.min(this.W / w, this.H / h);
  }

  /**
   * Point the camera; `snap` cuts instead of moving. A `still` shot is framed
   * where its elements are now and stays there when they move on — a banner
   * that is read and then leaves.
   */
  shoot(shot, snap = false) {
    if (shot && shot.still && shot.on) shot = { rect: this.rectAll(shot.on), pad: shot.pad, max: shot.max };
    this.shot = shot || { fit: true };
    if (snap || !this.alive) this.snapNext = true;
    this.track();
  }

  /** Legacy name: a view, and a duration only to say "cut" (0). */
  frame(shot, ms = 700) {
    this.shoot(shot, ms === 0);
  }

  /** Read the layout again until what is framed has stood still. */
  track() {
    this.tracking = true;
    this.dirty = true;
    this.quiet = performance.now();
    this.loop.wake();
  }

  /** Where a shot puts the camera: {x, y} at the stage's centre, and a zoom. */
  solve(shot) {
    const { w, h } = this.size;
    const W = this.W;
    const H = this.H;
    const fit = this.fit();
    let z = fit;
    let x = w / 2;
    let y = h / 2;
    if (shot && !shot.fit) {
      if (shot.on || shot.rect !== undefined) {
        const r = shot.rect || this.rectAll(shot.on);
        if (r) {
          const pad = shot.pad ?? PAD;
          z = Math.min((W - 2 * pad) / Math.max(1, r.w), (H - 2 * pad) / Math.max(1, r.h));
          z = clamp(z, fit, fit * (shot.max || this.spec.zoom || ZOOM));
          x = r.x + r.w / 2;
          y = r.y + r.h / 2;
        }
      } else {
        z = fit * (shot.zoom || 1);
        if (shot.x != null) x = shot.x;
        if (shot.y != null) y = shot.y;
      }
    }
    // Never past the world's edges.
    const hw = W / (2 * z);
    const hh = H / (2 * z);
    x = w <= 2 * hw ? w / 2 : clamp(x, hw, w - hw);
    y = h <= 2 * hh ? h / 2 : clamp(y, hh, h - hh);
    return { x, y, z };
  }

  /** The world rect a camera state shows. */
  region(g) {
    const hw = this.W / (2 * g.z);
    const hh = this.H / (2 * g.z);
    return { x: g.x - hw, y: g.y - hh, w: 2 * hw, h: 2 * hh };
  }

  settled() {
    const g = this.goal;
    if (!g) return true;
    const z = Math.exp(this.cz.x);
    return (
      Math.abs(this.cx.x - g.x) * z < 0.75 &&
      Math.abs(this.cy.x - g.y) * z < 0.75 &&
      Math.abs(this.cz.x - Math.log(g.z)) < 0.003
    );
  }

  /** Wait for the camera, but not longer than `max` — the cursor rides a moving camera fine. */
  async settle(run, max = 900) {
    const t0 = performance.now();
    await run.wait(34);
    while (!this.settled() && performance.now() - t0 < max) await run.wait(34);
  }

  /**
   * Bring a target into the frame: panned as little as that takes, at the same
   * zoom, and zoomed out only as far as a target too big for the frame needs.
   */
  async reveal(sel, run) {
    const r = this.rectOf(sel);
    const g = this.goal;
    if (!r || !g) return;
    const v = this.region(g);
    const m = MARGIN / g.z;
    if (r.x >= v.x + m && r.x + r.w <= v.x + v.w - m && r.y >= v.y + m && r.y + r.h <= v.y + v.h - m) return;
    const fit = this.fit();
    const over = Math.max((r.w + 2 * m) / v.w, (r.h + 2 * m) / v.h);
    const z = over > 1 ? Math.max(fit, g.z / over) : g.z;
    const hw = this.W / (2 * z);
    const hh = this.H / (2 * z);
    const mm = MARGIN / z;
    const x = clamp(g.x, r.x + r.w + mm - hw, r.x - mm + hw);
    const y = clamp(g.y, r.y + r.h + mm - hh, r.y - mm + hh);
    this.shoot({ x, y, zoom: z / fit });
    await this.settle(run, 480);
  }

  // Loop hooks: solve and step before anyone measures, write after. The camera
  // works in the stage's own pixels; the card around it may be scaled while it
  // opens, which only the mapping to the screen (`s`) has to know.
  prepare(now, dt) {
    if (!this.world) return;
    const W = this.view.clientWidth;
    const H = this.view.clientHeight;
    this.box = this.view.getBoundingClientRect();
    if (W !== this.W || H !== this.H) {
      this.W = W;
      this.H = H;
      this.dirty = true;
      // A stage that changes size is a new layout, not a camera move.
      this.snapNext = true;
    }
    if (!this.W || !this.H) return;
    if (this.dirty || this.tracking) this.aim(now);
    const g = this.goal;
    if (!g) return;
    const lz = Math.log(g.z);
    if (this.snapNext || !this.alive) {
      this.snapNext = false;
      this.cx.snap(g.x);
      this.cy.snap(g.y);
      this.cz.snap(lz);
    } else {
      this.cx.step(g.x, dt);
      this.cy.step(g.y, dt);
      this.cz.step(lz, dt);
    }
    const z = Math.exp(this.cz.x);
    const s = this.box.width / this.W || 1;
    this.cur = { z, s, tx: this.W / 2 - this.cx.x * z, ty: this.H / 2 - this.cy.x * z };
  }

  aim(now) {
    this.dirty = false;
    const g = this.solve(this.shot);
    const p = this.goal;
    const moved = !p || Math.abs(g.x - p.x) > 0.3 || Math.abs(g.y - p.y) > 0.3 || Math.abs(g.z / p.z - 1) > 0.001;
    this.goal = g;
    if (moved) this.quiet = now;
    else if (now - this.quiet > 400) this.tracking = false;
  }

  measure() {}

  render() {
    const c = this.cur;
    if (c) {
      const tf = `translate(${c.tx.toFixed(2)}px, ${c.ty.toFixed(2)}px) scale(${c.z.toFixed(4)})`;
      if (tf !== this.written) {
        this.cam.style.transform = tf;
        this.written = tf;
      }
    }
    // A layer promoted for the move keeps the scale it was painted at; at rest
    // it is let go, so what the camera zoomed into is painted sharp again.
    const moving = !this.settled();
    if (moving !== this.moving) {
      this.moving = moving;
      this.cam.style.willChange = moving ? "transform" : "auto";
    }
    return this.playing || this.tracking || moving;
  }

  // ─── playing ───────────────────────────────────────────────
  play() {
    this.stop();
    this.loop.add(this);
    const run = (this.run = new Run());
    this.playing = true;
    (async () => {
      try {
        for (let first = true; ; first = false) {
          if (!first) await this.fadeOut(run);
          // What the cursor was on belongs to the world being replaced; it waits
          // where it is for the new one's first beat.
          if (this.cursor && this.cursor.clip === this.clipFn) this.cursor.hold();
          this.build();
          if (first && this.cursor && this.cursor.clip !== this.clipFn) {
            // A cursor on the page comes along into the scene, then stays on the stage.
            if (this.cursor.visible) await this.fly(this.rest(), run);
            this.cursor.setClip(this.clipFn);
          }
          await run.wait(this.spec.lead ?? 400);
          for (const b of this.spec.beats) await this.beat(b, run);
          await run.wait(this.spec.hold ?? 2200);
        }
      } catch (e) {
        if (!isCancel(e)) console.error("[guide] scene failed", e);
      }
    })();
  }

  async fadeOut(run) {
    if (!this.world || !this.alive) return;
    this.world.classList.add("is-leaving");
    await run.wait(200);
  }

  rest() {
    const p = this.spec.park;
    if (typeof p === "string") return this.anchor(p);
    if (p) return this.at(p.x, p.y);
    return () => {
      const b = this.box;
      return b && { x: b.left + b.width * 0.72, y: b.top + b.height * 0.7 };
    };
  }

  fly(anchor, run, opts) {
    if (!this.cursor) return Promise.resolve(true);
    return run.guard(this.cursor.flyTo(anchor, Object.assign({ appear: true }, opts)));
  }

  /** Apply a change to the mock; whatever it moves, the camera follows. */
  apply(fn) {
    if (fn) fn(this);
    this.track();
  }

  async reach(sel, fx, fy, run) {
    await this.reveal(sel, run);
    await this.fly(this.anchor(sel, fx, fy), run);
  }

  async beat(b, run) {
    const c = this.cursor;
    switch (b.do) {
      case "wait":
        await run.wait(b.ms ?? 600);
        break;
      case "shot":
      case "focus":
        this.shoot(b.view || b);
        await this.settle(run, b.ms ?? 900);
        break;
      case "move":
        await this.reach(b.at, b.fx ?? 0.5, b.fy ?? 0.5, run);
        await run.wait(b.ms ?? 260);
        break;
      case "press":
        await this.reach(b.at, b.fx ?? 0.5, b.fy ?? 0.55, run);
        await run.wait(150);
        if (c) c.press();
        this.flash(b.at);
        this.apply(b.then);
        await run.wait(b.ms ?? 700);
        break;
      case "type":
        await this.reach(b.at, 0.18, 0.6, run);
        await run.wait(120);
        if (c) c.press();
        await this.type(b.at, b.text, run, b.mask);
        this.apply(b.then);
        await run.wait(b.ms ?? 320);
        break;
      case "auto":
        this.apply(b.then);
        await run.wait(b.ms ?? 800);
        break;
      case "scroll":
        await this.scroll(b, run);
        break;
      case "swipe":
        await this.swipe(b, run);
        break;
      default:
        break;
    }
  }

  async type(sel, text, run, mask) {
    const field = this.q(sel);
    if (!field) return;
    const out = field.querySelector(".gd-val, .gd-m-val") || field;
    field.classList.add("is-focus");
    out.textContent = "";
    for (const ch of Array.from(text)) {
      out.textContent += mask ? "•" : ch;
      await run.wait(40 + Math.random() * 40);
    }
    field.classList.remove("is-focus");
  }

  /**
   * Scroll `in` — a clipping box whose first child is its content — until `to`
   * is in view with `pad` to spare, by exactly as much as that takes. A phone is
   * dragged, the content following the finger; on a desk the cursor rests over
   * the box while the wheel turns.
   */
  async scroll(b, run) {
    const box = this.q(b.in);
    const body = box && box.firstElementChild;
    if (!body || !this.q(b.to)) return;
    const B = this.rectOf(box);
    const C = this.rectOf(body);
    const T = this.rectOf(b.to);
    // World pixels per pixel of the content's own: a page can be scaled inside the world.
    const k = C.w / (body.offsetWidth || C.w) || 1;
    const from = Number(body.dataset.y || 0);
    const pad = (b.pad ?? 20) * k;
    const top = T.y - B.y + from * k;
    const want = b.align === "start" ? top - pad : top + T.h + pad - B.h;
    const to = clamp(want, 0, Math.max(0, C.h - B.h)) / k;
    if (Math.abs(to - from) < 1) return;
    const ms = b.ms ?? 900;
    const move = () => {
      // easeOutCubic, the curve a drag flight follows (cursor.js).
      body.style.transition = `transform ${ms}ms cubic-bezier(0.33, 1, 0.68, 1)`;
      body.style.transform = `translateY(${(-to).toFixed(1)}px)`;
      body.dataset.y = String(to);
    };

    // Over the part of the box already in frame: low in it for a finger to push
    // up, in the middle of it for a wheel.
    const drag = b.drag ?? !!this.spec.touch;
    const v = this.goal ? this.region(this.goal) : { y: B.y, h: B.h };
    const y0 = Math.max(B.y, v.y);
    const y1 = Math.min(B.y + B.h, v.y + v.h);
    const seen = y1 > y0 ? [y0, y1 - y0] : [B.y, B.h];
    const start = this.at(B.x + B.w / 2, seen[0] + seen[1] * (drag ? 0.78 : 0.55));
    if (!drag || !this.cursor) {
      await this.fly(start, run);
      await run.wait(160);
      move();
      await run.wait(ms + 60);
      this.track();
      return;
    }
    // Drawn up by the distance scrolled, as far as the stage allows.
    await this.fly(start, run);
    const p = start();
    if (!p) return;
    this.cursor.press();
    await run.wait(110);
    move();
    const dy = (to - from) * k * (this.cur ? this.cur.z * this.cur.s : 1);
    const b0 = this.box;
    const end = { x: p.x, y: b0 ? Math.max(b0.top + EDGE + 12, p.y - dy) : p.y - dy };
    await run.guard(this.cursor.flyTo(() => end, { duration: ms, straight: true }));
    await run.wait(b.after ?? 260);
    this.track();
  }

  async swipe(b, run) {
    const start = this.anchor(b.at, b.fx ?? 0.5, b.fy ?? 0.5);
    await this.reveal(b.at, run);
    await this.fly(start, run);
    const p = start();
    if (!p || !this.cursor) return;
    this.cursor.press();
    await run.wait(120);
    this.apply(b.then);
    const z = this.cur ? this.cur.z * this.cur.s : 1;
    const end = { x: p.x + (b.dx || 0) * z, y: p.y + (b.dy || 0) * z };
    await run.guard(this.cursor.flyTo(() => end, { duration: b.ms || 700, straight: true }));
    await run.wait(b.after ?? 320);
  }
}
