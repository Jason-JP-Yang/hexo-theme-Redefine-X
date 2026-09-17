/**
 * The Gitea driver.
 *
 * Every read and every write is one request from the browser to Gitea. The
 * Worker is not in this path, which is what keeps a save carrying twenty
 * megabytes of images off a 10 ms CPU budget.
 *
 * What stands in for a server-side path allowlist is Gitea's own branch
 * protection: a dedicated account with `write:repository` on the content
 * repository only, and Protected File Patterns on `main` covering
 * `.github/**`, `.gitea/**`, `package.json`, `package-lock.json`, `bin/**`,
 * `themes/**`, `.gitmodules` and `_config.yml`. Without that last set a stolen
 * admin session can rewrite the workflow and get code execution on a runner
 * holding VAULT_MASTER.
 */

import { decodeText } from "./repo-bytes.js";

function base(b, path) {
  return `${String(b.api).replace(/\/+$/, "")}/repos/${b.owner}/${b.repo}${path}`;
}

async function call(b, path, init) {
  const res = await fetch(base(b, path), {
    ...init,
    headers: {
      Authorization: "token " + b.token,
      Accept: "application/json",
      ...(init && init.body ? { "Content-Type": "application/json" } : {}),
      ...((init && init.headers) || {}),
    },
  });

  // 401 is "this ticket is no longer good"; 403 is "this token may not do THAT",
  // which a fresh ticket cannot fix. Throwing the ticket away on a 403 turned
  // one unauthorized endpoint into a request to the Worker every few seconds,
  // for as long as whatever was polling kept polling.
  if (res.status === 401) {
    throw Object.assign(new Error("gitea rejected the token"), { status: 401 });
  }
  if (res.status === 403) {
    throw Object.assign(new Error("gitea refused: the token may not do that"), { status: 403 });
  }
  return res;
}

/* ─── where the branch is ──────────────────────────────────────────────────── */

export async function head(b, signal) {
  const res = await call(b, `/branches/${encodeURIComponent(b.branch)}`, { signal });
  if (!res.ok) return "";
  const body = await res.json().catch(() => ({}));
  return (body.commit && body.commit.id) || "";
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
  if (!res.ok) throw new Error(`could not read ${path}`);
  const row = await res.json();
  return { text: decodeText(row.content || ""), sha: row.sha, path: row.path };
}

export async function raw(b, path) {
  const res = await call(b, `/media/${encodeURI(path)}?ref=${encodeURIComponent(b.branch)}`);
  return res.ok ? res.blob() : null;
}

/* ─── the commit ───────────────────────────────────────────────────────────── */

/**
 * Gitea's ChangeFiles endpoint (1.20+) is what makes a save one commit rather
 * than N, and it takes the per-file blob sha that makes a stale write a
 * rejection instead of an overwrite.
 */
export async function commit(b, files, message) {
  const res = await call(b, "/contents", {
    method: "POST",
    body: JSON.stringify({
      branch: b.branch,
      message,
      author: { name: b.author.name, email: b.author.email },
      committer: { name: b.author.name, email: b.author.email },
      files: files.map((f) => ({
        operation: f.operation,
        path: f.path,
        ...(f.content != null ? { content: f.content } : {}),
        ...(f.sha ? { sha: f.sha } : {}),
      })),
    }),
  });

  if (res.status === 409 || res.status === 422) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.message || "the file changed in the repository"), {
      kind: "conflict",
      status: res.status,
    });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `commit failed (${res.status})`);
  }

  const body = await res.json().catch(() => ({}));
  const sha =
    (body.commit && body.commit.sha) ||
    (body.commits && body.commits[0] && body.commits[0].sha) ||
    "";
  return { sha, short: sha.slice(0, 7) };
}

/* ─── the build ────────────────────────────────────────────────────────────── */

/**
 * A link Gitea wrote, re-hung on the host we are actually talking to.
 *
 * `target_url` is built from the server's own `ROOT_URL`, which is whatever
 * that server was configured with rather than the address anybody reaches it
 * at — so "View run" pointed somewhere the reader's browser cannot go. Only the
 * ORIGIN is wrong; the path identifies the run, and the API base is by
 * definition reachable from here.
 */
function reachable(api, url) {
  if (!url) return "";
  try {
    const here = new URL(api);
    const there = new URL(url, here);
    there.protocol = here.protocol;
    there.host = here.host;
    return there.toString();
  } catch (err) {
    return url;
  }
}

export async function runStatus(b, sha) {
  const ref = String(sha || "").trim();
  if (!ref) return null;

  let res;
  try {
    res = await call(
      b,
      `/commits/${encodeURIComponent(ref)}/status?ref=${encodeURIComponent(b.branch)}`
    );
  } catch (err) {
    return null;
  }
  if (!res.ok) return null;

  const body = await res.json().catch(() => ({}));
  const rows = Array.isArray(body.statuses) ? body.statuses : [];
  const withLink = rows.find((row) => row.target_url);
  return {
    state: String(body.state || "").toLowerCase(),
    url: withLink ? reachable(b.api, withLink.target_url) : "",
    count: rows.length,
  };
}
