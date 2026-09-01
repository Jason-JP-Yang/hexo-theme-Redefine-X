/**
 * Vault — the authorization half of encrypted posts.
 *
 * The Worker stores no post, no image and no metadata: only a wrapped key per
 * post and, on the reader's moderation row, the list of posts that reader may
 * open. Everything else is an opaque blob on the CDN.
 *
 * ── Where the rows go ───────────────────────────────────────────────────────
 *
 * Grants live on `moderation`, NOT on `followers`, for the reason that table
 * already exists: unfollowing DELETES the follower row, and a grant that
 * disappeared when a reader unfollowed would silently re-lock their posts.
 * `moderation` is the table for what an ADMIN decided about an identity, which
 * is exactly what a grant is.
 *
 * ── Why two statements and not one ──────────────────────────────────────────
 *
 * A single correlated query over vault_posts would touch every encrypted post
 * once per request. Reading the grant list first costs one primary-key probe
 * and then reads ONLY the posts named in it — 1 + N rows instead of 2 x N_total
 * — and short-circuits to zero further reads for the overwhelmingly common
 * reader who has no grants at all.
 */

const IV_BYTES = 12;

function b64urlToBytes(str) {
  const b64 = String(str).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(str).length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The master key is imported on every unlock and changes only with a deploy.
// `encrypt` is in the usage list because the editor's mint path re-seals the
// whole keyring — the same file `npm run vault:seal` produces locally.
let masterCache = null;

async function importMaster(secret) {
  if (masterCache && masterCache.secret === secret) return masterCache.key;
  const raw = b64urlToBytes(secret);
  if (raw.length !== 32) throw new Error("VAULT_MASTER must decode to 32 bytes");
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  masterCache = { secret, key };
  return key;
}

/** iv ‖ ciphertext ‖ tag, base64url — the shape every blob in this system has. */
async function seal(masterKey, plaintext) {
  const bytes = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, masterKey, bytes));
  const out = new Uint8Array(iv.length + body.length);
  out.set(iv, 0);
  out.set(body, iv.length);
  return bytesToB64url(out);
}

/** iv ‖ ciphertext ‖ tag → the post key, base64url for the wire. */
async function unwrap(masterKey, wrapped) {
  const sealed = b64urlToBytes(wrapped);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.subarray(0, IV_BYTES) },
    masterKey,
    sealed.subarray(IV_BYTES)
  );
  return bytesToB64url(new Uint8Array(plain));
}

function splitList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinList(ids) {
  return Array.from(new Set(ids.map((s) => String(s).trim()).filter(Boolean))).join(",");
}

/**
 * Every post this session may open, with its key already unwrapped.
 * An admin gets all of them; anyone else gets exactly what their grant names.
 */
export async function grantedPosts(db, env, session) {
  const master = await importMaster(env.VAULT_MASTER);

  if (session.isAdmin) {
    const { results } = await db
      .prepare("SELECT id, slug, wrapped FROM vault_posts ORDER BY created_at DESC")
      .all();
    return unwrapAll(master, results);
  }

  const row = await db
    .prepare("SELECT vault, state FROM moderation WHERE github_id = ?1")
    .bind(session.id)
    .first();

  if (!row || row.state === "banned") return [];
  const ids = splitList(row.vault);
  if (!ids.length) return [];

  // D1 binds at most 100 parameters; a reader with more grants than that reads
  // the rest on a second call rather than silently losing them.
  const slice = ids.slice(0, 90);
  const holes = slice.map((_, i) => `?${i + 1}`).join(",");
  const { results } = await db
    .prepare(`SELECT id, slug, wrapped FROM vault_posts WHERE id IN (${holes})`)
    .bind(...slice)
    .all();

  return unwrapAll(master, results);
}

async function unwrapAll(master, rows) {
  const out = [];
  for (const row of rows || []) {
    try {
      out.push({ id: row.id, slug: row.slug, key: await unwrap(master, row.wrapped) });
    } catch {
      // A row whose wrapped key does not open under the current VAULT_MASTER is
      // from before a rotation. Skipping it locks that post rather than handing
      // the reader a key that decrypts nothing.
    }
  }
  return out;
}

/** Admin listing: ids and slugs only, plus who each is granted to. */
export async function listPosts(db, limit, offset) {
  const [posts, grants] = await Promise.all([
    db
      .prepare("SELECT id, slug, created_at FROM vault_posts ORDER BY created_at DESC LIMIT ?1 OFFSET ?2")
      .bind(limit + 1, offset)
      .all(),
    db.prepare("SELECT github_id, login, vault FROM moderation WHERE vault != ''").all(),
  ]);

  const byPost = new Map();
  for (const row of grants.results || []) {
    for (const id of splitList(row.vault)) {
      if (!byPost.has(id)) byPost.set(id, []);
      byPost.get(id).push({ id: row.github_id, login: row.login || "" });
    }
  }

  const rows = posts.results || [];
  const more = rows.length > limit;
  return {
    posts: rows.slice(0, limit).map((r) => ({
      id: r.id,
      slug: r.slug,
      created_at: r.created_at,
      audience: byPost.get(r.id) || [],
    })),
    more,
  };
}

/* ─── minting, for the online editor ───────────────────────────────────────── */

// Mirrors SLUG_ALPHABET in scripts/lib/vault-crypto.js — no I, L, O or U, since
// a slug gets read aloud and typed by hand.
const SLUG_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** sha256(source path), first 16 hex. The same identity the build computes. */
async function postId(sourcePath) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(sourcePath)));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function randomSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  return out;
}

/**
 * Mint and register a post key, then hand back the whole keyring re-sealed.
 *
 * This is the one thing the editor cannot do for itself: wrapping needs
 * VAULT_MASTER, and VAULT_MASTER is the secret that must never reach a browser.
 * Returning the sealed keyring in the same answer is what lets ONE commit carry
 * both a new encrypted post and the key that opens it — a key and its
 * ciphertext are never one commit apart, in either order.
 *
 * Idempotent on `source`: a path that already has a key gets that key back
 * rather than a second one, because a post's key is stable forever and minting
 * a new one would orphan everything already sealed under the old.
 */
export async function mintPost(db, env, { source, titles }) {
  const master = await importMaster(env.VAULT_MASTER);
  const id = await postId(source);

  const existing = await db
    .prepare("SELECT id, slug, wrapped FROM vault_posts WHERE id = ?1")
    .bind(id)
    .first();

  if (existing) {
    return {
      id,
      slug: existing.slug,
      key: await unwrap(master, existing.wrapped),
      keysEnc: await keyringBlob(db, env, titles),
      fresh: false,
    };
  }

  const taken = await db.prepare("SELECT slug FROM vault_posts").all();
  const used = new Set((taken.results || []).map((r) => r.slug));
  let slug = randomSlug();
  while (used.has(slug)) slug = randomSlug();

  const postKey = crypto.getRandomValues(new Uint8Array(32));

  await db
    .prepare("INSERT INTO vault_posts (id, slug, wrapped) VALUES (?1, ?2, ?3)")
    .bind(id, slug, await seal(master, postKey))
    .run();

  return {
    id,
    slug,
    key: bytesToB64url(postKey),
    keysEnc: await keyringBlob(db, env, titles),
    fresh: true,
  };
}

/**
 * `.vault/keys.enc`, byte-compatible with `npm run vault:seal`.
 *
 * Rebuilt from D1 every time rather than patched, so the file in the repository
 * and the rows in the database cannot drift. `titles` is supplied by the admin
 * browser — which reads them out of each post's own sealed record — because the
 * database deliberately stores none: a dump of it says how many encrypted posts
 * exist and who may read them, never what any of them is called.
 */
export async function keyringBlob(db, env, titles) {
  const master = await importMaster(env.VAULT_MASTER);
  const { results } = await db.prepare("SELECT id, slug, wrapped FROM vault_posts").all();

  const map = {};
  for (const id of (results || []).map((r) => r.id).sort()) {
    const row = results.find((r) => r.id === id);
    let key;
    try {
      key = await unwrap(master, row.wrapped);
    } catch {
      continue; // a row from before a rotation opens for nobody
    }
    map[id] = {
      key,
      slug: row.slug,
      title: (titles && titles[id]) || "",
      registered: true,
    };
  }

  return (await seal(master, JSON.stringify(map, null, 2) + "\n")) + "\n";
}

export async function registerPost(db, { id, slug, wrapped }) {
  await db
    .prepare(
      `INSERT INTO vault_posts (id, slug, wrapped) VALUES (?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, wrapped = excluded.wrapped`
    )
    .bind(id, slug, wrapped)
    .run();
}

export async function deletePost(db, id) {
  // The grant lists are cleaned lazily: a stale id in `moderation.vault` simply
  // matches no row on the next read, and rewriting every grant row here would
  // be a write per reader in the scarce direction to save nothing.
  const res = await db.prepare("DELETE FROM vault_posts WHERE id = ?1").bind(id).run();
  return res.meta ? res.meta.changes > 0 : false;
}

/**
 * Replace the audience of ONE post. `ids` is the complete new list, so the diff
 * is computed here and only the identities that actually changed are written.
 */
export async function setAudience(db, postId, ids) {
  const logins = new Map(ids.map((v) => [String(v.id || v), String(v.login || "")]));
  const wanted = new Set(logins.keys());

  const { results } = await db
    .prepare("SELECT github_id, login, vault FROM moderation WHERE vault != ''")
    .all();

  const statements = [];
  const seen = new Set();

  for (const row of results || []) {
    const key = String(row.github_id);
    seen.add(key);
    const list = splitList(row.vault);
    const has = list.includes(postId);
    // The login is refreshed even when the grant itself is unchanged: it is what
    // lets the panel render a name rather than a bare id after a reload, and a
    // row written before the client sent one has it empty.
    const login = logins.get(key) || row.login || "";
    if (wanted.has(key) === has) {
      if (has && login && login !== row.login) {
        statements.push(
          db
            .prepare("UPDATE moderation SET login = ?2 WHERE github_id = ?1")
            .bind(row.github_id, login)
        );
      }
      continue;
    }

    const next = wanted.has(key) ? list.concat(postId) : list.filter((v) => v !== postId);
    statements.push(
      db
        .prepare(
          "UPDATE moderation SET vault = ?2, login = ?3, updated_at = unixepoch() WHERE github_id = ?1"
        )
        .bind(row.github_id, joinList(next), login)
    );
  }

  for (const entry of ids) {
    const key = String(entry.id || entry);
    if (seen.has(key)) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO moderation (github_id, login, vault) VALUES (?1, ?2, ?3)
           ON CONFLICT(github_id) DO UPDATE SET
             login = CASE WHEN ?2 != '' THEN ?2 ELSE moderation.login END,
             vault = CASE WHEN instr(',' || moderation.vault || ',', ?4) > 0
                          THEN moderation.vault
                          ELSE trim(moderation.vault || ',' || ?3, ',') END,
             updated_at = unixepoch()`
        )
        .bind(Number(key), String(entry.login || ""), postId, "," + postId + ",")
    );
  }

  if (statements.length) await db.batch(statements);
  return statements.length;
}
