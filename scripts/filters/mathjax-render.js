'use strict';

/**
 * MathJax v4 Server-Side TeX → SVG Renderer (Hexo Filter)
 *
 * TWO-PHASE ARCHITECTURE:
 *  Phase 1  (before_post_render, priority 5):
 *    Scans raw Markdown for math delimiters ($, $$, \(\), \[\]),
 *    extracts TeX, and replaces each occurrence with an HTML comment
 *    placeholder BEFORE the Markdown renderer sees the source.
 *    This prevents Markdown from interpreting _ as <em>, \\ as <br>, | as tables, etc.
 *
 *  Phase 2  (after_post_render, priority 5):
 *    Finds the placeholder comments in the rendered HTML, converts each
 *    stored TeX expression to SVG via MathJax v4 tex2svgPromise(), and
 *    injects the SVG stylesheet once.
 */

/* ================================================================== */
/*  MathJax v4 singleton                                              */
/* ================================================================== */

let _mjPromise = null;

function getOrInitMathJax(log) {
  if (_mjPromise) return _mjPromise;

  _mjPromise = (async () => {
    const MJ = require('mathjax');

    const extraPackages = [
      'ams', 'newcommand', 'autoload', 'textmacros', 'noundefined',
      'configmacros', 'cases', 'mathtools', 'boldsymbol', 'cancel',
      'color', 'enclose', 'extpfeil', 'html', 'physics',
      'unicode', 'upgreek', 'bbox', 'amscd', 'action', 'braket',
      'centernot', 'gensymb', 'noerrors', 'verb'
    ];

    const MathJax = await MJ.init({
      loader: {
        load: [
          'input/tex', 'output/svg',
          ...extraPackages.map((p) => '[tex]/' + p)
        ]
      },
      tex: {
        packages: { '[+]': extraPackages },
        tags: 'none'            // disable (1)(2)(3) equation numbering
      },
      svg: { fontCache: 'local' },
      startup: { typeset: false }
    });

    const adaptor = MathJax.startup.adaptor;

    // Extract the SVG stylesheet that MathJax needs (frame borders, etc.)
    const cssNode = MathJax.svgStylesheet();
    const svgCSS  = adaptor.textContent(cssNode);

    if (log) {
      log.info('[mathjax] MathJax %s initialised (TeX → SVG, %d packages)',
        MathJax.version || '4.x', extraPackages.length);
    }

    return { MathJax, adaptor, svgCSS };
  })();

  _mjPromise.catch(() => { _mjPromise = null; });
  return _mjPromise;
}

/* ================================================================== */
/*  Per-post math store                                               */
/* ================================================================== */

// Map<filePath, Array<{ tex, display }>>
const mathStore = new Map();

/* ================================================================== */
/*  Phase 1 — Extract math from raw Markdown                         */
/* ================================================================== */

/**
 * Find the closing delimiter starting at `start`, respecting backslash-escapes.
 */
function findClosing(str, start, delim) {
  let pos = start;
  while (pos < str.length) {
    const idx = str.indexOf(delim, pos);
    if (idx === -1) return -1;
    let bs = 0;
    for (let k = idx - 1; k >= 0 && str[k] === '\\'; k--) bs++;
    if (bs % 2 === 0) return idx;
    pos = idx + delim.length;
  }
  return -1;
}

/**
 * Scan raw Markdown `text` and return { replaced, expressions[] }.
 * Each math span is replaced with <!--mathjax:N:display|inline-->.
 * Code fences (``` and ~~~) and inline code (`) are skipped.
 */
function extractMath(text, singleDollars) {
  const expressions = [];
  let result = '';
  let i = 0;

  const emit = (tex, display) => {
    const id = expressions.length;
    const mode = display ? 'display' : 'inline';
    expressions.push({ tex: tex.trim(), display });
    result += `<!--mathjax:${id}:${mode}-->`;
  };

  while (i < text.length) {
    // --- skip fenced code blocks (``` or ~~~) ---
    if ((text[i] === '`' && text.substr(i, 3) === '```') ||
        (text[i] === '~' && text.substr(i, 3) === '~~~')) {
      const fence = text.substr(i, 3);
      const endFence = text.indexOf('\n' + fence, i + 3);
      if (endFence !== -1) {
        // include the closing fence line
        const closeEnd = text.indexOf('\n', endFence + 1);
        const blockEnd = closeEnd !== -1 ? closeEnd : text.length;
        result += text.slice(i, blockEnd);
        i = blockEnd;
        continue;
      }
    }

    // --- skip inline code (`) ---
    if (text[i] === '`') {
      // count consecutive backticks
      let ticks = 0;
      let ti = i;
      while (ti < text.length && text[ti] === '`') { ticks++; ti++; }
      const closer = '`'.repeat(ticks);
      const closeIdx = text.indexOf(closer, ti);
      if (closeIdx !== -1) {
        result += text.slice(i, closeIdx + ticks);
        i = closeIdx + ticks;
        continue;
      }
    }

    // --- \[...\] display math ---
    if (text[i] === '\\' && text[i + 1] === '[') {
      const end = findClosing(text, i + 2, '\\]');
      if (end !== -1) {
        emit(text.slice(i + 2, end), true);
        i = end + 2;
        continue;
      }
    }

    // --- \(...\) inline math ---
    if (text[i] === '\\' && text[i + 1] === '(') {
      const end = findClosing(text, i + 2, '\\)');
      if (end !== -1) {
        emit(text.slice(i + 2, end), false);
        i = end + 2;
        continue;
      }
    }

    // --- $$ display math ---
    if (text[i] === '$' && text[i + 1] === '$' &&
        (i === 0 || text[i - 1] !== '\\')) {
      const end = findClosing(text, i + 2, '$$');
      if (end !== -1) {
        emit(text.slice(i + 2, end), true);
        i = end + 2;
        continue;
      }
    }

    // --- $ inline math ---
    if (text[i] === '$' && text[i + 1] !== '$' &&
        (i === 0 || text[i - 1] !== '\\') && singleDollars) {
      const end = findClosing(text, i + 1, '$');
      if (end !== -1) {
        const raw = text.slice(i + 1, end);
        // inline $ must not span multiple lines
        if (!raw.includes('\n')) {
          emit(raw, false);
          i = end + 1;
          continue;
        }
      }
    }

    result += text[i];
    i++;
  }

  return { replaced: result, expressions };
}

/* ================================================================== */
/*  Phase 2 — Render SVG and inject into HTML                        */
/* ================================================================== */

const PLACEHOLDER_RE = /<!--mathjax:(\d+):(display|inline)-->/g;

async function renderAndInject(html, expressions, mjRuntime, log) {
  const { MathJax, adaptor } = mjRuntime;

  // Pre-render all expressions
  const rendered = new Array(expressions.length);
  for (let i = 0; i < expressions.length; i++) {
    const { tex, display } = expressions[i];
    try {
      const node = await MathJax.tex2svgPromise(tex, { display });
      rendered[i] = adaptor.outerHTML(node);
    } catch (err) {
      log.warn('[mathjax] TeX render error: %s | Input: %s',
        err.message || err, tex.substring(0, 100));
      rendered[i] = null;
    }
  }

  // Replace placeholders in HTML
  return html.replace(PLACEHOLDER_RE, (match, idStr, mode) => {
    const id = parseInt(idStr, 10);
    const svg = rendered[id];
    if (svg == null) return match;   // keep placeholder if render failed

    if (mode === 'display') {
      return '<div class="mathjax-block" data-mathjax="display">' +
             '<div class="mathjax-scroll-wrapper">' + svg + '</div></div>';
    }
    return '<span class="mathjax-inline" data-mathjax="inline">' + svg + '</span>';
  });
}

/* ================================================================== */
/*  CSS injection helper                                              */
/* ================================================================== */

function injectSvgCSS(html, svgCSS) {
  if (!svgCSS) return html;
  // Inject MathJax SVG CSS into each page that contains math.
  // Each page is a separate HTML file, so we must inject in every one.
  const styleTag = '<style id="mathjax-svg-css">' + svgCSS + '</style>';
  const idx = html.indexOf('<div class="mathjax-block"');
  if (idx !== -1) {
    return html.slice(0, idx) + styleTag + html.slice(idx);
  }
  const idx2 = html.indexOf('<span class="mathjax-inline"');
  if (idx2 !== -1) {
    return html.slice(0, idx2) + styleTag + html.slice(idx2);
  }
  return html;
}

/* ================================================================== */
/*  Hexo filter registration                                          */
/* ================================================================== */

/**
 * Phase 1:  before_post_render  (priority 5 — runs early)
 * Extracts math from raw Markdown and stores it, replacing with placeholders.
 */
hexo.extend.filter.register('before_post_render', function (data) {
  const themeConfig = this.theme.config || {};
  const config = (themeConfig.plugins && themeConfig.plugins.mathjax) || {};
  if (!config.enable) return data;

  const shouldRender = config.every_page || data.mathjax === true;
  if (!shouldRender) return data;

  const singleDollars = config.single_dollars !== false;
  const { replaced, expressions } = extractMath(data.content, singleDollars);

  if (expressions.length > 0) {
    data.content = replaced;
    // Store expressions keyed by source path
    mathStore.set(data.source || data.slug || data._id, expressions);
  }

  return data;
}, 5);

/**
 * Phase 2:  after_post_render  (priority 5)
 * Renders stored TeX → SVG and replaces placeholders in post HTML.
 */
hexo.extend.filter.register('after_post_render', async function (data) {
  const themeConfig = this.theme.config || {};
  const config = (themeConfig.plugins && themeConfig.plugins.mathjax) || {};
  if (!config.enable) return data;

  const key = data.source || data.slug || data._id;
  const expressions = mathStore.get(key);
  if (!expressions || expressions.length === 0) return data;

  const log = this.log || console;

  try {
    const mjRuntime = await getOrInitMathJax(log);

    data.content = await renderAndInject(data.content, expressions, mjRuntime, log);
    data.content = injectSvgCSS(data.content, mjRuntime.svgCSS);

    log.info('[mathjax] Rendered %d expressions for "%s"',
      expressions.length, data.title || data.slug);
  } catch (err) {
    log.error('[mathjax] Processing failed for "%s": %s',
      data.title || data.slug, err.message || err);
  }

  // Clean up
  mathStore.delete(key);

  return data;
}, 5);
