/**
 * Loads the native giscus widget (giscus-widget.js) once a page has one, then
 * hands it every page view so the widgets of pages left behind are let go.
 */

let widget = null;

function init() {
  if (widget) return void widget.then((m) => m.init());
  if (!document.querySelector(".giscus[data-giscus]")) return;
  widget = import("./giscus-widget.js").then((m) => (m.init(), m));
}

document.addEventListener("DOMContentLoaded", init);

try {
  swup.hooks.on("page:view", init);
} catch (e) {}
