/**
 * The GitHub driver.
 *
 * Same contract as the Gitea driver, over an API that does two of the four
 * things differently — and the differences are not cosmetic.
 *
 * ── A save is not one request here ──────────────────────────────────────────
 *
 * Gitea has ChangeFiles: one POST carrying every file, one commit. GitHub's
 * contents API writes ONE file per commit, so a save that adds a post and three
 * pictures would be four commits and four builds, with a window in between
 * where the post references an image that is not there yet. The Git Data API is
 * the only way to keep the guarantee: blobs, then a tree, then a commit, then
 * one ref update. More requests, but still exactly one commit.
 *
 * ── Conflict detection has to be rebuilt ────────────────────────────────────
 *
 * Gitea rejects a write whose blob sha does not match what the editor loaded.
 * GitHub's ref update only rejects a non-fast-forward, which catches a
 * concurrent PUSH but not a concurrent edit of the same file from somewhere
 * else. So the tree is read once up front and every file is checked against it
 * — a backend that quietly accepted what the other refuses would be worse than
 * either behaviour on its own.
 *
 * ── The build reports somewhere else ────────────────────────────────────────
 *
 * GitHub Actions writes no commit status, so `/commits/{sha}/status` is empty
 * forever. The run itself is the answer, readable with `Actions: read`.
 *
 * The token is a fine-grained PAT scoped to this one repository with
 * `Contents: write`, `Metadata: read` and `Actions: read` — and deliberately
 * NOT `Workflows`, which is what makes GitHub itself refuse any write under
 * `.github/workflows/`. That refusal is this backend's half of the containment
 * Gitea gets from Protected File Patterns.
 */

import { decodeText } from "./repo-bytes.js";

const BLOB_PARALLEL = 4;

function base(b, path) {
  return `${String(b.api).replace(/\/+$/, "")}/repos/${b.owner}/${b.repo}${path}`;
}

async function call(b, path, init) {
  const res = await fetch(base(b, path), {
    ...init,
    headers: {
      Authorization: "Bearer " + b.token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init && init.body ? { "Content-Type": "application/json" } : {}),
      ...((init && init.headers) || {}),
    },
  });

  if (res.status === 401) {
    throw Object.assign(new Error("github rejected the token"), { status: 401 });
  }
  // 403 is how GitHub answers both "this PAT has no Workflows permission" and
  // "this blob is too large to return as JSON". The second is an answer the
  // caller handles, not a dead session, so only the first throws.
  if (res.status === 403) {
    const body = await res.clone().json().catch(() => ({}));
    if (!/too large|larger than/i.test(body.message || "")) {
      throw Object.assign(new Error(body.message || "github refused: the token may not do that"), {
        status: 403,
      });
    }
  }
  return res;
}

/* ─── where the branch is ──────────────────────────────────────────────────── */

export async function head(b, signal) {
  const res = await call(b, `/git/ref/heads/${encodeURIComponent(b.branch)}`, { signal });
  if (!res.ok) return "";
  const body = await res.json().catch(() => ({}));
  return (body.object && body.object.sha) || "";
}

export async function hasCommit(b, sha) {
  if (!sha) return false;
  const res = await call(b, `/git/commits/${encodeURIComponent(sha)}`);
  return res.ok;
}

/* ─── reads ────────────────────────────────────────────────────────────────── */

export async function list(b, dir) {
  const res = await call(b, `/contents/${encodeURI(dir)}?ref=${encodeURIComponent(b.branch)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`could not list ${dir}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [rows];
}

export async function read(b, path) {
  const res = await call(b, `/contents/${encodeURI(path)}?ref=${encodeURIComponent(b.branch)}`);
  if (res.status === 404) return null;

  if (res.ok) {
    const row = await res.json();
    // A file over 1 MB comes back with its metadata and an empty body; the
    // editor only ever reads markdown and the keyring, so this is the rare path.
    if (row.content) return { text: decodeText(row.content), sha: row.sha, path: row.path };
    if (row.sha) return { text: await blobText(b, row.sha), sha: row.sha, path: row.path };
  }

  // Over 1 MB GitHub answers 403 rather than returning metadata, so the sha has
  // to come from the parent listing.
  const dir = path.replace(/\/[^/]+$/, "");
  const row = (await list(b, dir === path ? "" : dir)).find((r) => r.path === path);
  if (!row) throw new Error(`could not read ${path}`);
  return { text: await blobText(b, row.sha), sha: row.sha, path: row.path };
}

async function blobText(b, sha) {
  const res = await call(b, `/git/blobs/${encodeURIComponent(sha)}`, {
    headers: { Accept: "application/vnd.github.raw" },
  });
  if (!res.ok) throw new Error("could not read the blob");
  return res.text();
}

export async function raw(b, path) {
  const res = await call(b, `/contents/${encodeURI(path)}?ref=${encodeURIComponent(b.branch)}`, {
    headers: { Accept: "application/vnd.github.raw" },
  });
  return res.ok ? res.blob() : null;
}

/* ─── the commit ───────────────────────────────────────────────────────────── */

async function json(b, path, init, what) {
  const res = await call(b, path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `${what} failed (${res.status})`);
  }
  return res.json();
}

/**
 * Every path in the branch tip, with its blob sha and mode.
 *
 * One request instead of one per file, and the mode matters: rebuilding an
 * entry as 100644 would silently drop the executable bit off anything that had
 * one. A truncated tree (100k entries) returns null and the caller checks the
 * few paths it is actually writing.
 */
async function treeIndex(b, treeSha) {
  const body = await json(b, `/git/trees/${encodeURIComponent(treeSha)}?recursive=1`, null, "read the tree");
  if (body.truncated) return null;
  const index = new Map();
  for (const row of body.tree || []) {
    if (row.type === "blob") index.set(row.path, { sha: row.sha, mode: row.mode });
  }
  return index;
}

async function entryAt(b, index, path, ref) {
  if (index) return index.get(path) || null;
  const res = await call(b, `/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`);
  if (!res.ok) return null;
  const row = await res.json().catch(() => null);
  return row && row.sha ? { sha: row.sha, mode: "100644" } : null;
}

function conflict(message) {
  return Object.assign(new Error(message), { kind: "conflict", status: 409 });
}

/** Blobs, in bounded parallel — a folder of photographs is not four requests. */
async function uploadBlobs(b, files) {
  const shas = new Map();
  const queue = files.filter((f) => f.content != null);

  for (let i = 0; i < queue.length; i += BLOB_PARALLEL) {
    const slice = queue.slice(i, i + BLOB_PARALLEL);
    const made = await Promise.all(
      slice.map((f) =>
        json(
          b,
          "/git/blobs",
          { method: "POST", body: JSON.stringify({ content: f.content, encoding: "base64" }) },
          `upload ${f.path}`
        )
      )
    );
    slice.forEach((f, n) => shas.set(f.path, made[n].sha));
  }
  return shas;
}

export async function commit(b, files, message) {
  const ref = `heads/${b.branch}`;

  const refBody = await json(b, `/git/ref/${ref}`, null, "read the branch");
  const parent = refBody.object.sha;
  const parentCommit = await json(b, `/git/commits/${parent}`, null, "read the branch tip");
  const index = await treeIndex(b, parentCommit.tree.sha);

  // Gitea's per-file guarantee, reproduced: a file that moved underneath us is
  // a rejection, and a create whose path already exists is too.
  for (const file of files) {
    const at = await entryAt(b, index, file.path, parent);
    if (file.operation === "create" && at) {
      throw conflict(`${file.path} already exists in the repository`);
    }
    if (file.operation !== "create") {
      if (!at) throw conflict(`${file.path} is no longer in the repository`);
      if (file.sha && at.sha !== file.sha) {
        throw conflict(`${file.path} changed in the repository`);
      }
    }
  }

  const blobs = await uploadBlobs(b, files);

  const tree = files.map((file) => {
    const at = index ? index.get(file.path) : null;
    if (file.operation === "delete") {
      return { path: file.path, mode: (at && at.mode) || "100644", type: "blob", sha: null };
    }
    return {
      path: file.path,
      mode: (at && at.mode) || "100644",
      type: "blob",
      sha: blobs.get(file.path),
    };
  });

  const made = await json(
    b,
    "/git/trees",
    { method: "POST", body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree }) },
    "build the tree"
  );

  const author = { name: b.author.name, email: b.author.email };
  const commitBody = await json(
    b,
    "/git/commits",
    {
      method: "POST",
      body: JSON.stringify({ message, tree: made.sha, parents: [parent], author, committer: author }),
    },
    "create the commit"
  );

  // force:false — anything that landed on the branch while this was assembling
  // makes the update a non-fast-forward, which is the same answer Gitea gives.
  const push = await call(b, `/git/refs/${ref}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commitBody.sha, force: false }),
  });
  if (!push.ok) {
    const body = await push.json().catch(() => ({}));
    if (push.status === 422) throw conflict(body.message || "the branch moved while saving");
    throw new Error(body.message || `commit failed (${push.status})`);
  }

  return { sha: commitBody.sha, short: commitBody.sha.slice(0, 7) };
}

/* ─── the build ────────────────────────────────────────────────────────────── */

const PENDING = /^(queued|in_progress|requested|waiting|pending)$/;

export async function runStatus(b, sha) {
  const ref = String(sha || "").trim();
  if (!ref) return null;

  const file = b.workflow || "deploy.yml";
  let res;
  try {
    res = await call(
      b,
      `/actions/workflows/${encodeURIComponent(file)}/runs?head_sha=${encodeURIComponent(ref)}&per_page=1`
    );
  } catch (err) {
    return null;
  }
  if (!res.ok) return null;

  const body = await res.json().catch(() => ({}));
  const run = (body.workflow_runs || [])[0];
  if (!run) return { state: "", url: "", count: 0 };

  const status = String(run.status || "").toLowerCase();
  const conclusion = String(run.conclusion || "").toLowerCase();
  const state = PENDING.test(status)
    ? "pending"
    : conclusion === "success"
      ? "success"
      : conclusion
        ? "failure"
        : "pending";

  return { state, url: run.html_url || "", count: 1 };
}
