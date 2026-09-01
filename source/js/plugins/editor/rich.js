/**
 * The nested rich editor — what a component's body is edited in.
 *
 * A `{% note %}` holds markdown, and that markdown is nearly always a couple of
 * paragraphs and a list. Giving it a full nested block canvas would mean nested
 * drag handles, nested slash menus and blocks that can be dragged out of their
 * own container; giving it a textarea would mean the one place the author most
 * wants to see a rendered note is the one place they cannot. So it gets a
 * contenteditable holding real rendered markup, read back by the walk below.
 *
 * The walk is deliberately total: an element it does not model contributes its
 * text, never nothing, so no edit can silently drop a body.
 */

import { htmlToInline } from "./markdown.js";

const LIST_TAGS = new Set(["UL", "OL"]);

export function richToMarkdown(root) {
  const parts = [];

  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3) {
      const text = node.nodeValue.trim();
      if (text) parts.push(text);
      continue;
    }
    if (node.nodeType !== 1) continue;

    const tag = node.tagName;

    if (/^H[1-6]$/.test(tag)) {
      parts.push("#".repeat(Number(tag[1])) + " " + htmlToInline(node));
    } else if (LIST_TAGS.has(tag)) {
      parts.push(listToMarkdown(node, 0));
    } else if (tag === "BLOCKQUOTE") {
      parts.push(
        richToMarkdown(node)
          .split("\n")
          .map((line) => "> " + line)
          .join("\n")
      );
    } else if (tag === "PRE") {
      const code = node.textContent.replace(/\n$/, "");
      parts.push("```\n" + code + "\n```");
    } else if (tag === "HR") {
      parts.push("---");
    } else if (tag === "BR") {
      continue;
    } else if (tag === "DIV" && node.children.length && !node.querySelector("br")) {
      // A contenteditable will happily produce nested divs; flatten them.
      parts.push(richToMarkdown(node));
    } else {
      const inline = htmlToInline(node);
      if (inline.trim()) parts.push(inline);
    }
  }

  return parts.filter((p) => p !== "").join("\n\n");
}

function listToMarkdown(list, depth) {
  const ordered = list.tagName === "OL";
  const pad = "  ".repeat(depth);
  const out = [];
  let index = 0;

  for (const li of Array.from(list.children)) {
    if (li.tagName !== "LI") continue;
    index += 1;

    const nested = [];
    const own = document.createElement("div");
    for (const child of Array.from(li.childNodes)) {
      if (child.nodeType === 1 && LIST_TAGS.has(child.tagName)) nested.push(child);
      else own.appendChild(child.cloneNode(true));
    }

    out.push(pad + (ordered ? index + "." : "-") + " " + htmlToInline(own));
    for (const child of nested) out.push(listToMarkdown(child, depth + 1));
  }

  return out.join("\n");
}

/**
 * Paste, reduced to what the document model can hold.
 *
 * A paste from a browser or an editor carries spans, inline styles, classes and
 * often a whole stylesheet's worth of attributes. None of it survives a
 * round-trip through markdown, so keeping it would mean showing the author
 * formatting that silently disappears on save.
 */
export function sanitizePaste(html) {
  const holder = document.createElement("div");
  holder.innerHTML = html;

  const KEEP = new Set([
    "P", "BR", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI",
    "BLOCKQUOTE", "PRE", "CODE", "STRONG", "B", "EM", "I", "DEL", "S",
    "A", "IMG", "HR", "MARK", "KBD", "SUP", "SUB",
  ]);
  const ATTRS = { A: ["href", "title"], IMG: ["src", "alt", "title"] };

  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 8) {
        node.removeChild(child);
        continue;
      }
      if (child.nodeType !== 1) continue;

      if (!KEEP.has(child.tagName)) {
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        node.removeChild(child);
        continue;
      }

      const allowed = ATTRS[child.tagName] || [];
      for (const attr of Array.from(child.attributes)) {
        if (!allowed.includes(attr.name)) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };

  walk(holder);
  return holder.innerHTML;
}
