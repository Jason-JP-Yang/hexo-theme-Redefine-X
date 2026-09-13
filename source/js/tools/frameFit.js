/**
 * The page as Umami's heatmap report needs to see it.
 *
 * THE BUG THIS EXISTS FOR
 * ───────────────────────
 * The report loads the live page in an iframe and sizes that iframe to the
 * WHOLE document — thousands of pixels tall. Inside a frame, viewport units
 * resolve against the frame, so `min-height: 100svh` on the home banner became
 * "as tall as the entire page". The banner swallowed the document, the grid fell
 * off the bottom, and every recorded click was drawn against the wrong y.
 * Because the frame height came from the visitor's own page height, each screen
 * width bucket rendered a differently broken page.
 *
 * THE FIX, BOTH ENDS
 * ──────────────────
 * The report now names the visitor's real viewport in the URL fragment, which
 * head.ejs turns into `--frame-vh` before the first paint. This file does the
 * rest: it holds the page still, then tells the report how tall the document
 * actually came out so the frame can be sized to it. A site that does not answer
 * gets the report's old guess, so nothing here is required of anyone else.
 */

const MESSAGE = "umami-frame-size";
const SETTLE_MS = 400;

let posted = 0;
let timer = null;

export function isFramed() {
  return !!window.__umamiFramed;
}

function report() {
  const doc = document.documentElement;
  const height = Math.max(
    doc.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
  );
  // Only when it has actually moved. The observer below fires on every lazy
  // image that lands, and a frame resize triggers another round of them.
  if (!height || Math.abs(height - posted) < 8) return;
  posted = height;
  try {
    window.parent.postMessage({ type: MESSAGE, height }, "*");
  } catch {}
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(report, SETTLE_MS);
}

/**
 * Everything that makes the page move on its own. A heatmap is drawn over a
 * still frame, so a preloader that fades, a subtitle that types itself and
 * covers that drift on scroll are all noise the report would have to guess past.
 */
function freeze() {
  const style = document.createElement("style");
  style.textContent = `
    [data-framed="umami"] .preloader,
    [data-framed="umami"] .progress-bar-container,
    [data-framed="umami"] .side-tools-container,
    [data-framed="umami"] .post-tools-container { display: none !important; }
    [data-framed="umami"] *,
    [data-framed="umami"] *::before,
    [data-framed="umami"] *::after {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
    }
    /* The whole point: viewport units bound to the visitor's screen, not to a
       frame that is as tall as the document. */
    [data-framed="umami"] .home-banner-container { min-height: var(--frame-vh) !important; }
    [data-framed="umami"] .home-banner-container .description { min-height: calc(var(--frame-vh) * 0.9) !important; }
    [data-framed="umami"] .home-banner-background { height: var(--frame-vh) !important; }
  `;
  document.head.appendChild(style);

  // Lazy images never enter the viewport in a frame that is never scrolled, so
  // the snapshot would be a page of empty boxes with the real content below
  // where it belongs.
  document.querySelectorAll("img[loading='lazy']").forEach((img) => {
    img.loading = "eager";
    const src = img.getAttribute("data-src");
    if (src && !img.getAttribute("src")) img.src = src;
  });
}

export default function initFrameFit() {
  if (!isFramed()) return;

  freeze();
  schedule();

  window.addEventListener("load", schedule);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);

  if (typeof ResizeObserver !== "undefined" && document.body) {
    new ResizeObserver(schedule).observe(document.body);
  }
}
