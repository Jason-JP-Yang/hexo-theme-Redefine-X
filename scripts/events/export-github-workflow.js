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
 * `ci/deploy.json` is the `deploy:` block as the workflow needs it (see
 * scripts/lib/deploy.js). `version.json` is the deploy record: the build every
 * footer names, which the deploy job polls until Vercel or Cloudflare Pages
 * serves main, and the recent runs' timings the publish rail estimates from.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
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
  const settings = deploy.resolve(hexo.theme.config, hexo.config.url);

  const workflows = path.join(hexo.public_dir, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  for (const name of settings.enable ? ["deploy.yml", "masonry-reactions-cleanup.yml"] : ["masonry-reactions-cleanup.yml"]) {
    const file = path.join(from, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(workflows, name));
  }

  if (!settings.enable) return;
  const ci = path.join(hexo.public_dir, "ci");
  copyTree(path.join(from, "ci"), ci);
  const { enable, ...shipped } = settings;
  fs.writeFileSync(path.join(ci, "deploy.json"), JSON.stringify(shipped, null, 2) + "\n");
  if (!settings.email) hexo.log.warn("[deploy] deploy.email is empty — the workflow has nobody to commit as.");
});

let warned = false;

hexo.extend.generator.register("redefine_version", function () {
  const theme = hexo.theme.config || {};

  if (!deploy.resolve(theme).enable) {
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
    data: JSON.stringify({ build: build.id, time: build.time, theme: version, runs: recordedRuns() }),
  };
});

/**
 * The runs the last artifact recorded (workflows/ci/record-run.mjs), carried
 * into this one. Read from git rather than the file: `hexo clean` has emptied
 * public/ by now, but its `.git` is kept, and HEAD is the artifact last built.
 */
function recordedRuns() {
  try {
    const text = execFileSync("git", ["show", "HEAD:version.json"], {
      cwd: hexo.public_dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const runs = JSON.parse(text).runs;
    return Array.isArray(runs) ? runs : [];
  } catch {
    return [];
  }
}
