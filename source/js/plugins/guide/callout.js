/**
 * Guide — the tip card that opens beside the cursor.
 *
 * Placement is arithmetic, not CSS: the card is measured once per content
 * change, and every frame it is put on whichever side of the target it fits
 * without covering it — below or above first depending on which half of the
 * viewport the target is in, then beside it. It keeps the side it was given for
 * as long as that side still fits, so a scrolling page does not make it jump.
 * When no side clears the target (a photo filling a phone screen) it sits in the
 * half of the viewport the target is not in.
 *
 * Material: solid, like the notifications panel. It floats over live content
 * only while it is open, which does not earn the backdrop-filter tier.
 */

import { clamp } from "./motion.js";

const MARGIN = 12;
const GAP = 14;
// The cursor's label hangs below and to the right of the tip. A card placed on
// those sides starts clear of it rather than under it.
const PILL_CLEAR_Y = 44;
const PILL_CLEAR_X = 84;

function place(t, p, w, h, vw, vh, keep) {
  const cx = clamp(p.x - 28, MARGIN, vw - MARGIN - w);
  const cy = clamp(p.y - 22, MARGIN, vh - MARGIN - h);
  const ox = `${clamp(p.x - cx, 18, w - 18).toFixed(0)}px`;
  const oy = `${clamp(p.y - cy, 18, h - 18).toFixed(0)}px`;
  const sides = {
    below: { x: cx, y: Math.max(t.bottom + GAP, p.y + PILL_CLEAR_Y), origin: `${ox} 0px` },
    above: { x: cx, y: t.top - GAP - h, origin: `${ox} ${h}px` },
    right: { x: Math.max(t.right + GAP, p.x + PILL_CLEAR_X), y: cy, origin: `0px ${oy}` },
    left: { x: t.left - GAP - w, y: cy, origin: `${w}px ${oy}` },
  };
  const fits = (s) => s.x >= MARGIN && s.y >= MARGIN && s.x + w <= vw - MARGIN && s.y + h <= vh - MARGIN;

  if (keep && sides[keep] && fits(sides[keep])) return { side: keep, ...sides[keep] };

  const upper = (t.top + t.bottom) / 2 < vh / 2;
  const order = upper ? ["below", "right", "left", "above"] : ["above", "right", "left", "below"];
  for (const side of order) if (fits(sides[side])) return { side, ...sides[side] };

  return {
    side: "over",
    x: clamp(p.x - w / 2, MARGIN, vw - MARGIN - w),
    y: upper ? vh - MARGIN - h : MARGIN,
    origin: "50% 50%",
  };
}

export class Callout {
  constructor(layer, loop, onAction) {
    this.loop = loop;
    this.active = false;
    this.holds = new Set();

    const el = (this.el = document.createElement("div"));
    el.className = "gd-callout";
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "false");
    el.setAttribute("aria-labelledby", "gd-callout-title");
    el.innerHTML =
      '<div class="gd-callout-card">' +
      '<div class="gd-callout-head">' +
      '<span class="gd-callout-kicker"><i class="fa-solid fa-location-arrow" aria-hidden="true"></i><span></span></span>' +
      '<button type="button" class="gd-callout-x" data-act="later"><i class="fa-regular fa-xmark" aria-hidden="true"></i></button>' +
      "</div>" +
      '<div class="gd-callout-title" id="gd-callout-title"></div>' +
      '<div class="gd-callout-body"></div>' +
      '<div class="gd-callout-actions">' +
      '<button type="button" class="gd-btn gd-btn-ghost" data-act="more"></button>' +
      '<button type="button" class="gd-btn gd-btn-primary" data-act="ok"></button>' +
      "</div>" +
      '<div class="gd-callout-timer"><i></i></div>' +
      "</div>";
    layer.appendChild(el);

    this.card = el.firstElementChild;
    this.kicker = el.querySelector(".gd-callout-kicker span");
    this.title = el.querySelector(".gd-callout-title");
    this.body = el.querySelector(".gd-callout-body");
    this.more = el.querySelector('[data-act="more"]');
    this.ok = el.querySelector('[data-act="ok"]');
    this.later = el.querySelector('[data-act="later"]');
    this.timer = el.querySelector(".gd-callout-timer");

    el.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (btn && this.active) onAction(btn.dataset.act);
    });
    el.addEventListener("pointerenter", () => this.hold("hover", true));
    el.addEventListener("pointerleave", () => this.hold("hover", false));
    el.addEventListener("focusin", () => this.hold("focus", true));
    el.addEventListener("focusout", (e) => {
      if (!el.contains(e.relatedTarget)) this.hold("focus", false);
    });
    window.addEventListener("resize", () => {
      this.sized = false;
    }, { passive: true });

    loop.add(this);
  }

  get held() {
    return this.holds.size > 0;
  }

  hold(reason, on) {
    if (on) this.holds.add(reason);
    else this.holds.delete(reason);
    this.el.classList.toggle("is-held", this.held);
  }

  /**
   * @param {object} spec  {id, kicker, title, body, ok, more, later, wait}
   * @param {() => {x:number,y:number}} anchor  the cursor tip
   * @param {() => DOMRect|null} avoid  what the card must not cover
   */
  open(spec, anchor, avoid) {
    this.anchor = anchor;
    this.avoid = avoid;
    this.side = null;
    this.sized = false;
    this.placed = false;
    this.holds.clear();

    this.kicker.textContent = spec.kicker || "";
    this.title.textContent = spec.title || "";
    this.body.innerHTML = spec.body || "";
    this.ok.textContent = spec.ok || "";
    this.later.setAttribute("aria-label", spec.later || "");
    this.later.title = spec.later || "";
    this.more.hidden = !spec.more;
    if (spec.more) this.more.innerHTML = `${spec.more}<i class="fa-solid fa-arrow-right" aria-hidden="true"></i>`;

    // Analytics marks — tools/uxEvents.js reads them off the button pressed.
    for (const [btn, action] of [[this.ok, "understand"], [this.more, "more"]]) {
      btn.setAttribute("data-ux", "guide");
      btn.setAttribute("data-ux-action", action);
      btn.setAttribute("data-ux-id", spec.id || "");
    }

    // A fresh bar restarts the countdown animation without a forced reflow.
    const bar = document.createElement("i");
    this.timer.replaceChildren(bar);
    this.timer.style.setProperty("--gd-wait", `${spec.wait || 15000}ms`);

    this.el.hidden = false;
    this.el.classList.remove("is-open", "is-closing", "is-held");
    this.el.classList.add("is-measuring");
    this.active = true;
    this.loop.add(this);
    this.loop.wake();
  }

  close() {
    if (!this.active && this.el.hidden) return;
    this.active = false;
    this.holds.clear();
    this.el.classList.remove("is-open", "is-held");
    this.el.classList.add("is-closing");
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.active) return;
      this.el.hidden = true;
      this.el.classList.remove("is-closing", "is-measuring");
    }, 240);
  }

  measure() {
    if (!this.active) return;
    if (!this.sized) {
      this.w = this.card.offsetWidth;
      this.h = this.card.offsetHeight;
      this.sized = true;
    }
    this.p = this.anchor ? this.anchor() : null;
    this.t = this.avoid ? this.avoid() : null;
    this.vw = document.documentElement.clientWidth;
    this.vh = window.innerHeight;
  }

  render() {
    if (!this.active) return false;
    if (!this.p || !this.t || !this.w) return true;

    const pos = place(this.t, this.p, this.w, this.h, this.vw, this.vh, this.side);
    this.side = pos.side;
    this.el.style.transform = `translate3d(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px, 0)`;

    if (!this.placed) {
      this.placed = true;
      this.card.style.transformOrigin = pos.origin;
      this.el.classList.remove("is-measuring");
      this.el.classList.add("is-open");
    }
    return true;
  }
}
