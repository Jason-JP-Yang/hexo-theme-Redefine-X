/**
 * Guide — the progress card behind "View More".
 *
 * One card: a stage where the current step is acted out by the page's own
 * cursor, the step's text under it, and a footer with the progress dots and
 * Back / Next. A walkthrough that differs by system carries a picker beside its
 * name, preset to the reader's system; changing it rebuilds the steps in place.
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

let current = null;

export class Tour {
  /**
   * @param {object} def   {id, name, steps:[{id,title,body,scene,final}], following,
   *                       platform, platforms:[{id,name,icon}], rebuild(platform)}
   *                       or {menu:true, entries, build(id)}
   * @param {object} opts  {cursor, from}
   */
  constructor(def, opts = {}) {
    this.def = def;
    this.opts = opts;
    this.index = 0;
    this.completed = false;
    this.result = {};
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
      '<div class="gd-pick" hidden>' +
      '<button type="button" class="gd-pick-btn" aria-haspopup="listbox" aria-expanded="false">' +
      '<i aria-hidden="true"></i><span></span><i class="gd-pick-caret fa-solid fa-chevron-down" aria-hidden="true"></i></button>' +
      '<ul class="gd-pick-list" role="listbox"></ul></div>' +
      '<span class="gd-tour-count"></span>' +
      '<button type="button" class="gd-tour-close"><i class="fa-regular fa-xmark" aria-hidden="true"></i></button>' +
      "</header>" +
      // A picture, not a page: nothing in it can be focused, pressed or read out.
      '<div class="gd-tour-stage"><div class="gd-view" inert aria-hidden="true"><div class="gd-cam"></div></div></div>' +
      '<div class="gd-tour-text"></div>' +
      '<footer class="gd-tour-foot">' +
      '<div class="gd-dots" role="group"></div>' +
      '<div class="gd-tour-nav">' +
      '<button type="button" class="gd-btn gd-btn-quiet" data-nav="back"></button>' +
      '<button type="button" class="gd-btn gd-btn-quiet" data-nav="done" hidden></button>' +
      '<button type="button" class="gd-btn gd-btn-primary" data-nav="next"></button>' +
      "</div>" +
      "</footer>" +
      "</section>";

    this.card = root.querySelector(".gd-tour-card");
    this.stage = root.querySelector(".gd-tour-stage");
    this.textBox = root.querySelector(".gd-tour-text");
    this.dots = root.querySelector(".gd-dots");
    this.back = root.querySelector('[data-nav="back"]');
    this.done = root.querySelector('[data-nav="done"]');
    this.next = root.querySelector('[data-nav="next"]');
    this.count = root.querySelector(".gd-tour-count");
    this.nameEl = root.querySelector(".gd-tour-name");
    this.pick = root.querySelector(".gd-pick");
    this.pickBtn = root.querySelector(".gd-pick-btn");
    this.pickList = root.querySelector(".gd-pick-list");

    root.querySelector(".gd-tour-kicker span").textContent = t("label", "Guide");
    const close = root.querySelector(".gd-tour-close");
    close.setAttribute("aria-label", t("close"));
    close.title = t("close");
    this.back.textContent = t("back");
    this.done.textContent = t("done");

    close.addEventListener("click", () => this.close("close"));
    root.querySelector(".gd-tour-mask").addEventListener("click", () => this.close("close"));
    this.back.addEventListener("click", () => this.go(this.index - 1, -1));
    this.next.addEventListener("click", () => this.forward());
    this.done.addEventListener("click", () => this.finish());
    this.dots.addEventListener("click", (e) => {
      const dot = e.target.closest("[data-step]");
      if (dot) this.go(Number(dot.dataset.step), Number(dot.dataset.step) > this.index ? 1 : -1);
    });
    this.textBox.addEventListener("click", (e) => this.menuClick(e));
    this.pickBtn.addEventListener("click", () => this.togglePick());
    this.pickList.addEventListener("click", (e) => {
      const item = e.target.closest("[data-platform]");
      if (item) this.choose(item.dataset.platform);
    });
    root.addEventListener("pointerdown", (e) => {
      if (this.pick.classList.contains("is-open") && !this.pick.contains(e.target)) this.togglePick(false);
    });

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
    this.scene = new Scene(this.stage, { cursor: this.opts.cursor || null });
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
      if (this.pick.classList.contains("is-open")) {
        this.togglePick(false);
        this.pickBtn.focus({ preventScroll: true });
      } else this.close("close");
      return;
    }
    if (this.mode === "steps" && !e.target.closest("input, textarea, .gd-pick")) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (!this.isLast()) this.forward();
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
        (el) => !el.hidden && el.offsetParent !== null && el.tabIndex >= 0 && !el.closest("[inert]"),
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

  // ─── the system picker ─────────────────────────────────────
  renderPick() {
    const def = this.tour;
    this.pick.hidden = !def.platforms;
    if (!def.platforms) return;
    const now = def.platforms.find((p) => p.id === def.platform) || def.platforms[0];
    this.pickBtn.firstElementChild.className = now.icon;
    this.pickBtn.querySelector("span").textContent = now.name;
    this.pickBtn.setAttribute("aria-label", `${t("platform")}: ${now.name}`);
    this.pickList.innerHTML = def.platforms
      .map(
        (p) =>
          `<li role="option" tabindex="-1" data-platform="${p.id}" aria-selected="${p.id === now.id}">` +
          `<i class="${p.icon}" aria-hidden="true"></i><span></span><i class="gd-pick-tick fa-solid fa-check" aria-hidden="true"></i></li>`,
      )
      .join("");
    this.pickList.querySelectorAll("li").forEach((li, i) => {
      li.querySelector("span").textContent = def.platforms[i].name;
    });
  }

  togglePick(open = !this.pick.classList.contains("is-open")) {
    this.pick.classList.toggle("is-open", open);
    this.pickBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      const sel = this.pickList.querySelector('[aria-selected="true"]');
      if (sel) sel.focus({ preventScroll: true });
    }
  }

  choose(platform) {
    this.togglePick(false);
    if (!this.tour || !this.tour.rebuild || platform === this.tour.platform) return;
    const at = this.steps[this.index] && this.steps[this.index].id;
    const def = this.tour.rebuild(platform);
    if (!def) return;
    // Stay on the same step where the new system has it, else the one in its place.
    const same = def.steps.findIndex((s) => s.id === at);
    this.start(def, null, same >= 0 ? same : Math.min(this.index, def.steps.length - 1));
    this.pickBtn.focus({ preventScroll: true });
  }

  // ─── steps ─────────────────────────────────────────────────
  start(def, from, index = -1) {
    this.mode = "steps";
    this.tour = def;
    this.steps = def.steps;
    this.completed = false;
    this.root.classList.remove("is-menu");
    // A walkthrough on a phone is framed in a taller stage, the same for every step.
    this.root.classList.toggle("is-tall", this.steps.some((s) => s.scene && s.scene.tall));
    this.nameEl.textContent = def.name;
    this.renderPick();
    this.dots.innerHTML = this.steps
      .map((s, i) => `<button type="button" class="gd-dot" data-step="${i}" aria-label="${i + 1} / ${this.steps.length}"></button>`)
      .join("");
    const at = index >= 0 ? index : from ? this.steps.findIndex((s) => s.id === from) : 0;
    this.go(at > 0 ? at : 0, 0, true);
    if (index < 0) setTimeout(() => this.next.focus({ preventScroll: true }), 60);
  }

  isLast() {
    return this.mode === "steps" && this.index >= this.steps.length - 1;
  }

  forward() {
    if (this.mode === "menu") return this.close("close");
    if (this.mode !== "steps") return;
    if (!this.isLast()) return this.go(this.index + 1, 1);
    // Follow / Let's Explore: placeholders for the guided run through the real
    // page; they do nothing yet.
    if (this.steps[this.index].final) return;
    this.finish();
  }

  finish() {
    this.completed = true;
    markTour(this.tour.id);
    this.close("done");
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
    this.labelNext(step, last);

    this.slide(step.title, step.body, dir);
    this.root.classList.toggle("no-stage", !step.scene);
    if (step.scene) this.scene.load(step.scene);
    else {
      this.scene.stop();
      if (this.opts.cursor) this.opts.cursor.vanish();
    }
  }

  /**
   * The last step of a walkthrough that ends in following: Follow for a reader
   * who does not follow yet, Done beside Let's Explore for one who does.
   */
  labelNext(step, last) {
    const icon = (name) => `<i class="fa-solid ${name}" aria-hidden="true"></i>`;
    const ux = (btn, on) => {
      if (on) {
        btn.setAttribute("data-ux", "guide");
        btn.setAttribute("data-ux-action", "finish");
        btn.setAttribute("data-ux-id", this.tour.id);
      } else btn.removeAttribute("data-ux");
    };
    const final = last && step.final;
    this.done.hidden = !(final && this.tour.following);
    ux(this.done, !this.done.hidden);
    if (!last) this.next.innerHTML = `${t("next")}${icon("fa-arrow-right")}`;
    else if (!final) this.next.innerHTML = `${t("done")}${icon("fa-check")}`;
    else if (this.tour.following) this.next.innerHTML = `${t("explore")}${icon("fa-compass")}`;
    else this.next.innerHTML = `<i class="fa-regular fa-bell" aria-hidden="true"></i>${t("follow")}`;
    // Only finishing a walkthrough is worth an analytics event; paging is not.
    ux(this.next, last && !final);
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

  // ─── the menu ──────────────────────────────────────────────
  showMenu() {
    this.mode = "menu";
    this.root.classList.add("is-menu", "no-stage");
    this.scene.stop();
    this.pick.hidden = true;
    this.nameEl.textContent = t("menu_title");
    this.count.textContent = "";
    this.dots.innerHTML = "";
    this.back.hidden = true;
    this.done.hidden = true;
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

  async menuClick(e) {
    if (this.mode !== "menu") return;
    const row = e.target.closest("[data-tour]");
    if (row) {
      const def = await this.def.build(row.dataset.tour);
      if (def && !this.closed) this.start(def, null);
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
    this.scene.stop();
    // The cursor leaves with the card; it only travels when it has somewhere to go.
    if (this.opts.cursor) {
      this.opts.cursor.vanish();
      if (this.opts.cursor.clip === this.scene.clipFn) this.opts.cursor.setClip(null);
    }
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
