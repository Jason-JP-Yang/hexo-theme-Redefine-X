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

import { emitBlock, escapeHTML, htmlToInline, inlineToHTML, nextId } from "./markdown.js";
import { renderBlock, renderMarkdown, renderMermaid, typesetMath } from "./render.js";
import { richToMarkdown, sanitizePaste } from "./rich.js";
import * as caret from "./caret.js";
import { anchorMarks } from "./inline.js";
import { crossFade, morphHeight, setDragImage } from "./motion.js";

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
    <div class="ed-body"></div>
    <textarea class="ed-raw" spellcheck="false" hidden></textarea>`;

  const body = el.querySelector(".ed-body");
  const view = { el, body, block, ctx, touched: false };
  wireRaw(view, el.querySelector(".ed-raw"));

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

  // A press anywhere in the block is a press ON the block. Without this an
  // image or a button — neither of which holds a caret — never became the
  // focused one, and the toolbar had nothing to say about it.
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".ed-gutter")) return;
    ctx.onFocus(view);
  });

  // Every block answers the toolbar, whether or not it has anything to say.
  if (!view.options) view.options = () => [];
  if (!view.subOptions) view.subOptions = () => [];
  if (!view.act) view.act = () => {};

  wireDrag(view);
  return view;
}

/**
 * The block's own markdown, every marker included.
 *
 * One implementation for all twelve types, because there is only one question
 * being asked — what does this block SAY in the file — and `emitBlock` already
 * answers it for each of them. What comes back may be several blocks (a pasted
 * section) or none (an emptied field); both are ordinary, not errors.
 */
function wireRaw(view, raw) {
  const grow = () => {
    raw.style.height = "auto";
    raw.style.height = raw.scrollHeight + "px";
  };

  view.sourceOn = () => !raw.hidden;

  view.showRaw = async () => {
    if (!raw.hidden) return;
    view.read();
    const block = view.block;
    raw.value = block.dirty ? emitBlock(block) : block.src || emitBlock(block);
    await crossFade(view.el, () => {
      view.body.hidden = true;
      raw.hidden = false;
      grow();
    });
    raw.focus();
  };

  view.hideRaw = () => {
    if (raw.hidden) return;
    const text = raw.value;
    raw.hidden = true;
    view.body.hidden = false;
    view.ctx.onRawEdited(view.block.id, text);
  };

  raw.addEventListener("input", grow);
  raw.addEventListener("focus", () => view.ctx.onFocus(view));
  raw.addEventListener("blur", () => view.hideRaw());
  raw.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      view.hideRaw();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      document.execCommand("insertText", false, "  ");
    }
  });
}

function wireDrag(view) {
  const handle = view.el.querySelector(".ed-handle");
  handle.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", view.block.id);
    // The ghost is the whole block, not the 26px button the pointer happened to
    // be on. Taken before `is-dragging` lands, so the ghost is the opaque block
    // and the one left behind is the faded one.
    setDragImage(e, view.el);
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
  // Boundary anchors from the first frame: the caret has to be able to stand
  // either side of a mark before anything has been applied to it.
  anchorMarks(host);
  typesetMath(host);
  wireInlineMath(host, view);

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

  // Heading levels 5 and 6 are not offered as conversions — four is already
  // more depth than a post uses — but a file that carries one has to be able to
  // say so, so the depth control covers all six.
  view.options = (open) => {
    if (block.type === "heading") {
      // One control that opens the depths, the way the highlighter opens the
      // palette. Six H icons in a row said nothing about which was which.
      return [
        {
          kind: "btn",
          act: "sub",
          arg: "level",
          icon: "fa-heading",
          label: "Heading " + (block.level || 2),
          tt: "b_heading" + (block.level || 2),
          wide: true,
          on: open === "level",
        },
      ];
    }
    if (block.type === "list") {
      return [
        { kind: "btn", act: "ordered", arg: "0", icon: "fa-list-ul", label: "Bullets", tt: "b_list", on: !block.ordered },
        { kind: "btn", act: "ordered", arg: "1", icon: "fa-list-ol", label: "Numbers", tt: "b_olist", on: !!block.ordered },
      ];
    }
    return [];
  };

  view.subOptions = (key) =>
    key !== "level" || block.type !== "heading"
      ? []
      : [
          { kind: "label", label: "Depth", tt: "depth" },
          ...[1, 2, 3, 4, 5, 6].map((level) => ({
            kind: "btn",
            act: "level",
            arg: level,
            icon: "fa-heading",
            label: "Heading " + level,
            tt: "b_heading" + level,
            wide: true,
            on: (block.level || 2) === level,
          })),
        ];

  view.act = (act, arg) => {
    if (act === "level") {
      block.level = Number(arg) || 2;
      view.touch();
      return view.ctx.onRemount(block.id);
    }
    if (act === "ordered") {
      block.ordered = arg === "1";
      block.marker = block.ordered ? "." : "-";
      view.touch();
      return view.ctx.onRemount(block.id);
    }
  };
}

/**
 * An equation in the middle of a sentence, opened to be read.
 *
 * Rendered it is an SVG, and an SVG is not something you can put a caret in —
 * so the chip is inert until it is clicked, and then it shows the LaTeX it was
 * made from as ordinary text. Leaving it typesets it again. Display math is a
 * block of its own with its own field; this is the inline half, and the two are
 * told apart by which delimiter wrote them.
 */
function wireInlineMath(host, view) {
  const close = (chip) => {
    const src = chip.querySelector(".ed-math-src");
    if (!src) return;
    const tex = src.textContent.trim();
    chip.setAttribute("data-tex", tex);
    chip.removeAttribute("data-editing");
    chip.contentEditable = "false";
    src.contentEditable = "false";
    chip.innerHTML = `<span class="ed-math-src">${escapeHTML(tex)}</span>`;
    typesetMath(chip);
    view.touch();
    view.read();
  };

  host.addEventListener("click", (e) => {
    const chip = e.target.closest(".ed-math");
    if (!chip || !host.contains(chip)) return;
    e.preventDefault();

    for (const other of host.querySelectorAll('.ed-math[data-editing="1"]')) {
      if (other !== chip) close(other);
    }
    if (chip.dataset.editing === "1") return;

    chip.dataset.editing = "1";
    chip.innerHTML = `<span class="ed-math-src">${escapeHTML(chip.getAttribute("data-tex") || "")}</span>`;
    const src = chip.querySelector(".ed-math-src");
    src.contentEditable = "true";
    caret.focusEnd(src);
  });

  host.addEventListener(
    "blur",
    (e) => {
      const chip = e.target.closest && e.target.closest('.ed-math[data-editing="1"]');
      if (chip) close(chip);
    },
    true
  );

  host.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" && e.key !== "Enter") return;
    const chip = e.target.closest && e.target.closest('.ed-math[data-editing="1"]');
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    close(chip);
    caret.focusEnd(host);
  });
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

/** Offered as buttons; anything else is typed once and remembered in the file. */
const LANGS = [
  "", "js", "ts", "jsx", "tsx", "html", "css", "styl", "json", "yaml", "toml",
  "bash", "python", "c", "cpp", "java", "go", "rust", "php", "sql", "diff", "md",
];

function mountSource(view) {
  const { block, ctx } = view;
  const field = SOURCE_FIELD[block.type];

  const wrap = document.createElement("div");
  wrap.className = "ed-source-block";
  wrap.dataset.kind = block.type;
  wrap.innerHTML = `
    <div class="ed-preview"></div>
    <textarea class="ed-source" spellcheck="false"></textarea>`;

  const preview = wrap.querySelector(".ed-preview");
  const source = wrap.querySelector(".ed-source");

  source.value = block[field] || "";
  view.body.appendChild(wrap);
  view.editable = source;

  const grow = () => {
    source.style.height = "auto";
    source.style.height = source.scrollHeight + "px";
  };

  const paint = async () => {
    if (block.type === "mermaid") return void (await renderMermaid(preview, block.code || ""));
    preview.innerHTML = renderBlock(block);
    if (block.type === "math") await typesetMath(preview);
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

  if (block.type === "code") {
    view.options = (open) => [
      {
        kind: "btn",
        act: "sub",
        arg: "lang",
        icon: "fa-file-code",
        label: block.lang || ctx.t("plain", "Plain text"),
        wide: true,
        on: open === "lang",
      },
    ];
    view.subOptions = (key) =>
      key !== "lang"
        ? []
        : [
            { kind: "label", label: "Language", tt: "language" },
            ...LANGS.map((name) => ({
              kind: "btn",
              act: "lang",
              arg: name,
              icon: name ? "fa-code" : "fa-align-left",
              label: name || ctx.t("plain", "Plain text"),
              wide: true,
              on: (block.lang || "") === name,
            })),
            { kind: "btn", act: "lang-other", icon: "fa-ellipsis", label: "Other", tt: "other", wide: true },
          ];
    view.act = async (act, arg) => {
      if (act === "lang") {
        block.lang = arg;
      } else if (act === "lang-other") {
        const name = await ctx.ask("lang", block.lang || "");
        if (name == null) return;
        block.lang = name.trim();
      } else {
        return;
      }
      view.touch();
      if (wrap.dataset.mode !== "source") paint();
      ctx.onOptionsChanged();
    };
  }

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
    <figcaption contenteditable="true" spellcheck="false"
      data-placeholder="${escapeHTML(ctx.t("caption", "Describe this image"))}"></figcaption>`;

  const caption = wrap.querySelector("figcaption");

  const paintCaption = () => {
    if (!captioned) return void (caption.hidden = true);
    const n = numbered ? ctx.figureIndex(block.id) : 0;
    caption.innerHTML = numbered
      ? (block.alt ? `<strong>Figure ${n}.</strong> ` : "") + escapeHTML(block.alt || `Figure ${n}`)
      : escapeHTML(block.alt || "");
  };

  const hasExif = () => !!block.exifTitle || Object.keys(block.exif || {}).some((k) => block.exif[k]);

  const paint = () => {
    const api = window.RedefineComponents;

    // With a caption title or camera data this is an `{% exifimage %}`, and the
    // card it prints is part of the picture. Rendered through the shared
    // emitter, so the canvas shows the figure the build will.
    if (hasExif() && api && api.exifImage) {
      wrap.className = "ed-figure ed-figure-exif";
      wrap.innerHTML = api.exifImage(
        [block.exifTitle || "", block.autoExif === false ? "auto-exif:false" : ""].filter(Boolean),
        api.buildExifBody({ description: block.alt, path: block.url, info: block.exif || {} }),
        null,
        { resolve: (p) => ctx.resolveAsset(p) }
      );
      const img = wrap.querySelector("img");
      if (img) img.setAttribute("data-no-viewer", "");
      return;
    }

    wrap.className = "image-caption ed-figure";
    if (!wrap.contains(caption)) wrap.appendChild(caption);
    const old = wrap.querySelector(".img-preloader, img");
    const node = ctx.buildPreloader(block.url, block.alt);
    // In the editor a click on a picture SELECTS it; the viewer is a button in
    // the toolbar, because opening a lightbox over the thing you are editing is
    // not what a click there means.
    node.setAttribute("data-no-viewer", "");
    if (old) old.replaceWith(node);
    else wrap.insertBefore(node, caption);
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

  caption.addEventListener("focus", () => ctx.onFocus(view));

  view.body.appendChild(wrap);
  view.read = () => {};
  view.renumber = paintCaption;
  view.focus = () => caret.focusEnd(caption);
  view.isEmpty = () => false;
  view.editable = caption;

  view.options = () => [
    { kind: "btn", act: "folder", icon: "fa-folder-open", label: "Open folder", tt: "open_folder", wide: true },
    { kind: "btn", act: "props", icon: "fa-sliders", label: "Properties", tt: "properties", wide: true, on: hasExif() },
    { kind: "btn", act: "view", icon: "fa-expand", label: "Open viewer", tt: "open_viewer" },
  ];

  view.act = async (act) => {
    if (act === "folder") {
      // The picker names it. Replacing and addressing were the same act asked
      // two ways, and one of them was a repository path typed from memory.
      const picked = await ctx.pickImage(block.url);
      if (!picked) return;
      block.url = picked.site;
    } else if (act === "props") {
      const next = await ctx.imageProps(block);
      if (!next) return;
      Object.assign(block, next);
    } else if (act === "view") {
      return void ctx.openViewer(wrap.querySelector("img"));
    } else {
      return;
    }
    view.touch();
    paint();
    ctx.onOptionsChanged();
  };
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

    wrap.innerHTML = `<div class="table-container"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
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
  let activeRow = -1;

  wrap.addEventListener("input", (e) => {
    if (e.target.matches("th, td")) view.touch();
  });

  wrap.addEventListener("focusin", (e) => {
    if (e.target.matches("th, td")) {
      activeCol = Number(e.target.dataset.col) || 0;
      activeRow = e.target.dataset.row == null ? -1 : Number(e.target.dataset.row);
      view.editable = e.target;
    }
    ctx.onFocus(view);
    ctx.onOptionsChanged();
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

  paint();
  view.read = () => {
    if (view.touched) readCells();
  };
  view.focus = () => caret.focusEnd(wrap.querySelector("th"));
  view.isEmpty = () => false;

  // Rows and columns act at the CELL the caret is in, not at the end of the
  // table: "add a row" after the third row is what the author means when the
  // caret is in the third row.
  view.options = () => [
    { kind: "btn", act: "row+", icon: "fa-arrow-down", label: "Row below", tt: "row_add", wide: true },
    { kind: "btn", act: "row-", icon: "fa-trash", label: "Remove row", tt: "row_del", wide: true, disabled: activeRow < 0 || block.rows.length <= 1 },
    { kind: "btn", act: "col+", icon: "fa-arrow-right", label: "Column after", tt: "col_add", wide: true },
    { kind: "btn", act: "col-", icon: "fa-trash", label: "Remove column", tt: "col_del", wide: true, disabled: block.header.length <= 1 },
    { kind: "sep" },
    { kind: "btn", act: "align", arg: "", icon: "fa-align-justify", label: "Default alignment", tt: "align_default", on: !block.align[activeCol] },
    { kind: "btn", act: "align", arg: "left", icon: "fa-align-left", label: "Align left", tt: "align_left", on: block.align[activeCol] === "left" },
    { kind: "btn", act: "align", arg: "center", icon: "fa-align-center", label: "Align centre", tt: "align_center", on: block.align[activeCol] === "center" },
    { kind: "btn", act: "align", arg: "right", icon: "fa-align-right", label: "Align right", tt: "align_right", on: block.align[activeCol] === "right" },
  ];

  view.act = (act, arg) => {
    const at = activeRow < 0 ? block.rows.length - 1 : activeRow;

    if (act === "align") return void rebuild(() => (block.align[activeCol] = arg));
    if (act === "row+") return void rebuild(() => block.rows.splice(at + 1, 0, block.header.map(() => "")));
    if (act === "row-") {
      return void rebuild(() => {
        if (block.rows.length > 1 && activeRow >= 0) block.rows.splice(activeRow, 1);
      });
    }
    if (act === "col+") {
      return void rebuild(() => {
        block.header.splice(activeCol + 1, 0, "");
        block.align.splice(activeCol + 1, 0, "");
        block.rows.forEach((row) => row.splice(activeCol + 1, 0, ""));
      });
    }
    if (act === "col-") {
      return void rebuild(() => {
        if (block.header.length <= 1) return;
        block.header.splice(activeCol, 1);
        block.align.splice(activeCol, 1);
        block.rows.forEach((row) => row.splice(activeCol, 1));
        activeCol = Math.max(0, activeCol - 1);
      });
    }
  };
}

/* ─── component ────────────────────────────────────────────────────────────── */

/* ─── component ────────────────────────────────────────────────────────────── */

const NOTE_COLORS = ["default", "info", "success", "warning", "danger", "primary"];
const FOLDING_COLORS = [
  "default", "blue", "cyan", "green", "yellow", "orange",
  "red", "pink", "purple", "gray", "white", "black",
];
const BTN_STYLES = [
  { arg: "", icon: "fa-align-left", label: "In the line" },
  { arg: "center", icon: "fa-align-center", label: "Centred" },
  { arg: "large", icon: "fa-maximize", label: "Large" },
  { arg: "center large", icon: "fa-expand", label: "Large, centred" },
];
const COMMON_ICONS = [
  "", "fa-circle-info", "fa-lightbulb", "fa-triangle-exclamation", "fa-circle-check",
  "fa-circle-xmark", "fa-bell", "fa-star", "fa-bookmark", "fa-flask", "fa-quote-left",
  "fa-book", "fa-code", "fa-link", "fa-download", "fa-play", "fa-fire", "fa-heart",
];

function swatchRow(list, current, dot) {
  return list.map((colour) => ({
    kind: "swatch",
    act: "colour",
    arg: colour,
    cls: dot(colour),
    label: colour,
    on: colour === current,
  }));
}

function iconRow(current) {
  return [
    { kind: "label", label: "Icon", tt: "icon" },
    ...COMMON_ICONS.map((icon) => ({
      kind: "btn",
      act: "icon",
      arg: icon,
      icon: icon || "fa-ban",
      label: icon || "None",
      on: (current || "") === icon,
    })),
  ];
}

/**
 * A component's own words, edited where the reader will see them.
 *
 * A note's title belongs on the note, not in a field floating above it — that
 * is the whole reason this editor works on the rendered article. The icon the
 * emitter put there stays; everything else is replaced by one editable span, so
 * what is typed is plain text and lands in the tag's arguments unescaped.
 */
function inPlace(host, value, onInput) {
  if (!host) return null;

  for (const node of Array.from(host.childNodes)) {
    if (node.nodeType === 1 && node.tagName === "I") continue;
    node.remove();
  }

  const span = document.createElement("span");
  span.className = "ed-inplace";
  span.contentEditable = "true";
  span.spellcheck = false;
  span.textContent = value;
  host.appendChild(span);

  span.addEventListener("input", () => onInput(span.textContent.replace(/\s+/g, " ").trim()));
  span.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault();
  });
  return span;
}

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
  if (!kind) return mountComponentSource(view, wrap, kind);
  if (kind === "tabs") return mountTabs(view, wrap);

  const argv = block.args ? block.args.trim().split(/\s+/) : [];
  const parsed = parseComponentArgs(kind, argv, block.args || "");

  const host = document.createElement("div");
  host.className = "ed-component-render";
  wrap.appendChild(host);

  const writeArgs = () => {
    block.args = buildComponentArgs(kind, parsed);
    view.touch();
  };

  const wireTitle = () => {
    if (kind === "noteLarge") {
      inPlace(host.querySelector(".notel-title"), parsed.title || "", (text) => {
        parsed.title = text;
        writeArgs();
      });
      return;
    }
    if (kind === "folding") {
      const details = host.querySelector("details");
      if (details) details.open = true;
      inPlace(host.querySelector("summary"), parsed.title || "", (text) => {
        parsed.title = text;
        writeArgs();
      });
      return;
    }
    if (kind === "btn") {
      const anchor = host.querySelector("a.button");
      if (anchor) anchor.addEventListener("click", (e) => e.preventDefault());
      inPlace(anchor, parsed.text || "", (text) => {
        parsed.text = text;
        writeArgs();
      });
    }
  };

  // A large note and a folding hold BLOCKS, not a slab of rich text — the same
  // blocks the article holds, with their own gutters and handles, so a picture
  // or a table inside one is edited the way it is edited anywhere else. A small
  // note and a box hold a line or two, and a canvas inside them would be more
  // machinery than the thing it edits.
  const nests = kind === "noteLarge" || kind === "folding";
  let nested = null;

  const paint = () => {
    if (nested) {
      ctx.unnest(nested);
      nested = null;
    }
    host.innerHTML = renderBlock(block);
    wireTitle();
    if (kind === "btn") return;

    const inner = host.querySelector(".markdown-body, .notel-content, .post-box, .content");
    if (nests && inner) {
      inner.classList.add("ed-nest");
      inner.innerHTML = "";
      nested = ctx.nest(inner, block.body || "", {
        write: (text) => {
          block.body = text;
          view.touch();
        },
        onEmpty: () => ctx.onDelete(block.id, "prev"),
      });
      if (nested) return;
      // No box came back, which means this note is already inside one. It falls
      // back to the flat body rather than opening a second level.
      inner.classList.remove("ed-nest");
      host.innerHTML = renderBlock(block);
      wireTitle();
    }

    const body = host.querySelector(".markdown-body, .notel-content, .post-box, .content");
    if (!body || parsed.bodyKind === "text") return mountComponentBody(view, host, parsed);
    mountComponentBody(view, body, parsed);
  };

  paint();
  view.nests = nests;

  view.read = () => {
    if (nested && ctx.writeBox) ctx.writeBox(nested);
  };
  view.focus = () => {
    const editable = wrap.querySelector("[contenteditable=true]");
    if (editable) caret.focusEnd(editable);
  };
  view.isEmpty = () => false;

  view.options = (open) => {
    const rows = [];
    if (kind === "box") rows.push(...swatchRow(api.BOX_COLORS, parsed.color, (c) => "post-box post-box-" + c));
    else if (kind === "folding") rows.push(...swatchRow(FOLDING_COLORS, parsed.color, (c) => "ed-fold-dot " + c));
    else if (kind === "note" || kind === "noteLarge") rows.push(...swatchRow(NOTE_COLORS, parsed.color, (c) => "note " + c));

    if (kind === "note" || kind === "noteLarge" || kind === "btn") {
      rows.push(
        { kind: "sep" },
        {
          kind: "btn",
          act: "sub",
          arg: "icon",
          icon: parsed.icon || "fa-face-smile",
          label: "Icon",
          tt: "icon",
          on: open === "icon",
        }
      );
    }
    if (kind === "btn") {
      rows.push(
        { kind: "sep" },
        ...BTN_STYLES.map((style) => ({
          kind: "btn",
          act: "colour",
          arg: style.arg,
          icon: style.icon,
          label: style.label,
          on: (parsed.color || "") === style.arg,
        })),
        { kind: "sep" },
        { kind: "btn", act: "address", icon: "fa-link", label: "Address", tt: "address", wide: true }
      );
    }
    return rows;
  };

  view.subOptions = (key) => (key === "icon" ? iconRow(parsed.icon) : []);

  view.act = async (act, arg) => {
    if (act === "colour") parsed.color = arg;
    else if (act === "icon") parsed.icon = arg;
    else if (act === "address") {
      const url = await ctx.ask("url", parsed.url || "https://");
      if (url == null) return;
      parsed.url = url.trim();
    } else return;

    writeArgs();
    await morphHeight(wrap, paint);
    ctx.onOptionsChanged();
  };
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

/* ─── tabs ─────────────────────────────────────────────────────────────────── */

const TAB_PANE = /<!--\s*tab (.*?)\s*-->\n?([\s\S]*?)<!--\s*endtab\s*-->/g;

function readPanes(body) {
  TAB_PANE.lastIndex = 0;
  const out = [];
  let match;
  while ((match = TAB_PANE.exec(String(body == null ? "" : body))) !== null) {
    out.push({ caption: match[1], body: match[2].trim() });
  }
  return out.length ? out : [{ caption: "Tab 1", body: "" }];
}

const capLabel = (caption) => String(caption).split("@")[0].trim();
const capIcon = (caption) => (String(caption).split("@")[1] || "").trim();

/**
 * Tabs, edited as tabs.
 *
 * The pane markers are HTML comments, so the whole component used to fall back
 * to a textarea — the one component whose whole point is that you look at one
 * pane at a time, shown as all of them at once with their markers in the way.
 * Here the nav is the nav: the chip is the caption, editable where it is read,
 * and only the open pane is mounted, which is also what the published tab does.
 */
function mountTabs(view, wrap) {
  const { block, ctx } = view;
  const api = window.RedefineComponents;

  const parts = api.splitArgs(block.args ? block.args.trim().split(/\s+/) : []);
  const group = { name: (parts[0] || "").trim(), active: Number(parts[1]) || 0 };
  const panes = readPanes(block.body);
  let open = Math.min(panes.length - 1, Math.max(0, (group.active || 1) - 1));

  wrap.innerHTML = `
    <div class="ed-tabs">
      <div class="ed-tabs-nav" contenteditable="false"></div>
      <div class="ed-tabs-pane markdown-body"></div>
    </div>`;

  const nav = wrap.querySelector(".ed-tabs-nav");
  const pane = wrap.querySelector(".ed-tabs-pane");

  const writeArgs = () => {
    block.args = group.active ? `${group.name}::${group.active}` : group.name;
    view.touch();
  };

  const writeBody = () => {
    block.body = panes
      .map((p) => `<!-- tab ${p.caption} -->\n\n${p.body}\n\n<!-- endtab -->`)
      .join("\n\n");
    view.touch();
  };

  // The pane's own box writes itself back as its blocks change, so reading is
  // only a matter of asking it to.
  const readPane = () => {
    if (nested && ctx.writeBox) ctx.writeBox(nested);
    else if (panes[open]) panes[open].body = richToMarkdown(pane);
  };

  const paintNav = () => {
    nav.innerHTML =
      panes
        .map(
          (p, i) =>
            `<span class="ed-tab-chip" data-i="${i}" data-on="${i === open ? "1" : "0"}">
               ${capIcon(p.caption) ? `<i class="${escapeHTML(capIcon(p.caption))}"></i>` : ""}
               <span class="ed-tab-cap"></span>
             </span>`
        )
        .join("") +
      `<button type="button" class="ed-tab-add" title="${escapeHTML(ctx.t("tab_add", "Add tab"))}"><i class="fa-solid fa-plus"></i></button>`;

    nav.querySelectorAll(".ed-tab-chip").forEach((chip) => {
      const i = Number(chip.dataset.i);
      inPlace(chip.querySelector(".ed-tab-cap"), capLabel(panes[i].caption), (text) => {
        const icon = capIcon(panes[i].caption);
        panes[i].caption = icon ? `${text}@${icon}` : text;
        writeBody();
      });
    });
  };

  // Each pane is a canvas of its own. Emptying one deletes that pane — its
  // caption goes with it, because a tab with no name and nothing in it is not
  // something you meant to keep — and the last pane takes the group with it.
  let nested = null;

  const dropPane = () => {
    if (panes.length <= 1) return void ctx.onDelete(block.id, "prev");
    panes.splice(open, 1);
    open = Math.max(0, open - 1);
    writeBody();
    paintNav();
    morphHeight(wrap, paintPane);
  };

  const paintPane = () => {
    if (nested) {
      ctx.unnest(nested);
      nested = null;
    }
    pane.innerHTML = "";
    pane.classList.add("ed-nest");
    nested = ctx.nest(pane, panes[open] ? panes[open].body : "", {
      write: (text) => {
        if (panes[open]) panes[open].body = text;
        writeBody();
      },
      onEmpty: dropPane,
    });
    if (!nested) {
      pane.classList.remove("ed-nest");
      pane.innerHTML = renderMarkdown(panes[open] ? panes[open].body : "");
    }
    ctx.observeImages();
  };

  const show = (i) => {
    if (i === open) return;
    readPane();
    open = Math.max(0, Math.min(panes.length - 1, i));
    paintNav();
    morphHeight(wrap, paintPane);
    ctx.onOptionsChanged();
  };

  nav.addEventListener("click", (e) => {
    if (e.target.closest(".ed-tab-add")) {
      e.preventDefault();
      readPane();
      panes.push({ caption: `Tab ${panes.length + 1}`, body: "" });
      writeBody();
      return void show(panes.length - 1);
    }
    const chip = e.target.closest(".ed-tab-chip");
    if (chip && !e.target.closest(".ed-inplace")) {
      e.preventDefault();
      show(Number(chip.dataset.i));
    }
  });

  paintNav();
  paintPane();

  view.nests = true;
  view.read = readPane;
  view.focus = () => {
    const first = pane.querySelector("[contenteditable=true]");
    if (first) caret.focusEnd(first);
  };
  view.isEmpty = () => false;

  view.options = () => [
    { kind: "btn", act: "tab-add", icon: "fa-plus", label: "Add tab", tt: "tab_add", wide: true },
    { kind: "btn", act: "tab-del", icon: "fa-trash", label: "Remove tab", tt: "tab_del", wide: true, disabled: panes.length <= 1 },
    { kind: "btn", act: "tab-move", arg: "-1", icon: "fa-arrow-left", label: "Move left", tt: "tab_left", disabled: open === 0 },
    { kind: "btn", act: "tab-move", arg: "1", icon: "fa-arrow-right", label: "Move right", tt: "tab_right", disabled: open === panes.length - 1 },
    { kind: "sep" },
    { kind: "btn", act: "tab-first", icon: "fa-thumbtack", label: "Open this one first", tt: "tab_first", wide: true, on: group.active === open + 1 },
    { kind: "btn", act: "tab-name", icon: "fa-tag", label: group.name || "Group name", tt: "tab_name", wide: true },
    { kind: "sep" },
    { kind: "btn", act: "sub", arg: "tabicon", icon: capIcon(panes[open].caption) || "fa-face-smile", label: "Tab icon", tt: "icon" },
  ];

  view.subOptions = (key) => (key === "tabicon" ? iconRow(capIcon(panes[open].caption).replace(/^fa-solid\s+/, "")) : []);

  view.act = async (act, arg) => {
    if (act === "tab-add") {
      readPane();
      panes.push({ caption: `Tab ${panes.length + 1}`, body: "" });
      writeBody();
      show(panes.length - 1);
    } else if (act === "tab-del") {
      if (panes.length <= 1) return;
      panes.splice(open, 1);
      open = Math.max(0, open - 1);
      writeBody();
      paintNav();
      await morphHeight(wrap, paintPane);
    } else if (act === "tab-move") {
      const to = open + Number(arg);
      if (to < 0 || to >= panes.length) return;
      readPane();
      const [moved] = panes.splice(open, 1);
      panes.splice(to, 0, moved);
      open = to;
      writeBody();
      paintNav();
    } else if (act === "tab-first") {
      group.active = group.active === open + 1 ? 0 : open + 1;
      writeArgs();
    } else if (act === "tab-name") {
      const name = await ctx.ask("name", group.name);
      if (name == null) return;
      group.name = name.trim();
      writeArgs();
    } else if (act === "icon") {
      const label = capLabel(panes[open].caption);
      panes[open].caption = arg ? `${label}@fa-solid ${arg}` : label;
      writeBody();
      paintNav();
    } else {
      return;
    }
    ctx.onOptionsChanged();
  };
}

/** The fallback editor: the tag's own source, exactly as it will be committed. */
function mountComponentSource(view, wrap, kind) {
  const { block, ctx } = view;
  wrap.innerHTML = `
    <div class="ed-preview"></div>
    <textarea class="ed-source" spellcheck="false"></textarea>`;

  const source = wrap.querySelector(".ed-source");
  const preview = wrap.querySelector(".ed-preview");
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
  source.addEventListener("focus", () => ctx.onFocus(view));
  source.addEventListener("blur", () => {
    if (!wrap.contains(document.activeElement)) show("preview");
  });
  preview.addEventListener("click", () => show("source").then(() => source.focus()));

  wrap.dataset.mode = "preview";
  paint();

  view.read = () => {};
  view.focus = () => show("source").then(() => source.focus());
  view.isEmpty = () => false;
  view.showSource = () => show("source");

  view.options = () => [
    { kind: "btn", act: "args", icon: "fa-sliders", label: "Arguments", tt: "arguments", wide: true },
  ];
  view.act = async (act) => {
    if (act !== "args") return;
    const args = await ctx.ask("args", block.args || "");
    if (args == null) return;
    block.args = args.trim();
    view.touch();
    paint();
    ctx.onOptionsChanged();
  };
}

/* ─── the tag's arguments, both ways ───────────────────────────────────────── */

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

  if (kind === "btn") {
    const parts = api.splitArgs(argv).map((part) => String(part).trim());
    let cls = "";
    let text = "";
    let url = "";
    let icon = "";
    if (parts.length >= 4) [cls, text, url, icon] = parts;
    else if (parts.length === 3) {
      if (/fa-/.test(parts[2])) [text, url, icon] = parts;
      else [cls, text, url] = parts;
    } else if (parts.length === 2) [text, url] = parts;
    else if (parts.length === 1) [text] = parts;

    const name = (icon.match(/fa-[\w-]+/g) || []).filter((c) => c !== "fa-solid" && c !== "fa-regular").pop() || "";
    return { color: cls, text, url, icon: name, bodyKind: "none", hasTitle: false, extra: [] };
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

  if (kind === "btn") {
    const icon = parsed.icon ? "fa-solid " + parsed.icon : "";
    if (icon) return [parsed.color, parsed.text, parsed.url, icon].join("::");
    if (parsed.color) return [parsed.color, parsed.text, parsed.url].join("::");
    return [parsed.text, parsed.url].join("::");
  }

  const parts = [parsed.color];
  if (parsed.icon) parts.push(parsed.icon);
  if (kind === "noteLarge" && parsed.title) parts.push(parsed.title);
  else if (parsed.extra && parsed.extra.length) parts.push(parsed.extra.join(" "));
  return parts.filter(Boolean).join(" ");
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
    image: { alt: "", url: "", title: "", exifTitle: "", autoExif: true, exif: {} },
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

