/**
 * Mermaid, actually run.
 *
 * The old version of this file called `mermaid.initialize()` on every
 * navigation and nothing else. `initialize` sets configuration; it does not
 * draw anything. Auto-drawing is `startOnLoad`, which fires once at load and
 * only for a bundle that was configured before it — so on a Swup navigation, on
 * a decrypted post, and on a page whose diagrams arrived after DOMContentLoaded,
 * nothing was ever rendered. The diagram stayed as the text it came in as.
 *
 * Everything here therefore drives mermaid explicitly, one `<pre class="mermaid">`
 * at a time, and keeps each diagram's SOURCE on the element it drew — because a
 * rendered diagram no longer contains the text it was made from, and light/dark
 * has to be able to draw it again.
 */

(function () {
  if (!window.theme?.plugins?.mermaid?.enable) return;

  const SELECTOR = "pre.mermaid, div.mermaid";
  let ready = false;
  let seq = 0;

  const isDark = () => document.documentElement.classList.contains("dark");

  /**
   * Mermaid is configured per PASS, not once.
   *
   * `theme` is baked into the SVG it produces — colours, strokes and text are
   * written into the markup, not read from a stylesheet — so the only way a
   * diagram follows the site's light/dark switch is to be drawn again under the
   * other theme. That is what `redefine:color-scheme-change` below is for.
   */
  function configure() {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: isDark() ? "dark" : "default",
      // A diagram is authored by the person who owns the repository, and
      // `loose` is what lets click-handlers and HTML labels work. It is the
      // same trust boundary every other tag in a post already has.
      securityLevel: "loose",
      suppressErrorRendering: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-family") || undefined,
    });
    ready = true;
  }

  /** The diagram's own text, kept where the drawing will overwrite it. */
  function sourceOf(el) {
    if (el.dataset.mmdSrc == null) el.dataset.mmdSrc = el.textContent.trim();
    return el.dataset.mmdSrc;
  }

  async function draw(el) {
    const code = sourceOf(el);
    if (!code) return;

    const id = "mmd-" + Date.now().toString(36) + "-" + seq++;
    try {
      const { svg, bindFunctions } = await window.mermaid.render(id, code);
      el.innerHTML = svg;
      if (bindFunctions) bindFunctions(el);
      el.dataset.mmdDone = isDark() ? "dark" : "light";
      el.classList.remove("mermaid-error");
    } catch (err) {
      // The source, legibly, rather than a half-drawn diagram or mermaid's own
      // full-width error card appended to the end of the document.
      el.textContent = code;
      el.dataset.mmdDone = "";
      el.classList.add("mermaid-error");
    } finally {
      for (const stray of document.querySelectorAll("#" + id + ", #d" + id)) {
        if (!el.contains(stray)) stray.remove();
      }
    }
  }

  /**
   * @param {Element|Document} root  where to look
   * @param {boolean} force  redraw diagrams already drawn — the theme changed
   */
  async function paint(root, force) {
    if (!window.mermaid) return;
    if (!ready || force) configure();

    const want = isDark() ? "dark" : "light";
    const nodes = Array.from((root || document).querySelectorAll(SELECTOR)).filter(
      (el) => force || el.dataset.mmdDone !== want
    );
    // Serial: mermaid keeps one shared parser and one sandbox element, and
    // twenty diagrams started at once race each other through both.
    for (const el of nodes) await draw(el);
  }

  window.RedefineMermaid = { paint };

  const repaint = () => paint(document, false);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", repaint);
  } else {
    repaint();
  }

  try {
    swup.hooks.on("page:view", repaint);
  } catch (e) {}

  // Content decrypted into a page that is already open never reaches Swup's
  // `page:view`; plugins/vault.js announces it here instead.
  window.addEventListener("redefine:content-injected", repaint);

  // Every diagram is redrawn, because the palette lives in the SVG.
  window.addEventListener("redefine:color-scheme-change", () => paint(document, true));
})();
