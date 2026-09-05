/**
 * Blocks → the markup the published post has.
 *
 * Not a preview. The canvas is `.article-content.markdown-body`, the same class
 * `layout/pages/post/article-content.ejs` puts around a real article, and the
 * custom components come out of `tools/components.js` — the same functions the
 * Hexo tags call. So what you edit is not a rendering of the post, it is the
 * post, minus the two things a browser cannot do: MathJax (pre-rendered to SVG
 * at build time) and code highlighting.
 */

import { escapeHTML, inlineToHTML, parseBlocks } from "./markdown.js";

/** tools/components.js is a classic script, so it arrives on the global. */
function components() {
  return window.RedefineComponents || null;
}

let componentsPromise = null;

/**
 * Fetch the shared emitters.
 *
 * Loaded from here rather than declared in scripts.ejs because the editor is
 * reached through Swup, and a conditional script tag outside `#swup` is only
 * ever evaluated on a full page load — the one navigation the editor is least
 * likely to arrive by.
 */
export function loadComponents() {
  if (components()) return Promise.resolve(components());
  if (componentsPromise) return componentsPromise;

  componentsPromise = new Promise((resolve) => {
    const root = String((window.config && window.config.root) || "/").replace(/\/+$/, "");
    const script = document.createElement("script");
    script.src = `${root}/js/build/tools/components.js`;
    script.onload = () => resolve(components());
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return componentsPromise;
}

/** Markdown → HTML, for a component's body. Recursive: a note holds blocks. */
export function renderMarkdown(text) {
  return parseBlocks(String(text == null ? "" : text))
    .map((b) => renderBlock(b))
    .join("\n");
}

export function renderBlock(b) {
  switch (b.type) {
    case "heading":
      return `<h${b.level}>${inlineToHTML(b.text)}</h${b.level}>`;

    case "paragraph":
      return `<p>${inlineToHTML(b.text)}</p>`;

    case "quote":
      return `<blockquote>${renderMarkdown(b.text)}</blockquote>`;

    case "hr":
      return "<hr>";

    case "code":
      return renderCode(b);

    case "mermaid":
      return `<pre class="mermaid">${escapeHTML(b.code)}</pre>`;

    case "math":
      // The published shape exactly: filters/mathjax-render.js emits
      // .mathjax-block[data-mathjax=display] wrapping .mathjax-scroll-wrapper,
      // and the article's CSS and the overflow handling in plugins/mathjax.js
      // both key off those. The editor's own ed-math-* classes matched neither,
      // which is why an equation here was a different size and shape from the
      // one that would be published.
      return (
        `<div class="mathjax-block" data-mathjax="display" data-tex="${escapeHTML(b.tex)}">` +
        `<div class="mathjax-scroll-wrapper"></div></div>`
      );

    case "image":
      return `<figure class="ed-figure"><img src="${escapeHTML(b.url)}" alt="${escapeHTML(b.alt)}"${b.title ? ` title="${escapeHTML(b.title)}"` : ""}>${b.title ? `<figcaption>${escapeHTML(b.title)}</figcaption>` : ""}</figure>`;

    case "list":
      return renderList(b);

    case "table":
      return renderTable(b);

    case "component":
      return renderComponent(b);

    default:
      return renderRaw(b);
  }
}

/**
 * A code block, in the frame the published page puts one in.
 *
 * Hexo's highlighter emits a two-column table — line numbers on the left, code
 * on the right — inside `figure.highlight`, and the build wraps that in
 * `.code-container[data-rel]`, which is what draws the mac-style bar with the
 * three dots and names the language. Emitting only the bare figure meant the
 * editor showed a code block with no bar and no numbers, which is not what the
 * post has. Highlighting itself is still the one thing a browser cannot do.
 */
function renderCode(b) {
  const lang = String(b.lang || "").trim();
  const lines = String(b.code == null ? "" : b.code).split(/\r?\n/);
  const gutter = lines.map((_, i) => `<span class="line">${i + 1}</span><br>`).join("");
  const code = lines.map((line) => `<span class="line">${escapeHTML(line) || " "}</span><br>`).join("");
  const rel = lang ? lang.charAt(0).toUpperCase() + lang.slice(1) : "";

  return (
    `<div class="code-container"${rel ? ` data-rel="${escapeHTML(rel)}"` : ""}>` +
    `<figure class="highlight ${escapeHTML(lang || "plain")}">` +
    `<table><tr><td class="gutter"><pre>${gutter}</pre></td>` +
    `<td class="code"><pre>${code}</pre></td></tr></table>` +
    `</figure></div>`
  );
}

/**
 * Hand-written HTML.
 *
 * Rendered, because that is what the published post does with it — except when
 * it carries a `<style>` or a `<script>`. Injecting those would apply the post's
 * rules to the EDITOR: one post here ships a `<style>` block, and rendering it
 * into the canvas restyles the workspace around it. Those show their source
 * instead, which is also the only form in which they can be edited.
 */
function renderRaw(b) {
  const text = b.text || "";
  if (/<\s*(style|script)\b/i.test(text)) {
    return `<pre class="ed-raw-source">${escapeHTML(text)}</pre>`;
  }
  return `<div class="ed-raw-render">${text}</div>`;
}

function renderList(b) {
  const tag = b.ordered ? "ol" : "ul";
  const items = b.items
    .map((item) => `<li>${inlineToHTML(item.text)}</li>`)
    .join("");
  return `<${tag}>${items}</${tag}>`;
}

function renderTable(b) {
  const style = (i) => (b.align[i] ? ` style="text-align:${b.align[i]}"` : "");
  const head = b.header.map((cell, i) => `<th${style(i)}>${inlineToHTML(cell)}</th>`).join("");
  const body = b.rows
    .map((row) => `<tr>${row.map((cell, i) => `<td${style(i)}>${inlineToHTML(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="table-container"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * A custom tag, through the very emitter the build uses.
 *
 * `args` arrives as one string because that is how it is written; the tag API
 * hands Hexo an array split on whitespace, so it is split the same way here.
 */
function renderComponent(b) {
  const api = components();
  const name = String(b.name || "").toLowerCase();
  const args = String(b.args || "").trim();
  const argv = args ? args.split(/\s+/) : [];

  if (!api) return `<div class="ed-raw-render">${escapeHTML(b.args || "")}</div>`;

  try {
    switch (api.TAG_INDEX.get(name)) {
      case "note":
        return api.note(argv, b.body, renderMarkdown);
      case "noteLarge":
        return api.noteLarge(argv, b.body, renderMarkdown);
      case "box":
        return api.box(argv, b.body);
      case "folding":
        return api.folding(argv, b.body, renderMarkdown);
      case "tabs":
        return api.tabs(argv, b.body, renderMarkdown, {});
      case "btn":
        return api.btn(argv);
      default:
        return unknownComponent(b);
    }
  } catch (err) {
    return unknownComponent(b);
  }
}

/**
 * A tag with no browser emitter — `errorbook`, `exifimage`, anything added
 * later. It shows its source under its own name rather than pretending to
 * render, and it round-trips exactly, so an unsupported tag costs fidelity in
 * the canvas and nothing at all in the file.
 */
function unknownComponent(b) {
  return `<div class="ed-unknown">
    <span class="ed-unknown-tag"><i class="fa-solid fa-cube" aria-hidden="true"></i>${escapeHTML(b.name)}</span>
    <pre>${escapeHTML(b.body == null ? b.args || "" : b.body)}</pre>
  </div>`;
}

/* ─── deferred renderers ───────────────────────────────────────────────────── */

let mathjaxPromise = null;

/**
 * MathJax, on demand.
 *
 * The site does not ship a browser MathJax: every equation is rendered to SVG
 * at build time (filters/mathjax-render.js), which is why an article carries no
 * typesetting cost. The editor is the one page that has to typeset live, so it
 * loads the CDN build the first time a formula needs it and never on a page
 * without one.
 */
export function loadMathJax() {
  if (mathjaxPromise) return mathjaxPromise;

  mathjaxPromise = new Promise((resolve) => {
    if (window.MathJax && window.MathJax.tex2svgPromise) return resolve(window.MathJax);

    window.MathJax = {
      loader: { load: ["input/tex-full", "output/svg"] },
      tex: { inlineMath: [["$", "$"]], displayMath: [["$$", "$$"]], packages: { "[+]": ["ams", "physics", "cases", "mathtools"] } },
      svg: { fontCache: "local" },
      // The editor converts its own equations with tex2svgPromise, which is
      // unaffected by this. What it stops is the SITE plugin's blanket
      // `typesetPromise()` sweeping the canvas and rendering everything a
      // second time — including the plain-text stand-in inside a chip that is
      // being edited, which it would have turned into an equation mid-keystroke.
      options: { ignoreHtmlClass: "ed-no-typeset" },
      startup: {
        typeset: false,
        ready() {
          window.MathJax.startup.defaultReady();
          resolve(window.MathJax);
        },
      },
    };

    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg-full.js";
    script.async = true;
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });

  return mathjaxPromise;
}

/** Typeset one `[data-tex]` host in place. Safe to call on a node with none. */
/**
 * Typeset every `[data-tex]` under `host`, once.
 *
 * The "once" is load-bearing. `plugins/mathjax.js` re-typesets the WHOLE
 * document whenever `MathJax.typesetPromise` exists, and the editor is what
 * makes it exist — so every equation was rendered a second time, by a different
 * path, on top of the first. A node that already holds an `mjx-container` is
 * finished, and `ignoreHtmlClass` (set in loadMathJax) keeps that sweep out of
 * the canvas entirely.
 */
export async function typesetMath(host) {
  if (!host) return;
  const all = host.matches && host.matches("[data-tex]")
    ? [host]
    : Array.from(host.querySelectorAll("[data-tex]"));
  const nodes = all.filter((node) => !node.querySelector("mjx-container"));
  if (!nodes.length) return;

  const mj = await loadMathJax();

  for (const node of nodes) {
    const tex = node.getAttribute("data-tex") || "";
    const display = node.getAttribute("data-mathjax") === "display";
    // Display math is published inside a scroll wrapper, so that is where the
    // SVG goes; an inline one replaces the plain-text stand-in.
    const target = node.querySelector(".mathjax-scroll-wrapper") || node;

    if (!mj) {
      target.textContent = tex;
      continue;
    }
    try {
      const svg = await mj.tex2svgPromise(tex, { display });
      target.innerHTML = "";
      target.appendChild(svg);
      node.classList.remove("ed-math-error");
    } catch (err) {
      target.textContent = tex;
      node.classList.add("ed-math-error");
    }
  }
}

/** Mermaid is already vendored for the site; the editor reuses that global. */
export async function renderMermaid(host, code) {
  if (!window.mermaid) {
    host.textContent = code;
    return;
  }
  const id = "ed-mmd-" + Math.random().toString(36).slice(2, 9);
  try {
    window.mermaid.initialize({
      startOnLoad: false,
      // Mermaid's own error report is a full-width SVG it appends to the BODY
      // and never takes away, so a diagram in mid-sentence printed "Syntax
      // error in text" across the foot of the article. The message belongs in
      // the block being edited and nowhere else.
      suppressErrorRendering: true,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
    });
    const { svg } = await window.mermaid.render(id, code);
    host.innerHTML = svg;
    host.classList.remove("ed-mermaid-error");
  } catch (err) {
    host.textContent = String((err && err.message) || err);
    host.classList.add("ed-mermaid-error");
  } finally {
    // Older mermaid ignores suppressErrorRendering and leaves the sandbox
    // behind regardless, so whatever it parked outside the block is removed.
    for (const stray of document.querySelectorAll("#" + id + ", #d" + id)) {
      if (!host.contains(stray)) stray.remove();
    }
  }
}
