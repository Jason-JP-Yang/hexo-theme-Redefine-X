/**
 * The toolbar: four ways of editing, one surface.
 *
 * A block editor has more than one thing you can be doing, and a single row of
 * icons that changes under you cannot say which. So the four are named, and the
 * toolbar is a tab strip over a row of controls:
 *
 *   FORMAT   what a SELECTION is — bold, a link, a highlight. Only ever about
 *            the words between the two ends of the range.
 *   BLOCK    what this block IS — text, a heading, a list, a note — plus that
 *            block's own settings: a note's colour, a table's alignment, which
 *            tab is open. This is where a component's options live, so that
 *            nothing has to be drawn on top of the article to reach them.
 *   INSERT   what goes in at the caret. Never a heading or a list: those are
 *            things this paragraph BECOMES, and offering them here would be two
 *            controls for one outcome.
 *   SOURCE   the block's markdown, every marker included.
 *
 * FORMAT takes over the moment there is a selection and hands back the moment
 * there is not, because that is what the selection means; the other three are
 * chosen and stay chosen. A control that needs more than one tap — a palette, a
 * heading level, an icon — opens the second row rather than a popover, so the
 * chrome stays in one place and the article is never covered.
 *
 * Nothing here is a text field. Anything that has to be typed is either edited
 * in place, where it will appear in the published post, or asked for in a
 * prompt the toolbar opens.
 */

import { escapeHTML } from "./markdown.js";
import { caretRect, selection } from "./caret.js";
import {
  HIGHLIGHTS,
  MARKS,
  applyMark,
  clearMarks,
  markState,
  restoreRange,
  saveRange,
} from "./inline.js";
import { conversions } from "./convert.js";
import { MORPH_MS, EASE, pop, reduced } from "./motion.js";

/**
 * What can be put IN, and every one of them arrives as a NEW BLOCK.
 *
 * Nothing inline lives here. A link, a highlight, an equation or a code span
 * are things a SELECTION becomes — they need words to act on, and offering them
 * where there is no selection is offering something that cannot happen. They
 * are in Format, which is where the selection is.
 *
 * The first group is the four shapes a block can also be CONVERTED to, kept
 * together because reaching for them here means "and a new one after this",
 * not "and make this one that".
 */
export const INSERTS = [
  { key: "paragraph", icon: "fa-paragraph", label: "Plain text" },
  { key: "code", icon: "fa-code", label: "Code block" },
  { key: "math", icon: "fa-square-root-variable", label: "Equation" },
  { key: "mermaid", icon: "fa-diagram-project", label: "Diagram" },
  { key: "-" },
  { key: "image", icon: "fa-image", label: "Image" },
  { key: "table", icon: "fa-table", label: "Table" },
  { key: "note", icon: "fa-circle-info", label: "Note" },
  { key: "notel", icon: "fa-rectangle-list", label: "Large note" },
  { key: "folding", icon: "fa-chevron-right", label: "Folding" },
  { key: "tabs", icon: "fa-folder-tree", label: "Tabs" },
  { key: "btn", icon: "fa-square-arrow-up-right", label: "Button" },
  { key: "hr", icon: "fa-minus", label: "Divider" },
];

/** The slash menu offers both halves, because at an empty line both apply. */
export const CATALOGUE = [
  ...conversions({ type: "paragraph", text: "" }).map((entry) => ({
    key: entry.key,
    icon: entry.icon,
    label: entry.label,
    kind: "convert",
    keywords: entry.label.toLowerCase() + " " + entry.key,
  })),
  ...INSERTS.filter((entry) => entry.key !== "-").map((entry) => ({
    key: entry.key,
    icon: entry.icon,
    label: entry.label,
    kind: "insert",
    keywords: entry.label.toLowerCase() + " " + entry.key,
  })),
];

/**
 * Two slots, not four.
 *
 * FORMAT does not sit beside BLOCK — it REPLACES it, because they are the same
 * question asked of different things: what is selected, or, when nothing is,
 * what this block is. A tab you can never usefully press is worse than no tab,
 * and Format with no selection was exactly that.
 *
 * SOURCE is not a tab either. Showing a block's markdown is a way of LOOKING at
 * the block, so it is a switch inside Block.
 */
const TAB_FORMAT = { key: "format", icon: "fa-highlighter", label: "Format" };
const TAB_BLOCK = { key: "block", icon: "fa-cube", label: "Block" };
const TAB_INSERT = { key: "insert", icon: "fa-plus", label: "Insert" };

/* ─── rendering the control vocabulary ─────────────────────────────────────── */

function control(item, t) {
  if (item.kind === "sep") return `<span class="ed-tool-sep"></span>`;
  if (item.kind === "label") return `<span class="ed-tool-label">${escapeHTML(t(item.tt || item.label, item.label))}</span>`;

  const label = escapeHTML(t(item.tt || item.label, item.label));
  const state = ` data-on="${item.on ? "1" : item.mixed ? "2" : "0"}"${item.disabled ? " disabled" : ""}`;
  const data =
    ` data-act="${escapeHTML(item.act || "")}"` +
    ` data-arg="${escapeHTML(item.arg == null ? "" : String(item.arg))}"`;

  if (item.kind === "swatch") {
    return `<button type="button" class="ed-swatch"${data}${state} title="${label}"><span class="ed-swatch-dot ${escapeHTML(item.cls || "")}"></span></button>`;
  }
  const text = item.wide ? `<span>${label}</span>` : "";
  return `<button type="button" class="ed-tool${item.wide ? " is-wide" : ""}"${data}${state} title="${label}">
    <i class="fa-solid ${escapeHTML(item.icon || "fa-circle")}" aria-hidden="true"></i>${text}</button>`;
}

/** Repaint only when the row actually differs: a selection change fires often. */
function paint(row, items, t) {
  const html = items.map((item) => control(item, t)).join("");
  if (row.__sig === html) return false;
  row.__sig = html;
  row.innerHTML = html;
  return true;
}

/* ─── the toolbar ──────────────────────────────────────────────────────────── */

export function createToolbar(ctx) {
  const t = ctx.t;

  const el = document.createElement("div");
  el.className = "ed-toolbar";
  el.dataset.tab = "block";
  el.innerHTML = `
    <div class="ed-toolbar-card">
      <div class="ed-toolbar-tabs" role="tablist"></div>
      <div class="ed-toolbar-row" data-row="main"></div>
      <div class="ed-toolbar-row ed-toolbar-sub" data-row="sub" hidden></div>
    </div>`;

  const tabs = el.querySelector(".ed-toolbar-tabs");
  const main = el.querySelector('[data-row="main"]');
  const sub = el.querySelector('[data-row="sub"]');
  const card = el.querySelector(".ed-toolbar-card");

  // The tab the author chose. FORMAT is never it: that one is decided by
  // whether there is a selection, and choosing it would mean choosing to have
  // selected something.
  let chosen = "block";
  let subKey = "";
  let state = null;

  /* ─── the four faces ─────────────────────────────────────────────────── */

  function formatItems() {
    const s = state || { active: new Set(), partial: new Set(), literal: "", collapsed: true };
    const locked = s.literal === "code" || s.literal === "literal";
    const dead = s.collapsed;

    // The highlighter opens the palette rather than toggling a colour of its
    // own: a button that highlights and a button that picks the colour are the
    // same button, and having both meant one of them was always the wrong one.
    const items = MARKS.filter((mark) => mark.key !== "link").map((mark) => ({
      kind: "btn",
      act: mark.colours ? "sub" : "mark",
      arg: mark.colours ? "highlight" : mark.key,
      icon: mark.icon,
      label: mark.label,
      tt: "m_" + mark.key,
      on: mark.colours ? subKey === "highlight" || s.active.has(mark.key) : s.active.has(mark.key),
      mixed: s.partial.has(mark.key),
      disabled: dead || (locked && mark.key !== "code"),
    }));

    items.push(
      { kind: "sep" },
      {
        kind: "btn",
        act: "mark",
        arg: "link",
        icon: "fa-link",
        label: "Link",
        tt: "m_link",
        on: s.active.has("link"),
        disabled: dead || locked,
      },
      {
        kind: "btn",
        act: "unlink",
        icon: "fa-link-slash",
        label: "Remove link",
        tt: "m_unlink",
        disabled: !s.active.has("link") && !s.partial.has("link"),
      },
      { kind: "sep" },
      { kind: "btn", act: "clear", icon: "fa-eraser", label: "Clear formatting", tt: "m_clear", disabled: dead }
    );
    return items;
  }

  function blockItems() {
    const view = ctx.view();
    // Read first: legality is decided from the block's CONTENT, and a block
    // that has been typed into since the last read still says it holds one
    // line — which is how a three-line paragraph stayed convertible to a
    // heading.
    if (view && view.read) view.read();
    const block = view && view.block;
    const rows = conversions(block).map((entry) => ({
      kind: "btn",
      act: "convert",
      arg: entry.key,
      icon: entry.icon,
      label: entry.label,
      tt: "b_" + entry.key,
      on: entry.on,
      disabled: entry.disabled,
    }));

    const own = view && view.options ? view.options(subKey) : [];
    const common = [
      { kind: "btn", act: "move", arg: "-1", icon: "fa-arrow-up", label: "Move up", tt: "move_up" },
      { kind: "btn", act: "move", arg: "1", icon: "fa-arrow-down", label: "Move down", tt: "move_down" },
      { kind: "btn", act: "duplicate", icon: "fa-clone", label: "Duplicate", tt: "duplicate" },
      { kind: "btn", act: "delete", icon: "fa-trash", label: "Remove", tt: "remove_block" },
    ];

    if (!view) return common;

    // Looking at the markdown is a way of looking at THIS block, so it is a
    // switch here rather than a tab of its own.
    const raw = !!(view.sourceOn && view.sourceOn());
    const source = {
      kind: "btn",
      act: "source",
      arg: raw ? "off" : "on",
      icon: raw ? "fa-eye" : "fa-file-code",
      label: raw ? "Back to the rendered block" : "Show this block's markdown",
      tt: raw ? "src_off" : "src_on",
      on: raw,
    };
    if (raw) return [source, { kind: "sep" }, ...common];

    const head = [...rows, ...(own.length ? [{ kind: "sep" }, ...own] : [])];
    return [...head, { kind: "sep" }, source, ...common];
  }

  function insertItems() {
    return INSERTS.map((entry) =>
      entry.key === "-"
        ? { kind: "sep" }
        : {
            kind: "btn",
            act: "insert",
            arg: entry.key,
            icon: entry.icon,
            label: entry.label,
            tt: "b_" + entry.key,
            wide: true,
          }
    );
  }

  /* ─── the second row ─────────────────────────────────────────────────── */

  function subItems() {
    if (subKey === "highlight") {
      const now = state ? state.colour : "";
      return [
        { kind: "label", label: "Highlight", tt: "m_colour" },
        ...HIGHLIGHTS.map((colour) => ({
          kind: "swatch",
          act: "highlight",
          arg: colour,
          cls: "post-box post-box-" + colour,
          label: colour,
          on: now === colour,
        })),
        { kind: "sep" },
        { kind: "btn", act: "mark", arg: "box", icon: "fa-ban", label: "No highlight", tt: "m_nohl" },
      ];
    }

    const view = ctx.view();
    if (view && view.subOptions) return view.subOptions(subKey) || [];
    return [];
  }

  function openSub(key) {
    subKey = subKey === key ? "" : key;
    render();
  }

  /* ─── painting ───────────────────────────────────────────────────────── */

  function itemsFor(tab) {
    if (tab === "format") return formatItems();
    if (tab === "insert") return insertItems();
    return blockItems();
  }

  let morph = 0;

  /** Slot one is Format while there is a selection and Block when there is not. */
  function paintTabs(tab) {
    const strip = [tab === "format" ? TAB_FORMAT : TAB_BLOCK, TAB_INSERT];
    const html = strip
      .map(
        (item) =>
          `<button type="button" class="ed-tab" data-tab="${item.key}" role="tab" data-on="${item.key === tab ? "1" : "0"}">
             <i class="fa-solid ${item.icon}" aria-hidden="true"></i><span>${escapeHTML(t("tab_" + item.key, item.label))}</span>
           </button>`
      )
      .join("");
    if (tabs.__sig !== html) {
      tabs.__sig = html;
      tabs.innerHTML = html;
    }
  }

  async function render(animate) {
    const tab = el.dataset.tab;
    paintTabs(tab);

    const before = animate ? card.offsetHeight : 0;
    const moved = paint(main, itemsFor(tab), t);

    const rows = subKey ? subItems() : [];
    const wasHidden = sub.hidden;
    sub.hidden = !rows.length;
    if (rows.length) paint(sub, rows, t);
    else sub.__sig = "";

    if (!animate || reduced() || (!moved && wasHidden === sub.hidden)) return;

    const token = ++morph;
    const after = card.offsetHeight;
    if (before === after || token !== morph) return;
    card.animate([{ height: before + "px" }, { height: after + "px" }], {
      duration: MORPH_MS,
      easing: EASE,
    });
  }

  /* ─── what the editor calls ──────────────────────────────────────────── */

  /**
   * Recompute from the live selection. FORMAT is claimed whenever there is one
   * and released the moment there is not, so the tab strip always says what the
   * next click will act on.
   */
  function sync() {
    const root = ctx.richRoot();
    state = root ? markState(root) : null;

    // Nothing focused means nothing to act on, so the toolbar goes back to how
    // it opened rather than sitting on the last block's settings.
    if (!ctx.view()) {
      chosen = "block";
      subKey = "";
    }

    const selecting = !!(state && !state.collapsed);
    const want = chosen === "insert" ? "insert" : selecting ? "format" : "block";
    if (el.dataset.tab !== want) {
      el.dataset.tab = want;
      if (want !== "format" && subKey === "highlight") subKey = "";
    }
    if (!selecting && subKey === "highlight") subKey = "";
    render(true);
  }

  /** Back to the opening state — called when the canvas loses the caret. */
  function reset() {
    chosen = "block";
    subKey = "";
    state = null;
    el.dataset.tab = "block";
    render(true);
  }

  el.addEventListener("mousedown", (e) => e.preventDefault());

  tabs.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (!tab) return;
    e.preventDefault();
    chosen = tab.dataset.tab === "insert" ? "insert" : "block";
    el.dataset.tab = tab.dataset.tab;
    subKey = "";
    render(true);
  });

  card.addEventListener("click", async (e) => {
    const button = e.target.closest("[data-act]");
    if (!button || button.disabled) return;
    e.preventDefault();

    const act = button.dataset.act;
    const arg = button.dataset.arg;
    const root = ctx.richRoot();

    if (act === "sub") return void openSub(arg);

    if (act === "mark") {
      if (!root) return;
      const spec = MARKS.find((m) => m.key === arg);
      if (spec && spec.asks === "url") {
        // The prompt takes the focus, and the focus is what holds the
        // selection. Without this the address was typed and applied to nothing.
        const held = saveRange();
        const url = await ctx.ask("url", (state && state.href) || "https://");
        if (url == null) return;
        if (!restoreRange(held)) return;
        applyMark(root, "link", { href: url });
      } else {
        applyMark(root, arg, {});
      }
      ctx.onMarked();
      return void sync();
    }

    if (act === "highlight") {
      if (!root) return;
      applyMark(root, "box", { colour: arg });
      ctx.onMarked();
      return void sync();
    }

    if (act === "unlink") {
      if (!root) return;
      if (state && (state.active.has("link") || state.partial.has("link"))) applyMark(root, "link", {});
      ctx.onMarked();
      return void sync();
    }

    if (act === "clear") {
      if (!root) return;
      clearMarks(root);
      ctx.onMarked();
      return void sync();
    }

    if (act === "convert") return void ctx.onConvert(arg);
    if (act === "insert") {
      // One insert, then back to the block it landed in — staying on Insert
      // means the next thing pressed adds a second one by accident.
      ctx.onInsert(arg);
      chosen = "block";
      el.dataset.tab = "block";
      return void render(true);
    }
    if (act === "source") return void ctx.onSource(arg === "on");

    // Everything else belongs to the focused block, which owns its own options.
    ctx.onAct(act, arg);
    render(true);
  });

  render(false);

  return {
    el,
    sync,
    reset,
    /** Re-read the focused block's own options without touching the tab. */
    refresh: () => render(true),
    openSub,
    /** Ctrl-K, through the same held-range path the button uses. */
    link: async () => {
      const root = ctx.richRoot();
      if (!root) return;
      const held = saveRange();
      const url = await ctx.ask("url", (state && state.href) || "https://");
      if (url == null) return;
      if (!restoreRange(held)) return;
      applyMark(root, "link", { href: url });
      ctx.onMarked();
      sync();
    },
    applyMark: (key, opts) => {
      const root = ctx.richRoot();
      if (!root) return;
      applyMark(root, key, opts || {});
      ctx.onMarked();
      sync();
    },
  };
}

/* ─── slash menu ───────────────────────────────────────────────────────────── */

export function createSlashMenu(ctx) {
  const el = document.createElement("div");
  el.className = "ed-slash";
  el.hidden = true;
  document.body.appendChild(el);

  let items = [];
  let index = 0;
  let query = "";
  let host = null;

  function repaint() {
    const q = query.toLowerCase();
    items = CATALOGUE.filter((item) => !q || item.keywords.includes(q));
    if (index >= items.length) index = Math.max(0, items.length - 1);

    el.innerHTML = items.length
      ? items
          .map(
            (item, i) =>
              `<button type="button" class="ed-slash-row" data-key="${item.key}" data-kind="${item.kind}" data-on="${i === index ? "1" : "0"}">
                 <i class="fa-solid ${item.icon}" aria-hidden="true"></i>
                 <span>${escapeHTML(ctx.t("b_" + item.key, item.label))}</span>
               </button>`
          )
          .join("")
      : `<div class="ed-slash-empty">${escapeHTML(ctx.t("no_match", "Nothing matches"))}</div>`;
  }

  function place() {
    const rect = caretRect();
    if (!rect) return;
    const height = el.offsetHeight;
    const below = window.innerHeight - rect.bottom;
    el.style.top = (below < height + 24 ? rect.top - height - 8 : rect.bottom + 8) + window.scrollY + "px";
    el.style.left = Math.min(rect.left, window.innerWidth - el.offsetWidth - 16) + window.scrollX + "px";
  }

  function open(view) {
    host = view;
    query = "";
    index = 0;
    el.hidden = false;
    repaint();
    place();
    pop(el);
  }

  function close() {
    el.hidden = true;
    host = null;
  }

  function key(e) {
    if (el.hidden) return false;

    if (e.key === "Escape") {
      close();
      return true;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      index = Math.max(0, Math.min(items.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)));
      repaint();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (!items[index]) return false;
      e.preventDefault();
      const chosen = items[index];
      close();
      ctx.onPick(chosen, host);
      return true;
    }
    if (e.key === "Backspace" && !query) {
      close();
      return false;
    }
    if (e.key === "Backspace") {
      query = query.slice(0, -1);
      repaint();
      return false;
    }
    if (e.key.length === 1) {
      query += e.key;
      repaint();
      place();
      return false;
    }
    return false;
  }

  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("click", (e) => {
    const row = e.target.closest("[data-key]");
    if (!row) return;
    const chosen = CATALOGUE.find((item) => item.key === row.dataset.key && item.kind === row.dataset.kind);
    const target = host;
    close();
    if (chosen) ctx.onPick(chosen, target);
  });

  return { el, open, close, key, get open$() { return !el.hidden; } };
}

/* ─── the one thing that has to be typed ───────────────────────────────────── */

/**
 * A short prompt, anchored to the toolbar.
 *
 * The toolbar itself holds no fields — a row of controls that sometimes grows a
 * text box is a row whose height and tab order change under the author — so the
 * two values that genuinely have to be typed, a URL and a language, are asked
 * for here and the toolbar goes back to being buttons.
 */
export function askFor(anchor, ctx, kind, current) {
  document.querySelectorAll(".ed-ask").forEach((node) => node.remove());

  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "ed-ask";
    box.innerHTML = `
      <label class="ed-ask-label">${escapeHTML(ctx.t("ask_" + kind, kind === "url" ? "Address" : "Language"))}</label>
      <input class="ed-ask-input" spellcheck="false" value="${escapeHTML(current || "")}">
      <button type="button" class="ed-ask-ok" title="${escapeHTML(ctx.t("apply", "Apply"))}"><i class="fa-solid fa-check"></i></button>`;

    const rect = anchor.getBoundingClientRect();
    document.body.appendChild(box);
    box.style.top = rect.bottom + 8 + window.scrollY + "px";
    box.style.left =
      Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 12)) + window.scrollX + "px";
    pop(box);

    const input = box.querySelector("input");
    input.focus();
    input.select();

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      box.remove();
      document.removeEventListener("pointerdown", away, true);
      resolve(value);
    };
    const away = (e) => {
      if (!box.contains(e.target)) finish(null);
    };

    box.querySelector(".ed-ask-ok").addEventListener("click", () => finish(input.value.trim()));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value.trim());
      }
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    });
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
  });
}
