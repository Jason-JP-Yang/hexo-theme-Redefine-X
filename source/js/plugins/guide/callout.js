/**
 * Guide — what the cursor says.
 *
 * The cursor's label is the tip. "Guide" grows into "Guide: …" as the text is
 * typed, then the title opens above the text and the answers below it, the
 * corner by the arrow staying where it is. The text is laid out once, at its
 * finished width, and typing only uncovers it: a word never jumps to the next
 * line halfway through, and the finished size is known before the first letter
 * — which is what lets the cursor pick the corner the whole bubble fits on.
 *
 * Material: the label's own solid accent, tier 1 — it moves every frame.
 */

import { Spring } from "./motion.js";
import { escapeHTML } from "./store.js";

// About sixty characters a second, never under half a second or over two, with
// a breath after a sentence and a shorter one after a clause.
const PER_CHAR = 16;
const TYPE_MIN = 450;
const TYPE_MAX = 1800;
const LEAD = 60; // after landing, before the first character
const PAUSE = 140; // after the last, before the title and the answers open
const STAGGER = 70; // the answers a moment after the title
const SENTENCE = /[.!?。！？]/;
const CLAUSE = /[,;:，；、：]/;
const ARIA = ["role", "aria-modal", "aria-labelledby", "aria-describedby"];

const graphemes =
  typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * Every character becomes its own span, so typing can show them one at a time
 * without the text being laid out again. An element with no text of its own —
 * an icon — counts as one character.
 */
function split(root) {
  const units = [];
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const text = child.data;
        // Indentation between blocks of rendered Markdown shows nothing.
        if (!text || (!text.trim() && text.includes("\n"))) continue;
        const frag = document.createDocumentFragment();
        const parts = graphemes ? Array.from(graphemes.segment(text), (s) => s.segment) : Array.from(text);
        for (const ch of parts) {
          const s = document.createElement("span");
          s.className = "gd-c";
          s.textContent = ch;
          frag.appendChild(s);
          units.push(s);
        }
        child.replaceWith(frag);
      } else if (child.nodeType === 1 && child.tagName !== "BR") {
        if (child.textContent) walk(child);
        else {
          child.classList.add("gd-c");
          units.push(child);
        }
      }
    }
  };
  walk(root);
  return units;
}

export class Callout {
  /**
   * @param {import("./cursor.js").Cursor} cursor  the page cursor, whose label this becomes
   * @param {(act: string) => void} onAction         "ok" | "more" | "later"
   */
  constructor(cursor, onAction) {
    this.cursor = cursor;
    this.pill = cursor.pill;
    const box = (this.box = cursor.box);
    box.insertAdjacentHTML(
      "afterbegin",
      '<div class="gd-say-title"><div class="gd-say-title-in" id="gd-say-title"></div></div>',
    );
    box.insertAdjacentHTML(
      "beforeend",
      '<div class="gd-say-actions"><div class="gd-say-actions-in">' +
        '<button type="button" class="gd-say-btn is-ok" data-act="ok"></button>' +
        '<button type="button" class="gd-say-btn" data-act="more"></button>' +
        '<button type="button" class="gd-say-x" data-act="later"><i class="fa-regular fa-xmark" aria-hidden="true"></i></button>' +
        "</div></div>" +
        '<div class="gd-say-timer"></div><span class="gd-sr" id="gd-say-text"></span>',
    );
    this.titleWrap = box.querySelector(".gd-say-title");
    this.titleIn = this.titleWrap.firstElementChild;
    this.textWrap = box.querySelector(".gd-say-text");
    this.actWrap = box.querySelector(".gd-say-actions");
    this.actIn = this.actWrap.firstElementChild;
    this.ok = box.querySelector('[data-act="ok"]');
    this.more = box.querySelector('[data-act="more"]');
    this.later = box.querySelector('[data-act="later"]');
    this.timer = box.querySelector(".gd-say-timer");
    this.srText = box.querySelector("#gd-say-text");
    this.body = document.createElement("span");
    this.body.className = "gd-say-body";
    this.body.setAttribute("aria-hidden", "true");
    cursor.line.appendChild(this.body);

    // idle → prepared (laid out, unseen) → typing → open → hushing → idle
    this.state = "idle";
    this.holds = new Set();
    this.m = null;
    this.units = [];
    this.text = "";
    this.written = new Map();
    this.g = { w: 0, h: 0, fw: 0, fh: 0, sw: 0, sh: 0, decide: false };

    this.w = new Spring(0, 420, 40);
    this.th = new Spring(0, 520, 44);
    this.rt = new Spring(0, 300, 28);
    this.ra = new Spring(0, 300, 28);
    // The finished size, eased in from the label's, is what the cursor keeps in view.
    this.fw = new Spring(0, 260, 32);
    this.fh = new Spring(0, 260, 32);

    this.pill.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (btn && this.state === "open") onAction(btn.dataset.act);
      // Pressing the bubble while it is still talking finishes the sentence.
      else if (this.state === "typing") this.skip = true;
    });
    this.pill.addEventListener("pointerenter", () => this.hold("hover", true));
    this.pill.addEventListener("pointerleave", () => this.hold("hover", false));
    this.pill.addEventListener("focusin", () => this.hold("focus", true));
    this.pill.addEventListener("focusout", (e) => {
      if (!this.pill.contains(e.relatedTarget)) this.hold("focus", false);
    });

    cursor.speech = this;
  }

  get active() {
    return this.state !== "idle";
  }

  /** Everything has been said and the answers are open. */
  get ready() {
    return this.state === "open";
  }

  get held() {
    return this.holds.size > 0;
  }

  hold(reason, on) {
    if (on) this.holds.add(reason);
    else this.holds.delete(reason);
    this.pill.classList.toggle("is-held", this.held);
  }

  /**
   * Lay out what is about to be said, unseen, so the cursor can choose its side
   * while it is still on the way.
   * @param {object} spec  {id, colon, title, body, ok, more, later, wait}
   */
  prepare(spec) {
    clearTimeout(this.dropTimer);
    this.fresh = this.state === "idle";
    this.state = "prepared";
    this.spec = spec;
    this.holds.clear();
    this.skip = false;
    this.decide = false;
    this.typed = 0;
    this.m = null;
    this.pill.classList.remove("is-speaking", "is-ready", "is-held", "is-hushing");
    this.pill.classList.add("has-say");

    let title = spec.title || "";
    let body = spec.body || "";
    if (!body) [title, body] = ["", escapeHTML(title)];
    this.titleIn.textContent = title;
    this.titleWrap.hidden = !title;
    const colon = spec.colon || ": ";
    this.body.innerHTML = `<b>${escapeHTML(colon)}</b>${body}`;
    this.units = split(this.body);
    this.text = this.body.textContent.slice(colon.length).trim();
    this.srText.textContent = this.text;

    this.ok.textContent = spec.ok || "";
    this.more.hidden = !spec.more;
    if (spec.more) this.more.innerHTML = `${spec.more}<i class="fa-solid fa-arrow-right" aria-hidden="true"></i>`;
    this.later.setAttribute("aria-label", spec.later || "");
    this.later.title = spec.later || "";
    // Analytics marks — tools/uxEvents.js reads them off the button pressed.
    for (const [btn, action] of [[this.ok, "understand"], [this.more, "more"]]) {
      btn.setAttribute("data-ux", "guide");
      btn.setAttribute("data-ux-action", action);
      btn.setAttribute("data-ux-id", spec.id || "");
    }
    this.timer.replaceChildren();

    const n = this.units.length;
    const step = Math.min(TYPE_MAX, Math.max(TYPE_MIN, n * PER_CHAR)) / Math.max(1, n);
    this.at = new Float32Array(n);
    let t = LEAD;
    for (let i = 0; i < n; i++) {
      this.at[i] = t;
      const ch = this.units[i].textContent;
      t += step + (SENTENCE.test(ch) ? 70 : CLAUSE.test(ch) ? 30 : 0);
    }
    this.end = t;
    this.cursor.loop.wake();
  }

  /** The cursor has arrived: start talking. */
  speak() {
    if (this.state !== "prepared") return;
    this.state = "typing";
    this.t0 = performance.now();
    this.pill.classList.add("is-speaking");
    this.pill.setAttribute("role", "dialog");
    this.pill.setAttribute("aria-modal", "false");
    this.pill.setAttribute("aria-describedby", "gd-say-text");
    if (this.titleIn.textContent) this.pill.setAttribute("aria-labelledby", "gd-say-title");
    this.cursor.loop.wake();
  }

  /** Stop talking and fold back into the label. */
  close() {
    if (this.state === "idle" || this.state === "hushing") return;
    if (this.state === "prepared" && !this.m) return this.release();
    this.state = "hushing";
    this.holds.clear();
    this.pill.classList.remove("is-speaking", "is-ready", "is-held");
    this.pill.classList.add("is-hushing");
    for (const a of ARIA) this.pill.removeAttribute(a);
    if (this.pill.contains(document.activeElement)) document.activeElement.blur();
    this.timer.replaceChildren();
    this.cursor.loop.wake();
  }

  /** The cursor has gone; let go once it has faded. */
  drop() {
    clearTimeout(this.dropTimer);
    if (this.state === "idle") return;
    this.dropTimer = setTimeout(() => {
      if (!this.cursor.visible) this.release();
    }, 240);
  }

  release() {
    clearTimeout(this.dropTimer);
    this.state = "idle";
    this.m = null;
    this.holds.clear();
    this.pill.classList.remove("has-say", "is-speaking", "is-ready", "is-held", "is-hushing");
    for (const a of ARIA) this.pill.removeAttribute(a);
    this.body.replaceChildren();
    this.units = [];
    this.timer.replaceChildren();
    for (const el of [this.box, this.titleWrap, this.textWrap, this.actWrap]) el.removeAttribute("style");
    this.written.clear();
  }

  // ─── frame ─────────────────────────────────────────────────
  measure() {
    if (this.state === "idle") return;
    // Measured on the way: the cursor chooses its corner for the finished bubble
    // before it lands, so it arrives already facing the right way.
    if (!this.m) {
      this.m = this.read();
      this.decide = this.state === "prepared";
    }
  }

  /** The finished bubble, and where every character ends — one layout, read once. */
  read() {
    const L = this.cursor.label;
    const line = this.cursor.line;
    const name = this.cursor.name;
    // Offsets rather than client rects: the box is scaled while it appears.
    const ox = line.offsetLeft;
    const oy = line.offsetTop;
    const lead = L.lh - (name.offsetTop + name.offsetHeight - oy);
    const n = this.units.length;
    const right = new Float32Array(n + 1);
    const bottom = new Float32Array(n + 1);
    right[0] = name.offsetLeft + name.offsetWidth - ox;
    bottom[0] = L.lh;
    for (let i = 0; i < n; i++) {
      const c = this.units[i];
      const w = c.offsetWidth;
      const h = c.offsetHeight;
      right[i + 1] = w ? Math.max(right[i], c.offsetLeft + w - ox) : right[i];
      bottom[i + 1] = h ? Math.max(bottom[i], c.offsetTop + h - oy + lead) : bottom[i];
    }
    const titled = !this.titleWrap.hidden;
    const U = titled ? this.titleIn.offsetHeight : 0;
    const actH = this.actIn.offsetHeight;
    const lineH = line.offsetHeight;
    const W = Math.ceil(Math.max(right[n], titled ? this.titleIn.offsetWidth : 0, this.actIn.offsetWidth)) + 2 * L.px + 1;
    return { right, bottom, U, actH, lineH, W, H: L.pt + U + lineH + actH + L.pb };
  }

  /** Advance the typing and the reveals, size the rows, and report the geometry. */
  frame(now, dt, L) {
    const m = this.m;
    const g = this.g;
    if (!m) {
      g.w = g.fw = g.sw = L.w;
      g.h = g.fh = g.sh = L.h;
      g.decide = false;
      return g;
    }
    const alive = this.cursor.alive;
    if (this.fresh) {
      this.fresh = false;
      for (const [s, v] of [[this.w, L.w], [this.th, L.lh], [this.rt, 0], [this.ra, 0], [this.fw, L.w], [this.fh, L.h]]) s.snap(v);
    }

    let wT = L.w;
    let thT = L.lh;
    let rtT = 0;
    let raT = 0;
    if (this.state === "typing") {
      const n = this.units.length;
      const t = now - this.t0;
      let k = this.typed;
      if (this.skip || !alive) k = n;
      else while (k < n && this.at[k] <= t) k++;
      for (let i = this.typed; i < k; i++) this.units[i].classList.add("is-on");
      this.typed = k;
      wT = m.right[k] + 2 * L.px + 1;
      thT = m.bottom[k];
      if (k >= n && (this.skip || !alive || t >= this.end + PAUSE)) this.open(now);
    }
    if (this.state === "open") {
      wT = m.W;
      thT = m.lineH;
      rtT = 1;
      raT = now - this.openAt >= STAGGER ? 1 : 0;
    }
    const said = this.state === "typing" || this.state === "open";

    if (!alive) {
      this.w.snap(wT);
      this.th.snap(thT);
      this.rt.snap(rtT);
      this.ra.snap(raT);
    } else {
      // Typing widens the bubble letter by letter; anything else is eased.
      if (this.state === "typing" && this.w.x <= wT) this.w.snap(wT);
      else this.w.step(wT, dt);
      this.th.step(thT, dt);
      this.rt.step(rtT, dt);
      this.ra.step(raT, dt);
    }
    for (const [s, v] of [[this.fw, said ? m.W : L.w], [this.fh, said ? m.H : L.h]]) {
      if (alive) s.step(v, dt);
      else s.snap(v);
    }

    const w = Math.max(0, this.w.x);
    const th = Math.max(0, this.th.x);
    const u = Math.max(0, this.rt.x) * m.U;
    const a = Math.max(0, this.ra.x) * m.actH;
    this.set(this.box, "width", w);
    this.set(this.titleWrap, "height", u);
    this.set(this.textWrap, "height", th);
    this.set(this.actWrap, "height", a);

    const hushing = this.state === "hushing";
    g.w = w;
    g.h = L.pt + u + th + a + L.pb;
    g.fw = this.fw.x;
    g.fh = this.fh.x;
    g.sw = hushing ? L.w : m.W;
    g.sh = hushing ? L.h : m.H;
    g.decide = this.decide;
    this.decide = false;

    if (hushing && Math.abs(w - L.w) < 0.5 && Math.abs(th - L.lh) < 0.5 && u < 0.3 && a < 0.3) {
      this.release();
    }
    return g;
  }

  open(now) {
    this.state = "open";
    this.openAt = now;
    this.pill.classList.add("is-ready");
    this.timer.style.setProperty("--gd-wait", `${this.spec.wait || 12000}ms`);
    this.timer.replaceChildren(document.createElement("i"));
  }

  // Style writes only when the value changes: the loop runs every frame.
  set(el, prop, px) {
    const v = `${px.toFixed(2)}px`;
    let seen = this.written.get(el);
    if (!seen) this.written.set(el, (seen = {}));
    if (seen[prop] === v) return;
    seen[prop] = v;
    el.style[prop] = v;
  }
}
