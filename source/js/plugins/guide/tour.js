/**
 * Guide — the progress card behind "View More".
 *
 * One card: a stage where the current step is acted out, the step's own text
 * under it, and a footer with the progress dots and Back / Next. Steps can also
 * be LIVE: the stage folds away, the card drops to the bottom of the screen, the
 * page shows through, and the page's own cursor flies out of the card to the
 * real control the step is about — only if that control is on screen, because
 * the guide never scrolls the page.
 *
 * It is a modal dialog: focus moves into it and is kept there, Esc closes it,
 * ←/→ page through it, and the page behind does not scroll while it is open.
 * The same card doubles as the guide menu, listing every walkthrough.
 *
 * Material: solid card over a plain dimming mask. The mask is not blurred: a
 * full-screen backdrop-filter is the most expensive surface the site could draw.
 */

import { t, markTour } from "./store.js";
import { Scene } from "./scene.js";
import { reducedMotion, clamp } from "./motion.js";
import { shown, ratioInView, anchorOf } from "./dom.js";

let current = null;

export class Tour {
  /**
   * @param {object} def   {id, name, steps:[{id,title,body,scene,live,liveTitle,liveBody}]}
   *                       or {menu:true, entries, build(id)}
   * @param {object} opts  {cursor, halo, from}
   */
  constructor(def, opts = {}) {
    this.def = def;
    this.opts = opts;
    this.index = 0;
    this.completed = false;
    this.result = {};
    this.liveEl = null;
    this.reduced = reducedMotion();
  }

  open() {
    if (current) current.close("replaced");
    current = this;
    this.returnFocus = document.activeElement;
    this.buildDom();
    document.body.appendChild(this.root);

    return new Promise((resolve) => {
      this.resolve = resolve;
      requestAnimationFrame(() => {
        this.root.classList.add("is-open");
        if (this.def.menu) this.showMenu();
        else this.start(this.def, this.opts.from);
        this.enterFromCursor();
      });
    });
  }

  // ─── dom ───────────────────────────────────────────────────
  buildDom() {
    const root = (this.root = document.createElement("div"));
    root.className = "gd-tour";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "gd-tour-name");
    root.innerHTML =
      '<div class="gd-tour-mask"></div>' +
      '<section class="gd-tour-card">' +
      '<header class="gd-tour-head">' +
      '<span class="gd-tour-kicker"><i class="fa-regular fa-compass" aria-hidden="true"></i><span></span></span>' +
      '<span class="gd-tour-name" id="gd-tour-name"></span>' +
      '<span class="gd-tour-count"></span>' +
      '<button type="button" class="gd-tour-close"><i class="fa-regular fa-xmark" aria-hidden="true"></i></button>' +
      "</header>" +
      '<div class="gd-tour-stage">' +
      '<div class="gd-view"><div class="gd-cam"></div></div>' +
      '<div class="gd-caption"><span></span></div>' +
      '<button type="button" class="gd-try"></button>' +
      "</div>" +
      '<div class="gd-tour-text"></div>' +
      '<footer class="gd-tour-foot">' +
      '<div class="gd-dots" role="group"></div>' +
      '<div class="gd-tour-nav">' +
      '<button type="button" class="gd-btn gd-btn-quiet" data-nav="back"></button>' +
      '<button type="button" class="gd-btn gd-btn-primary" data-nav="next"></button>' +
      "</div>" +
      "</footer>" +
      "</section>";

    this.card = root.querySelector(".gd-tour-card");
    this.stage = root.querySelector(".gd-tour-stage");
    this.textBox = root.querySelector(".gd-tour-text");
    this.dots = root.querySelector(".gd-dots");
    this.back = root.querySelector('[data-nav="back"]');
    this.next = root.querySelector('[data-nav="next"]');
    this.count = root.querySelector(".gd-tour-count");
    this.nameEl = root.querySelector(".gd-tour-name");

    root.querySelector(".gd-tour-kicker span").textContent = t("label", "Guide");
    const close = root.querySelector(".gd-tour-close");
    close.setAttribute("aria-label", t("close"));
    close.title = t("close");
    this.back.textContent = t("back");

    close.addEventListener("click", () => this.close("close"));
    root.querySelector(".gd-tour-mask").addEventListener("click", () => this.close("close"));
    this.back.addEventListener("click", () => this.go(this.index - 1, -1));
    this.next.addEventListener("click", () => this.forward());
    this.dots.addEventListener("click", (e) => {
      const dot = e.target.closest("[data-step]");
      if (dot) this.go(Number(dot.dataset.step), Number(dot.dataset.step) > this.index ? 1 : -1);
    });
    this.textBox.addEventListener("click", (e) => this.menuClick(e));

    root.addEventListener("keydown", (e) => this.key(e));
    // The page behind a modal does not scroll: wheel and touch are swallowed
    // everywhere except inside the text, and there only while it has something
    // to scroll — otherwise the gesture would chain through to the page.
    const hold = (e) => {
      const box = e.target.closest(".gd-tour-text");
      if (box && box.scrollHeight > box.clientHeight + 1) return;
      e.preventDefault();
    };
    root.addEventListener("wheel", hold, { passive: false });
    root.addEventListener("touchmove", hold, { passive: false });

    this.swipe(this.textBox);

    this.scene = new Scene(this.stage, {
      label: t("you", "You"),
      tryLabel: t("try"),
      watchLabel: t("watch"),
      turnLabel: t("your_turn"),
      doneLabel: t("try_done"),
      onPracticed: () => this.next.classList.add("is-ready"),
    });
  }

  swipe(el) {
    let x0 = 0;
    let y0 = 0;
    let on = false;
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || this.mode !== "steps") return;
      on = true;
      x0 = e.clientX;
      y0 = e.clientY;
    });
    el.addEventListener("pointerup", (e) => {
      if (!on) return;
      on = false;
      const dx = e.clientX - x0;
      if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(e.clientY - y0) * 1.5) {
        if (dx < 0) this.forward();
        else this.go(this.index - 1, -1);
      }
    });
    el.addEventListener("pointercancel", () => (on = false));
  }

  key(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close("close");
      return;
    }
    if (this.mode === "steps" && !e.target.closest("input, textarea")) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        this.forward();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        this.go(this.index - 1, -1);
        return;
      }
    }
    if (e.key === "Tab") {
      const f = Array.from(this.card.querySelectorAll("button, [href], [tabindex]")).filter(
        (el) => !el.hidden && el.offsetParent !== null && el.tabIndex >= 0,
      );
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // ─── steps ─────────────────────────────────────────────────
  start(def, from) {
    this.mode = "steps";
    this.tour = def;
    this.steps = def.steps;
    this.completed = false;
    this.root.classList.remove("is-menu");
    this.nameEl.textContent = def.name;
    this.dots.innerHTML = this.steps
      .map((s, i) => `<button type="button" class="gd-dot" data-step="${i}" aria-label="${i + 1} / ${this.steps.length}"></button>`)
      .join("");
    const at = from ? this.steps.findIndex((s) => s.id === from) : 0;
    this.go(at > 0 ? at : 0, 0, true);
    setTimeout(() => this.next.focus({ preventScroll: true }), 60);
  }

  forward() {
    if (this.mode === "menu") return this.close("close");
    if (this.mode !== "steps") return;
    if (this.index >= this.steps.length - 1) {
      this.completed = true;
      markTour(this.tour.id);
      this.close("done");
      return;
    }
    this.go(this.index + 1, 1);
  }

  go(i, dir, first = false) {
    if (this.mode !== "steps") return;
    i = clamp(i, 0, this.steps.length - 1);
    if (i === this.index && !first) return;
    this.index = i;
    const step = this.steps[i];
    const last = i === this.steps.length - 1;

    this.dots.querySelectorAll(".gd-dot").forEach((d, k) => {
      d.classList.toggle("is-current", k === i);
      d.classList.toggle("is-done", k < i);
      if (k === i) d.setAttribute("aria-current", "step");
      else d.removeAttribute("aria-current");
    });
    this.count.textContent = `${i + 1} / ${this.steps.length}`;
    this.back.hidden = i === 0;
    this.next.classList.remove("is-ready");
    this.next.innerHTML = last
      ? `${t("done")}<i class="fa-solid fa-check" aria-hidden="true"></i>`
      : `${t("next")}<i class="fa-solid fa-arrow-right" aria-hidden="true"></i>`;
    // Only finishing a walkthrough is worth an analytics event; paging is not.
    if (last) {
      this.next.setAttribute("data-ux", "guide");
      this.next.setAttribute("data-ux-action", "finish");
      this.next.setAttribute("data-ux-id", this.tour.id);
    } else this.next.removeAttribute("data-ux");

    const live = step.live ? step.live() : null;
    const liveOk = live && shown(live) && ratioInView(live) >= 0.5;
    this.slide(
      liveOk ? step.liveTitle || step.title : step.title,
      liveOk ? step.liveBody || step.body : step.body,
      dir,
    );
    if (liveOk) this.enterLive(live);
    else {
      this.leaveLive();
      if (step.scene) this.scene.load(step.scene);
      else this.scene.stop();
      this.root.classList.toggle("no-stage", !step.scene);
    }
  }

  /** Swap the step's text, sliding in from the side it was paged towards. */
  slide(title, body, dir) {
    const box = this.textBox;
    const old = box.querySelector(".gd-tour-slide:not(.is-leaving)");
    const h0 = box.offsetHeight;

    const el = document.createElement("div");
    el.className = "gd-tour-slide";
    el.innerHTML = `<h3 class="gd-tour-title"></h3><div class="gd-tour-body"></div>`;
    el.firstChild.textContent = title;
    el.lastChild.innerHTML = body;
    box.appendChild(el);

    if (!old || this.reduced) {
      if (old) old.remove();
      box.style.height = "";
      return;
    }

    el.style.setProperty("--gd-dir", String(dir || 1));
    old.style.setProperty("--gd-dir", String(dir || 1));
    old.classList.add("is-leaving");
    el.classList.add("is-entering");
    const h1 = el.offsetHeight;
    box.style.height = `${h0}px`;
    box.classList.add("is-sliding");
    requestAnimationFrame(() => {
      box.style.height = `${h1}px`;
    });
    clearTimeout(this.slideTimer);
    this.slideTimer = setTimeout(() => {
      box.querySelectorAll(".gd-tour-slide.is-leaving").forEach((n) => n.remove());
      el.classList.remove("is-entering");
      box.classList.remove("is-sliding");
      box.style.height = "";
    }, 420);
  }

  // ─── live steps ────────────────────────────────────────────
  enterLive(el) {
    this.scene.stop();
    this.root.classList.add("is-live");
    this.liveEl = el;
    const { cursor, halo } = this.opts;
    if (!cursor) return;
    const card = this.card.getBoundingClientRect();
    halo.show(el);
    cursor.flyTo(anchorOf(el, [0.5, 0.6]), { from: { x: card.left + card.width / 2, y: card.top + 24 } });
  }

  leaveLive() {
    if (!this.liveEl) return;
    this.liveEl = null;
    this.root.classList.remove("is-live");
    const { cursor, halo } = this.opts;
    if (halo) halo.hide();
    if (cursor) cursor.vanish();
  }

  /** The guide's cursor, if it brought the reader here, steps into the card. */
  async enterFromCursor() {
    const { cursor } = this.opts;
    if (!cursor || !cursor.visible || this.liveEl) return;
    const stage = this.stage.getBoundingClientRect();
    const r = stage.width ? stage : this.card.getBoundingClientRect();
    const spot = { x: r.left + r.width * 0.72, y: r.top + r.height * 0.72 };
    await cursor.flyTo(() => spot, { duration: 640 });
    if (!this.liveEl) cursor.vanish();
  }

  // ─── the menu ──────────────────────────────────────────────
  showMenu() {
    this.mode = "menu";
    this.root.classList.add("is-menu", "no-stage");
    this.scene.stop();
    this.nameEl.textContent = t("menu_title");
    this.count.textContent = "";
    this.dots.innerHTML = "";
    this.back.hidden = true;
    this.next.innerHTML = t("close");
    this.next.removeAttribute("data-ux");

    const rows = this.def.entries
      .map(
        (e) =>
          `<button type="button" class="gd-menu-row" data-tour="${e.id}">` +
          `<span class="gd-menu-icon"><i class="${e.icon}" aria-hidden="true"></i></span>` +
          `<span class="gd-menu-text"><b></b><span></span></span>` +
          `<span class="gd-menu-meta">${e.count}</span>` +
          `<i class="gd-menu-go fa-solid fa-arrow-right" aria-hidden="true"></i></button>`,
      )
      .join("");
    const body =
      `<p class="gd-menu-lede"></p><div class="gd-menu-list">${rows}</div>` +
      `<button type="button" class="gd-menu-reset" data-reset="1"><i class="fa-regular fa-rotate-left" aria-hidden="true"></i><span></span></button>` +
      `<p class="gd-menu-note"></p>`;
    this.slide("", "", 0);
    const slide = this.textBox.querySelector(".gd-tour-slide:last-child");
    slide.classList.add("is-menu");
    slide.querySelector(".gd-tour-title").remove();
    slide.querySelector(".gd-tour-body").innerHTML = body;
    slide.querySelector(".gd-menu-lede").textContent = t("menu_lede");
    slide.querySelector(".gd-menu-reset span").textContent = t("reset");
    slide.querySelector(".gd-menu-note").textContent = t("reset_note");
    this.def.entries.forEach((e, i) => {
      const row = slide.querySelectorAll(".gd-menu-row")[i];
      row.querySelector("b").textContent = e.name;
      row.querySelector(".gd-menu-text span").textContent = e.desc;
      row.setAttribute("data-ux", "guide");
      row.setAttribute("data-ux-action", "menu-open");
      row.setAttribute("data-ux-id", e.id);
    });
    setTimeout(() => {
      const first = this.textBox.querySelector(".gd-menu-row");
      if (first) first.focus({ preventScroll: true });
    }, 60);
  }

  menuClick(e) {
    if (this.mode !== "menu") return;
    const row = e.target.closest("[data-tour]");
    if (row) {
      const def = this.def.build(row.dataset.tour);
      if (def) this.start(def, null);
      return;
    }
    const reset = e.target.closest("[data-reset]");
    if (!reset) return;
    if (!reset.classList.contains("is-armed")) {
      reset.classList.add("is-armed");
      reset.querySelector("span").textContent = t("reset_confirm");
      return;
    }
    this.result.reset = true;
    reset.classList.remove("is-armed");
    reset.classList.add("is-done");
    reset.querySelector("span").textContent = t("reset_done");
    setTimeout(() => this.close("reset"), 700);
  }

  // ─── closing ───────────────────────────────────────────────
  close(reason) {
    if (this.closed) return;
    this.closed = true;
    if (current === this) current = null;
    this.leaveLive();
    this.scene.stop();
    this.root.classList.remove("is-open");
    this.root.classList.add("is-closing");
    const done = () => {
      this.scene.destroy();
      this.root.remove();
    };
    if (this.reduced) done();
    else setTimeout(done, 320);
    if (this.returnFocus && this.returnFocus.focus && reason !== "replaced") {
      try {
        this.returnFocus.focus({ preventScroll: true });
      } catch {}
    }
    this.resolve(Object.assign({ completed: this.completed, reason }, this.result));
  }

  static closeCurrent() {
    if (current) current.close("navigate");
  }
}
