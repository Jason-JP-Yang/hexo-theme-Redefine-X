/**
 * The admin surface's front door: Blog Management and the editor.
 *
 * A reader downloads any of it. The console's page is only a probe, opened by
 * plugins/admin-gate.js once the Worker releases the admin key; an editor is
 * imported only when `html.blog-admin` is set and the page carries its pencil.
 *
 * WHICH editor is decided by the pencil, not by the page: an album and an
 * article are two documents with two document models, and the pencil an album
 * page renders is the only one that says so before anything has been loaded.
 */

function boot() {
  if (document.querySelector("[data-admin-gate]")) {
    import("./admin-gate.js").then((module) => module.default()).catch(() => {});
  }

  if (!document.documentElement.classList.contains("blog-admin")) return;

  if (document.querySelector(".tool-edit-album")) {
    import("./editor/masonry.js").then((module) => module.initMasonryEditor()).catch(() => {});
  } else if (document.querySelector(".tool-edit-post")) {
    import("./editor/index.js").then((module) => module.initEditor()).catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", boot);

try {
  swup.hooks.on("page:view", boot);
} catch (e) {}
