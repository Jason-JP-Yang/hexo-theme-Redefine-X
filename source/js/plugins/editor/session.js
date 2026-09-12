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

import * as repo from "./repo.js";
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

/**
 * A repository path, from either spelling of the same file.
 *
 * Hexo's `post.source` is relative to `source/` — that is what the rendered
 * page carries and what the sealed metadata records — while Gitea lists and
 * writes full repository paths. Mixing the two is not a cosmetic mismatch: an
 * encrypted post whose `_posts/x.md` never matched a listed `source/_posts/x.md`
 * fell out of the document list entirely, so opening it reported that the post
 * was not in the repository, and a save that did find it would have created a
 * second file at the wrong path.
 */
function repoPath(p) {
  const rel = String(p || "").replace(/^\/+/, "");
  if (!rel) return "";
  return rel.startsWith("source/") ? rel : "source/" + rel;
}

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
  // `raw` is BYTES, the same shape plugins/vault.js keeps. The sealed-asset
  // helpers take raw key material, and one of the two spellings silently
  // derives the wrong path rather than failing.
  grants = (body.posts || []).map((row) => ({ ...row, key: null, raw: b64urlToBytes(row.key) }));
  return grants;
}

async function keyOf(grant) {
  if (!grant.key) grant.key = await importAesKey(grant.raw);
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
  const [files, granted] = await Promise.all([repo.list(POSTS_DIR), loadGrants(true)]);

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
      path: repoPath(meta.source),
      title: meta.title || "",
      date: meta.date || "",
      draft: meta.draft === true,
      supersedes: meta.supersedes || "",
      excerpt: meta.excerpt || "",
      cover: meta.cover || "",
      // Published route -> content hash for this post's sealed images. The only
      // way to find them: their plaintext routes are withheld from the build.
      assets: meta.assets || {},
      sizes: meta.sizes || {},
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
      assets: vault ? vault.assets : null,
      sizes: vault ? vault.sizes : null,
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

/**
 * The document the page in front of you is showing.
 *
 * `source` comes from the rendered post; `slug` from an encrypted one, whose
 * page carries nothing else. A published post that already HAS a draft resolves
 * to the draft — editing the published copy instead would fork a second one,
 * and the reader is already being shown the draft's text.
 */
export async function entryForPage({ source, slug }) {
  const entries = await listDocuments();

  if (slug) return entries.find((e) => e.slug === slug) || null;

  const path = repoPath(source);
  if (!path) return null;

  const row = entries.find((e) => e.path === path);
  if (!row) return null;
  if (!row.shadowed) return row;

  const link = permalinkOf(row);
  return entries.find((e) => e.draft && e.supersedes === link) || row;
}

/** The post key for an id, after a mint has put it in D1. */
export async function grantFor(id) {
  const rows = await loadGrants(true);
  return rows.find((row) => row.id === id) || null;
}

/* ─── open ─────────────────────────────────────────────────────────────────── */

export async function openDocument(entry) {
  if (entry.encrypted && entry.grant) {
    // The repository is authoritative — a save has to know the blob sha it is
    // overwriting, and the repo holds what the last COMMIT wrote. `s.bin` holds
    // what the last BUILD sealed, so the two differing means a build is still
    // in flight. A post built before `s.bin` existed simply skips that check.
    const [file, sealed] = await Promise.all([
      entry.path ? repo.read(entry.path) : Promise.resolve(null),
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

  const file = await repo.read(entry.path);
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
export async function mintVaultKey(sourcePath) {
  const session = await window.blogAuth.getSession();
  const base = window.blogAuth.resolveApiBase();

  const res = await fetch(base + "/api/admin/vault/mint", {
    method: "POST",
    headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
    body: JSON.stringify({ source: sourcePath }),
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
const TRUTHY = /^(true|yes|on|1)$/i;

/**
 * Should the PUBLISHED post be encrypted?
 *
 * `vault` means two different things depending on who wrote it. On a draft it
 * is machinery — every draft is encrypted, and the fork writes the flag itself
 * — so publishing has to drop it or the first edit of any post would encrypt it
 * forever. In a post's own front matter it is the author's decision, and
 * dropping it there is why the Encrypted switch did nothing.
 *
 * `choice` is that switch, and it is set only when it was actually operated, so
 * it wins over both readings without needing to guess between them.
 */
function publishEncrypted(doc, entry, choice) {
  if (choice !== undefined && choice !== null) return TRUTHY.test(String(choice));
  if (entry.draft) return false;
  return TRUTHY.test(String(parseFrontMatter(doc.front).vault || ""));
}

/**
 * The picker's renames and moves — as a NOTE, never as file operations.
 *
 * Gitea's contents API takes a file as base64 inside a JSON body. Moving a
 * folder of two hundred photographs by committing them at their new paths would
 * mean pulling every one of them down through the tab and pushing every one
 * back up a third larger, hundreds of megabytes, for a commit that changes no
 * bytes at all — and git already stores one blob however many paths point at
 * it. So the save commits the REQUEST: a few hundred bytes of
 * `source/_data/image-moves.json` however large the move is.
 *
 * The build is where the files move. It has the whole tree on disk, where a
 * rename costs nothing; it rewrites the other forty posts at the same time; and
 * the deploy commits the result back, which is the commit git records as a
 * rename. See scripts/lib/image-moves.js.
 *
 * (What this must never go back to is `{ operation: "update", path: to,
 * from_path: from, sha }` with no content. That reads like a rename and is not
 * one: Gitea takes missing content as EMPTY content, drops the old path from
 * the index and writes a zero-byte blob at the new one — the picture destroyed
 * by the commit meant to move it, and every check downstream agreeing the move
 * went fine because a file did arrive.)
 *
 * A picture the repository has never seen needs no note: it was added in this
 * same session and rides in on the pending upload under its final name.
 */
async function movedFiles(stage) {
  if (!stage || !stage.dirty) return [];

  // One listing per folder, not one per file: a folder move is hundreds of
  // pairs that all share a parent.
  const listings = new Map();
  const known = async (repoPath) => {
    const dir = repoPath.replace(/\/[^/]+$/, "");
    if (!listings.has(dir)) listings.set(dir, repo.list(dir).catch(() => []));
    return (await listings.get(dir)).some((row) => row.path === repoPath);
  };

  const notes = [];
  for (const move of stage.moves) {
    if (move.noted) continue;
    if (await known(move.from)) notes.push({ from: move.from, to: move.to });
  }
  if (!notes.length) return [];

  const JOURNAL = "source/_data/image-moves.json";
  let held = [];
  let sha = "";
  try {
    const current = await repo.read(JOURNAL);
    if (current) {
      sha = current.sha;
      held = JSON.parse(current.text) || [];
    }
  } catch (err) {
    held = [];
  }

  const body = JSON.stringify(held.concat(notes), null, 2) + "\n";
  return [
    {
      operation: sha ? "update" : "create",
      path: JOURNAL,
      content: repo.toBase64(body),
      ...(sha ? { sha } : {}),
    },
  ];
}

export async function save(doc, mode, pending, choice, stage) {
  const files = [];
  const entry = doc.entry || {};
  // Stamped here rather than offered as a field: `updated` means "when this was
  // last saved", and the only moment that is known is this one.
  doc.front = setFrontMatterKey(doc.front, "updated", localStamp());
  doc.frontDirty = true;
  const source = docToMarkdown(doc);
  let minted = null;
  let keysEnc = null;

  // At the path the staged tidy-up says it ends up at, not the one it was
  // uploaded under: a picture added and then renamed in the browser has no sha
  // to move, so the rename can only happen by committing it under the new name.
  for (const asset of pending || []) {
    const at = stage ? stage.resolve(asset.path) : asset.path;
    files.push({ operation: "create", path: at, content: repo.toBase64(asset.bytes) });
  }
  files.push(...(await movedFiles(stage)));

  if (mode === "publish") {
    // A post that has never been saved publishes straight to its own file: it
    // has no draft to fold back and no key to revoke.
    const target = doc.isNew
      ? pathForTitle(frontOf(doc).title)
      : entry.draft
        ? findPublishTarget(doc, entry)
        : doc.path;
    const encrypted = publishEncrypted(doc, entry, choice);
    const clean = withFront(source, {
      vault: encrypted ? "true" : null,
      draft: null,
      supersedes: null,
    });

    const current = await repo.read(target);
    files.push({
      operation: current ? "update" : "create",
      path: target,
      content: repo.toBase64(clean),
      ...(current ? { sha: current.sha } : {}),
    });

    if (entry.draft && doc.path && doc.path !== target) {
      const draftFile = await repo.read(doc.path);
      if (draftFile) files.push({ operation: "delete", path: doc.path, sha: draftFile.sha });
      // The draft's key goes; the published post gets its own from the build,
      // which is what puts it on the console's Encrypted Posts list.
      const revoked = await revokeVaultKey(entry.id);
      keysEnc = revoked.keysEnc;
    }

    if (keysEnc) {
      files.push(await keyringFile(keysEnc));
    }

    const result = await repo.commit(files, `Publish: ${titleOf(doc)}`);
    return { ...result, path: target, published: true, encrypted };
  }

  // ── draft ──────────────────────────────────────────────────────────────
  let path = doc.path;
  let sha = doc.sha;
  let body = source;

  if (doc.isNew) {
    path = pathForTitle(frontOf(doc).title);
    sha = "";
    if (await repo.read(path)) {
      throw new Error(`${path} already exists — give this post a different title`);
    }
    minted = await mintVaultKey(path);
    keysEnc = minted.keysEnc;
    body = withFront(source, { vault: "true", draft: "true" });
  } else if (!entry.draft && !entry.encrypted) {
    // First edit of a published post: fork it.
    path = draftPathFor(doc.path);
    sha = "";
    minted = await mintVaultKey(path);
    keysEnc = minted.keysEnc;
    body = withFront(source, {
      vault: "true",
      draft: "true",
      supersedes: permalinkOf({ date: frontOf(doc).date, path: doc.path }),
    });
  } else if (!entry.encrypted) {
    minted = await mintVaultKey(path);
    keysEnc = minted.keysEnc;
    body = withFront(source, { vault: "true", draft: "true" });
  } else {
    const existing = await repo.read(path);
    sha = existing ? existing.sha : "";
  }

  files.push({
    operation: sha ? "update" : "create",
    path,
    content: repo.toBase64(body),
    ...(sha ? { sha } : {}),
  });

  if (keysEnc) files.push(await keyringFile(keysEnc));

  const result = await repo.commit(files, `Draft: ${titleOf(doc)}`);
  return { ...result, path, minted, published: false };
}

/**
 * A brand-new post, in memory only.
 *
 * Nothing is committed and no key is minted until the first save. Creating a
 * file the moment someone opens the editor would put an empty post in the
 * repository — and start a build for it — for every visit that changed its
 * mind.
 */
export function newDocument() {
  const now = localStamp();
  const source =
    `---\n` +
    `title: ""\n` +
    `cover: \n` +
    `thumbnail: \n` +
    // Quoted, not bare: `title` and `excerpt` are String fields in Hexo's Post
    // schema, and a null one aborts the build before anything renders.
    `excerpt: ""\n` +
    `sticky: \n` +
    `date: ${now}\n` +
    `updated: ${now}\n` +
    `vault: true\n` +
    `draft: true\n` +
    `mathjax: false\n` +
    `categories:\n` +
    `tags:\n` +
    `---\n\n`;

  return {
    ...markdownToDoc(source),
    path: "",
    sha: "",
    isNew: true,
    entry: { kind: "new", draft: true, encrypted: true },
    stale: false,
  };
}

/** Where a new post's file goes, derived from its title at save time. */
function pathForTitle(title) {
  const stem =
    String(title || "").trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").slice(0, 80) ||
    "untitled-" + Date.now().toString(36);
  return `${POSTS_DIR}/${stem}.md`;
}

/**
 * Take published articles down without losing them.
 *
 * Each one's markdown becomes a draft — encrypted, and readable by nobody but
 * its author — and the published file is deleted. ONE commit for the whole
 * selection, so no article is ever both live and withdrawn, never neither, and
 * a batch of five costs one build rather than five.
 *
 * `supersedes` is dropped on the way: it names the published post a draft
 * stands in front of, and after this there is no such post. A draft that kept
 * it would be folded back into a row whose published half no longer exists,
 * both in the console's inventory and in the reader's listings.
 *
 * The keyring is written ONCE, at the end. Every mint and every revoke hands
 * back the whole file rebuilt from the database, so only the last answer is
 * current — collecting them all and keeping the last is the same rule the
 * single-post path followed, generalised.
 *
 * @param {Array<object>} rows  items of the console's sealed inventory
 */
export async function unpublishAll(rows) {
  const files = [];
  let keysEnc = null;

  for (const row of rows) {
    const source = repoPath(row.source);
    const published = source ? await repo.read(source) : null;
    const draftSource = row.draft && row.draft.source ? repoPath(row.draft.source) : "";

    if (draftSource) {
      // A draft already stands in front of it. It simply stops standing in for
      // anything — its path and its key are unchanged, so no key moves here.
      const current = await repo.read(draftSource);
      if (current) {
        files.push({
          operation: "update",
          path: draftSource,
          sha: current.sha,
          content: repo.toBase64(
            withFront(current.text, { vault: "true", draft: "true", supersedes: null })
          ),
        });
      }
    } else {
      if (!published) throw new Error(`${source || row.title} is not in the repository`);
      const path = draftPathFor(source);
      if (await repo.read(path)) throw new Error(`${path} already exists`);
      keysEnc = (await mintVaultKey(path)).keysEnc;
      files.push({
        operation: "create",
        path,
        content: repo.toBase64(
          withFront(published.text, { vault: "true", draft: "true", supersedes: null })
        ),
      });
    }

    if (published) files.push({ operation: "delete", path: source, sha: published.sha });

    if (row.encrypted && row.vaultId) {
      keysEnc = (await revokeVaultKey(row.vaultId)).keysEnc;
    }
  }

  if (!files.length) return null;
  if (keysEnc) files.push(await keyringFile(keysEnc));

  const titles = rows.map((row) => row.title || repoPath(row.source)).filter(Boolean);
  return repo.commit(
    files,
    titles.length === 1 ? `Unpublish: ${titles[0]}` : `Unpublish ${titles.length} posts`
  );
}

export async function remove(entry) {
  const files = [];
  const file = await repo.read(entry.path);
  if (file) files.push({ operation: "delete", path: entry.path, sha: file.sha });

  if (entry.encrypted && entry.id) {
    const revoked = await revokeVaultKey(entry.id);
    if (revoked.keysEnc) files.push(await keyringFile(revoked.keysEnc));
  }
  if (!files.length) return null;
  return repo.commit(files, `Remove: ${entry.title || entry.path}`);
}

async function keyringFile(keysEnc) {
  const current = await repo.read(".vault/keys.enc");
  return {
    operation: current ? "update" : "create",
    path: ".vault/keys.enc",
    content: repo.toBase64(keysEnc),
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
