/**
 * <math-renderer>: the element GitHub wraps TeX in when it renders a comment.
 * giscus turns it into MathML through MathJax's TeX input and sanitizes the
 * result; this does the same, with the same version, packages and limits:
 * no more than 100 macros in one expression or 2000 on the page, a short list
 * of macros refused, spacing arguments clamped, and a refused or broken
 * expression shown as an error over its source. MathJax and DOMPurify load
 * only when a comment actually contains math.
 */

const MATHJAX = "https://cdn.jsdelivr.net/npm/mathjax@3.2.0/es5";
const PURIFY = "https://cdn.jsdelivr.net/npm/dompurify@3.2.3/dist/purify.min.js";
const BAD = "Unable to render expression.";
const PER_EXPRESSION = 100;
const PER_PAGE = 2000;
const REFUSED = [
  "DeclareMathOperator", "DeclarePairedDelimiters", "renewtagform", "newtagform", "colorbox", "fcolorbox",
  "hphantom", "vphantom", "phantom", "operatorname", "Newextarrow", "definecolor", "mathchoice", "unicode", "mmlToken",
];
const SPACING = "hskip|hspace|raise|mspace|mskip|kern|lower|above|mkern|moveleft|moveright|rule|Rule|space|Space";
const LIMITS = { em: 2, pt: 20, pc: 0.75, ex: 2.5 };
const SPACED = new RegExp(`(${SPACING})((?:\\{-?\\d+\\.?\\d*?(?:em|pt|pc|ex)\\})+)`, "g");
const MJX = /^(TEX|mjx|MJX)-/;
const PURIFY_OPTIONS = {
  USE_PROFILES: { mathMl: true },
  ADD_ATTR: ["jax", "unselectable", "class", "style", "size", "justify", "space"],
  KEEP_CONTENT: true,
  CUSTOM_ELEMENT_HANDLING: { tagNameCheck: MJX, attributeNameCheck: MJX, allowCustomizedBuiltInElements: true },
};

const usage = new Map(); // run id -> macros counted
let loading = null;

function script(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = resolve;
    el.onerror = reject;
    document.head.append(el);
  });
}

function load() {
  return (loading ||= (async () => {
    window.MathJax = {
      ...(window.MathJax || {}),
      loader: { paths: { mathjax: MATHJAX }, load: ["ui/safe"] },
      tex: {
        inlineMath: [["$", "$"]],
        displayMath: [["$$", "$$"]],
        packages: { "[-]": ["noerrors", "bbox", "html", "require", "newcommand", "action", "colortbl"] },
        maxMacros: 1000,
      },
      startup: { typeset: false },
      options: { enableMenu: false },
    };
    await script(`${MATHJAX}/tex-chtml-full.js`);
    await window.MathJax.startup.promise;
    if (!window.DOMPurify) await script(PURIFY);
    window.DOMPurify.addHook("uponSanitizeAttribute", (el, data) => {
      if (el.tagName === "mtable" && data.attrName === "columnalign") {
        data.keepAttr = true;
        data.forceKeepAttr = true;
      } else if (data.attrName === "class") {
        data.attrValue = data.attrValue.split(" ").filter((c) => MJX.test(c) || c === "MathJax").join(" ");
        if (!data.attrValue) data.keepAttr = false;
      }
    });
  })());
}

// Clamp every dimension a spacing macro is handed to its unit's limit.
const clampSpacing = (tex) =>
  tex.replace(SPACED, (all, macro, args) =>
    macro +
    args.replace(/\{(-?\d+\.?\d*?)(em|pt|pc|ex)\}/g, (arg, n, unit) => {
      const max = LIMITS[unit];
      return Math.abs(Number(n)) > max ? `{${max}${unit}}` : arg;
    }),
  );

class MathRenderer extends HTMLElement {
  get source() {
    return this.firstChild?.textContent ?? "";
  }

  connectedCallback() {
    if (this.__rendered) return;
    this.runId = this.getAttribute("data-run-id") || "";
    load().then(
      () => requestAnimationFrame(() => this.render()),
      () => this.error(),
    );
  }

  disconnectedCallback() {
    usage.delete(this.runId);
  }

  error(msg = BAD, raw = this.source) {
    this.__rendered = true;
    const flash = document.createElement("div");
    flash.className = "flash flash-error";
    flash.textContent = msg;
    if (!raw) return void this.replaceChildren(flash);
    const pre = document.createElement("pre");
    pre.textContent = raw;
    this.replaceChildren(flash, document.createElement("br"), pre);
  }

  render() {
    const first = this.firstElementChild;
    if (this.__rendered || (first && /^(MATH|MJX-CONTAINER|MATH-RENDERER)$/i.test(first.nodeName)) || first?.classList.contains("flash-error")) return;
    const source = this.source;
    const macros = source.split("{").length;
    usage.set(this.runId, (usage.get(this.runId) || 0) + macros);
    let total = 0;
    for (const n of usage.values()) total += n;
    if (total > PER_PAGE || macros > PER_EXPRESSION) return this.error();
    const refused = REFUSED.filter((m) => source.includes(`\\${m}`));
    if (refused.length) return this.error(`The following macros are not allowed: ${refused.join(", ")}`);

    // Anything tag-like inside the TeX is read as markup and dropped, never run.
    const text = new DOMParser().parseFromString(clampSpacing(source), "text/html").body.textContent || "";
    const tex = text.trim().replace(/^\${1,2}|\${1,2}$/g, "");
    const purify = window.DOMPurify;
    let node;
    try {
      const mml = window.MathJax.tex2mml(tex, { display: !this.classList.contains("js-inline-math") });
      node = purify.sanitize(mml, { USE_PROFILES: { mathMl: true }, RETURN_DOM: true }).firstElementChild;
    } catch (e) {
      return this.error();
    }
    const merror = node?.querySelector("merror")?.textContent;
    if (merror != null) return this.error(merror.includes("Misplaced &") ? BAD : merror);
    if (!node) return this.error();
    const clean = purify.sanitize(node, PURIFY_OPTIONS);
    if (!clean) return this.error();
    this.__rendered = true;
    this.innerHTML = clean;
    // WebKit ignores mtable[columnalign]: align the cells themselves.
    for (const table of this.querySelectorAll("mtable[columnalign]")) {
      const aligns = table.getAttribute("columnalign").trim().split(/\s+/);
      if (aligns.length < 2) continue;
      for (const row of table.querySelectorAll(":scope > mtr")) {
        row.querySelectorAll("mtd").forEach((cell, i) => {
          const a = aligns[i] ?? aligns[aligns.length - 1];
          if (/^(left|center|right)$/.test(a)) cell.style.textAlign = a;
        });
      }
    }
  }
}

export function defineMathRenderer() {
  if (!customElements.get("math-renderer")) customElements.define("math-renderer", MathRenderer);
}
