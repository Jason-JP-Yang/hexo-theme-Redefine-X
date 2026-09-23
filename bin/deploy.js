#!/usr/bin/env node
"use strict";

/**
 * A local build, committed where the deploy workflow takes it. Run from the
 * SITE root: `npm run deploy`, then `cd public && git push`.
 *
 *   1. Refuses a source that is behind its upstream. The build is a whole new
 *      site, so a stale source would publish over saves the editor made since.
 *      `npm run deploy -- --force` builds anyway.
 *   2. `hexo clean` + `hexo generate`.
 *   3. Commits public/ GPG-signed — what verify checks — onto `publish` when a
 *      ruleset locks main to the deploy key, else onto `main`.
 *   4. Points that branch's upstream at the same name on origin, so a plain
 *      `git push` sends it.
 *
 * The commit is made on top of origin's copy of the branch without touching a
 * file: the branch ref moves, and the index is rebuilt from the tree the build
 * just wrote. A checkout would refuse, with every page modified.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const https = require("https");
const path = require("path");

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "public");
const FORCE = process.argv.includes("--force");

function fail(message) {
  console.error(`[deploy] ${message}`);
  process.exit(1);
}

function git(args, { cwd = PUBLIC, soft = false, inherit = false } = {}) {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: inherit ? "inherit" : "pipe",
  });
  if (run.status !== 0 && !soft) fail(`git ${args.join(" ")} failed${run.stderr ? `\n${run.stderr.trim()}` : ""}`);
  return run.status === 0 ? String(run.stdout || "").trim() : null;
}

function npm(script) {
  const run = spawnSync("npm", ["run", script], { cwd: ROOT, stdio: "inherit", shell: true, windowsHide: true });
  if (run.status !== 0) fail(`npm run ${script} failed`);
}

/** Whether a ruleset restricts updates to `main` — the deploy-key setup. Null when GitHub cannot say. */
function mainLocked(repo) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.github.com/repos/${repo}/rules/branches/main`,
      { headers: { "User-Agent": "redefine-x-deploy", Accept: "application/vnd.github+json" }, timeout: 8000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const rules = JSON.parse(body);
            resolve(Array.isArray(rules) ? rules.some((rule) => rule && rule.type === "update") : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

(async () => {
  if (!fs.existsSync(path.join(PUBLIC, ".git"))) fail("public/ is not a git checkout of the site repository.");

  if (!FORCE) {
    git(["fetch", "--quiet"], { cwd: ROOT, soft: true });
    const behind = Number(git(["rev-list", "--count", "HEAD..@{u}"], { cwd: ROOT, soft: true }) || 0);
    if (behind > 0) {
      fail(`the source is ${behind} commit(s) behind its upstream — pull first, or run with --force.`);
    }
  }

  npm("clean");
  npm("build");

  const url = git(["remote", "get-url", "origin"]);
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url || "");
  if (!match) fail(`origin (${url}) is not a GitHub repository.`);
  git(["fetch", "--quiet", "origin"], { soft: true });

  let branch = "main";
  const locked = await mainLocked(match[1]);
  if (locked === null) {
    const current = git(["rev-parse", "--abbrev-ref", "HEAD"], { soft: true });
    if (current === "publish") branch = current;
    console.warn(`[deploy] GitHub did not say whether main is locked; committing to ${branch}.`);
  } else if (locked) {
    branch = "publish";
  }

  const has = (ref) => git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { soft: true });
  const base = has(`origin/${branch}`) || has("origin/main") || has("HEAD");
  if (!base) fail("found nothing to commit on top of — fetch origin first.");

  git(["update-ref", `refs/heads/${branch}`, base]);
  git(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  git(["add", "-A"]);

  if (git(["diff", "--cached", "--quiet"], { soft: true }) !== null) {
    console.log(`[deploy] public/ is identical to origin/${branch} — nothing to commit.`);
  } else {
    let build = "";
    try {
      build = JSON.parse(fs.readFileSync(path.join(PUBLIC, "version.json"), "utf8")).build || "";
    } catch {}
    const stamp = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
    const message = ["-m", `Site updated: ${stamp}`];
    if (build) message.push("-m", `Build: ${build}`);
    git(["commit", "-S", "-q", ...message], { inherit: true });
  }

  git(["config", `branch.${branch}.remote`, "origin"]);
  git(["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);

  console.log(
    `[deploy] ${git(["rev-parse", "--short", "HEAD"])} on ${branch}, upstream origin/${branch}. Next: cd public && git push`
  );
})();
