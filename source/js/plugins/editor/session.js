/**
 * Documents: where they are read from, and what a save turns into.
 *
 * ── Two places a post can live ──────────────────────────────────────────────
 *
 * A PUBLIC post is read straight out of Gitea. An ENCRYPTED one is not in the
 * public build at all, so it is read the way a reader reads it: `s.bin` off the
 * CDN, opened with the key the Worker released. That blob is the only copy of
 * an encrypted post's source outside the repository, and it is what makes
 * editing one possible without handing the browser the whole repo.
 *
 * ── What a save is ──────────────────────────────────────────────────────────
 *
 * One commit. There is no draft store and no autosave to a server: saving is
 * committing, and every commit runs the pipeline. Local recovery is the
 * browser's own, sealed under the document's key so a stolen disk yields
 * nothing.
 *
 * ── Drafts ──────────────────────────────────────────────────────────────────
 *
 * A draft is an ordinary encrypted post carrying `draft: true` and
 * `supersedes: <permalink>`. Editing a published post for the first time forks
 * one; publishing writes the draft's body back over the original and deletes
 * the draft in the same commit, so the two can never both be live.
 */

import * as gitea from "./gitea.js";
import { docToMarkdown, markdownToDoc, parseFrontMatter, setFrontMatterKey } from "./markdown.js";
import {
  b64urlToBytes,
  importAesKey,
  openText,
  openJSON,
  fetchSealed,
  vaultPrefix,
  siteRoot,
} from "../../tools/vaultCrypto.js";

const POSTS_DIR = "source/_posts";

let grants = null;

/* ─── grants ───────────────────────────────────────────────────────────────── */

async function loadGrants(force) {
  if (grants && !force) return grants;
  if (!window.blogAuth) return (grants = []);

  const session = await window.blogAuth.getSession();
  const base = window.blogAuth.resolveApiBase();
  if (!session || !session.token || !base) return (grants = []);

  const res = await fetch(base + "/api/vault/keys", {
    method: "POST",
    headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) return (grants = []);

  const body = await res.json().catch(() => ({}));
  grants = (body.posts || []).map((row) => ({ ...row, key: null, raw: row.key }));
  return grants;
}

async function keyOf(grant) {
  if (!grant.key) grant.key = await importAesKey(b64urlToBytes(grant.raw));
  return grant.key;
}

/** The sealed metadata record — title, date, draft flag, source path. */
async function metaOf(grant) {
  if (grant.meta !== undefined) return grant.meta;
  try {
    const sealed = await fetchSealed(`${vaultPrefix()}/${grant.slug}/c.bin`);
    grant.meta = sealed ? (await openJSON(await keyOf(grant), sealed)).meta || null : null;
  } catch (err) {
    grant.meta = null;
  }
  return grant.meta;
}

/* ─── the document list ────────────────────────────────────────────────────── */

/**
 * Everything the admin may open, newest first.
 *
 * A draft SHADOWS the post it supersedes rather than sitting beside it — the
 * same rule the reader applies to the published listings, for the same reason:
 * two entries for one article is a way to edit the wrong one.
 */
export async function listDocuments() {
  const [files, granted] = await Promise.all([gitea.list(POSTS_DIR), loadGrants(true)]);

  const metas = await Promise.all(granted.map(metaOf));
  const vaultBySource = new Map();
  const drafts = [];

  granted.forEach((grant, i) => {
    const meta = metas[i];
    if (!meta || meta.kind === "album") return;
    const entry = {
      kind: "vault",
      id: grant.id,
      slug: grant.slug,
      grant,
      path: meta.source || "",
      title: meta.title || "",
      date: meta.date || "",
      draft: meta.draft === true,
      supersedes: meta.supersedes || "",
      excerpt: meta.excerpt || "",
      cover: meta.cover || "",
    };
    if (entry.draft) drafts.push(entry);
    if (entry.path) vaultBySource.set(entry.path, entry);
  });

  const shadowed = new Set(drafts.map((d) => d.supersedes).filter(Boolean));
  const out = [];

  for (const file of files) {
    if (file.type !== "file" || !/\.md$/i.test(file.name)) continue;

    const vault = vaultBySource.get(file.path);
    if (vault && vault.draft) continue; // listed from the draft side below

    out.push({
      kind: vault ? "vault" : "public",
      id: vault ? vault.id : file.path,
      slug: vault ? vault.slug : "",
      grant: vault ? vault.grant : null,
      path: file.path,
      sha: file.sha,
      title: vault ? vault.title : titleFromName(file.name),
      date: vault ? vault.date : "",
      encrypted: !!vault,
      draft: false,
      shadowed: false,
    });
  }

  for (const draft of drafts) {
    out.push({ ...draft, kind: "vault", encrypted: true, sha: "" });
  }

  // A public post whose draft exists is marked rather than hidden: the admin
  // still needs to see that the published version is there and unchanged.
  for (const row of out) {
    if (row.permalink === undefined) row.permalink = "";
    if (!row.draft && shadowed.has(permalinkOf(row))) row.shadowed = true;
  }

  return out.sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.path.localeCompare(b.path));
}

function titleFromName(name) {
  return name.replace(/\.md$/i, "");
}

/** Hexo's `:year/:month/:day/:title/`, read off the file rather than computed
 *  through a timezone the browser does not share with the build. */
export function permalinkOf(entry) {
  const date = String(entry.date || "");
  const parts = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!parts) return "";
  const stem = String(entry.path || "").split("/").pop().replace(/\.md$/i, "");
  return `/${parts[1]}/${parts[2]}/${parts[3]}/${stem}/`;
}

/* ─── open ─────────────────────────────────────────────────────────────────── */

export async function openDocument(entry) {
  if (entry.encrypted && entry.grant) {
    // The repository is authoritative — a save has to know the blob sha it is
    // overwriting, and the repo holds what the last COMMIT wrote. `s.bin` holds
    // what the last BUILD sealed, so the two differing means a build is still
    // in flight. A post built before `s.bin` existed simply skips that check.
    const [file, sealed] = await Promise.all([
      entry.path ? gitea.read(entry.path) : Promise.resolve(null),
      fetchSealed(`${vaultPrefix()}/${entry.slug}/s.bin`).catch(() => null),
    ]);

    const built = sealed ? await openText(await keyOf(entry.grant), sealed).catch(() => null) : null;
    if (!file && !built) throw new Error(`${entry.path || entry.slug} is not in the repository`);

    return {
      ...markdownToDoc(file ? file.text : built),
      path: entry.path,
      sha: file ? file.sha : "",
      entry,
      stale: !!(file && built && file.text !== built),
    };
  }

  const file = await gitea.read(entry.path);
  if (!file) throw new Error(`${entry.path} is not in the repository`);
  return { ...markdownToDoc(file.text), path: entry.path, sha: file.sha, entry, stale: false };
}

/* ─── keys ─────────────────────────────────────────────────────────────────── */

/**
 * Mint a post key for a path that does not have one.
 *
 * Only the Worker can do this: it holds VAULT_MASTER, so it is the only party
 * that can wrap the key for D1 — and it returns the re-sealed keyring so the
 * SAME commit that creates the file also updates `.vault/keys.enc`. A key and
 * the content it protects can never be one commit apart.
 */
export async function mintVaultKey(sourcePath, title) {
  const session = await window.blogAuth.getSession();
  const base = window.blogAuth.resolveApiBase();

  const res = await fetch(base + "/api/admin/vault/mint", {
    method: "POST",
    headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
    body: JSON.stringify({ source: sourcePath, title: title || "" }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "could not mint a key for this post");
  }
  return res.json(); // { id, slug, keysEnc }
}

export async function revokeVaultKey(id) {
  const session = await window.blogAuth.getSession();
  const base = window.blogAuth.resolveApiBase();
  const res = await fetch(base + "/api/admin/vault/mint?id=" + encodeURIComponent(id), {
    method: "DELETE",
    headers: { Authorization: "Bearer " + session.token },
  });
  if (!res.ok) throw new Error("could not revoke the draft's key");
  return res.json(); // { keysEnc }
}

/* ─── save ─────────────────────────────────────────────────────────────────── */

function draftPathFor(path) {
  return path.replace(/\.md$/i, ".draft.md");
}

function withFront(source, updates) {
  const doc = markdownToDoc(source);
  let front = doc.front;
  for (const [key, value] of Object.entries(updates)) front = setFrontMatterKey(front, key, value);
  doc.front = front;
  doc.frontDirty = true;
  return docToMarkdown(doc);
}

/**
 * Save.
 *
 * `mode` is `draft` or `publish`. A draft commit writes one encrypted file and,
 * the first time, mints its key; a publish writes the body back over the
 * original, deletes the draft and revokes its key — one commit, so there is no
 * window in which both exist or neither does.
 */
export async function save(doc, mode, pending) {
  const files = [];
  const entry = doc.entry || {};
  const source = docToMarkdown(doc);
  let minted = null;
  let keysEnc = null;

  for (const asset of pending || []) {
    files.push({ operation: "create", path: asset.path, content: gitea.toBase64(asset.bytes) });
  }

  if (mode === "publish") {
    const target = entry.draft ? findPublishTarget(doc, entry) : doc.path;
    const clean = withFront(source, { vault: null, draft: null, supersedes: null });

    const current = await gitea.read(target);
    files.push({
      operation: current ? "update" : "create",
      path: target,
      content: gitea.toBase64(clean),
      ...(current ? { sha: current.sha } : {}),
    });

    if (entry.draft && doc.path && doc.path !== target) {
      const draftFile = await gitea.read(doc.path);
      if (draftFile) files.push({ operation: "delete", path: doc.path, sha: draftFile.sha });
      const revoked = await revokeVaultKey(entry.id);
      keysEnc = revoked.keysEnc;
    }

    if (keysEnc) {
      files.push(await keyringFile(keysEnc));
    }

    const result = await gitea.commit(files, `Publish: ${titleOf(doc)}`);
    return { ...result, path: target, published: true };
  }

  // ── draft ──────────────────────────────────────────────────────────────
  let path = doc.path;
  let sha = doc.sha;
  let body = source;

  if (!entry.draft && !entry.encrypted) {
    // First edit of a published post: fork it.
    path = draftPathFor(doc.path);
    sha = "";
    minted = await mintVaultKey(path, titleOf(doc));
    keysEnc = minted.keysEnc;
    body = withFront(source, {
      vault: "true",
      draft: "true",
      supersedes: permalinkOf({ date: frontOf(doc).date, path: doc.path }),
    });
  } else if (!entry.encrypted) {
    minted = await mintVaultKey(path, titleOf(doc));
    keysEnc = minted.keysEnc;
    body = withFront(source, { vault: "true", draft: "true" });
  } else {
    const existing = await gitea.read(path);
    sha = existing ? existing.sha : "";
  }

  files.push({
    operation: sha ? "update" : "create",
    path,
    content: gitea.toBase64(body),
    ...(sha ? { sha } : {}),
  });

  if (keysEnc) files.push(await keyringFile(keysEnc));

  const result = await gitea.commit(files, `Draft: ${titleOf(doc)}`);
  return { ...result, path, minted, published: false };
}

/** A brand-new post, encrypted from its first commit. */
export async function create(title, front) {
  const stem = String(title).trim().replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || "untitled";
  const path = `${POSTS_DIR}/${stem}.md`;
  const minted = await mintVaultKey(path, title);

  const now = front && front.date ? front.date : localStamp();
  const source =
    `---\n` +
    `title: ${title}\n` +
    `cover: \n` +
    `thumbnail: \n` +
    `excerpt: \n` +
    `sticky: \n` +
    `date: ${now}\n` +
    `updated: ${now}\n` +
    `vault: true\n` +
    `draft: true\n` +
    `supersedes: \n` +
    `mathjax: false\n` +
    `categories:\n` +
    `tags:\n` +
    `---\n\n`;

  const files = [
    { operation: "create", path, content: gitea.toBase64(source) },
    await keyringFile(minted.keysEnc),
  ];
  const result = await gitea.commit(files, `New draft: ${title}`);
  return { ...result, path, source, minted };
}

export async function remove(entry) {
  const files = [];
  const file = await gitea.read(entry.path);
  if (file) files.push({ operation: "delete", path: entry.path, sha: file.sha });

  if (entry.encrypted && entry.id) {
    const revoked = await revokeVaultKey(entry.id);
    if (revoked.keysEnc) files.push(await keyringFile(revoked.keysEnc));
  }
  if (!files.length) return null;
  return gitea.commit(files, `Remove: ${entry.title || entry.path}`);
}

async function keyringFile(keysEnc) {
  const current = await gitea.read(".vault/keys.enc");
  return {
    operation: current ? "update" : "create",
    path: ".vault/keys.enc",
    content: gitea.toBase64(keysEnc),
    ...(current ? { sha: current.sha } : {}),
  };
}

function frontOf(doc) {
  return parseFrontMatter(doc.front);
}

function titleOf(doc) {
  return frontOf(doc).title || doc.path.split("/").pop().replace(/\.md$/i, "");
}

/** Where a draft's body belongs when it is published. */
function findPublishTarget(doc, entry) {
  if (entry.supersedes) {
    const stem = String(entry.supersedes).replace(/\/+$/, "").split("/").pop();
    if (stem) return `${POSTS_DIR}/${stem}.md`;
  }
  return doc.path.replace(/\.draft\.md$/i, ".md");
}

function localStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ─── local recovery ───────────────────────────────────────────────────────── */

/**
 * The crash net, and nothing more.
 *
 * Sealed under the document's own key, so what lands on disk is ciphertext and
 * reopening it needs a session — the same bargain the reader side makes. A
 * document with no key yet (a public post being edited for the first time) is
 * simply not cached; its source is in the repository already.
 */
const RECOVERY_DB = "redefine-editor";

function idb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(RECOVERY_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("drafts", { keyPath: "path" });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function withStore(mode, fn) {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("drafts", mode);
      const result = fn(tx.objectStore("drafts"));
      tx.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    return null;
  }
}

export async function stash(doc, grant) {
  if (!grant) return;
  const key = await keyOf(grant);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(docToMarkdown(doc))
  );
  const blob = new Uint8Array(iv.length + sealed.byteLength);
  blob.set(iv, 0);
  blob.set(new Uint8Array(sealed), iv.length);
  await withStore("readwrite", (store) => store.put({ path: doc.path, blob, at: Date.now() }));
}

export async function recover(path, grant) {
  if (!grant) return null;
  const row = await withStore("readonly", (store) => store.get(path));
  if (!row || !row.blob) return null;
  try {
    const key = await keyOf(grant);
    const blob = row.blob;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.slice(0, 12) },
      key,
      blob.slice(12)
    );
    return { source: new TextDecoder().decode(plain), at: row.at };
  } catch (err) {
    return null;
  }
}

export async function dropStash(path) {
  await withStore("readwrite", (store) => store.delete(path));
}

export { siteRoot };
