/**
 * Add the runs finished since the last artifact to version.json.
 *
 * version.json is the deploy record: the build it names, and how long each job
 * of the last few runs waited for a runner and took over each step. The publish
 * rail (source/js/plugins/editor/rail.js) reads it once to know what share of a
 * job each step is. A run cannot record itself — its artifact is committed
 * before it ends — so each build records the runs before it; the generator
 * carries the list forward between builds (scripts/events/export-github-workflow.js).
 *
 * Only jobs that succeeded are kept: a failed step's duration is how long it
 * took to fail, not how long it takes. A skipped step is kept as taking no time,
 * which is what it will take the next time it is skipped.
 *
 * Usage, from the artifact directory:  node <theme>/workflows/ci/record-run.mjs .
 */

import fs from "node:fs";
import path from "node:path";

const KEEP = 10;
const LOOK_BACK = 5;

const { GITHUB_API_URL = "https://api.github.com", GITHUB_REPOSITORY, GITHUB_RUN_ID, GH_TOKEN } = process.env;
const file = path.join(process.argv[2] || ".", "version.json");

async function api(route) {
  const res = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${route}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  return res.ok ? res.json() : null;
}

const seconds = (from, to) => Math.round(Math.max(0, Date.parse(to) - Date.parse(from)) / 100) / 10;

let version;
try {
  version = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  process.exit(0);
}

const runs = Array.isArray(version.runs) ? version.runs : [];
const known = new Set(runs.map((run) => String(run.id)));
const list = await api(`/actions/workflows/deploy.yml/runs?status=completed&per_page=${LOOK_BACK}`);

for (const run of (list && list.workflow_runs) || []) {
  if (String(run.id) === GITHUB_RUN_ID || known.has(String(run.id))) continue;
  const body = await api(`/actions/runs/${run.id}/jobs?per_page=20`);
  const jobs = {};
  for (const job of (body && body.jobs) || []) {
    if (job.conclusion !== "success" || !job.started_at) continue;
    jobs[job.name] = {
      queue: seconds(job.created_at, job.started_at),
      steps: (job.steps || [])
        .filter((step) => step.conclusion === "skipped" || (step.conclusion === "success" && step.started_at && step.completed_at))
        .map((step) => [step.name, step.conclusion === "skipped" ? 0 : seconds(step.started_at, step.completed_at)]),
    };
  }
  if (Object.keys(jobs).length) runs.push({ id: run.id, at: run.run_started_at || run.created_at, jobs });
}

version.runs = runs.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, KEEP);
fs.writeFileSync(file, JSON.stringify(version));
process.stdout.write(`version.json records ${version.runs.length} run(s)\n`);
