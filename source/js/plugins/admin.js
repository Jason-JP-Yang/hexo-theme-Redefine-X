/**
 * The admin surface's front door: Blog Management and the editor.
 *
 * A reader downloads neither. The console's page is only a probe, opened by
 * plugins/admin-gate.js once the Worker releases the admin key; the editor is
 * imported only when `html.blog-admin` is set and the page carries a pencil.
 */

function boot() {
  if (document.querySelector("[data-admin-gate]")) {
    import("./admin-gate.js").then((module) => module.default()).catch(() => {});
  }

  if (
    document.documentElement.classList.contains("blog-admin") &&
    document.querySelector(".tool-edit-post")
  ) {
    import("./editor/index.js").then((module) => module.initEditor()).catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", boot);

try {
  swup.hooks.on("page:view", boot);
} catch (e) {}
