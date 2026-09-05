/**
 * What one block may turn into.
 *
 * This is the "change the style of this paragraph" half of editing — the half a
 * word processor puts in a dropdown at the far left of its ribbon — and it is
 * deliberately NOT the same thing as inserting. You do not insert a heading;
 * you write a line and say that line is a heading. Everything reachable from
 * here therefore carries the same words across: the block's plain text lines go
 * in, the new block's fields come out, and nothing is ever dropped.
 *
 * Which is also where the legality comes from. A heading is one line by
 * definition, so a block holding three of them cannot become one — the toolbar
 * greys it out rather than silently throwing two lines away.
 */

/** The types a textual block can be, in the order the toolbar offers them. */
export const BLOCK_TYPES = [
  { key: "paragraph", type: "paragraph", icon: "fa-paragraph", label: "Text" },
  { key: "heading1", type: "heading", fields: { level: 1 }, icon: "fa-heading", label: "Heading 1", single: true },
  { key: "heading2", type: "heading", fields: { level: 2 }, icon: "fa-heading", label: "Heading 2", single: true },
  { key: "heading3", type: "heading", fields: { level: 3 }, icon: "fa-heading", label: "Heading 3", single: true },
  { key: "heading4", type: "heading", fields: { level: 4 }, icon: "fa-heading", label: "Heading 4", single: true },
  { key: "list", type: "list", fields: { ordered: false, marker: "-" }, icon: "fa-list-ul", label: "Bullet list" },
  { key: "olist", type: "list", fields: { ordered: true, marker: "." }, icon: "fa-list-ol", label: "Numbered list" },
  { key: "quote", type: "quote", icon: "fa-quote-left", label: "Quote" },
  { key: "code", type: "code", fields: { lang: "" }, icon: "fa-code", label: "Code block" },
  { key: "math", type: "math", icon: "fa-square-root-variable", label: "Equation" },
  { key: "mermaid", type: "mermaid", icon: "fa-diagram-project", label: "Diagram" },
  { key: "raw", type: "raw", icon: "fa-file-code", label: "Raw HTML" },
];

/** Types whose content is plain lines, and which can therefore interconvert. */
const TEXTUAL = new Set(["paragraph", "heading", "quote", "list", "code", "math", "mermaid", "raw"]);

export function convertible(block) {
  return !!block && TEXTUAL.has(block.type);
}

/** The block's content as plain lines — the only currency a conversion has. */
export function linesOf(block) {
  if (!block) return [];
  if (block.type === "list") return (block.items || []).map((item) => item.text || "");
  if (block.type === "code" || block.type === "mermaid") return String(block.code || "").split("\n");
  if (block.type === "math") return String(block.tex || "").split("\n");
  return String(block.text || "").split("\n");
}

/** Which entry describes this block as it stands. */
export function keyOf(block) {
  if (!block) return "";
  if (block.type === "heading") return "heading" + Math.min(4, Math.max(1, block.level || 2));
  if (block.type === "list") return block.ordered ? "olist" : "list";
  return BLOCK_TYPES.some((entry) => entry.key === block.type) ? block.type : "";
}

/**
 * The fields the target type needs to hold `lines`.
 *
 * A list keeps one item per line, everything else joins them back — a paragraph
 * carrying a newline is a soft break, which is exactly what a two-line list
 * flattened into prose should be.
 */
export function fieldsFor(entry, lines) {
  const text = lines.join("\n");
  const base = Object.assign({}, entry.fields);

  if (entry.type === "list") {
    const items = (lines.length ? lines : [""]).map((line) => ({ indent: 0, text: line }));
    return Object.assign(base, { items });
  }
  if (entry.type === "code" || entry.type === "mermaid") return Object.assign(base, { code: text });
  if (entry.type === "math") return Object.assign(base, { tex: text });
  return Object.assign(base, { text });
}

/**
 * Every conversion offered for this block, each already told whether it is
 * legal and whether it is what the block already is.
 */
export function conversions(block) {
  if (!convertible(block)) return [];
  const lines = linesOf(block).filter((line, i, all) => line !== "" || all.length === 1);
  const here = keyOf(block);

  return BLOCK_TYPES.map((entry) => ({
    key: entry.key,
    icon: entry.icon,
    label: entry.label,
    on: entry.key === here,
    // A heading is one line. Offering it for three would mean choosing which
    // two to lose, which is not a choice an editor gets to make quietly.
    disabled: entry.single && lines.length > 1,
  }));
}

export function entryFor(key) {
  return BLOCK_TYPES.find((entry) => entry.key === key) || null;
}
