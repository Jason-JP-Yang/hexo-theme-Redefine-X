/**
 * Documents: where they are read from, and what a save turns into.
 *
 * ── Where a post is read from ───────────────────────────────────────────────
 *
 * One place, for every post: `s.bin` off the CDN, opened with the key the
 * Worker released for that item. It used to be two — an encrypted post read
 * this way and a public one read straight out of the repository with a token
 * the browser held — and the second half is gone with the token. Every post
 * has a sealed source copy now, and a key opens exactly one of them.
 *
 * ── What a save is ──────────────────────────────────────────────────────────
 *
 * One sealed payload, pushed to a queue branch of the PUBLIC repository with a
 * signed receipt naming who asked and what they were cleared for. The runner
 * opens it, checks every path against that receipt, and applies it to the
 * private repository or refuses the whole of it. There is no draft store and no
 * autosave to a server: saving is committing, and every commit runs the
 * pipeline. Local recovery is the browser's own, sealed under the document's
 * key so a stolen disk yields nothing.
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
  assetURL,
  b64urlToBytes,
  dropAssetKeys,
  importAesKey,
  openText,
  openJSON,
  fetchSealed,
  pageId,
  registerAssetKey,
  vaultPrefix,
  siteRoot,
} from "../../tools/vaultCrypto.js";

const POSTS_DIR = "source/_posts";

/**
 * A repository path, from either spelling of the same file.
 *
 * Hexo's `post.source` is relative to `source/` — that is what the rendered
 * page carries and what the sealed metadata records — while a save names full
 * repository paths. Mixing the two is not a cosmetic mismatch: an
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
let sealedAll = null;
// hash -> the grant that opens it. Held here and handed to nobody: the browser
// asks for one picture at a time and gets a URL, never a key.
let owners = null;

/* ─── grants ───────────────────────────────────────────────────────────────── */

/**
 * Every item this session may open.
 *
 * `/api/editor/keys` rather than `/api/vault/keys`: the second is the READER's
 * route and returns only the encrypted posts a reader was granted. The editor
 * needs the other axis — everything this identity may open OR change, which
 * now includes every public post, because a public post's markdown is sealed
 * beside the site so that editing it needs no credential for the repository it
 * lives in.
 *
 * `masonry` and `log` come back on the same list and are not documents; they
 * are filtered out here rather than at the Worker, which has no business
 * knowing what a document is.
 */
async function loadGrants(force) {
  if (grants && !force) return grants;
  // A re-fetch replaces the grant objects, and the sealed index is built out of
  // the metadata cached on them.
  sealedAll = null;
  if (!window.blogAuth) return (grants = []);

  const session = await window.blogAuth.getSession();
  const base = window.blogAuth.resolveApiBase();
  if (!session || !session.token || !base) return (grants = []);

  const res = await fetch(base + "/api/editor/keys", {
    method: "POST",
    headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) return (grants = []);

  const body = await res.json().catch(() => ({}));
  // `raw` is BYTES, the same shape plugins/vault.js keeps. The sealed-asset
  // helpers take raw key material, and one of the two spellings silently
  // derives the wrong path rather than failing.
  grants = (body.items || [])
    .filter((row) => row.kind === "post" || row.kind === "album")
    .map((row) => ({ ...row, key: null, raw: b64urlToBytes(row.key) }));
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

/**
 * Every sealed picture in the vault, under both of the names it answers to.
 *
 * The public manifest deliberately omits them — a withheld image's FILE NAME is
 * the one piece of plaintext encryption would otherwise leave behind — so
 * without this the picture browser simply could not see a third of the library,
 * and previewing one meant asking the site for a route the build withdrew: a
 * 404, the browser's broken-picture glyph, and only then the slow fall back to
 * the repository. That is the flash this removes.
 *
 * It costs NO requests. `listDocuments` has already fetched every grant and
 * opened every `c.bin`, and both are cached on the grant objects; this walks
 * what is already in hand.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 *
 * It does not register a single decryption key. An earlier version registered
 * all of them here, which quietly made every withheld picture on the site
 * openable by anything holding a hash, for as long as the page lived — a
 * listing is not permission to decrypt. Keys are handed to `vaultCrypto` one
 * picture at a time, by `unlockAsset` below, when the author clicks that
 * picture, and taken back when they click away from it.
 *
 * Keyed by published route AND source path, the two spellings `noteAsset`
 * writes, so a caller with either one finds it.
 *
 * @returns {Promise<Object<string, {hash: string, width: number, height: number}>>}
 */
export async function sealedIndex() {
  if (sealedAll) return sealedAll;

  // FORCED when there are no grants in hand. `loadGrants` returns an empty
  // array — which is truthy — for every reason the session was not ready yet:
  // no `blogAuth` on the page, no token, a Worker that did not answer. Asking
  // it again without `force` hands the same empty array back for the rest of
  // the page's life, and the picture browser is then permanently missing every
  // withheld picture with nothing to say it went wrong.
  const granted = await loadGrants(!grants || !grants.length);
  const metas = await Promise.all(granted.map((grant) => metaOf(grant)));
  const out = {};
  const map = new Map();

  granted.forEach((grant, i) => {
    const meta = metas[i];
    if (!meta || !meta.assets) return;
    const sizes = meta.sizes || {};
    for (const [name, hash] of Object.entries(meta.assets)) {
      if (!hash) continue;
      const wh = sizes[name] || [];
      out[name] = { hash, width: wh[0] || 0, height: wh[1] || 0 };
      map.set(hash, grant);
    }
  });

  if (!granted.length) return out; // nothing to cache, and nothing to unlock

  owners = map;
  return (sealedAll = out);
}

/**
 * Open ONE sealed picture, now, because the author asked to look at it.
 *
 * The key is registered for this hash alone and only at this moment; the caller
 * gets a blob URL back and never the key. `relockAsset` takes it away again.
 * Nothing is unlocked ahead of a click, so a browser left open on a folder of
 * withheld pictures holds none of them in the clear.
 *
 * Returns "" when this hash belongs to no grant — including before the index
 * has ever been built, which is the ordinary case for the open document's own
 * images: those are registered by `setVaultAssets`, and `assetURL` finds them.
 */
export async function unlockAsset(hash) {
  if (!hash) return "";
  const grant = owners && owners.get(hash);
  if (grant) registerAssetKey(hash, grant.raw);
  return assetURL(hash);
}

/** Take the key and the decrypted bytes back. */
export function relockAsset(hashes) {
  dropAssetKeys(hashes);
}

/**
 * Drop the post keys.
 *
 * Same bargain as the repository tokens: they live in this module's closure and
 * nowhere else, and they go the moment the editor does. credentials.js is the
 * complete list of events that reach here.
 */
export function forgetGrants() {
  grants = null;
  sealedAll = null;
  owners = null;
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
  const granted = await loadGrants(true);

  const metas = await Promise.all(granted.map(metaOf));
  const vaultBySource = new Map();
  const drafts = [];
  // Every post has a sealed source copy now, so this list is no longer two
  // lists stitched together — a repository listing for the public ones and the
  // grants for the rest. It is the grants, and what separates the two kinds is
  // `enc`: whether the item is encrypted ON THE SITE, not whether the editor
  // can open it.
  const files = [];

  granted.forEach((grant, i) => {
    const meta = metas[i];
    if (!meta || meta.kind === "album") return;
    const path = repoPath(meta.source);

    // EVERY article gets a row here, encrypted or not. `files` used to be a
    // repository listing of `_posts`, which is what made the loop below work:
    // it walked every file on disk and `vaultBySource` upgraded the encrypted
    // ones in place. Filling it only with the public ones left every published
    // encrypted post out of the list entirely — the editor then reported that
    // the post it was standing on was not one it could write to.
    //
    // A public post's title and date used to be guessed from its file name,
    // because a repository listing is a name and a sha and nothing else. The
    // sealed record carries the real ones, so the list agrees with the site.
    files.push({
      type: "file",
      name: String(meta.source || "").split("/").pop() || "",
      path,
      sha: "",
      title: meta.title || "",
      date: meta.date || "",
      grant,
      slug: grant.slug,
    });

    if (grant.enc !== 1) return;

    const entry = {
      kind: "vault",
      id: grant.id,
      slug: grant.slug,
      grant,
      path,
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

  // Keyed by the PUBLISHED FILE the draft stands in front of, not by permalink.
  // A permalink needs a date, and a plain published post has none here — its
  // front matter is never fetched — so every public row's permalink came out
  // empty, matched nothing, and no published post was ever marked shadowed.
  // Opening one then edited the published copy while the reader was being shown
  // the draft, and saving forked a SECOND draft of the same article.
  const shadowed = new Set(drafts.map(publishedPathOf).filter(Boolean));
  const out = [];

  for (const file of files) {
    if (file.type !== "file" || !/\.md$/i.test(file.name)) continue;

    const vault = vaultBySource.get(file.path);
    if (vault && vault.draft) continue; // listed from the draft side below

    out.push({
      kind: vault ? "vault" : "public",
      id: vault ? vault.id : file.path,
      slug: vault ? vault.slug : file.slug || "",
      grant: vault ? vault.grant : file.grant || null,
      path: file.path,
      sha: file.sha,
      title: vault ? vault.title : file.title || titleFromName(file.name),
      date: vault ? vault.date : file.date || "",
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
    if (!row.draft && shadowed.has(row.path)) row.shadowed = true;
  }

  return out.sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.path.localeCompare(b.path));
}

function titleFromName(name) {
  return name.replace(/\.md$/i, "");
}

/**
 * The published post a draft stands in front of — as a FILE.
 *
 * `supersedes` is a permalink, and its last segment is the published post's
 * filename stem: `permalinkOf` builds it from that very path. Matching on the
 * whole permalink needs a date the public listing does not have; matching on
 * the file needs nothing. This is also where a draft's body goes when it is
 * published, which is why there is one function and not two.
 */
function publishedPathOf(entry) {
  const stem = String(entry.supersedes || "").replace(/\/+$/, "").split("/").pop();
  if (stem) return `${POSTS_DIR}/${stem}.md`;
  return String(entry.path || "").replace(/\.draft\.md$/i, ".md");
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
 *
 * BOTH spellings resolve. The slug branch used to return whatever grant the page
 * named and stop there, so an ENCRYPTED published post with a draft in front of
 * it opened the published copy — the same confusion the path branch was written
 * to prevent, reached by the other door.
 */
export async function entryForPage({ source, slug }) {
  const path = slug ? "" : repoPath(source);
  if (!slug && !path) return null;

  const entries = await listDocuments();
  const row = slug
    ? entries.find((e) => e.slug === slug)
    : entries.find((e) => e.path === path);

  if (!row) return null;
  if (row.draft || !row.shadowed) return row;
  return entries.find((e) => e.draft && publishedPathOf(e) === row.path) || row;
}

/** The post key for an id, after a mint has put it in D1. */
export async function grantFor(id) {
  const rows = await loadGrants(true);
  return rows.find((row) => row.id === id) || null;
}

/* ─── albums ───────────────────────────────────────────────────────────────── */

/**
 * Every encrypted album this identity holds a key for.
 *
 * `listDocuments` skips them on purpose — an album is not a file in `_posts` and
 * has no markdown — but the masonry editor needs exactly what it discards: the
 * grant that opens an album's sealed photographs, and the `assets` / `sizes`
 * maps that say what those photographs are called and what shape they are. Both
 * are already in hand; this walks the same cached metadata a second time.
 */
export async function listAlbums(force) {
  const granted = await loadGrants(force !== false);
  const metas = await Promise.all(granted.map(metaOf));

  const out = [];
  granted.forEach((grant, i) => {
    const meta = metas[i];
    if (!meta || meta.kind !== "album") return;
    out.push({
      kind: "album",
      id: grant.id,
      slug: grant.slug,
      grant,
      title: meta.title || "",
      name: meta.name || meta.title || "",
      category: meta.category || "",
      draft: meta.draft === true,
      supersedes: meta.supersedes || "",
      // The published album's real address, sealed by the build. Pairing on it
      // rather than on the title is exact: a title is a string two entries have
      // to spell identically, an address is the page itself.
      supersedesHref: meta.supersedesHref || "",
      assets: meta.assets || {},
      sizes: meta.sizes || {},
    });
  });
  return out;
}

/**
 * The key the admin surface is sealed under.
 *
 * Every identity that can reach the editor at all holds it, and unlike a post
 * key it exists before anything has been saved — which is what makes it the one
 * key a brand-new document can seal its local recovery copy under. Without it a
 * post or an album being written for the first time has no crash net at all,
 * which is exactly when losing the work costs the most.
 */
export async function adminGrant() {
  const rows = await loadGrants(false);
  const wanted = await pageId("admin");
  return rows.find((row) => row.id === wanted) || null;
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
 * `vault` means ONE thing wherever it is written: whether the post readers end
 * up with is encrypted. It never describes the draft — a draft is withheld
 * because it is a draft, which the build reads off `draft:` alone — so a fork
 * carries the published post's value forward unchanged and publishing simply
 * hands it back.
 *
 * The earlier reading made it machinery on a draft and re-read the published
 * file at publish time, which meant the Encrypted switch silently did nothing
 * on any draft, and a fork rewrote `vault: true` over a public post's own
 * setting.
 *
 * `choice` is the switch, set only when it was actually operated, so it wins.
 */
function publishEncrypted(doc, choice) {
  if (choice !== undefined && choice !== null) return TRUTHY.test(String(choice));
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
/**
 * The notes that tell the build a picture moved.
 *
 * Every move is noted now, rather than only the ones a repository listing
 * confirmed. There is no repository to list — the editor reads from the
 * published site — and the two errors are not symmetrical: a note for a file
 * that was never there is a line the build finds nothing to do with, while a
 * MISSING note is a picture left behind by the commit meant to move it, with
 * every check downstream agreeing the move went fine because a file did arrive.
 *
 * The journal is APPENDED by the runner rather than rewritten here, for the
 * same reason: this session cannot read what is already in it, and a save that
 * replaced the file with its own idea of the contents would drop whatever
 * another save had put there.
 */
async function movedFiles(stage) {
  if (!stage || !stage.dirty) return [];

  const notes = [];
  for (const move of stage.moves) {
    if (move.noted) continue;
    notes.push({ from: move.from, to: move.to });
  }
  if (!notes.length) return [];

  return [
    {
      operation: "append",
      path: "source/_data/image-moves.json",
      content: repo.toBase64(JSON.stringify(notes)),
    },
  ];
}

/**
 * Add the signed-in collaborator to `contributor:`, once.
 *
 * Both halves of a save reach here — a draft and a publish — because both are
 * work on the post, and a name that only appeared once it went live would say
 * nothing about who wrote it. The admin is never added: they are the author, and
 * an author listed among their own collaborators is a byline that has lost track
 * of what it is for.
 *
 * Ids already there are kept in the order the file has them, so a save by one
 * person never reorders anybody else's line. The value is only written when it
 * actually changes, so an ordinary save by an existing contributor produces no
 * front-matter diff at all.
 */
function stampContributor(front) {
  const me = repo.collaborator();
  if (!me) return front;

  const held = parseFrontMatter(front).contributor;
  const ids = (Array.isArray(held) ? held : String(held == null ? "" : held).split(","))
    .map((v) => String(v).trim())
    .filter(Boolean);
  if (ids.includes(String(me.id))) return front;

  return setFrontMatterKey(front, "contributor", ids.concat(String(me.id)));
}

export async function save(doc, mode, pending, choice, stage) {
  const files = [];
  const entry = doc.entry || {};
  // Stamped here rather than offered as a field: `updated` means "when this was
  // last saved", and the only moment that is known is this one. `contributor` is
  // stamped for the same reason and is not a field either — see the editor's
  // front-matter card, which refuses to render it.
  doc.front = setFrontMatterKey(doc.front, "updated", localStamp());
  doc.front = stampContributor(doc.front);
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
    const current = await repo.read(target);
    const encrypted = publishEncrypted(doc, choice);
    const clean = withFront(source, {
      vault: encrypted ? "true" : null,
      draft: null,
      supersedes: null,
    });

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

  // `vault:` is never written by a draft save. It is the author's decision
  // about the PUBLISHED post and it travels with the fork untouched; the draft
  // itself is withheld and keyed on `draft: true`, which the build reads on its
  // own (scripts/filters/vault.js). Overwriting it here is what made forking a
  // public post silently mark it for encryption.
  if (doc.isNew) {
    path = pathForTitle(frontOf(doc).title);
    sha = "";
    if (await repo.read(path)) {
      throw new Error(`${path} already exists — give this post a different title`);
    }
    minted = await mintVaultKey(path);
    keysEnc = minted.keysEnc;
    body = withFront(source, { draft: "true" });
  } else if (!entry.draft) {
    // A published post, encrypted or not, is never written by a draft save: it
    // forks. Testing `encrypted` here is what sent an encrypted post's draft
    // straight over the published file.
    path = draftPathFor(doc.path);
    sha = "";
    minted = await mintVaultKey(path);
    keysEnc = minted.keysEnc;
    body = withFront(source, {
      draft: "true",
      supersedes: permalinkOf({ date: frontOf(doc).date, path: doc.path }),
    });
  } else if (!entry.encrypted) {
    minted = await mintVaultKey(path);
    keysEnc = minted.keysEnc;
    body = withFront(source, { draft: "true" });
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
    // What the PUBLISHED post will be, which the Encrypted switch edits. The
    // document itself is a draft and is withheld whatever this says.
    `vault: false\n` +
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
export const MASONRY_DATA = "source/_data/masonry.yml";

/**
 * Take albums down, in the SAME commit as the articles beside them.
 *
 * An album is a `list:` entry in one shared file rather than a file of its own,
 * so withdrawing it is a line edit: `draft: true` is what the build reads as
 * "withhold this" — the card, the page and every photograph go, and only an
 * admin holds the key that brings them back. `supersedes` goes with it, because
 * after this there is no published album for a draft to stand in front of.
 *
 * Returns the one file entry, or null when nothing in the selection is an album.
 */
async function unpublishAlbumsFile(rows) {
  const albums = rows.filter((row) => row.kind === "album" && row.album && row.album.title);
  if (!albums.length) return null;

  // Loaded only when a selection actually holds an album: the post editor
  // imports this file on every article it opens, and the album document model
  // is of no use to it.
  const my = await import("./masonry-yaml.js");

  const current = await repo.read(MASONRY_DATA);
  if (!current) throw new Error(`${MASONRY_DATA} is not in the repository`);

  const doc = my.parseMasonry(current.text);
  for (const row of albums) {
    const found = my.findAlbum(doc, row.album.title, row.draft ? "draft" : "published");
    if (!found) throw new Error(`${row.album.title} is no longer in ${MASONRY_DATA}`);
    my.setItemField(found.item, "draft", "true");
    my.setItemField(found.item, "supersedes", null);
  }

  return {
    operation: "update",
    path: MASONRY_DATA,
    sha: current.sha,
    content: repo.toBase64(my.emitMasonry(doc)),
  };
}

export async function unpublishAll(rows) {
  const files = [];
  // The freshly minted draft key of every article withdrawn here. The console
  // repaints the row as unpublished the moment this returns, and without the
  // new id it would have nothing to hang "who can edit this" on until the next
  // build's inventory arrived.
  const minted = [];
  let keysEnc = null;

  const albumFile = await unpublishAlbumsFile(rows);
  if (albumFile) files.push(albumFile);

  for (const row of rows.filter((row) => row.kind !== "album")) {
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
          content: repo.toBase64(withFront(current.text, { draft: "true", supersedes: null })),
        });
      }
    } else {
      if (!published) throw new Error(`${source || row.title} is not in the repository`);
      const path = draftPathFor(source);
      if (await repo.read(path)) throw new Error(`${path} already exists`);
      const mint = await mintVaultKey(path);
      keysEnc = mint.keysEnc;
      minted.push({ source: row.source, id: mint.id, slug: mint.slug, path });
      files.push({
        operation: "create",
        path,
        // `vault:` is left exactly as the published post had it: it says what
        // this article is when it goes back up, and taking it down changes
        // nothing about that.
        content: repo.toBase64(withFront(published.text, { draft: "true", supersedes: null })),
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
  const result = await repo.commit(
    files,
    titles.length === 1 ? `Unpublish: ${titles[0]}` : `Unpublish ${titles.length} posts`
  );
  return { ...result, minted };
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

/**
 * The resealed keyring, straight from the mint that produced it.
 *
 * No read first. There is nothing to read — the keyring is not published — and
 * nothing to compare against: the Worker rebuilds the whole file from its own
 * rows every time it mints, so what comes back IS the file, and the runner
 * accepts it only because it opens under VAULT_MASTER.
 */
async function keyringFile(keysEnc) {
  return {
    operation: "update",
    path: ".vault/keys.enc",
    content: repo.toBase64(keysEnc),
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
  return publishedPathOf({ supersedes: entry.supersedes, path: doc.path });
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

/** Any text, under any grant, at any key — what the two callers below share. */
export async function stashText(path, text, grant) {
  if (!grant || !path) return;
  const key = await keyOf(grant);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(String(text == null ? "" : text))
  );
  const blob = new Uint8Array(iv.length + sealed.byteLength);
  blob.set(iv, 0);
  blob.set(new Uint8Array(sealed), iv.length);
  await withStore("readwrite", (store) => store.put({ path, blob, at: Date.now() }));
}

export async function recoverText(path, grant) {
  if (!grant || !path) return null;
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

export function stash(doc, grant) {
  return stashText(doc.path, docToMarkdown(doc), grant);
}

export function recover(path, grant) {
  return recoverText(path, grant);
}

export async function dropStash(path) {
  await withStore("readwrite", (store) => store.delete(path));
}

export { siteRoot };
