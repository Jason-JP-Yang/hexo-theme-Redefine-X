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

  // 401 is "this ticket is no longer good"; 403 is "this token may not do THAT",
  // which a fresh ticket cannot fix. Throwing the ticket away on a 403 turned
  // one unauthorized endpoint into a request to the Worker every few seconds,
  // for as long as whatever was polling kept polling.
  if (res.status === 401) {
    forgetTicket();
    throw Object.assign(new Error("gitea rejected the token"), { status: 401 });
  }
  if (res.status === 403) {
    throw Object.assign(new Error("gitea refused: the token may not do that"), { status: 403 });
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

/**
 * Where the build for one commit has got to.
 *
 * NOT `/actions/runs`. Gitea's Actions endpoints are administrative — the
 * runners, the secrets, the variables and the task list all sit behind owner or
 * admin, and this token belongs to a dedicated account with `write:repository`
 * on the content repository and nothing else. Every poll came back 403, so the
 * rail stopped at "Committed" and never moved again.
 *
 * Commit statuses are the same information asked for the right way: Gitea
 * Actions writes one per job as the run starts and finishes, they are indexed
 * by the sha we just pushed rather than by "the last five runs", and the
 * endpoint is plain repository read. `target_url` is the run page.
 *
 * @returns {Promise<{state: string, url: string, count: number}|null>}
 *   `state` is Gitea's rollup — pending / success / failure / error / warning —
 *   or "" when no job has reported yet. null means the request itself failed.
 */
export async function commitStatus(sha) {
  const t = await getTicket();
  const ref = String(sha || "").trim();
  if (!ref) return null;

  let res;
  try {
    res = await call(`/commits/${encodeURIComponent(ref)}/status?ref=${encodeURIComponent(t.branch)}`);
  } catch (err) {
    return null;
  }
  if (!res.ok) return null;

  const body = await res.json().catch(() => ({}));
  const rows = Array.isArray(body.statuses) ? body.statuses : [];
  const withLink = rows.find((row) => row.target_url);
  return {
    state: String(body.state || "").toLowerCase(),
    url: withLink ? withLink.target_url : "",
    count: rows.length,
  };
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
 *
 * ── Every operation carries its own content ─────────────────────────────────
 *
 * A file only ever appears here as bytes the editor holds — a post it wrote, an
 * image somebody dropped on it. Nothing is ever committed by reference.
 *
 * That rules out `from_path`, which is the one thing that looks like it would
 * make a rename cheap. It does not: Gitea's `update` takes `from_path` and an
 * empty `content` together, removes the old path from the index and hashes the
 * bytes it was given — which for an absent `content` is a ZERO-BYTE BLOB. The
 * picture is destroyed by the commit that was supposed to move it, and every
 * check downstream then agrees the move went fine because a file did arrive.
 * Sending the bytes instead is correct and unusable: base64 in a JSON body, for
 * a folder of photographs, through a browser tab.
 *
 * So a move is not committed here at all. `movedFiles` in session.js writes a
 * note, and the build does the renaming where a rename is free.
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

/**
 * Where an image the editor uploaded will live.
 *
 * Content-addressed, so the same picture pasted twice is committed once — and
 * the digest is stripped off the stem before it is put back on. A picture
 * already carrying one is exactly what you get by saving a file the editor
 * named and adding it again, and appending unconditionally turned
 * `16-0e1a33510ad8.png` into `16-0e1a33510ad8-0e1a33510ad8.png`, then into a
 * third copy of the same twelve characters the time after that.
 */
export async function assetPath(name, bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest).slice(0, 6))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const ext = (String(name).match(/\.([a-z0-9]+)$/i) || [, "png"])[1].toLowerCase();
  const stem =
    String(name)
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(-[0-9a-f]{12})+$/, "")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image";
  return `source/images/posts/${stem}-${hash}.${ext}`;
}

/* ─── reading bytes the site does not serve yet ─────────────────────────────── */

/**
 * A repository file as an object URL.
 *
 * The site is the right place to fetch a picture from — it is the copy the
 * reader gets, compressed where the build compressed it. But between committing
 * an image and the deploy that publishes it there is a window, minutes long,
 * where the site simply does not have it: the editor asked for `/images/…` and
 * got a 404, and the author was shown a broken picture for something they had
 * just added. This is the second answer, used only when the first one fails.
 *
 * Cached per path for the session, and revoked with the rest of the session's
 * object URLs.
 */
const blobs = new Map();

export function blobURL(path) {
  const key = String(path || "").replace(/^\/+/, "");
  if (!key) return Promise.resolve("");
  if (blobs.has(key)) return blobs.get(key);

  const pending = (async () => {
    try {
      const t = await getTicket();
      const res = await call(`/media/${encodeURI(key)}?ref=${encodeURIComponent(t.branch)}`);
      if (!res.ok) return "";
      return URL.createObjectURL(await res.blob());
    } catch (err) {
      return "";
    }
  })();

  blobs.set(key, pending);
  return pending;
}

export function forgetBlobs() {
  for (const pending of blobs.values()) {
    pending.then((url) => url && URL.revokeObjectURL(url)).catch(() => {});
  }
  blobs.clear();
}
