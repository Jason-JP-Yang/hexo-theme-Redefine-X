/**
 * One view per block, and the keyboard that moves between them.
 *
 * ── Why a block is never marked dirty by reading it ─────────────────────────
 *
 * A block re-emits itself from its fields only once it is `dirty`, and that
 * flag is set by an actual input event — never by `read()`. Deriving it from
 * "did the serialised form change" would be subtly wrong in both directions:
 * `inlineToHTML` followed by `htmlToInline` is not quite the identity on
 * unusual escaping, so an untouched paragraph could rewrite itself, and a real
 * edit that happens to normalise back to the same string would be silently
 * dropped. Touch is a fact about the session, so it is recorded as one.
 *
 * ── Two shapes of block ─────────────────────────────────────────────────────
 *
 *   RICH      paragraph, heading, quote, list, and every component body:
 *             rendered markup in a contenteditable, read back through
 *             htmlToInline / richToMarkdown.
 *   SOURCE    code, mermaid, math, raw: a mono field on focus, the rendered
 *             result on blur. This is the "click in to edit, leave to render"
 *             behaviour, and in a block model it is not a feature bolted on —
 *             it is just which of the two layers is showing.
 */

import { escapeHTML, htmlToInline, inlineToHTML, nextId } from "./markdown.js";
import { renderBlock, renderMermaid, typesetMath } from "./render.js";
import { richToMarkdown, sanitizePaste } from "./rich.js";
import * as caret from "./caret.js";
import { crossFade, morphHeight, pop } from "./motion.js";

const RICH_TYPES = new Set(["paragraph", "heading", "quote", "list"]);
const SOURCE_TYPES = new Set(["code", "mermaid", "math", "raw"]);

const BLOCK_ICONS = {
  paragraph: "fa-paragraph",
  heading: "fa-heading",
  quote: "fa-quote-left",
  list: "fa-list",
  code: "fa-code",
  mermaid: "fa-diagram-project",
  math: "fa-square-root-variable",
  image: "fa-image",
  table: "fa-table",
  hr: "fa-minus",
  component: "fa-cube",
  raw: "fa-file-code",
};

/* ─── shell ────────────────────────────────────────────────────────────────── */

export function createView(block, ctx) {
  const el = document.createElement("section");
  el.className = "ed-block";
  el.dataset.type = block.type;
  el.dataset.id = block.id;

  el.innerHTML = `
    <div class="ed-gutter" contenteditable="false">
      <button type="button" class="ed-gutter-btn ed-add" title="${escapeHTML(ctx.t("insert", "Insert block"))}" tabindex="-1">
        <i class="fa-solid fa-plus" aria-hidden="true"></i>
      </button>
      <button type="button" class="ed-gutter-btn ed-handle" title="${escapeHTML(ctx.t("drag", "Drag to reorder"))}" draggable="true" tabindex="-1">
        <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
      </button>
    </div>
    <div class="ed-body"></div>`;

  const body = el.querySelector(".ed-body");
  const view = { el, body, block, ctx, touched: false };

  view.touch = () => {
    view.touched = true;
    block.dirty = true;
    ctx.onChange();
  };

  if (RICH_TYPES.has(block.type)) mountRich(view);
  else if (SOURCE_TYPES.has(block.type)) mountSource(view);
  else if (block.type === "image") mountImage(view);
  else if (block.type === "table") mountTable(view);
  else if (block.type === "component") mountComponent(view);
  else mountRule(view);

  el.querySelector(".ed-add").addEventListener("click", (e) => {
    e.preventDefault();
    ctx.onInsertAfter(block.id);
  });

  wireDrag(view);
  return view;
}

function wireDrag(view) {
  const handle = view.el.querySelector(".ed-handle");
  handle.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", view.block.id);
    // The ghost is the whole block, not the 26px button the pointer happened to
    // be on. Taken before `is-dragging` lands, so the ghost is the opaque block
    // and the one left behind is the faded one.
    const box = view.el.getBoundingClientRect();
    if (e.dataTransfer.setDragImage) {
      e.dataTransfer.setDragImage(view.el, e.clientX - box.left, e.clientY - box.top);
    }
    view.el.classList.add("is-dragging");
    view.ctx.onDragStart(view.block.id);
  });
  handle.addEventListener("dragend", () => {
    view.el.classList.remove("is-dragging");
    view.ctx.onDragEnd();
  });
}

/* ─── rich blocks ──────────────────────────────────────────────────────────── */

function richTag(block) {
  if (block.type === "heading") return "h" + block.level;
  if (block.type === "quote") return "blockquote";
  if (block.type === "list") return block.ordered ? "ol" : "ul";
  return "p";
}

function richHTML(block) {
  if (block.type === "list") {
    return block.items.map((item) => `<li>${inlineToHTML(item.text)}</li>`).join("");
  }
  if (block.type === "quote") {
    return block.text
      .split(/\n{2,}/)
      .map((part) => `<p>${inlineToHTML(part)}</p>`)
      .join("");
  }
  return inlineToHTML(block.text);
}

function mountRich(view) {
  const { block } = view;
  const host = document.createElement(richTag(block));
  host.className = "ed-rich";
  host.contentEditable = "true";
  host.spellcheck = true;
  host.dataset.placeholder = view.ctx.t("placeholder", "Write, or press / for a block");
  host.innerHTML = richHTML(block);

  view.body.appendChild(host);
  view.editable = host;

  host.addEventListener("input", () => {
    view.touch();
    autoFormat(view);
  });
  host.addEventListener("paste", (e) => onPaste(view, e));
  host.addEventListener("keydown", (e) => richKeydown(view, e));
  host.addEventListener("focus", () => view.ctx.onFocus(view));

  view.read = () => {
    if (!view.touched) return;
    if (block.type === "list") {
      block.items = Array.from(host.children)
        .filter((li) => li.tagName === "LI")
        .map((li) => ({ indent: 0, text: htmlToInline(li) }));
      if (!block.items.length) block.items = [{ indent: 0, text: "" }];
    } else if (block.type === "quote") {
      block.text = richToMarkdown(host);
    } else {
      block.text = htmlToInline(host);
    }
  };

  view.focus = (where) => (where === "start" ? caret.focusStart(host) : caret.focusEnd(host));
  view.isEmpty = () => !host.textContent.trim();
}

/**
 * The markdown you type turns into the thing you meant, at the moment the
 * shorthand becomes unambiguous — a space after `## `, the closing `**`.
 */
function autoFormat(view) {
  const host = view.editable;
  const text = host.textContent;

  if (view.block.type === "paragraph") {
    const lead = text.match(/^(#{1,6}|>|-|\*|\d+\.|```)\s$/);
    if (lead) {
      const token = lead[1];
      host.textContent = "";
      if (token === ">") return void view.ctx.onConvert(view.block.id, "quote", {});
      if (token === "```") return void view.ctx.onConvert(view.block.id, "code", { lang: "", code: "" });
      if (token === "-" || token === "*") {
        return void view.ctx.onConvert(view.block.id, "list", {
          ordered: false, marker: token, items: [{ indent: 0, text: "" }],
        });
      }
      if (/^\d+\.$/.test(token)) {
        return void view.ctx.onConvert(view.block.id, "list", {
          ordered: true, marker: ".", items: [{ indent: 0, text: "" }],
        });
      }
      return void view.ctx.onConvert(view.block.id, "heading", { level: token.length, text: "" });
    }
  }

  inlineAutoFormat(host);
}

const INLINE_PAIRS = [
  { close: "**", tag: "strong" },
  { close: "~~", tag: "del" },
  { close: "`", tag: "code" },
  { close: "*", tag: "em" },
];

/** `**bold**` becomes bold the instant its closing delimiter lands. */
function inlineAutoFormat(host) {
  const sel = caret.selection();
  if (!sel || !sel.isCollapsed) return;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== 3) return;

  const before = node.nodeValue.slice(0, sel.anchorOffset);

  for (const pair of INLINE_PAIRS) {
    if (!before.endsWith(pair.close)) continue;
    const head = before.slice(0, -pair.close.length);
    const open = head.lastIndexOf(pair.close);
    if (open < 0) continue;

    const inner = head.slice(open + pair.close.length);
    if (!inner || /^\s|\s$/.test(inner)) continue;
    // `*` must not fire inside a `**` that is still being typed.
    if (pair.close === "*" && (head.endsWith("*") || inner.includes("*"))) continue;

    const wrapper = document.createElement(pair.tag);
    wrapper.setAttribute("data-md", pair.tag === "strong" ? "strong" : pair.tag === "del" ? "strike" : pair.tag);
    wrapper.textContent = inner;

    const total = pair.close.length * 2 + inner.length;
    caret.replaceBefore(host, total, wrapper);

    // A trailing zero-width text node is what lets the caret sit OUTSIDE the
    // new element; without it the next keystroke lands back inside it.
    const tail = document.createTextNode("​");
    wrapper.parentNode.insertBefore(tail, wrapper.nextSibling);
    const range = document.createRange();
    range.setStart(tail, 1);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }
}

function richKeydown(view, e) {
  const { block, ctx } = view;
  const host = view.editable;

  if (e.key === "Enter" && !e.shiftKey) {
    if (block.type === "list") return; // the browser makes the next <li>
    e.preventDefault();
    view.read();
    const tail = caret.splitAtCaret(host);
    view.touch();
    ctx.onSplit(block.id, htmlToInline(fragmentOf(tail)));
    return;
  }

  if (e.key === "Backspace" && caret.atStart(host) && caret.isCollapsed()) {
    if (block.type !== "paragraph") {
      e.preventDefault();
      view.read();
      view.touch();
      return void ctx.onConvert(block.id, "paragraph", { text: plainOf(view) });
    }
    if (view.isEmpty()) {
      e.preventDefault();
      return void ctx.onDelete(block.id, "prev");
    }
    e.preventDefault();
    view.read();
    return void ctx.onMergeBack(block.id);
  }

  if (e.key === "Delete" && caret.atEnd(host) && caret.isCollapsed() && view.isEmpty()) {
    e.preventDefault();
    return void ctx.onDelete(block.id, "next");
  }

  if (e.key === "ArrowUp" && caret.atStart(host)) {
    e.preventDefault();
    return void ctx.onFocusSibling(block.id, -1);
  }
  if (e.key === "ArrowDown" && caret.atEnd(host)) {
    e.preventDefault();
    return void ctx.onFocusSibling(block.id, 1);
  }

  if (e.key === "/" && view.isEmpty()) {
    // Let the slash land first, so the menu can filter on what follows it.
    setTimeout(() => ctx.onSlash(view), 0);
  }

  if (e.key === "Tab" && block.type === "list") {
    e.preventDefault();
    document.execCommand(e.shiftKey ? "outdent" : "indent");
    view.touch();
  }
}

function fragmentOf(html) {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return holder;
}

function plainOf(view) {
  if (view.block.type === "list") return view.block.items.map((i) => i.text).join("\n");
  return view.block.text || "";
}

function onPaste(view, e) {
  const data = e.clipboardData;
  if (!data) return;
  e.preventDefault();

  const html = data.getData("text/html");
  const text = data.getData("text/plain");

  if (html) {
    document.execCommand("insertHTML", false, sanitizePaste(html));
  } else if (text) {
    // Multi-line plain text is a document, not a run of characters: hand it to
    // the parser so it arrives as blocks rather than as one long paragraph.
    if (/\n/.test(text.trim())) view.ctx.onPasteMarkdown(view.block.id, text);
    else document.execCommand("insertText", false, text);
  }
  view.touch();
}

/* ─── source blocks ────────────────────────────────────────────────────────── */

const SOURCE_FIELD = { code: "code", mermaid: "code", math: "tex", raw: "text" };

function mountSource(view) {
  const { block, ctx } = view;
  const field = SOURCE_FIELD[block.type];

  const wrap = document.createElement("div");
  wrap.className = "ed-source-block";
  wrap.innerHTML = `
    <div class="ed-source-bar" contenteditable="false">
      <span class="ed-chip"><i class="fa-solid ${BLOCK_ICONS[block.type]}" aria-hidden="true"></i>${escapeHTML(ctx.t("t_" + block.type, block.type))}</span>
      ${block.type === "code" ? `<input class="ed-lang" spellcheck="false" placeholder="${escapeHTML(ctx.t("language", "language"))}" value="${escapeHTML(block.lang || "")}">` : ""}
      <button type="button" class="ed-source-toggle" title="${escapeHTML(ctx.t("toggle_source", "Show source"))}">
        <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
      </button>
    </div>
    <div class="ed-preview"></div>
    <textarea class="ed-source" spellcheck="false"></textarea>`;

  const preview = wrap.querySelector(".ed-preview");
  const source = wrap.querySelector(".ed-source");
  const lang = wrap.querySelector(".ed-lang");

  source.value = block[field] || "";
  view.body.appendChild(wrap);
  view.editable = source;

  const grow = () => {
    source.style.height = "auto";
    source.style.height = source.scrollHeight + "px";
  };

  const paint = async () => {
    if (block.type === "mermaid") await renderMermaid(preview, block.code || "");
    else if (block.type === "math") {
      preview.innerHTML = `<div class="mathjax-block ed-math-block" data-tex="${escapeHTML(block.tex || "")}"></div>`;
      await typesetMath(preview);
    } else {
      preview.innerHTML = renderBlock(block);
    }
  };

  const show = async (mode) => {
    if (wrap.dataset.mode === mode) return;
    await crossFade(wrap, async () => {
      wrap.dataset.mode = mode;
      if (mode === "source") grow();
      else await paint();
    });
  };

  view.showSource = () => show("source");
  view.showPreview = () => show("preview");

  source.addEventListener("input", () => {
    block[field] = source.value;
    view.touch();
    grow();
  });
  source.addEventListener("blur", () => {
    if (!wrap.contains(document.activeElement)) view.showPreview();
  });
  source.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      document.execCommand("insertText", false, "  ");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      view.showPreview();
      ctx.onFocusSibling(block.id, 1);
      return;
    }
    if (e.key === "Backspace" && !source.value) {
      e.preventDefault();
      ctx.onDelete(block.id, "prev");
    }
  });

  if (lang) {
    lang.addEventListener("input", () => {
      block.lang = lang.value.trim();
      view.touch();
    });
  }

  wrap.querySelector(".ed-source-toggle").addEventListener("click", () => {
    if (wrap.dataset.mode === "source") view.showPreview();
    else view.showSource().then(() => source.focus());
  });

  preview.addEventListener("click", () => {
    view.showSource().then(() => source.focus());
  });

  source.addEventListener("focus", () => ctx.onFocus(view));

  view.read = () => {};
  view.focus = () => view.showSource().then(() => source.focus());
  view.isEmpty = () => !source.value.trim();
  view.refresh = paint;

  // Everything starts rendered: opening a document should look like the post.
  wrap.dataset.mode = "preview";
  paint();
}

/* ─── image ────────────────────────────────────────────────────────────────── */

/**
 * An image, built the way the published page builds one.
 *
 * The page emits a `.img-preloader` that the lazyload observer turns into an
 * `<img>` when it is about to be seen, optionally wrapped in
 * `<figure class="image-caption">` with the ALT text as the caption — see
 * scripts/filters/img-handle.js and scripts/filters/lazyload-handle.js. The
 * editor emits exactly that and lets the same observer, the same skeleton and
 * the same image viewer take it from there. What is added is a small overlay of
 * controls and an editable caption; nothing about the image itself is local.
 *
 * The caption edits `alt`, not the markdown title, because alt is what the page
 * prints under the picture. The title never appears anywhere.
 */
function mountImage(view) {
  const { block, ctx } = view;
  const style = (window.theme && window.theme.articles && window.theme.articles.style) || {};
  const numbered = style.image_figure_number === true;
  const captioned = style.image_caption !== false;

  const wrap = document.createElement("figure");
  wrap.className = "image-caption ed-figure";
  wrap.innerHTML = `
    <div class="ed-image-tools" contenteditable="false">
      <button type="button" data-act="replace" title="${escapeHTML(ctx.t("replace", "Replace"))}"><i class="fa-solid fa-arrows-rotate"></i></button>
      <button type="button" data-act="remove" title="${escapeHTML(ctx.t("remove_block", "Remove"))}"><i class="fa-solid fa-trash"></i></button>
    </div>
    <figcaption contenteditable="true" spellcheck="false"
      data-placeholder="${escapeHTML(ctx.t("caption", "Describe this image"))}"></figcaption>`;

  const caption = wrap.querySelector("figcaption");
  const tools = wrap.querySelector(".ed-image-tools");

  const paintCaption = () => {
    if (!captioned) return void (caption.hidden = true);
    const n = numbered ? ctx.figureIndex(block.id) : 0;
    caption.innerHTML = numbered
      ? (block.alt ? `<strong>Figure ${n}.</strong> ` : "") + escapeHTML(block.alt || `Figure ${n}`)
      : escapeHTML(block.alt || "");
  };

  const paint = () => {
    const old = wrap.querySelector(".img-preloader, img");
    const node = ctx.buildPreloader(block.url, block.alt);
    if (old) old.replaceWith(node);
    else wrap.insertBefore(node, tools);
    paintCaption();
    ctx.observeImages();
  };
  paint();

  // Typing in the caption IS typing the alt text; the numbering prefix is the
  // page's, not the author's, so it is stripped back off on the way out.
  caption.addEventListener("input", () => {
    const text = caption.textContent.replace(/^\s*Figure\s+\d+\.?\s*/i, "").trim();
    block.alt = text;
    view.touch();
  });
  caption.addEventListener("blur", paintCaption);

  tools.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    e.preventDefault();

    if (act.dataset.act === "remove") return void ctx.onDelete(block.id, "prev");
    const picked = await ctx.pickImage();
    if (!picked) return;
    // The SITE path, not the repository path: what lands in the markdown has to
    // be what a browser can ask for.
    block.url = picked.site;
    view.touch();
    paint();
  });

  view.body.appendChild(wrap);
  view.read = () => {};
  view.renumber = paintCaption;
  view.focus = () => caret.focusEnd(caption);
  view.isEmpty = () => false;
}

/* ─── table ────────────────────────────────────────────────────────────────── */

function mountTable(view) {
  const { block, ctx } = view;
  const wrap = document.createElement("div");
  wrap.className = "ed-table-block";
  view.body.appendChild(wrap);

  const paint = () => {
    const style = (i) => (block.align[i] ? ` style="text-align:${block.align[i]}"` : "");
    const head = block.header
      .map((cell, i) => `<th${style(i)} contenteditable="true" data-col="${i}">${inlineToHTML(cell)}</th>`)
      .join("");
    const body = block.rows
      .map(
        (row, r) =>
          `<tr>${row
            .map((cell, i) => `<td${style(i)} contenteditable="true" data-row="${r}" data-col="${i}">${inlineToHTML(cell)}</td>`)
            .join("")}</tr>`
      )
      .join("");

    wrap.innerHTML = `
      <div class="ed-table-bar" contenteditable="false">
        <span class="ed-chip"><i class="fa-solid fa-table" aria-hidden="true"></i>${escapeHTML(ctx.t("t_table", "Table"))}</span>
        <span class="ed-table-align" role="group">
          <button type="button" data-align="" title="${escapeHTML(ctx.t("align_default", "Default"))}"><i class="fa-solid fa-align-justify"></i></button>
          <button type="button" data-align="left"><i class="fa-solid fa-align-left"></i></button>
          <button type="button" data-align="center"><i class="fa-solid fa-align-center"></i></button>
          <button type="button" data-align="right"><i class="fa-solid fa-align-right"></i></button>
        </span>
        <button type="button" data-act="add-row"><i class="fa-solid fa-plus"></i>${escapeHTML(ctx.t("row", "Row"))}</button>
        <button type="button" data-act="add-col"><i class="fa-solid fa-plus"></i>${escapeHTML(ctx.t("column", "Column"))}</button>
        <button type="button" data-act="del-row"><i class="fa-solid fa-minus"></i>${escapeHTML(ctx.t("row", "Row"))}</button>
        <button type="button" data-act="del-col"><i class="fa-solid fa-minus"></i>${escapeHTML(ctx.t("column", "Column"))}</button>
      </div>
      <div class="table-container"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  };

  const readCells = () => {
    for (const th of wrap.querySelectorAll("th")) {
      block.header[Number(th.dataset.col)] = htmlToInline(th);
    }
    for (const td of wrap.querySelectorAll("td")) {
      block.rows[Number(td.dataset.row)][Number(td.dataset.col)] = htmlToInline(td);
    }
  };

  const rebuild = async (mutate) => {
    readCells();
    await morphHeight(wrap, () => {
      mutate();
      paint();
    });
    view.touch();
  };

  let activeCol = 0;

  wrap.addEventListener("input", (e) => {
    if (e.target.matches("th, td")) view.touch();
  });

  wrap.addEventListener("focusin", (e) => {
    if (e.target.matches("th, td")) activeCol = Number(e.target.dataset.col) || 0;
    ctx.onFocus(view);
  });

  wrap.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || !e.target.matches("th, td")) return;
    const cells = Array.from(wrap.querySelectorAll("th, td"));
    const index = cells.indexOf(e.target);
    const next = cells[index + (e.shiftKey ? -1 : 1)];
    if (!next) return;
    e.preventDefault();
    caret.focusEnd(next);
  });

  wrap.addEventListener("click", (e) => {
    const align = e.target.closest("[data-align]");
    if (align) {
      e.preventDefault();
      return void rebuild(() => {
        block.align[activeCol] = align.dataset.align;
      });
    }

    const act = e.target.closest("[data-act]");
    if (!act) return;
    e.preventDefault();

    if (act.dataset.act === "add-row") {
      return void rebuild(() => block.rows.push(block.header.map(() => "")));
    }
    if (act.dataset.act === "del-row") {
      return void rebuild(() => {
        if (block.rows.length > 1) block.rows.pop();
      });
    }
    if (act.dataset.act === "add-col") {
      return void rebuild(() => {
        block.header.push("");
        block.align.push("");
        block.rows.forEach((row) => row.push(""));
      });
    }
    if (act.dataset.act === "del-col") {
      return void rebuild(() => {
        if (block.header.length <= 1) return;
        block.header.pop();
        block.align.pop();
        block.rows.forEach((row) => row.pop());
      });
    }
  });

  paint();
  view.read = () => {
    if (view.touched) readCells();
  };
  view.focus = () => caret.focusEnd(wrap.querySelector("th"));
  view.isEmpty = () => false;
}

/* ─── component ────────────────────────────────────────────────────────────── */

const NOTE_COLORS = ["default", "info", "success", "warning", "danger", "primary"];
const COMMON_ICONS = [
  "", "fa-circle-info", "fa-lightbulb", "fa-triangle-exclamation", "fa-circle-check",
  "fa-circle-xmark", "fa-bell", "fa-star", "fa-bookmark", "fa-flask", "fa-quote-left",
];

function mountComponent(view) {
  const { block, ctx } = view;
  const api = window.RedefineComponents;
  const kind = api ? api.TAG_INDEX.get(block.name) : null;

  const wrap = document.createElement("div");
  wrap.className = "ed-component";
  wrap.dataset.kind = kind || "unknown";
  view.body.appendChild(wrap);

  // A tag with no browser emitter is edited as its source. Nothing is lost:
  // the block still round-trips byte for byte.
  if (!kind || kind === "tabs") {
    return mountComponentSource(view, wrap, kind);
  }

  const argv = block.args ? block.args.trim().split(/\s+/) : [];
  const parsed = parseComponentArgs(kind, argv, block.args || "");

  wrap.innerHTML = `
    <div class="ed-component-bar" contenteditable="false">
      <span class="ed-chip"><i class="fa-solid fa-cube" aria-hidden="true"></i>${escapeHTML(block.name)}</span>
      <div class="ed-swatches" role="group"></div>
      ${kind === "note" || kind === "noteLarge" ? `<button type="button" class="ed-icon-btn" title="${escapeHTML(ctx.t("icon", "Icon"))}"><i class="fa-solid ${escapeHTML(parsed.icon || "fa-face-smile")}"></i></button>` : ""}
      ${parsed.hasTitle ? `<input class="ed-component-title" placeholder="${escapeHTML(ctx.t("title", "Title"))}" value="${escapeHTML(parsed.title || "")}">` : ""}
      <button type="button" class="ed-component-remove" title="${escapeHTML(ctx.t("remove_block", "Remove"))}"><i class="fa-solid fa-trash"></i></button>
    </div>
    <div class="ed-component-render"></div>`;

  const swatches = wrap.querySelector(".ed-swatches");
  const palette = kind === "box" ? api.BOX_COLORS : NOTE_COLORS;
  swatches.innerHTML = palette
    .map(
      (color) =>
        `<button type="button" class="ed-swatch" data-color="${escapeHTML(color)}" data-on="${color === parsed.color ? "1" : "0"}" title="${escapeHTML(color)}"><span class="ed-swatch-dot ${kind === "box" ? "post-box post-box-" + escapeHTML(color) : "note " + escapeHTML(color)}"></span></button>`
    )
    .join("");

  const host = wrap.querySelector(".ed-component-render");

  const writeArgs = () => {
    block.args = buildComponentArgs(kind, parsed);
    view.touch();
  };

  const paint = () => {
    host.innerHTML = renderBlock(block);
    const inner = host.querySelector(".markdown-body, .notel-content, .post-box, .content");
    if (!inner || parsed.bodyKind === "text") return mountComponentBody(view, host, parsed);
    mountComponentBody(view, inner, parsed);
  };

  swatches.addEventListener("click", (e) => {
    const swatch = e.target.closest(".ed-swatch");
    if (!swatch) return;
    e.preventDefault();
    parsed.color = swatch.dataset.color;
    for (const node of swatches.children) node.dataset.on = node === swatch ? "1" : "0";
    writeArgs();
    morphHeight(wrap, paint);
  });

  const iconBtn = wrap.querySelector(".ed-icon-btn");
  if (iconBtn) {
    iconBtn.addEventListener("click", (e) => {
      e.preventDefault();
      openIconPicker(iconBtn, parsed.icon, (icon) => {
        parsed.icon = icon;
        iconBtn.querySelector("i").className = "fa-solid " + (icon || "fa-face-smile");
        writeArgs();
        morphHeight(wrap, paint);
      });
    });
  }

  const titleInput = wrap.querySelector(".ed-component-title");
  if (titleInput) {
    titleInput.addEventListener("input", () => {
      parsed.title = titleInput.value;
      writeArgs();
    });
    titleInput.addEventListener("change", () => morphHeight(wrap, paint));
  }

  wrap.querySelector(".ed-component-remove").addEventListener("click", (e) => {
    e.preventDefault();
    ctx.onDelete(block.id, "prev");
  });

  paint();
  view.read = () => {};
  view.focus = () => {
    const editable = wrap.querySelector("[contenteditable=true]");
    if (editable) caret.focusEnd(editable);
  };
  view.isEmpty = () => false;
}

function mountComponentBody(view, host, parsed) {
  const { block } = view;
  if (parsed.bodyKind === "text") {
    host.contentEditable = "true";
    host.classList.add("ed-rich");
    host.addEventListener("input", () => {
      block.body = host.textContent;
      view.touch();
    });
    return;
  }

  host.contentEditable = "true";
  host.classList.add("ed-rich");
  host.addEventListener("input", () => {
    block.body = richToMarkdown(host);
    view.touch();
  });
  host.addEventListener("paste", (e) => onPaste(view, e));
  host.addEventListener("focus", () => view.ctx.onFocus(view));
}

/** The fallback editor: the tag's own source, exactly as it will be committed. */
function mountComponentSource(view, wrap, kind) {
  const { block, ctx } = view;
  wrap.innerHTML = `
    <div class="ed-component-bar" contenteditable="false">
      <span class="ed-chip"><i class="fa-solid fa-cube" aria-hidden="true"></i>${escapeHTML(block.name)}</span>
      <input class="ed-component-args" spellcheck="false" placeholder="${escapeHTML(ctx.t("arguments", "arguments"))}" value="${escapeHTML(block.args || "")}">
      <button type="button" class="ed-source-toggle" title="${escapeHTML(ctx.t("toggle_source", "Show source"))}"><i class="fa-solid fa-pen-to-square"></i></button>
      <button type="button" class="ed-component-remove" title="${escapeHTML(ctx.t("remove_block", "Remove"))}"><i class="fa-solid fa-trash"></i></button>
    </div>
    <div class="ed-preview"></div>
    <textarea class="ed-source" spellcheck="false"></textarea>`;

  const source = wrap.querySelector(".ed-source");
  const preview = wrap.querySelector(".ed-preview");
  const args = wrap.querySelector(".ed-component-args");
  source.value = block.body == null ? "" : block.body;

  const grow = () => {
    source.style.height = "auto";
    source.style.height = source.scrollHeight + "px";
  };
  const paint = () => {
    preview.innerHTML = renderBlock(block);
  };
  const show = (mode) =>
    crossFade(wrap, () => {
      wrap.dataset.mode = mode;
      if (mode === "source") grow();
      else paint();
    });

  source.addEventListener("input", () => {
    block.body = source.value;
    view.touch();
    grow();
  });
  args.addEventListener("input", () => {
    block.args = args.value;
    view.touch();
  });
  source.addEventListener("blur", () => {
    if (!wrap.contains(document.activeElement)) show("preview");
  });
  wrap.querySelector(".ed-source-toggle").addEventListener("click", () => {
    if (wrap.dataset.mode === "source") show("preview");
    else show("source").then(() => source.focus());
  });
  preview.addEventListener("click", () => show("source").then(() => source.focus()));
  wrap.querySelector(".ed-component-remove").addEventListener("click", (e) => {
    e.preventDefault();
    ctx.onDelete(block.id, "prev");
  });

  wrap.dataset.mode = block.body == null ? "preview" : "preview";
  paint();

  view.read = () => {};
  view.focus = () => show("source").then(() => source.focus());
  view.isEmpty = () => false;
  if (kind === "tabs") wrap.dataset.kind = "tabs";
}

/**
 * The tag's arguments, in the shape its editor needs.
 *
 * `note` takes `color` then an optional FontAwesome icon then extra classes;
 * `folding` and `noteLarge` also carry a title. The split is the emitter's own
 * (`components.splitIcon`), so what the editor shows and what the build renders
 * cannot disagree about which argument is which.
 */
function parseComponentArgs(kind, argv, raw) {
  const api = window.RedefineComponents;

  if (kind === "box") {
    return { color: api.boxColor(argv[0]), bodyKind: "text", hasTitle: false, extra: [] };
  }

  if (kind === "folding") {
    const parts = api.splitArgs(argv);
    return {
      color: (parts[0] || "").trim() || "default",
      title: (parts[1] || "").trim(),
      bodyKind: "blocks",
      hasTitle: true,
      extra: [],
      separator: "::",
    };
  }

  const color = argv[0] || "default";
  const { icon, rest } = api.splitIcon(argv.slice(1), "");
  const iconName = (icon.match(/fa-[\w-]+(?="|\s|$)/g) || []).filter((c) => c !== "fa-solid" && c !== "fa-regular").pop() || "";

  if (kind === "noteLarge") {
    return { color, icon: iconName, title: rest.join(" "), bodyKind: "blocks", hasTitle: true, extra: [] };
  }
  return { color, icon: iconName, bodyKind: "blocks", hasTitle: false, extra: rest, raw };
}

function buildComponentArgs(kind, parsed) {
  if (kind === "box") return parsed.color;
  if (kind === "folding") return [parsed.color, parsed.title].join("::");

  const parts = [parsed.color];
  if (parsed.icon) parts.push(parsed.icon);
  if (kind === "noteLarge" && parsed.title) parts.push(parsed.title);
  else if (parsed.extra && parsed.extra.length) parts.push(parsed.extra.join(" "));
  return parts.filter(Boolean).join(" ");
}

function openIconPicker(anchor, current, onPick) {
  const existing = document.querySelector(".ed-icon-picker");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.className = "ed-icon-picker";
  menu.innerHTML = COMMON_ICONS.map(
    (icon) =>
      `<button type="button" data-icon="${escapeHTML(icon)}" data-on="${icon === current ? "1" : "0"}">${icon ? `<i class="fa-solid ${escapeHTML(icon)}"></i>` : '<i class="fa-solid fa-ban"></i>'}</button>`
  ).join("");

  const rect = anchor.getBoundingClientRect();
  menu.style.top = rect.bottom + 6 + "px";
  menu.style.left = rect.left + "px";
  document.body.appendChild(menu);
  pop(menu);

  menu.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-icon]");
    if (!btn) return;
    onPick(btn.dataset.icon);
    menu.remove();
  });

  const close = (e) => {
    if (menu.contains(e.target) || anchor.contains(e.target)) return;
    menu.remove();
    document.removeEventListener("pointerdown", close, true);
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

/* ─── rule ─────────────────────────────────────────────────────────────────── */

function mountRule(view) {
  const wrap = document.createElement("div");
  wrap.className = "ed-rule";
  wrap.innerHTML = "<hr>";
  view.body.appendChild(wrap);
  view.read = () => {};
  view.focus = () => view.el.scrollIntoView({ block: "nearest" });
  view.isEmpty = () => false;
}

/* ─── factory for new blocks ───────────────────────────────────────────────── */

export function makeBlock(type, fields) {
  const base = { id: nextId(), type, src: "", after: "\n\n", dirty: true };
  const defaults = {
    paragraph: { text: "" },
    heading: { level: 2, text: "" },
    quote: { text: "" },
    list: { ordered: false, marker: "-", items: [{ indent: 0, text: "" }] },
    code: { lang: "", code: "", fence: "```" },
    mermaid: { code: "graph TD\n  A --> B" },
    math: { tex: "" },
    image: { alt: "", src: "", title: "" },
    hr: {},
    raw: { text: "" },
    table: {
      header: ["", "", ""],
      align: ["", "", ""],
      rows: [["", "", ""], ["", "", ""]],
    },
    component: { name: "note", args: "info", body: "" },
  };
  return Object.assign(base, defaults[type] || {}, fields || {});
}

