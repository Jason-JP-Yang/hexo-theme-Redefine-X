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
 * rendered diagram no longer contains the text it was made from.
 *
 * `theme` is baked into the SVG — colours, strokes and text are written into
 * the markup, not read from a stylesheet — so each diagram is drawn under BOTH
 * schemes, the one not showing while the page is idle. A light/dark switch then
 * swaps the SVG inside the same style pass as everything else, and the diagram
 * changes with the wave instead of after it.
 */

(function () {
  if (!window.theme?.plugins?.mermaid?.enable) return;

  const SELECTOR = "pre.mermaid, div.mermaid";
  const drawn = new WeakMap(); // element -> { light, dark }: { svg, bind } | { error }
  let seq = 0;
  let queue = Promise.resolve();

  const scheme = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 300));

  // Serial: mermaid keeps one shared parser, one sandbox element and one global
  // configuration, and drawings started at once race each other through all
  // three. The editor's diagrams queue here too.
  const serial = (job) => (queue = queue.then(job, job));

  /** The diagram's own text, kept where the drawing will overwrite it. */
  function sourceOf(el) {
    if (el.dataset.mmdSrc == null) el.dataset.mmdSrc = el.textContent.trim();
    return el.dataset.mmdSrc;
  }

  async function render(code, s) {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: s === "dark" ? "dark" : "default",
      // A diagram is authored by the person who owns the repository, and
      // `loose` is what lets click-handlers and HTML labels work. It is the
      // same trust boundary every other tag in a post already has.
      securityLevel: "loose",
      suppressErrorRendering: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-family") || undefined,
    });
    const id = "mmd-" + Date.now().toString(36) + "-" + seq++;
    try {
      const { svg, bindFunctions } = await window.mermaid.render(id, code);
      return { svg, bind: bindFunctions };
    } catch (err) {
      return { error: true };
    } finally {
      for (const stray of document.querySelectorAll("#" + id + ", #d" + id)) stray.remove();
    }
  }

  async function draw(el, s) {
    const code = sourceOf(el);
    if (!code) return;
    const both = drawn.get(el) || {};
    if (!both[s]) both[s] = await render(code, s);
    drawn.set(el, both);
  }

  /** Puts up the drawing for `s`, if there is one yet. */
  function show(el, s) {
    const d = drawn.get(el)?.[s];
    if (!d) return false;
    if (d.error) {
      // The source, legibly, rather than a half-drawn diagram or mermaid's own
      // full-width error card appended to the end of the document.
      el.textContent = sourceOf(el);
      el.classList.add("mermaid-error");
    } else {
      el.innerHTML = d.svg;
      d.bind?.(el);
      el.classList.remove("mermaid-error");
    }
    el.dataset.mmdDone = s;
    return true;
  }

  // Until it shows the scheme the page is in — which can change mid-drawing.
  async function bring(el) {
    if (!sourceOf(el)) return;
    while (el.dataset.mmdDone !== scheme()) {
      const s = scheme();
      await draw(el, s);
      if (scheme() === s) show(el, s);
    }
  }

  function paint(root) {
    return serial(async () => {
      if (!window.mermaid) return;
      const nodes = Array.from((root || document).querySelectorAll(SELECTOR));
      for (const el of nodes) await bring(el);
      idle(() => drawOther(nodes));
    });
  }

  function drawOther(nodes) {
    serial(async () => {
      for (const el of nodes) {
        const s = scheme() === "dark" ? "light" : "dark";
        if (el.isConnected && !drawn.get(el)?.[s]) await draw(el, s);
      }
    });
  }

  window.RedefineMermaid = { paint, serial };

  const repaint = () => paint(document);

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

  // Runs inside the switch's style pass, so a diagram changes with everything
  // else. One not yet drawn under the new scheme (toggled straight after load)
  // fades in when it is.
  window.addEventListener("redefine:color-scheme-change", () => {
    const s = scheme();
    const late = [];
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (el.dataset.mmdDone && el.dataset.mmdDone !== s && !show(el, s)) late.push(el);
    }
    if (!late.length) return;
    serial(async () => {
      for (const el of late) {
        await bring(el);
        el.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
      }
    });
  });
})();
