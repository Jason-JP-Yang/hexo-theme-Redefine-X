/**
 * The repository layer — one façade over two build backends.
 *
 * The site's source lives in two places at once: a Gitea instance on Jason's
 * own machine, and a private GitHub mirror. Either can build and publish, and
 * whichever one takes a commit is the one that builds it. This module decides
 * which, and every other part of the editor talks only to it.
 *
 * ── Which backend, and why ──────────────────────────────────────────────────
 *
 * Reachability first, Gitea preferred. Build SPEED is deliberately not a
 * criterion: a home runner's queue has nothing to do with how fast its API
 * answers, so measuring latency would pick the wrong one confidently.
 *
 * The one thing that can go wrong is divergence. Gitea goes down, a post is
 * committed to GitHub, Gitea comes back — now it is behind, and committing to
 * it would fork the history. So selection compares the two heads and picks the
 * one that is AHEAD, not merely the one that answers.
 *
 * ── Who builds a commit ─────────────────────────────────────────────────────
 *
 * `Build-on:` is written into the commit message here and read by both
 * workflows. It is what stops the mirror step on either side from triggering a
 * build on the other, which would then mirror back — and it guarantees one
 * source commit is built exactly once, which matters because a vault blob's
 * nonce is redrawn every build, so two builds of one commit publish two
 * different artifacts that overwrite each other.
 *
 * `done` is the third value and it is not decoration: CI's own reseal commit is
 * pushed to main and re-evaluated by the very workflow that made it.
 *
 * ── Where the tokens live, and for how long ─────────────────────────────────
 *
 * Both backends hand over a standing credential — Gitea's tokens carry no
 * expiry and the GitHub PAT is fine-grained but permanent — so nothing about
 * the token itself bounds it. What bounds it is this module's closure and
 * nothing else: never localStorage, never sessionStorage, never IndexedDB,
 * never a cookie, for the same reason post keys never touch storage.
 *
 * `forget()` is the erase, and credentials.js is the complete list of events
 * that call it.
 */

import * as giteaDriver from "./repo-gitea.js";
import * as githubDriver from "./repo-github.js";

export { toBase64, fromBase64, decodeText } from "./repo-bytes.js";

const DRIVERS = { gitea: giteaDriver, github: githubDriver };

const ALLOWED = [/^source\//, /^\.vault\/keys\.enc$/, /^scaffolds\//];
const FORBIDDEN = [
  /^\.github\//,
  /^\.gitea\//,
  /^themes\//,
  /^bin\//,
  /^package(-lock)?\.json$/,
  /^_config[^/]*\.yml$/,
  // A submodule URL is a code path: point `themes/redefine-x` somewhere else
  // and the next build runs that repository's scripts on a runner holding
  // VAULT_MASTER.
  /^\.gitmodules$/,
  /(^|\/)\.\.(\/|$)/,
];

const PROBE_MS = 6000;
const TICKET_MS = 90 * 60 * 1000;

let ticket = null;
let ticketAt = 0;
let chosen = null;
let forced = "";
let idleTimer = 0;

/**
 * A ticket nobody has touched for the session bound is ERASED, not merely
 * refused. The bound already existed; this is what makes reaching it mean the
 * credential is gone rather than stale — a page left open overnight holds no
 * repository token in the morning.
 */
function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(forget, TICKET_MS);
}

/* ─── paths ────────────────────────────────────────────────────────────────── */

/**
 * The client-side half of the write limit.
 *
 * The real control is at the token: the Gitea account holds `write:repository`
 * on the content repository and `main` carries Protected File Patterns, while
 * the GitHub PAT is fine-grained, scoped to the one repository, and has no
 * `Workflows` permission — so GitHub itself refuses any write under
 * `.github/workflows/`. This list turns a mistake into an error message instead
 * of a rejected push; it is a courtesy, not the control.
 */
export function checkPath(path) {
  const clean = String(path || "").replace(/^\/+/, "");
  if (!clean) return "empty path";
  if (FORBIDDEN.some((re) => re.test(clean))) return `${clean} is protected`;
  if (!ALLOWED.some((re) => re.test(clean))) return `${clean} is outside the editable tree`;
  return null;
}

/* ─── the ticket ───────────────────────────────────────────────────────────── */

async function fetchTicket() {
  if (!window.blogAuth) throw new Error("not signed in");

  const session = await window.blogAuth.getSession();
  const base = window.blogAuth.resolveApiBase();
  if (!session || !session.token || !base) throw new Error("not signed in");

  const res = await fetch(base + "/api/admin/repo/ticket", {
    headers: { Authorization: "Bearer " + session.token },
  });
  if (res.status === 401 || res.status === 403) throw new Error("forbidden");
  if (!res.ok) throw new Error("ticket unavailable");

  const body = await res.json();
  const rows = (body.backends || []).filter((b) => b && b.id && DRIVERS[b.kind || b.id]);
  if (!rows.length) throw new Error("ticket unavailable");

  return {
    prefer: body.prefer || rows[0].id,
    backends: rows.map((b) => ({ ...b, driver: DRIVERS[b.kind || b.id] })),
  };
}

/* ─── selection ────────────────────────────────────────────────────────────── */

function withTimeout(ms) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), ms);
  return { signal: control.signal, done: () => clearTimeout(timer) };
}

/** Ask both backends where their branch tip is, in parallel. */
async function probe(backends) {
  return Promise.all(
    backends.map(async (backend) => {
      const gate = withTimeout(PROBE_MS);
      try {
        const head = await backend.driver.head(backend, gate.signal);
        return { backend, head, up: !!head };
      } catch (err) {
        return { backend, head: "", up: false };
      } finally {
        gate.done();
      }
    })
  );
}

/**
 * Which of two reachable backends is ahead.
 *
 * Asked as "does yours contain mine?" rather than by comparing dates or
 * counting commits: a repository either has a commit object or it does not, and
 * that answer is one request and cannot be wrong. Both containing the other is
 * only possible when the heads are equal, which is handled before this runs.
 */
async function order(a, b) {
  const [bHasA, aHasB] = await Promise.all([
    b.backend.driver.hasCommit(b.backend, a.head).catch(() => false),
    a.backend.driver.hasCommit(a.backend, b.head).catch(() => false),
  ]);
  if (bHasA && !aHasB) return { ahead: b, behind: a };
  if (aHasB && !bHasA) return { ahead: a, behind: b };
  return null; // diverged, or neither could answer
}

/**
 * Open a session: resolve the ticket, then pick a backend.
 *
 * @returns {Promise<{active: object, rows: Array, behind: object|null, diverged: boolean}>}
 */
export async function open(force) {
  if (!force && ticket && chosen && Date.now() - ticketAt < TICKET_MS) {
    return { active: chosen, rows: ticket.backends, behind: null, diverged: false };
  }

  ticket = await fetchTicket();
  ticketAt = Date.now();
  chosen = null;
  touch();

  const probed = await probe(ticket.backends);
  for (const row of probed) row.backend.up = row.up;

  const live = probed.filter((row) => row.up);
  if (!live.length) throw new Error("unreachable");

  // A forced choice still has to be reachable; silently honouring a dead one
  // would report "not signed in" three requests later.
  if (forced) {
    const pick = live.find((row) => row.backend.id === forced);
    if (pick) {
      chosen = pick.backend;
      return { active: chosen, rows: ticket.backends, behind: null, diverged: false };
    }
    forced = "";
  }

  const preferred = live.find((row) => row.backend.id === ticket.prefer) || live[0];

  if (live.length === 1 || live.every((row) => row.head === live[0].head)) {
    chosen = preferred.backend;
    return { active: chosen, rows: ticket.backends, behind: null, diverged: false };
  }

  const [a, b] = live;
  const ranked = await order(a, b);
  if (!ranked) {
    chosen = preferred.backend;
    return { active: chosen, rows: ticket.backends, behind: null, diverged: true };
  }

  chosen = ranked.ahead.backend;
  return {
    active: chosen,
    rows: ticket.backends,
    // Only worth catching up when the side that fell behind is the preferred
    // one; the other direction heals itself on the next build's mirror step.
    behind: ranked.behind.backend.id === ticket.prefer ? ranked.behind.backend : null,
    diverged: false,
  };
}

export function active() {
  if (!chosen) throw new Error("not signed in");
  return chosen;
}

export function activeId() {
  return chosen ? chosen.id : "";
}

export function backends() {
  return ticket ? ticket.backends : [];
}

/** Force a backend for the rest of the session. Re-runs selection. */
export async function use(id) {
  forced = String(id || "");
  return open(true);
}

/** Move to an already-probed backend without asking the Worker again. */
export function adopt(id) {
  const row = backends().find((backend) => backend.id === id);
  if (!row) return false;
  chosen = row;
  return true;
}

/**
 * Erase the credentials.
 *
 * The token strings are blanked ON THE ROWS before the ticket is released,
 * because a driver call already in flight holds its `backend` object by
 * reference rather than by lookup — dropping the ticket alone would leave that
 * one live. A string cannot be zeroed in JavaScript; dropping every reference to
 * it is the whole of what can be done, and keeping one in a closure is the thing
 * that undoes it.
 *
 * The blob cache goes too. Those are the contents of files from a private
 * repository, held as object URLs that outlive the page that made them unless
 * they are revoked.
 */
export function forget() {
  for (const backend of (ticket && ticket.backends) || []) backend.token = "";
  ticket = null;
  ticketAt = 0;
  chosen = null;
  forced = "";
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = 0;
  forgetBlobs();
}

/* ─── catching the preferred backend up ────────────────────────────────────── */

/**
 * Fast-forward the backend that fell behind.
 *
 * The catch-up itself is a push, and only a runner can make it: the browser
 * holds a content token, not a git client. So the Worker fires the ahead
 * backend's sync workflow — which pushes and does NOT build — and this polls
 * until the heads agree.
 *
 * It does NOT move the session onto the backend it caught up. This takes up to
 * two minutes, an editing session is live the whole time, and changing which
 * repository a save goes to underneath a half-typed post is not something to do
 * without looking at what the author is doing. The caller decides; see
 * `adopt`.
 *
 * A timeout is not an error. The editor is already on a working backend, and
 * the only cost of giving up is that this session commits to the mirror.
 */
export async function catchUp(target, timeoutMs = 120000) {
  if (!window.blogAuth || !target) return false;

  const session = await window.blogAuth.getSession();
  const base = window.blogAuth.resolveApiBase();
  if (!session || !session.token || !base) return false;

  const res = await fetch(base + "/api/admin/repo/sync", {
    method: "POST",
    headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
    body: JSON.stringify({ to: target.id }),
  });
  if (!res.ok) return false;

  const want = chosen ? await chosen.driver.head(chosen).catch(() => "") : "";
  if (!want) return false;

  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const head = await target.driver.head(target).catch(() => "");
    if (head === want) return true;
  }
  return false;
}

/* ─── reads ────────────────────────────────────────────────────────────────── */

/**
 * A backend rejecting the ticket means the whole selection is stale — the
 * token is gone, not this one request — so the next call re-opens rather than
 * spending the session on a credential nothing will accept.
 */
async function guard(fn) {
  // Erased — by the idle timer, by a 401, by anything. The credential is meant
  // to be short-lived in the page, so getting one back has to be ordinary rather
  // than an error the author has to work around.
  if (!chosen) await open(false);

  const backend = active();
  touch();
  try {
    return await fn(backend);
  } catch (err) {
    if (err && err.status === 401) forget();
    throw err;
  }
}

/** One directory listing: `{ name, path, type, sha, size }`. */
export function list(dir) {
  return guard((backend) => backend.driver.list(backend, dir));
}

/** One file: `{ text, sha, path }`. Returns null when it does not exist. */
export function read(path) {
  return guard((backend) => backend.driver.read(backend, path));
}

/**
 * Where the build for one commit has got to.
 *
 * The two backends report it in different places and neither is the obvious
 * one. Gitea Actions writes a COMMIT STATUS per job, because its `/actions/*`
 * endpoints are owner-or-admin and this token is a content token — every poll
 * came back 403 and the rail stopped at "Committed". GitHub Actions writes no
 * commit status at all, so there the answer is the workflow run itself, which a
 * fine-grained PAT can read with `Actions: read`.
 *
 * @returns {Promise<{state: string, url: string, count: number}|null>}
 *   `state` is pending / success / failure, or "" when no job has reported yet.
 *   null means the request itself failed — ask again.
 */
export function commitStatus(sha) {
  const backend = active();
  return backend.driver.runStatus(backend, sha);
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
 * `sha` on an update is the blob sha the editor loaded, so a file that moved
 * underneath us is a rejection rather than a silent overwrite. Gitea enforces
 * that itself; the GitHub driver reproduces it, because a backend that quietly
 * accepted what the other refuses is worse than either behaviour alone.
 *
 * Nothing is ever committed by reference — a file appears here only as bytes
 * the editor holds. That rules out a server-side rename, which is why a picture
 * move is committed as a note for the build to act on. See `movedFiles` in
 * session.js.
 */
export async function commit(files, message) {
  for (const file of files) {
    const bad = checkPath(file.path);
    if (bad) throw Object.assign(new Error(bad), { path: file.path, kind: "path" });
  }

  return guard(async (backend) => {
    const body = `${message}\n\nBuild-on: ${backend.id}\n`;
    const result = await backend.driver.commit(backend, files, body);
    return { ...result, backend: backend.id };
  });
}

/**
 * Where an image the editor uploaded will live.
 *
 * Content-addressed, so the same picture pasted twice is committed once — and
 * the digest is stripped off the stem before it is put back on, because a
 * picture already carrying one is exactly what you get by saving a file the
 * editor named and adding it again.
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
 * where the site does not have it. This is the second answer, used only when
 * the first one fails.
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
      const backend = active();
      const blob = await backend.driver.raw(backend, key);
      return blob ? URL.createObjectURL(blob) : "";
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
