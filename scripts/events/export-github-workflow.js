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
 *
 * `version.json` names the build every footer names. The deploy job polls it
 * until Vercel or Cloudflare Pages serves the build on main.
 */

const fs = require("fs");
const path = require("path");
const deploy = require("../lib/deploy");
const { version } = require("../../package.json");

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
  const enabled = deploy.resolve(hexo.theme.config).enable;

  const workflows = path.join(hexo.public_dir, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  for (const name of enabled ? ["deploy.yml", "masonry-reactions-cleanup.yml"] : ["masonry-reactions-cleanup.yml"]) {
    const file = path.join(from, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(workflows, name));
  }

  const ci = path.join(from, "ci");
  if (enabled && fs.existsSync(ci)) copyTree(ci, path.join(hexo.public_dir, "ci"));
});

let warned = false;

hexo.extend.generator.register("redefine_version", function () {
  const theme = hexo.theme.config || {};
  const settings = deploy.resolve(theme);

  if (!settings.enable) {
    const editor = (theme.backend || {}).online_editor || {};
    if (!warned && editor.repo && editor.verify_key) {
      warned = true;
      hexo.log.warn("[deploy] backend.online_editor needs deploy.enable: true — the editor is off for this build.");
    }
    return [];
  }

  const build = deploy.build();
  return {
    path: "version.json",
    data: JSON.stringify({
      build: build.id,
      time: build.time,
      theme: version,
      platform: settings.platform,
      url: String(hexo.config.url || "").replace(/\/+$/, "") + "/",
    }),
  };
});
