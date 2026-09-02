/**
 * The floating toolbar and the slash menu — two faces of one catalogue.
 *
 * The toolbar is contextual and morphs between them rather than swapping: with
 * a selection it shows the inline marks, without one it shows what can be
 * inserted. The pill's width animates and its contents cross-fade, so the
 * change reads as the same control turning over rather than two controls
 * trading places.
 *
 * It is one of the three surfaces in the editor that genuinely float over live
 * content, so it is one of the three that earns a backdrop-filter.
 */

import { escapeHTML } from "./markdown.js";
import { caretRect, toggleWrap, selection } from "./caret.js";
import { FADE_MS, MORPH_MS, EASE, pop, reduced } from "./motion.js";

/** Everything that can be inserted, in the order the menu offers it. */
export const CATALOGUE = [
  { key: "paragraph", icon: "fa-paragraph", label: "Text", keywords: "text paragraph p" },
  { key: "heading2", icon: "fa-heading", label: "Heading 2", keywords: "heading h2 title", type: "heading", fields: { level: 2 } },
  { key: "heading3", icon: "fa-heading", label: "Heading 3", keywords: "heading h3 subtitle", type: "heading", fields: { level: 3 } },
  { key: "list", icon: "fa-list-ul", label: "Bullet list", keywords: "list bullet ul" },
  { key: "olist", icon: "fa-list-ol", label: "Numbered list", keywords: "list numbered ol ordered", type: "list", fields: { ordered: true, marker: "." } },
  { key: "quote", icon: "fa-quote-left", label: "Quote", keywords: "quote blockquote" },
  { key: "code", icon: "fa-code", label: "Code", keywords: "code snippet pre" },
  { key: "table", icon: "fa-table", label: "Table", keywords: "table grid" },
  { key: "image", icon: "fa-image", label: "Image", keywords: "image picture photo figure" },
  { key: "math", icon: "fa-square-root-variable", label: "Equation", keywords: "math equation latex tex mathjax" },
  { key: "mermaid", icon: "fa-diagram-project", label: "Diagram", keywords: "mermaid diagram flowchart graph" },
  { key: "note", icon: "fa-circle-info", label: "Note", keywords: "note callout admonition info", type: "component", fields: { name: "note", args: "info", body: "" } },
  { key: "notel", icon: "fa-rectangle-list", label: "Large note", keywords: "note large title callout", type: "component", fields: { name: "notel", args: "info fa-circle-info Title", body: "" } },
  { key: "box", icon: "fa-highlighter", label: "Highlight box", keywords: "box highlight inline", type: "component", fields: { name: "box", args: "blue", body: "" } },
  { key: "folding", icon: "fa-chevron-right", label: "Folding", keywords: "folding details collapse accordion", type: "component", fields: { name: "folding", args: "blue::Details", body: "" } },
  { key: "tabs", icon: "fa-folder-tree", label: "Tabs", keywords: "tabs tabbed", type: "component", fields: { name: "tabs", args: "GROUP", body: "<!-- tab One -->\n\n<!-- endtab -->" } },
  { key: "btn", icon: "fa-link", label: "Button", keywords: "button btn link cta", type: "component", fields: { name: "btn", args: "primary::Label::https://", body: null } },
  { key: "hr", icon: "fa-minus", label: "Divider", keywords: "divider rule hr separator" },
];

const MARKS = [
  { key: "strong", icon: "fa-bold", tag: "strong", shortcut: "b" },
  { key: "em", icon: "fa-italic", tag: "em", shortcut: "i" },
  { key: "strike", icon: "fa-strikethrough", tag: "del" },
  { key: "code", icon: "fa-code", tag: "code" },
  { key: "mark", icon: "fa-highlighter", tag: "mark" },
  { key: "link", icon: "fa-link", tag: "a", prompt: true },
];

export function createToolbar(ctx) {
  const el = document.createElement("div");
  el.className = "ed-toolbar";
  el.dataset.mode = "blocks";
  el.innerHTML = `
    <div class="ed-toolbar-inner">
      <div class="ed-toolbar-face" data-face="blocks"></div>
      <div class="ed-toolbar-face" data-face="marks" hidden></div>
    </div>`;

  const blocks = el.querySelector('[data-face="blocks"]');
  const marks = el.querySelector('[data-face="marks"]');

  blocks.innerHTML =
    CATALOGUE.slice(0, 12)
      .map(
        (item) =>
          `<button type="button" class="ed-tool" data-insert="${item.key}" title="${escapeHTML(ctx.t("b_" + item.key, item.label))}"><i class="fa-solid ${item.icon}" aria-hidden="true"></i></button>`
      )
      .join("") +
    `<span class="ed-tool-sep"></span>
     <button type="button" class="ed-tool ed-tool-more" title="${escapeHTML(ctx.t("more", "More"))}"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></button>`;

  marks.innerHTML =
    MARKS.map(
      (mark) =>
        `<button type="button" class="ed-tool" data-mark="${mark.key}" title="${escapeHTML(ctx.t("m_" + mark.key, mark.key))}"><i class="fa-solid ${mark.icon}" aria-hidden="true"></i></button>`
    ).join("") +
    `<span class="ed-tool-sep"></span>
     <button type="button" class="ed-tool" data-mark="clear" title="${escapeHTML(ctx.t("m_clear", "Clear formatting"))}"><i class="fa-solid fa-eraser" aria-hidden="true"></i></button>`;

  /**
   * Morph between the two faces: width animates, contents cross-fade.
   *
   * Nothing here is allowed to leave a filled animation behind. A `forwards`
   * fill on the outgoing face persists `opacity: 0` on an element this function
   * will show again later, and the fade-in that follows does not outrank it —
   * the pill comes back empty and stays empty. Every animation is cancelled
   * before the next one starts, and `mode` is claimed synchronously so two
   * selection changes in one frame cannot interleave halfway through.
   */
  let morph = 0;

  async function setMode(mode) {
    if (el.dataset.mode === mode) return;
    el.dataset.mode = mode;

    const token = ++morph;
    const inner = el.querySelector(".ed-toolbar-inner");
    const from = inner.offsetWidth;

    const show = mode === "marks" ? marks : blocks;
    const hide = mode === "marks" ? blocks : marks;

    for (const face of [blocks, marks]) face.getAnimations().forEach((a) => a.cancel());
    inner.getAnimations().forEach((a) => a.cancel());

    const swap = () => {
      hide.hidden = true;
      hide.style.opacity = "";
      show.hidden = false;
      show.style.opacity = "";
    };

    if (reduced()) return void swap();

    await hide.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS }).finished.catch(() => {});
    if (token !== morph) return;

    swap();
    const to = inner.offsetWidth;

    inner.animate([{ width: from + "px" }, { width: to + "px" }], { duration: MORPH_MS, easing: EASE });
    show.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS });
  }

  el.addEventListener("mousedown", (e) => e.preventDefault());

  el.addEventListener("click", (e) => {
    const insert = e.target.closest("[data-insert]");
    if (insert) {
      e.preventDefault();
      return void ctx.onInsert(insert.dataset.insert);
    }

    const more = e.target.closest(".ed-tool-more");
    if (more) {
      e.preventDefault();
      return void ctx.onMore(more);
    }

    const mark = e.target.closest("[data-mark]");
    if (!mark) return;
    e.preventDefault();
    applyMark(mark.dataset.mark, ctx);
  });

  /** Selection decides the face. Called from the editor's selectionchange. */
  function sync() {
    const sel = selection();
    const live = sel && !sel.isCollapsed && ctx.ownsSelection(sel);
    setMode(live ? "marks" : "blocks");
    if (live) {
      for (const button of marks.querySelectorAll("[data-mark]")) {
        const spec = MARKS.find((m) => m.key === button.dataset.mark);
        button.dataset.on = spec && isInside(sel, spec.tag) ? "1" : "0";
      }
    }
  }

  return { el, sync, setMode, applyMark: (key) => applyMark(key, ctx) };
}

/** A selection anchors on a TEXT node far more often than on an element, so the
 *  walk has to start at its parent or it never takes a single step. */
function isInside(sel, tag) {
  let node = sel.anchorNode;
  if (node && node.nodeType === 3) node = node.parentNode;

  const name = tag.toUpperCase();
  while (node && node.nodeType === 1) {
    if (node.tagName === name) return true;
    if (node.classList.contains("ed-rich")) return false;
    node = node.parentNode;
  }
  return false;
}

function applyMark(key, ctx) {
  if (key === "clear") {
    document.execCommand("removeFormat");
    return void ctx.onMarked();
  }

  const spec = MARKS.find((m) => m.key === key);
  if (!spec) return;

  if (spec.prompt) {
    const url = window.prompt(ctx.t("link_url", "Link URL"), "https://");
    if (!url) return;
    toggleWrap("a", { href: url, "data-md": "link" });
    return void ctx.onMarked();
  }

  toggleWrap(spec.tag, { "data-md": key });
  ctx.onMarked();
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

  function paint() {
    const q = query.toLowerCase();
    items = CATALOGUE.filter(
      (item) => !q || item.keywords.includes(q) || item.label.toLowerCase().includes(q)
    );
    if (index >= items.length) index = Math.max(0, items.length - 1);

    el.innerHTML = items.length
      ? items
          .map(
            (item, i) =>
              `<button type="button" class="ed-slash-row" data-key="${item.key}" data-on="${i === index ? "1" : "0"}">
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
    const top = rect.bottom + window.scrollY + 8;
    const height = el.offsetHeight;
    const below = window.innerHeight - rect.bottom;
    el.style.top = (below < height + 24 ? rect.top + window.scrollY - height - 8 : top) + "px";
    el.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - el.offsetWidth - 16) + "px";
  }

  function open(view) {
    host = view;
    query = "";
    index = 0;
    el.hidden = false;
    paint();
    place();
    pop(el);
  }

  function close() {
    el.hidden = true;
    host = null;
  }

  /** Returns true when the key belonged to the menu. */
  function key(e) {
    if (el.hidden) return false;

    if (e.key === "Escape") {
      close();
      return true;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      index = Math.max(0, Math.min(items.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)));
      paint();
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
      paint();
      return false;
    }
    if (e.key.length === 1) {
      query += e.key;
      paint();
      place();
      return false;
    }
    return false;
  }

  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("click", (e) => {
    const row = e.target.closest("[data-key]");
    if (!row) return;
    const chosen = CATALOGUE.find((item) => item.key === row.dataset.key);
    const target = host;
    close();
    if (chosen) ctx.onPick(chosen, target);
  });

  return { el, open, close, key, get open$() { return !el.hidden; } };
}

/** The overflow menu behind the toolbar's ellipsis. */
export function openMoreMenu(anchor, ctx) {
  const existing = document.querySelector(".ed-more-menu");
  if (existing) return void existing.remove();

  const menu = document.createElement("div");
  menu.className = "ed-more-menu";
  menu.innerHTML = CATALOGUE.slice(12)
    .map(
      (item) =>
        `<button type="button" data-key="${item.key}"><i class="fa-solid ${item.icon}" aria-hidden="true"></i><span>${escapeHTML(ctx.t("b_" + item.key, item.label))}</span></button>`
    )
    .join("");

  const rect = anchor.getBoundingClientRect();
  menu.style.top = rect.bottom + window.scrollY + 8 + "px";
  menu.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 240) + "px";
  document.body.appendChild(menu);
  pop(menu);

  menu.addEventListener("mousedown", (e) => e.preventDefault());
  menu.addEventListener("click", (e) => {
    const row = e.target.closest("[data-key]");
    if (!row) return;
    menu.remove();
    ctx.onInsert(row.dataset.key);
  });

  const close = (e) => {
    if (menu.contains(e.target) || anchor.contains(e.target)) return;
    menu.remove();
    document.removeEventListener("pointerdown", close, true);
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}
