"use strict";

/**
 * Put the deploy machinery into the artifact, because the artifact repository
 * is where it runs.
 *
 * The private repository has no workflow of its own any more — nothing there
 * may run code, since the credentials a build needs are exactly the ones an
 * editing session must never reach. So the one workflow, and the scripts it
 * calls, are copied into `public/` on every build and travel to the public
 * repository with the site.
 *
 * `ci/` is deliberately at the artifact's root rather than under `.github/`:
 * the runner's own token cannot write under `.github/workflows/`, so a change
 * to the workflow file has to arrive from a build at home — while `ci/` is
 * ordinary content the runner can carry forward like anything else.
 */

const fs = require("fs");
const path = require("path");

/** Copy a directory tree, creating what is missing and overwriting what is not. */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

hexo.extend.filter.register("after_generate", function () {
  const from = path.join(hexo.theme_dir, "workflows");

  const workflows = path.join(hexo.public_dir, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  for (const name of ["deploy.yml", "masonry-reactions-cleanup.yml"]) {
    const file = path.join(from, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(workflows, name));
  }

  const ci = path.join(from, "ci");
  if (fs.existsSync(ci)) copyTree(ci, path.join(hexo.public_dir, "ci"));
});
