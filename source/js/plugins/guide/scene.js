/**
 * Guide — the stage inside the progress card.
 *
 * A scene is a small mock of a real screen (a sign-up form, a share sheet, the
 * inbox) played by a second cursor. Nothing is a video: the mock is DOM and CSS,
 * so it is sharp at any size, follows the site's light/dark theme, and costs a
 * few kilobytes instead of a few megabytes.
 *
 * GEOMETRY. Every scene is authored on one fixed logical canvas (W × H) and the
 * whole canvas is scaled to the stage — one number, uniformly — so positions are
 * exact and nothing reflows at a different width. The canvas may be taller than
 * the stage; a CAMERA (translate + zoom on `.gd-cam`) then frames the part that
 * matters, and the scene's cursor lives inside the camera so it moves with it.
 * Points are converted from screen rects back to camera space, which makes them
 * correct under any combination of fit scale, zoom and in-flight transitions.
 *
 * A scene is a list of BEATS:
 *   press   fly to an element, press it, apply `then(scene)`
 *   type    fly to a field, press it, type `text` (masked if `mask`)
 *   move    fly to an element
 *   auto    something happens by itself (a redirect, a notification)
 *   wait    hold
 *   focus   move the camera to a point at a zoom
 *   swipe   press-and-drag the cursor by (dx, dy) while `then` runs
 *   wheel   scroll-wheel gesture at an element, then `then`
 *   pinch   two-finger gesture at an element, then `then`
 *
 * TWO MODES. "Watch" plays the beats on a loop. "Try it yourself" rebuilds the
 * scene and waits at every press/type beat for the reader to do it — the next
 * control pulses, the cursor waits beside it, and a wrong tap is answered with a
 * shake of the right one. Automatic beats still play by themselves.
 */

import { Loop, Run, isCancel } from "./motion.js";
import { Cursor } from "./cursor.js";

export const W = 360;
export const H = 225;

const INTERACTIVE = new Set(["press", "type"]);

export class Scene {
  constructor(stage, { label, tryLabel, watchLabel, turnLabel, doneLabel, onPracticed }) {
    this.stage = stage;
    this.view = stage.querySelector(".gd-view");
    this.cam = stage.querySelector(".gd-cam");
    this.captionBox = stage.querySelector(".gd-caption");
    this.caption = this.captionBox.querySelector("span");
    this.tryBtn = stage.querySelector(".gd-try");
    this.labels = { tryLabel, watchLabel, turnLabel, doneLabel };
    this.onPracticed = onPracticed;
    this.spec = null;
    this.run = null;
    this.expect = null;
    this.mode = "demo";
    this.size = { w: W, h: H };

    this.loop = new Loop();
    this.cursor = new Cursor({
      layer: this.cam,
      loop: this.loop,
      label,
      bounds: () => this.size,
      variant: "is-local",
    });

    this.tryBtn.addEventListener("click", () => (this.mode === "try" ? this.demo() : this.practice()));
    this.cam.addEventListener("click", (e) => this.tap(e));

    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(stage);
    this.fit();
  }

  fit() {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    if (!w || !h) return;
    const k = Math.min(w / W, h / H);
    this.view.style.transform = `translate(${((w - W * k) / 2).toFixed(2)}px, ${((h - H * k) / 2).toFixed(2)}px) scale(${k.toFixed(4)})`;
  }

  load(spec) {
    this.spec = spec;
    const interactive = spec.beats.some((b) => INTERACTIVE.has(b.do));
    this.tryBtn.hidden = !interactive;
    this.demo();
  }

  stop() {
    if (this.run) this.run.kill();
    this.run = null;
    this.expect = null;
    this.stage.classList.remove("is-trying", "is-done");
  }

  destroy() {
    this.stop();
    this.ro.disconnect();
    this.cursor.destroy();
    this.loop.stop();
  }

  // ─── building ──────────────────────────────────────────────
  build() {
    const spec = this.spec;
    this.size = spec.size || { w: W, h: H };
    for (const old of this.cam.querySelectorAll(".gd-world")) old.remove();
    const world = document.createElement("div");
    world.className = "gd-world" + (spec.cls ? " " + spec.cls : "");
    world.style.width = `${this.size.w}px`;
    world.style.height = `${this.size.h}px`;
    world.innerHTML = spec.html;
    this.cam.prepend(world);
    this.world = world;
    this.cam.style.width = `${this.size.w}px`;
    this.cam.style.height = `${this.size.h}px`;
    const f = spec.camera || { x: this.size.w / 2, y: H / 2, zoom: 1 };
    this.focus(f.x, f.y, f.zoom, 0);
    const park = spec.park || { x: W - 44, y: H - 30 };
    this.cursor.park(park.x, park.y);
    this.say("");
    if (spec.setup) spec.setup(this);
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

  /** A point on an element, in camera coordinates. */
  pointOf(sel, fx = 0.5, fy = 0.5) {
    const el = this.q(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const c = this.cam.getBoundingClientRect();
    const s = c.width / this.size.w || 1;
    return { x: (r.left + r.width * fx - c.left) / s, y: (r.top + r.height * fy - c.top) / s };
  }

  anchor(sel, fx, fy) {
    return () => this.pointOf(sel, fx, fy);
  }

  /** Centre the camera on (x, y) of the canvas at `zoom`. */
  focus(x, y, zoom = 1, ms = 700) {
    const tx = Math.min(0, Math.max(W - this.size.w * zoom, W / 2 - x * zoom));
    const ty = Math.min(0, Math.max(H - this.size.h * zoom, H / 2 - y * zoom));
    this.cam.style.setProperty("--gd-cam-ms", `${ms}ms`);
    this.cam.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${zoom})`;
  }

  say(text) {
    this.caption.textContent = text || "";
    this.captionBox.classList.toggle("is-on", !!text);
  }

  flash(sel) {
    const el = this.q(sel);
    if (!el || !el.animate) return;
    el.animate([{ filter: "brightness(1)" }, { filter: "brightness(0.82)" }, { filter: "brightness(1)" }], {
      duration: 260,
      easing: "ease-out",
    });
  }

  // ─── modes ─────────────────────────────────────────────────
  demo() {
    this.stop();
    this.mode = "demo";
    this.tryBtn.innerHTML = `<i class="fa-regular fa-hand-pointer" aria-hidden="true"></i>${this.labels.tryLabel}`;
    const run = (this.run = new Run());
    (async () => {
      try {
        for (;;) {
          this.build();
          await run.wait(600);
          await this.play(run, false);
          await run.wait(this.spec.hold || 2600);
        }
      } catch (e) {
        if (!isCancel(e)) console.error("[guide] scene failed", e);
      }
    })();
  }

  practice() {
    this.stop();
    this.mode = "try";
    this.stage.classList.add("is-trying");
    this.tryBtn.innerHTML = `<i class="fa-regular fa-play" aria-hidden="true"></i>${this.labels.watchLabel}`;
    const run = (this.run = new Run());
    (async () => {
      try {
        this.build();
        await run.wait(300);
        await this.play(run, true);
        this.say(this.labels.doneLabel);
        this.stage.classList.add("is-done");
        if (this.onPracticed) this.onPracticed();
      } catch (e) {
        if (!isCancel(e)) console.error("[guide] scene failed", e);
      }
    })();
  }

  async play(run, yours) {
    for (const b of this.spec.beats) {
      if (yours && INTERACTIVE.has(b.do)) await this.yourTurn(b, run);
      else await this.beat(b, run);
    }
  }

  // ─── beats ─────────────────────────────────────────────────
  async beat(b, run) {
    if (b.say !== undefined) this.say(b.say);
    const c = this.cursor;
    switch (b.do) {
      case "wait":
        await run.wait(b.ms || 600);
        break;
      case "move":
        await run.guard(c.flyTo(this.anchor(b.at, b.fx ?? 0.5, b.fy ?? 0.5)));
        await run.wait(b.ms ?? 260);
        break;
      case "press":
        await run.guard(c.flyTo(this.anchor(b.at, b.fx ?? 0.5, b.fy ?? 0.55)));
        await run.wait(150);
        c.press();
        this.flash(b.at);
        if (b.then) b.then(this);
        await run.wait(b.ms ?? 700);
        break;
      case "type":
        await run.guard(c.flyTo(this.anchor(b.at, 0.18, 0.6)));
        await run.wait(120);
        c.press();
        await this.type(b.at, b.text, run, b.mask);
        if (b.then) b.then(this);
        await run.wait(b.ms ?? 320);
        break;
      case "auto":
        if (b.then) b.then(this);
        await run.wait(b.ms ?? 800);
        break;
      case "focus":
        this.focus(b.x, b.y, b.zoom || 1, b.ms ?? 700);
        await run.wait((b.ms ?? 700) + 80);
        break;
      case "swipe":
        await this.swipe(b, run);
        break;
      case "wheel":
        await this.wheel(b, run);
        break;
      case "pinch":
        await this.pinch(b, run);
        break;
      default:
        break;
    }
  }

  async yourTurn(b, run) {
    const el = this.q(b.at);
    if (!el) return;
    this.say(`${this.labels.turnLabel} · ${b.say || ""}`);
    el.classList.add("gd-try-target");
    // Beside the control, not on it: the reader is about to press it.
    await run.guard(this.cursor.flyTo(this.anchor(el, 1.05, 1.1)));
    await run.guard(new Promise((resolve) => (this.expect = { el, resolve })));
    el.classList.remove("gd-try-target");
    this.flash(el);
    if (b.do === "type") await this.type(b.at, b.text, run, b.mask);
    if (b.then) b.then(this);
    await run.wait(b.ms ?? 560);
  }

  tap(e) {
    if (this.mode !== "try" || !this.expect) return;
    const { el, resolve } = this.expect;
    if (el.contains(e.target)) {
      this.expect = null;
      resolve();
      return;
    }
    if (el.animate) {
      el.animate(
        [
          { transform: "translateX(0)" },
          { transform: "translateX(-3px)" },
          { transform: "translateX(3px)" },
          { transform: "translateX(0)" },
        ],
        { duration: 260, easing: "ease-in-out" },
      );
    }
  }

  async type(sel, text, run, mask) {
    const field = this.q(sel);
    if (!field) return;
    const out = field.querySelector(".gd-m-val") || field;
    field.classList.add("is-focus");
    out.textContent = "";
    for (const ch of Array.from(text)) {
      out.textContent += mask ? "•" : ch;
      await run.wait(48 + Math.random() * 46);
    }
    field.classList.remove("is-focus");
  }

  async swipe(b, run) {
    const c = this.cursor;
    const start = this.pointOf(b.at, b.fx ?? 0.5, b.fy ?? 0.5);
    if (!start) return;
    await run.guard(c.flyTo(() => start));
    c.press();
    await run.wait(120);
    if (b.then) b.then(this);
    const end = { x: start.x + (b.dx || 0), y: start.y + (b.dy || 0) };
    await run.guard(c.flyTo(() => end, { duration: b.ms || 700 }));
    await run.wait(b.after ?? 320);
  }

  async wheel(b, run) {
    const c = this.cursor;
    await run.guard(c.flyTo(this.anchor(b.at, b.fx ?? 0.5, b.fy ?? 0.5)));
    const p = this.pointOf(b.at, b.fx ?? 0.5, b.fy ?? 0.5);
    const glyph = document.createElement("div");
    glyph.className = "gd-wheel";
    glyph.style.transform = `translate(${(p.x + 16).toFixed(1)}px, ${(p.y - 30).toFixed(1)}px)`;
    glyph.innerHTML = "<i></i>";
    this.cam.appendChild(glyph);
    await run.wait(200);
    if (b.then) b.then(this);
    try {
      await run.wait(b.ms || 1100);
    } finally {
      glyph.remove();
    }
  }

  async pinch(b, run) {
    const p = this.pointOf(b.at, b.fx ?? 0.5, b.fy ?? 0.5);
    if (!p) return;
    await run.guard(this.cursor.flyTo(() => ({ x: p.x + 40, y: p.y + 46 })));
    const dots = [];
    for (const dir of [-1, 1]) {
      const d = document.createElement("div");
      d.className = "gd-touch";
      d.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      this.cam.appendChild(d);
      dots.push(d);
      try {
        d.animate(
          [
            { transform: `translate(${p.x + dir * 8}px, ${p.y + dir * 6}px)`, opacity: 0 },
            { transform: `translate(${p.x + dir * 10}px, ${p.y + dir * 8}px)`, opacity: 1, offset: 0.15 },
            { transform: `translate(${p.x + dir * 48}px, ${p.y + dir * 34}px)`, opacity: 1, offset: 0.85 },
            { transform: `translate(${p.x + dir * 50}px, ${p.y + dir * 36}px)`, opacity: 0 },
          ],
          { duration: b.ms || 1200, easing: "cubic-bezier(.4,.1,.3,1)", fill: "forwards" },
        );
      } catch {}
    }
    await run.wait(220);
    if (b.then) b.then(this);
    try {
      await run.wait((b.ms || 1200) - 120);
    } finally {
      dots.forEach((d) => d.remove());
    }
  }
}
