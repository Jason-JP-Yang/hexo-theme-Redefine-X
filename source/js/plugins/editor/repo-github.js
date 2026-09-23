/**
 * The GitHub side of a save: three requests, one commit, one branch.
 *
 * What used to be here was a whole repository client — listings, blob reads,
 * conflict detection against a tree, a commit that assembled dozens of files
 * into the source of the site. None of it is needed: the editor reads from the
 * published site now, and what it writes is ONE sealed payload that only the
 * runner can open.
 *
 * ── Why the queue branch is rewritten rather than appended to ───────────────
 *
 * The runner empties it after every save by force-pushing a commit with no
 * parent, so the branch never holds more than one payload and checking it out
 * never costs more than the save itself. A push here therefore does not build
 * on what is there — it replaces it. Which is also what makes a refused save
 * cheap to undo: there is nothing behind it to preserve.
 *
 * ── The token ───────────────────────────────────────────────────────────────
 *
 * A fine-grained PAT on the PUBLIC repository with `Contents: read and write`,
 * `Metadata: read` and `Actions: read` — and deliberately NOT `Workflows`,
 * which is what makes GitHub itself refuse any write under
 * `.github/workflows/`. The workflow is the thing that decides whether a save
 * is legitimate, so a token that could edit it would decide for itself.
 */

const PAYLOAD = "payload.bin";

function url(repo, path) {
  return `${String(repo.api).replace(/\/+$/, "")}/repos/${repo.owner}/${repo.repo}${path}`;
}

async function call(repo, path, init, anonymous) {
  const res = await fetch(url(repo, path), {
    ...init,
    headers: {
      ...(anonymous ? {} : { Authorization: "Bearer " + repo.token }),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init && init.body ? { "Content-Type": "application/json" } : {}),
      ...((init && init.headers) || {}),
    },
  });
  if (res.status === 401) throw Object.assign(new Error("github rejected the token"), { status: 401 });
  return res;
}

async function json(repo, path, init, what) {
  const res = await call(repo, path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `${what} failed (${res.status})`);
  }
  return res.json();
}

/**
 * Push one sealed payload onto the queue branch.
 *
 * Rootless on purpose: `parents: []` means the branch carries this save and
 * nothing before it, so a refused save leaves no history to unpick and the
 * runner's checkout of it is one file deep.
 */
export async function pushQueue(repo, base64, message) {
  const branch = repo.queue || "editor-queue";

  const blob = await json(
    repo,
    "/git/blobs",
    { method: "POST", body: JSON.stringify({ content: base64, encoding: "base64" }) },
    "upload the save"
  );

  const tree = await json(
    repo,
    "/git/trees",
    {
      method: "POST",
      body: JSON.stringify({ tree: [{ path: PAYLOAD, mode: "100644", type: "blob", sha: blob.sha }] }),
    },
    "build the save"
  );

  const commit = await json(
    repo,
    "/git/commits",
    { method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: [] }) },
    "sign the save"
  );

  // force:true, because the branch is not a history. Anything on it is either a
  // save the runner has already applied and emptied, or one it refused.
  const ref = `/git/refs/heads/${encodeURIComponent(branch)}`;
  let push = await call(repo, ref, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });

  if (push.status === 404 || push.status === 422) {
    push = await call(repo, "/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    });
  }

  if (!push.ok) {
    const body = await push.json().catch(() => ({}));
    throw new Error(body.message || `the save could not be pushed (${push.status})`);
  }

  return { sha: commit.sha, short: commit.sha.slice(0, 7) };
}

/* ─── where the build has got to ───────────────────────────────────────────── */

const PENDING = /^(queued|in_progress|requested|waiting|pending)$/;

/**
 * Is a BUILD still running? Asked before a save, and answered anonymously.
 *
 * Scoped to the deploy workflow rather than to the repository. The repository
 * also runs a nightly reactions sweep, and a save refused because an unrelated
 * cron happened to be running would be a wait nobody could account for.
 */
export async function running(repo) {
  const file = repo.workflow || "deploy.yml";
  for (const status of ["in_progress", "queued"]) {
    const res = await call(
      repo,
      `/actions/workflows/${encodeURIComponent(file)}/runs?status=${status}&per_page=1`,
      null,
      true
    ).catch(() => null);
    if (!res || !res.ok) continue;
    const body = await res.json().catch(() => ({}));
    if ((body.workflow_runs || []).length) return true;
  }
  return false;
}

/** One page of a run query, or null — the shape every lookup below returns. */
async function runsPage(repo, path) {
  const res = await call(repo, path, null, true).catch(() => null);
  if (!res || !res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return body.workflow_runs || [];
}

/**
 * The run a SAVE was dispatched as.
 *
 * `workflow_dispatch` from `main` gives every run `head_sha: main`, so the
 * commit the save pushed is not on the run at all — the ONE place it appears is
 * the `run-name` the workflow formats out of its inputs, and `display_title` is
 * that string. Matched on the full commit id first, then its short form, since
 * the run-name is written with whichever the dispatcher named.
 */
async function dispatchedRun(repo, file, ref) {
  const short = String(ref).slice(0, 7);
  const runs = await runsPage(
    repo,
    `/actions/workflows/${encodeURIComponent(file)}/runs?event=workflow_dispatch&per_page=20`
  );
  if (!runs) return null;
  return (
    runs.find((run) => {
      const title = String(run.display_title || run.name || "");
      return title.includes(ref) || title.includes(short);
    }) || null
  );
}

// A run, once found, is read by its id: one request a poll instead of two
// searches, against an anonymous budget of sixty requests an hour.
const runs = new Map();

/** A job as the rail draws it. */
function stageOf(job) {
  const status = String(job.status || "").toLowerCase();
  if (status === "in_progress") return "live";
  if (PENDING.test(status)) return "wait";
  return job.conclusion === "success" || job.conclusion === "skipped" ? "done" : "fail";
}

/**
 * The run for one commit, as its three jobs — verify, build, deploy — each a
 * rail state. The run is over when deploy is, or when any job fails.
 *
 * Read WITHOUT a credential. The repository is public, so its runs are public,
 * which means the build rail keeps working after the session's token has been
 * erased — and an author watching a deploy is not holding a write credential
 * for the whole of it.
 */
export async function runStatus(repo, sha) {
  const ref = String(sha || "").trim();
  if (!ref) return null;

  const file = repo.workflow || "deploy.yml";
  let run = runs.get(ref);

  // Two ways to find the run, because there are two kinds of run. A push starts
  // one whose `head_sha` IS the commit. A save cannot push its way into a run —
  // the queue commit is rootless and carries no workflow file — so the Worker
  // dispatches it from `main` and names the queue commit only in `run-name`.
  // `head_sha` finds the first kind and never the second.
  if (!run) {
    const pushed = await runsPage(
      repo,
      `/actions/workflows/${encodeURIComponent(file)}/runs?head_sha=${encodeURIComponent(ref)}&per_page=1`
    );
    const found = (pushed && pushed[0]) || (await dispatchedRun(repo, file, ref));
    if (!found) return { state: "", url: "", count: 0, stages: {} };
    run = { id: found.id, url: found.html_url || "" };
    runs.set(ref, run);
  }

  const res = await call(repo, `/actions/runs/${run.id}/jobs?per_page=10`, null, true).catch(() => null);
  if (!res || !res.ok) return null;
  const body = await res.json().catch(() => ({}));
  const stages = {};
  for (const job of body.jobs || []) stages[job.name] = stageOf(job);

  const state = Object.values(stages).includes("fail") ? "failure" : stages.deploy === "done" ? "success" : "pending";
  return { state, url: run.url, count: 1, stages };
}
