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
      return `<figure class="highlight ${escapeHTML(b.lang || "plain")}"><pre><code>${escapeHTML(b.code)}</code></pre></figure>`;

    case "mermaid":
      return `<pre class="mermaid">${escapeHTML(b.code)}</pre>`;

    case "math":
      return `<div class="mathjax-block ed-math-block" data-tex="${escapeHTML(b.tex)}"></div>`;

    case "image":
      return `<figure class="ed-figure"><img src="${escapeHTML(b.src)}" alt="${escapeHTML(b.alt)}"${b.title ? ` title="${escapeHTML(b.title)}"` : ""}>${b.title ? `<figcaption>${escapeHTML(b.title)}</figcaption>` : ""}</figure>`;

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
export async function typesetMath(host) {
  const nodes = host.matches && host.matches("[data-tex]")
    ? [host]
    : Array.from(host.querySelectorAll("[data-tex]"));
  if (!nodes.length) return;

  const mj = await loadMathJax();
  if (!mj) {
    for (const node of nodes) node.textContent = node.getAttribute("data-tex");
    return;
  }

  for (const node of nodes) {
    const tex = node.getAttribute("data-tex") || "";
    const display = node.classList.contains("ed-math-block");
    try {
      const svg = await mj.tex2svgPromise(tex, { display });
      node.innerHTML = "";
      node.appendChild(svg);
    } catch (err) {
      node.textContent = tex;
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
  try {
    window.mermaid.initialize({ startOnLoad: false, theme: document.documentElement.classList.contains("dark") ? "dark" : "default" });
    const id = "ed-mmd-" + Math.random().toString(36).slice(2, 9);
    const { svg } = await window.mermaid.render(id, code);
    host.innerHTML = svg;
    host.classList.remove("ed-mermaid-error");
  } catch (err) {
    host.textContent = String((err && err.message) || err);
    host.classList.add("ed-mermaid-error");
  }
}
