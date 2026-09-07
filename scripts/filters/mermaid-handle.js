"use strict";

/**
 * ```mermaid fences → the element mermaid actually looks for.
 *
 * This was `hexo-filter-mermaid-diagrams`, a dependency the theme carried in
 * order to do sixteen lines of string replacement — and one that read its
 * switch from `hexo.config.mermaid` while the theme's own switch lives at
 * `theme.plugins.mermaid.enable`, so the two could disagree about whether the
 * feature was on. It is the theme's now, keyed on the theme's switch.
 *
 * ── Why `before_post_render` ────────────────────────────────────────────────
 *
 * Because the fence has to be taken away from the markdown renderer BEFORE it
 * sees one. Left alone, hexo-renderer-marked hands ```mermaid to highlight.js
 * and gets back `figure.highlight` wrapping a two-column table of numbered
 * `<span class="line">`s — a syntax-highlighted listing of the diagram's source,
 * which is exactly what a mermaid diagram that "renders as plain text" is.
 * Matching that structure back out of the HTML afterwards is possible and
 * fragile; not creating it is neither.
 *
 * The body is escaped, which the plugin this replaces did not do. Mermaid reads
 * `textContent`, so entities are decoded back to the source it was given, while
 * a label containing `<` stops being an unterminated tag in the middle of the
 * article.
 */

const FENCE = /(^|\n)([ \t]*)(`{3,}|~{3,})[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*\3[ \t]*(?=\r?\n|$)/g;
const SKIP = new Set([".js", ".css", ".html", ".htm"]);

function escapeHTML(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

hexo.extend.filter.register(
  "before_post_render",
  function (data) {
    if (!this.theme.config.plugins?.mermaid?.enable) return data;
    if (typeof data.content !== "string" || !data.content.includes("mermaid")) return data;

    const ext = String(data.source || "").slice(String(data.source || "").lastIndexOf("."));
    if (SKIP.has(ext.toLowerCase())) return data;

    data.content = data.content.replace(FENCE, (all, lead, indent, fence, body) => {
      return `${lead}<pre class="mermaid">${escapeHTML(body)}</pre>\n`;
    });
    return data;
  },
  9
);
