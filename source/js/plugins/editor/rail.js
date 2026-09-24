/**
 * The publish rail — Commit → Verify → Build → Deploy — shared by the post
 * editor, the album editor and Blog Management's unpublish bar.
 *
 * Commit is the save reaching the repository, and its bubble fills with the
 * bytes the upload has actually sent. Verify, Build and Deploy are the three
 * jobs of the Actions run that save started, read with the reader's own GitHub
 * token (repo-github.js); each fills with how far through its steps the job is.
 *
 * ── How far through a job ───────────────────────────────────────────────────
 *
 * Steps are not equal: the build's render is most of the build. Each step is
 * given the share of the job it took in the runs recorded in version.json
 * (workflows/ci/record-run.mjs), the runner queue included, and a job is as far
 * along as the shares of its finished steps plus the running step's elapsed
 * time — which never passes 95% of that step's OWN share. A slow step therefore
 * waits at its own edge; it can never carry the fill into steps that have not
 * started. With no record yet, every step is given the same share.
 *
 * The fill is drawn every frame, closes on the estimate smoothly, and only
 * moves forward. A stage whose job has finished completes its fill first and
 * only then turns to its done colour, so the eye follows one continuous motion.
 */

import { EASE, pop, reduced } from "./motion.js";
import { siteRoot } from "../../tools/vaultCrypto.js";

const STAGES = [
  ["commit", "fa-code-commit", ["Commit", "Committing", "Committed", "Commit failed"]],
  ["verify", "fa-shield-check", ["Verify", "Verifying", "Verified", "Verify failed"]],
  ["build", "fa-hammer", ["Build", "Building", "Built", "Build failed"]],
  ["deploy", "fa-globe", ["Deploy", "Deploying", "Deployed", "Deploy failed"]],
];
const STATES = ["wait", "live", "done", "fail"];
const JOBS = ["verify", "build", "deploy"];

// With the reader's token GitHub allows 5,000 reads an hour; one every two
// seconds is 1,800. Without it the budget is sixty, and the rail slows down.
const POLL_MS = 2000;
const ANON_POLL_MS = 6000;
const GIVE_UP_MS = 30 * 60 * 1000;

const escapeHTML = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const STEP_CAP = 0.95;
const DEFAULT_QUEUE_S = 10;
const DEFAULT_STEP_S = 4;
// How quickly the drawn fill closes on the estimate, and the slowest it may
// move while doing so — so a finished stage completes in well under two seconds.
const CLOSE_RATE = 7;
const MIN_SPEED = 0.6;

function median(values) {
  const sorted = values.filter((v) => typeof v === "number" && v >= 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined;
}

/** The runs version.json records, newest first. */
async function loadRecord() {
  try {
    const res = await fetch(`${siteRoot()}/version.json?t=${Date.now()}`, { cache: "no-store" });
    const runs = res.ok ? (await res.json()).runs : null;
    return Array.isArray(runs) ? runs : [];
  } catch {
    return [];
  }
}

/**
 * Per job: the median runner queue, the median of each step by name, and the
 * step list of the newest run that had the job — what a job that has not
 * started yet is expected to consist of.
 */
function baselines(runs) {
  const out = {};
  for (const name of JOBS) {
    const queue = [];
    const steps = new Map();
    let order = null;
    for (const run of runs) {
      const job = run && run.jobs && run.jobs[name];
      if (!job) continue;
      queue.push(job.queue);
      if (!order && Array.isArray(job.steps)) order = job.steps.map(([step]) => step);
      for (const [step, seconds] of job.steps || []) {
        if (!steps.has(step)) steps.set(step, []);
        steps.get(step).push(seconds);
      }
    }
    out[name] = {
      queue: Math.max(median(queue) ?? DEFAULT_QUEUE_S, 1),
      steps: new Map([...steps].map(([step, list]) => [step, median(list) ?? DEFAULT_STEP_S])),
      order: order || [],
    };
  }
  return out;
}

const share = (elapsed, expected) => (expected > 0 ? Math.min(Math.max(elapsed, 0) / expected, STEP_CAP) * expected : 0);

/** 0–1: how far through its queue and steps a job is, at `now`. */
function estimate(job, base, since, now) {
  const seconds = (step) => base.steps.get(step) ?? DEFAULT_STEP_S;
  const steps =
    job && Array.isArray(job.steps) && job.steps.length
      ? job.steps
      : base.order.map((name) => ({ name, status: "queued" }));
  const total = base.queue + steps.reduce((sum, step) => sum + seconds(step.name), 0);

  if (!job || !job.started_at) {
    const from = job && job.created_at ? Date.parse(job.created_at) : since;
    return share((now - from) / 1000, base.queue) / total;
  }

  let done = base.queue;
  for (const step of steps) {
    if (step.status === "completed") {
      done += seconds(step.name);
      continue;
    }
    if (step.status === "in_progress" && step.started_at) {
      done += share((now - Date.parse(step.started_at)) / 1000, seconds(step.name));
    }
    break;
  }
  return done / total;
}

/**
 * @param {Element} host   the `.ed-progress` box the rail is drawn in
 * @param {object} options { repo, t, onDone, onFail(stageKey) }
 */
export function createRail(host, { repo, t, onDone, onFail }) {
  if (host._rail) host._rail.stop();

  const label = (key, state) => {
    const [, , words] = STAGES.find(([k]) => k === key);
    return t(`r_${key}_${state}`, words[STATES.indexOf(state)]);
  };

  host.hidden = false;
  host.innerHTML =
    STAGES.map(
      ([key, icon]) =>
        `<span class="ed-stage" data-key="${key}" data-state="wait">` +
        `<span class="ed-stage-fill" aria-hidden="true"></span>` +
        `<i class="fa-solid ${icon}" aria-hidden="true"></i>` +
        `<span class="ed-stage-label">${escapeHTML(label(key, "wait"))}</span></span>`
    ).join("") +
    `<a class="ed-stage-link" target="_blank" rel="noopener" hidden>${escapeHTML(t("view_run", "View run"))}</a>`;
  pop(host);

  const link = host.querySelector(".ed-stage-link");
  const stages = STAGES.map(([key]) => {
    const node = host.querySelector(`.ed-stage[data-key="${key}"]`);
    return {
      key,
      node,
      text: node.querySelector(".ed-stage-label"),
      state: "wait",
      target: 0,
      shown: 0,
      finishing: false,
      job: null,
      since: 0,
    };
  });
  const byKey = (key) => stages.find((stage) => stage.key === key);

  let base = baselines([]);
  loadRecord().then((runs) => (base = baselines(runs)));

  let stopped = false;
  let halted = false;
  let sha = "";
  let timer = 0;
  let frameId = 0;
  let last = 0;
  let begun = Date.now();

  /** A width that follows its new words, and words that fade in, not jump. */
  function swapText(stage, words) {
    const { node, text } = stage;
    if (text.textContent === words) return;
    if (reduced() || !node.isConnected) {
      text.textContent = words;
      return;
    }
    const from = node.getBoundingClientRect().width;
    text.textContent = words;
    const to = node.getBoundingClientRect().width;
    if (Math.abs(to - from) > 0.5) {
      node.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: 260, easing: EASE });
    }
    text.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
  }

  function setState(stage, state) {
    if (stage.state === state) return;
    stage.state = state;
    stage.node.dataset.state = state;
    swapText(stage, label(stage.key, state));
    if (state === "live") {
      stage.since = Date.now();
      stage.shown = stage.target = 0;
      stage.node.style.setProperty("--p", "0");
    }
  }

  /** The stage after `stage` goes live — or the rail is done. */
  function advance(stage) {
    setState(stage, "done");
    const next = stages[stages.indexOf(stage) + 1];
    if (next && !halted) return void setState(next, "live");
    stopAll();
    if (!halted && onDone) onDone();
  }

  function frame(time) {
    frameId = 0;
    if (stopped) return;
    const dt = last ? Math.min((time - last) / 1000, 0.1) : 0;
    last = time;
    const now = Date.now();

    for (const stage of stages) {
      if (stage.state !== "live") continue;
      if (stage.finishing) stage.target = 1;
      else if (stage.key !== "commit") {
        stage.target = Math.max(stage.target, estimate(stage.job, base[stage.key], stage.since, now));
      }

      const gap = stage.target - stage.shown;
      if (reduced()) stage.shown = stage.target;
      else if (gap > 0) stage.shown = Math.min(stage.target, stage.shown + Math.max(gap * Math.min(1, dt * CLOSE_RATE), dt * MIN_SPEED));
      stage.node.style.setProperty("--p", stage.shown.toFixed(4));

      if (stage.finishing && stage.shown >= 0.999) advance(stage);
    }
    if (!stopped) frameId = requestAnimationFrame(frame);
  }

  function fail(key) {
    const failing = byKey(key);
    for (const stage of stages.slice(0, stages.indexOf(failing))) {
      if (stage.state !== "done") setState(stage, "done");
    }
    setState(failing, "fail");
    stopAll();
    if (onFail) onFail(key);
  }

  function apply(status) {
    if (status.url) {
      link.href = status.url;
      link.hidden = false;
    }
    const jobs = new Map((status.jobs || []).map((job) => [job.name, job]));
    for (const key of JOBS) {
      const job = jobs.get(key);
      if (!job) continue;
      const stage = byKey(key);
      stage.job = job;
      if (job.status !== "completed") continue;
      if (job.conclusion === "success" || job.conclusion === "skipped") stage.finishing = true;
      else return void fail(key);
    }
  }

  async function poll() {
    timer = 0;
    if (stopped) return;
    if (Date.now() - begun > GIVE_UP_MS) return void stopAll();
    const status = await repo.commitStatus(sha).catch(() => null);
    if (stopped) return;
    if (status && status.count) apply(status);
    if (!stopped) timer = setTimeout(poll, status && status.authed === false ? ANON_POLL_MS : POLL_MS);
  }

  function stopAll() {
    stopped = true;
    clearTimeout(timer);
    if (frameId) cancelAnimationFrame(frameId);
    releaseCommit();
  }

  const releaseCommit = repo.watchCommit((fraction) => {
    const commit = byKey("commit");
    commit.target = Math.max(commit.target, Math.min(fraction, 1));
  });

  setState(byKey("commit"), "live");
  frameId = requestAnimationFrame(frame);

  const rail = {
    /** The save is in the repository; follow its run if one was started. */
    committed(result) {
      releaseCommit();
      byKey("commit").finishing = true;
      // Committed, but no run was started for it: nothing further will happen.
      if (!result || result.started === false || !result.sha) {
        halted = true;
        return;
      }
      sha = result.sha;
      begun = Date.now();
      poll();
    },
    fail,
    stop: stopAll,
  };
  host._rail = rail;
  return rail;
}
