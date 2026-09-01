/**
 * The repository client — the browser talking to Gitea directly.
 *
 * The Worker is NOT in this path. It authenticates the session and hands over a
 * ticket; every read and every write after that is one request from here to
 * Gitea, which is what keeps a save off a 10 ms CPU budget no matter how many
 * megabytes of images it carries.
 *
 * ── What stands in for the Worker's path allowlist ──────────────────────────
 *
 * A token in a browser can write anything the token can write, so the limit has
 * to be enforced where the token is spent rather than where it is handed out:
 *
 *   · a dedicated Gitea account with write on the content repository ONLY
 *   · token scope `write:repository`
 *   · branch protection → Protected File Patterns on `main`, covering
 *     `.github/**`, `.gitea/**`, `package.json`, `package-lock.json`,
 *     `bin/**`, `themes/**`, `_config.yml`
 *
 * That last line is the one that matters: without it a stolen admin session can
 * rewrite the workflow and get code execution on a runner that holds
 * VAULT_MASTER. `ALLOWED` below refuses the same paths client-side, which turns
 * a mistake into an error message instead of a rejected push — it is a
 * courtesy, not the control.
 *
 * The ticket lives in this module's closure. Never storage, for the same reason
 * post keys never touch storage.
 */

const ALLOWED = [/^source\//, /^\.vault\/keys\.enc$/, /^scaffolds\//];
const FORBIDDEN = [/^\.github\//, /^\.gitea\//, /^themes\//, /^bin\//, /^package(-lock)?\.json$/, /^_config[^/]*\.yml$/, /(^|\/)\.\.(\/|$)/];

let ticket = null;
let ticketAt = 0;

/* ─── base64 ───────────────────────────────────────────────────────────────── */

export function toBase64(input) {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  // Chunked: `apply` on a multi-megabyte array overflows the argument list.
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(String(text || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function decodeText(base64) {
  return new TextDecoder().decode(fromBase64(base64));
}

/* ─── the ticket ───────────────────────────────────────────────────────────── */

/**
 * Ask the Worker who we are and what we may write to.
 *
 * Cached for the session token's own lifetime, so an editing session costs ONE
 * Worker request no matter how many times it saves.
 */
export async function getTicket(force) {
  if (!force && ticket && Date.now() - ticketAt < 90 * 60 * 1000) return ticket;
  if (!window.blogAuth) throw new Error("not signed in");

  const session = await window.blogAuth.getSession();
  const base = window.blogAuth.resolveApiBase();
  if (!session || !session.token || !base) throw new Error("not signed in");

  const res = await fetch(base + "/api/admin/gitea/ticket", {
    headers: { Authorization: "Bearer " + session.token },
  });
  if (res.status === 401 || res.status === 403) throw new Error("forbidden");
  if (!res.ok) throw new Error("ticket unavailable");

  ticket = await res.json();
  ticketAt = Date.now();
  return ticket;
}

export function forgetTicket() {
  ticket = null;
  ticketAt = 0;
}

function repoURL(t, path) {
  return `${t.api.replace(/\/+$/, "")}/repos/${t.owner}/${t.repo}${path}`;
}

async function call(path, init) {
  const t = await getTicket();
  const res = await fetch(repoURL(t, path), {
    ...init,
    headers: {
      Authorization: "token " + t.token,
      Accept: "application/json",
      ...(init && init.body ? { "Content-Type": "application/json" } : {}),
      ...((init && init.headers) || {}),
    },
  });

  if (res.status === 401 || res.status === 403) {
    forgetTicket();
    throw Object.assign(new Error("gitea rejected the token"), { status: res.status });
  }
  return res;
}

/* ─── paths ────────────────────────────────────────────────────────────────── */

export function checkPath(path) {
  const clean = String(path || "").replace(/^\/+/, "");
  if (!clean) return "empty path";
  if (FORBIDDEN.some((re) => re.test(clean))) return `${clean} is protected`;
  if (!ALLOWED.some((re) => re.test(clean))) return `${clean} is outside the editable tree`;
  return null;
}

/* ─── reads ────────────────────────────────────────────────────────────────── */

/** One directory listing: `{ name, path, type, sha, size }`. */
export async function list(dir) {
  const t = await getTicket();
  const res = await call(`/contents/${encodeURI(dir)}?ref=${encodeURIComponent(t.branch)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`could not list ${dir}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [rows];
}

/** One file: `{ text, sha }`. Returns null when it does not exist. */
export async function read(path) {
  const t = await getTicket();
  const res = await call(`/contents/${encodeURI(path)}?ref=${encodeURIComponent(t.branch)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`could not read ${path}`);
  const row = await res.json();
  return { text: decodeText(row.content || ""), sha: row.sha, path: row.path };
}

/** Recent Actions runs, so the editor can show where a publish got to. */
export async function runs(limit) {
  const res = await call(`/actions/runs?limit=${Number(limit) || 5}`);
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  const rows = body.workflow_runs || body.runs || [];
  return rows.map((run) => ({
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    sha: run.head_sha || run.commit_sha || "",
    started: run.started_at || run.created_at || "",
    url: run.html_url || run.url || "",
  }));
}

/* ─── the commit ───────────────────────────────────────────────────────────── */

/**
 * One commit carrying every change.
 *
 * `files` is `[{ operation, path, content, sha }]` where `content` is already
 * base64 — text and images travel in the same array, which is what makes a save
 * atomic: a post is never committed without the image it references, and the
 * build never sees a half-written state.
 *
 * Gitea's ChangeFiles endpoint (1.20+) is what makes that one commit rather
 * than N. `sha` on an update is the blob sha the editor loaded, so a file that
 * moved underneath us is a rejection here rather than a silent overwrite.
 */
export async function commit(files, message) {
  const t = await getTicket();

  for (const file of files) {
    const bad = checkPath(file.path);
    if (bad) throw Object.assign(new Error(bad), { path: file.path, kind: "path" });
  }

  const res = await call("/contents", {
    method: "POST",
    body: JSON.stringify({
      branch: t.branch,
      message,
      author: { name: t.author.name, email: t.author.email },
      committer: { name: t.author.name, email: t.author.email },
      files: files.map((f) => ({
        operation: f.operation,
        path: f.path,
        ...(f.content != null ? { content: f.content } : {}),
        ...(f.sha ? { sha: f.sha } : {}),
        ...(f.from ? { from_path: f.from } : {}),
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
  const sha = (body.commit && body.commit.sha) || (body.commits && body.commits[0] && body.commits[0].sha) || "";
  return { sha, short: sha.slice(0, 7), files: body.files || [] };
}

/** Where an image the editor uploaded will live. Content-addressed so the same
 *  picture pasted twice is committed once. */
export async function assetPath(name, bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest).slice(0, 6))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const ext = (String(name).match(/\.([a-z0-9]+)$/i) || [, "png"])[1].toLowerCase();
  const stem = String(name)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "image";
  return `source/images/posts/${stem}-${hash}.${ext}`;
}
