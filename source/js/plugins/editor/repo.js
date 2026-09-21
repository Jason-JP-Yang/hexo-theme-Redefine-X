/**
 * The repository layer — what is left of it once the browser stopped having one.
 *
 * The editor used to hold a write token for the repository the site is written
 * in, and read and commit to it directly. It holds nothing of the kind now.
 * What it holds is:
 *
 *   to READ    a key per item, released by the Worker to whoever that item's
 *              permissions name, and a sealed copy of the item published
 *              beside the site. There is no repository to read from, so there
 *              is nothing a stolen session could read beyond what it was given.
 *
 *   to WRITE   a token for the PUBLIC repository, and a signed receipt naming
 *              who asked and what they were cleared for. A save is one sealed
 *              payload pushed to a branch of its own; the runner opens it,
 *              checks every path against the receipt, and applies it to the
 *              private repository or refuses the whole of it.
 *
 * Nothing in this module can write to the source. That is the point of it.
 *
 * ── Where the tokens live, and for how long ─────────────────────────────────
 *
 * The same bargain as before, and for the same reason: this module's closure
 * and nowhere else. Never localStorage, never sessionStorage, never IndexedDB,
 * never a cookie. `forget()` is the erase and credentials.js is the complete
 * list of events that call it.
 */

import * as githubDriver from "./repo-github.js";
import {
  b64urlToBytes,
  bytesToB64url,
  fetchSealed,
  importAesKey,
  openText,
  postId,
  sha256Hex,
  vaultPrefix,
} from "../../tools/vaultCrypto.js";

export { toBase64, fromBase64, decodeText } from "./repo-bytes.js";

const TICKET_MS = 90 * 60 * 1000;

const POSTS_DIR = "source/_posts";
const MASONRY = "source/_data/masonry.yml";
const KEYRING = ".vault/keys.enc";
const JOURNAL = "source/_data/image-moves.json";

const ALLOWED = [/^source\//, /^\.vault\/keys\.enc$/];
const FORBIDDEN = [
  /^\.github\//,
  /^\.gitea\//,
  /^themes\//,
  /^bin\//,
  /^ci\//,
  /^package(-lock)?\.json$/,
  /^_config[^/]*\.yml$/,
  /^\.gitmodules$/,
  /(^|\/)\.\.(\/|$)/,
];

let ticket = null; // { me, repo, verify }
let ticketAt = 0;
let idleTimer = 0;
let itemsById = null; // id -> { id, slug, kind, enc, draft, write, raw }
let roster = [];
let textCache = new Map(); // repo path -> { text, sha }

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(forget, TICKET_MS);
}

/* ─── paths ────────────────────────────────────────────────────────────────── */

/**
 * The client-side half of the write limit.
 *
 * The real control is the runner, which re-derives the owner of every path in a
 * save and checks it against the signed receipt — and the token, which is
 * fine-grained on the PUBLIC repository and carries no `Workflows` permission,
 * so GitHub itself refuses any write under `.github/workflows/`. This turns a
 * mistake into an error message instead of a refused save.
 */
export function checkPath(path) {
  const clean = String(path || "").replace(/^\/+/, "");
  if (!clean) return "empty path";
  if (FORBIDDEN.some((re) => re.test(clean))) return `${clean} is protected`;
  if (!ALLOWED.some((re) => re.test(clean))) return `${clean} is outside the editable tree`;
  return null;
}

/* ─── the ticket ───────────────────────────────────────────────────────────── */

async function auth() {
  if (!window.blogAuth) throw new Error("not signed in");
  const session = await window.blogAuth.getSession();
  const base = window.blogAuth.resolveApiBase();
  if (!session || !session.token || !base) throw new Error("not signed in");
  return { base, headers: { Authorization: "Bearer " + session.token } };
}

/**
 * The collaborator roster, opened with the admin key.
 *
 * Half of each entry is a person's login and email address — the identity a
 * commit is signed with. The half the site actually prints, their name and
 * their picture, is already in the markup of every post they worked on; the
 * rest travels behind the same key the console does.
 *
 * Absent for a collaborator, who does not hold that key. Nothing is lost: the
 * only thing the roster is used for is attributing a save, and the Worker signs
 * a receipt with the identity it verified rather than with one this page typed.
 */
async function loadRoster(item) {
  if (!item) return [];
  try {
    const sealed = await fetchSealed(`${vaultPrefix()}/${item.slug}/o.bin`);
    if (!sealed) return [];
    const body = JSON.parse(await openText(await importAesKey(item.raw), sealed));
    return Array.isArray(body.collaborators) ? body.collaborators : [];
  } catch (err) {
    return [];
  }
}

async function fetchTicket() {
  const { base, headers } = await auth();

  const [sessionRes, keysRes] = await Promise.all([
    fetch(base + "/api/editor/session", { headers }),
    fetch(base + "/api/editor/keys", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    }),
  ]);

  if (sessionRes.status === 401 || sessionRes.status === 403) throw new Error("forbidden");
  if (!sessionRes.ok || !keysRes.ok) throw new Error("ticket unavailable");

  const me = await sessionRes.json();
  const keys = await keysRes.json().catch(() => ({ items: [] }));

  itemsById = new Map();
  for (const row of keys.items || []) {
    itemsById.set(row.id, { ...row, raw: b64urlToBytes(row.key), key: null });
  }

  roster = await loadRoster(Array.from(itemsById.values()).find((row) => row.kind === "page"));

  return { me, repo: me.repo || null, verify: me.verify || "" };
}

/**
 * The signed-in identity, when it is a collaborator's rather than the admin's.
 * Matched on the GitHub NUMERIC id — a login can be released and re-registered.
 */
export function collaborator() {
  const id = window.blogAuth && window.blogAuth.githubId;
  if (!id || (ticket && ticket.me && ticket.me.admin)) return null;
  return roster.find((row) => String(row.id) === String(id)) || null;
}

/** What this session may see in the console, and whether it is the admin's. */
export function session() {
  return ticket ? ticket.me : null;
}

/** Every item this session may open, as the Worker released them. */
export function items() {
  return itemsById ? Array.from(itemsById.values()) : [];
}

export async function open(force) {
  if (!force && ticket && Date.now() - ticketAt < TICKET_MS) {
    return { active: ticket.repo, rows: [], behind: null, diverged: false };
  }
  ticket = await fetchTicket();
  ticketAt = Date.now();
  textCache = new Map();
  touch();
  return { active: ticket.repo, rows: [], behind: null, diverged: false };
}

export function active() {
  if (!ticket || !ticket.repo) throw new Error("not signed in");
  return ticket.repo;
}

/**
 * There is one backend now, so there is nothing to choose between.
 *
 * These four are kept because every surface that used to offer the choice still
 * calls them, and an empty list is the honest answer: the picker renders
 * nothing and the catch-up control never appears.
 */
export function activeId() {
  return ticket && ticket.repo ? "github" : "";
}

export function backends() {
  return [];
}

export function use() {
  return open(true);
}

export function adopt() {
  return false;
}

export function catchUp() {
  return Promise.resolve(false);
}

export function forget() {
  if (ticket && ticket.repo) ticket.repo.token = "";
  ticket = null;
  ticketAt = 0;
  itemsById = null;
  roster = [];
  textCache = new Map();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = 0;
  forgetBlobs();
}

/* ─── which sealed item holds which path ───────────────────────────────────── */

async function ready() {
  if (!ticket) await open(false);
  touch();
  return ticket;
}

function pick(kind) {
  for (const row of itemsById ? itemsById.values() : []) if (row.kind === kind) return row;
  return null;
}

/**
 * The sealed item a repository path lives in.
 *
 * An article is found by hashing its own path, which is the identity every side
 * of this system derives independently — so no index has to be published and
 * none can go stale. masonry.yml is a single item in two versions and the
 * Worker has already decided which of them this session holds.
 */
async function itemFor(path) {
  await ready();
  const rel = String(path || "").replace(/^\/+/, "");

  if (rel === MASONRY) return pick("masonry") || pick("masonry-open");
  if (rel.startsWith(POSTS_DIR + "/")) return itemsById.get(await postId(rel)) || null;
  return null;
}

/** The blob one item's source lives in. */
function blobName(item) {
  if (item.kind === "masonry" || item.kind === "masonry-open") return "y.bin";
  if (item.kind === "album") return "y.bin";
  return "s.bin";
}

async function decrypt(item, name) {
  if (!item.key) item.key = await importAesKey(item.raw);
  const sealed = await fetchSealed(`${vaultPrefix()}/${item.slug}/${name}`);
  if (!sealed) return null;
  return openText(item.key, sealed);
}

/* ─── reads ────────────────────────────────────────────────────────────────── */

/**
 * One file, as `{ text, sha, path }`.
 *
 * `sha` is the digest of what was read rather than a git blob id, because there
 * is no git object here to name. It serves the purpose the blob sha served: the
 * save carries it, and a file that changed underneath the editor is a rejection
 * at the runner rather than a silent overwrite.
 */
export async function read(path) {
  const rel = String(path || "").replace(/^\/+/, "");
  if (!rel) return null;
  if (textCache.has(rel)) return textCache.get(rel);

  // The keyring and the move journal are build bookkeeping, not content. The
  // editor never needs to see either: a new keyring comes back from the mint
  // that produced it, and a move is APPENDED by the runner rather than
  // rewritten here.
  if (rel === KEYRING || rel === JOURNAL) return null;

  const item = await itemFor(rel);
  if (!item) return null;

  const text = await decrypt(item, blobName(item));
  if (text == null) return null;

  const row = { text, sha: await sha256Hex(text), path: rel };
  textCache.set(rel, row);
  return row;
}

/**
 * A directory listing, for the one directory anything still lists.
 *
 * Every post has a sealed source copy now, so the list of articles is the list
 * of items — there is no repository to enumerate and no request to make. Any
 * other directory answers empty, which is the truthful answer: this session
 * cannot see a directory, only the items it was given.
 */
export async function list(dir) {
  await ready();
  const clean = String(dir || "").replace(/^\/+|\/+$/g, "");
  if (clean !== POSTS_DIR) return [];

  const rows = [];
  for (const item of itemsById.values()) {
    if (item.kind !== "post" || !item.source) continue;
    const path = item.source;
    rows.push({ name: path.split("/").pop(), path, type: "file", sha: "", size: 0 });
  }
  return rows;
}

/**
 * Let a caller that already has the inventory fill in what `list` needs.
 *
 * Blog Management opens with the whole inventory sealed into its own page, so
 * making this module fetch a metadata blob per item to learn the same thing
 * would be a request per post for something already in hand.
 */
export function seedSources(rows) {
  if (!itemsById) return;
  for (const row of rows || []) {
    const item = itemsById.get(row.vaultId || row.id);
    if (item && row.source) item.source = row.source;
  }
}

/* ─── the commit ───────────────────────────────────────────────────────────── */

/** Which item a path belongs to, for the owner list a receipt is issued against. */
async function ownerOf(file) {
  const rel = String(file.path || "").replace(/^\/+/, "");
  if (rel === KEYRING || rel === JOURNAL) return "";
  if (rel === MASONRY) {
    // Declared by the caller: only the album editor knows which album it just
    // changed, and the runner re-derives the true set from the file itself and
    // refuses anything the receipt did not name.
    return Array.isArray(file.owners) ? file.owners : file.owner ? [file.owner] : [];
  }
  if (rel.startsWith(POSTS_DIR + "/")) return postId(rel);
  return file.owner || "";
}

/**
 * Does this post body say it is a draft? The FRONT MATTER, not the file name.
 *
 * A brand-new article is saved as a draft at its future published path — the
 * `.draft.md` suffix exists only for a draft standing in front of an article
 * that is already published. So the suffix alone calls a new draft a publish,
 * which is what stopped a collaborator from ever creating one, however clearly
 * the body said `draft: true`.
 */
function draftBody(content) {
  let text = "";
  try {
    text = atob(String(content || ""));
  } catch (err) {
    return false;
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return !!front && /^draft:\s*(true|yes|on|1)\s*$/im.test(front[1]);
}

/**
 * Does this save publish or unpublish something?
 *
 * Creating an article at a published path, or removing one, is the decision
 * that changes what the SITE shows — and that is never a collaborator's. Read
 * off the files rather than off the caller's intent, so the same test runs
 * whichever surface asked, and refused again at the Worker and at the runner.
 */
function publishes(files) {
  return files.some((file) => {
    const rel = String(file.path || "");
    if (!rel.startsWith(POSTS_DIR + "/") || !/\.md$/i.test(rel) || /\.draft\.md$/i.test(rel)) {
      return false;
    }
    // A new article that is still a draft changes nothing the site shows.
    if (file.operation === "create" && draftBody(file.content)) return false;
    return file.operation === "create" || file.operation === "delete";
  });
}

/**
 * One save: sealed, signed, and pushed to a branch of its own.
 *
 * `files` is the same shape every caller already builds —
 * `[{ operation, path, content, sha }]` with `content` already base64 — so a
 * post, its pictures and the keyring that opens it travel together and the
 * runner applies all of them or none.
 */
export async function commit(files, message) {
  for (const file of files) {
    const bad = checkPath(file.path);
    if (bad) throw Object.assign(new Error(bad), { path: file.path, kind: "path" });
  }

  await ready();
  const repo = active();
  if (!repo || !repo.token) throw new Error("saving is not configured");

  await refuseWhileBuilding(repo);

  // ── who owns what in this save ───────────────────────────────────────────
  //
  // Articles and albums name themselves: a post's identity IS the hash of its
  // path, and an album's is declared by the one surface that knows which album
  // it just changed. A picture names nothing, and it does not have to — it
  // belongs to the document being saved, and that document is in this same
  // payload. So an asset with no owner of its own takes the first one, which is
  // what makes a save atomic in permissions as well as in files: the picture
  // and the post it is for are cleared together or not at all.
  const owners = new Set();
  const resolved = new Map();
  for (const file of files) {
    const owner = await ownerOf(file);
    resolved.set(file, owner);
    for (const id of Array.isArray(owner) ? owner : [owner]) if (id) owners.add(id);
  }
  const [first] = owners;
  if (!first) throw new Error("this save names nothing that can be checked");

  const payload = JSON.stringify({
    v: 1,
    message: String(message || ""),
    files: files.map((file) => {
      const owner = resolved.get(file);
      const one = Array.isArray(owner) ? owner[0] : owner;
      return {
        op: file.operation === "delete" ? "delete" : file.operation === "append" ? "append" : "write",
        path: String(file.path).replace(/^\/+/, ""),
        owner: one || first,
        ...(file.operation === "delete" ? {} : { data: file.content }),
      };
    }),
  });

  const key = crypto.getRandomValues(new Uint8Array(32));
  const sealed = await sealPayload(key, payload);
  const hash = await sha256Bytes(sealed);

  const { base, headers } = await auth();
  const res = await fetch(base + "/api/editor/submit", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      owners: Array.from(owners),
      hash,
      key: bytesToB64url(key),
      publish: publishes(files),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "this save was not authorised");
  }
  const receipt = await res.json();

  // Whose work this is. The receipt already names the identity the Worker
  // verified — that is what the runner reads — so this trailer is the ordinary
  // git courtesy beside it, not a claim anything acts on.
  const me = collaborator();
  const trailers =
    `Editor-Receipt: ${receipt.receipt}\n` +
    `Editor-Signature: ${receipt.signature}\n` +
    `Editor-Key: ${receipt.wrapped}\n` +
    (me ? `Co-authored-by: ${me.name} <${me.email}>\n` : "");

  const result = await githubDriver.pushQueue(repo, bytesToB64(sealed), `${message}\n\n${trailers}`);
  textCache = new Map();

  // ── start the run the save cannot start by itself ─────────────────────────
  //
  // The commit just pushed is ROOTLESS and holds one file, so nothing happens
  // when GitHub sees it: a push-triggered workflow is taken from the pushed
  // commit's own tree, and that tree has no workflow in it. The Worker starts
  // the run instead, from `main`, naming this exact commit — the page cannot,
  // because its token deliberately carries no `Actions: write`.
  //
  // A failure here does NOT undo the save: the payload is on the queue branch
  // and the next run that names it applies it. What is lost is only the run for
  // THIS save, so that is all the caller is told.
  let started = false;
  let why = "";
  try {
    const res = await fetch(base + "/api/editor/dispatch", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ sha: result.sha }),
    });
    started = res.ok;
    if (!started) {
      const body = await res.json().catch(() => ({}));
      why = body.error || `the Worker did not start the run (${res.status})`;
    }
  } catch (err) {
    why = String((err && err.message) || err);
  }

  return { ...result, backend: "github", started, why };
}

/**
 * Refuse to push while a run is still going.
 *
 * Two saves in flight at once would have the second one's payload verified
 * against a queue branch the first is about to empty, and the second build
 * would clone a source the first has not finished writing. Waiting is not worth
 * the machinery: one look at the runs, and an author who is told to try again
 * in a minute.
 */
async function refuseWhileBuilding(repo) {
  const busy = await githubDriver.running(repo);
  if (busy) {
    throw Object.assign(
      new Error("a build is still running — try again when it has finished"),
      { kind: "busy" }
    );
  }
}

/* ─── sealing ──────────────────────────────────────────────────────────────── */

async function sealPayload(rawKey, text) {
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text))
  );
  const out = new Uint8Array(iv.length + body.length);
  out.set(iv, 0);
  out.set(body, iv.length);
  return out;
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Base64 for the wire, in chunks — a megabyte of photographs in one
 *  `String.fromCharCode(...bytes)` overflows the argument stack. */
function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/* ─── where the build has got to ───────────────────────────────────────────── */

/**
 * The public repository's own runs, read WITHOUT a credential.
 *
 * It is a public repository, so its workflow runs are public — which means the
 * build rail needs no token at all, and goes on working after the session's
 * credentials have been erased.
 */
export function commitStatus(sha) {
  const repo = ticket && ticket.repo;
  if (!repo) return Promise.resolve(null);
  return githubDriver.runStatus(repo, sha);
}

/* ─── pictures the site does not serve yet ─────────────────────────────────── */

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

/**
 * A picture as an object URL.
 *
 * The site is the only place these come from now. A public post's images are
 * published in the clear, so this is a plain fetch; an encrypted post's are
 * sealed, and those never reach here at all — they go through `unlockAsset` in
 * session.js, which holds the key for one picture at a time.
 *
 * Between committing an image and the deploy that publishes it there is a
 * window, minutes long, in which neither answer exists. The editor shows the
 * bytes it still holds from the upload; this is what is left afterwards.
 */
const blobs = new Map();

export function blobURL(path) {
  const key = String(path || "").replace(/^\/+/, "");
  if (!key) return Promise.resolve("");
  if (blobs.has(key)) return blobs.get(key);

  const pending = (async () => {
    try {
      const root = String((window.config && window.config.root) || "/").replace(/\/+$/, "");
      const res = await fetch(`${root}/${key.replace(/^source\//, "")}`);
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
