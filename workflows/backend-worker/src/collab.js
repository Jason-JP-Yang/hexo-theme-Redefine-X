/**
 * Collaborator permissions, and the credential a save is carried by.
 *
 * The browser no longer holds a token for the repository the site is written
 * in. It holds a token for the PUBLIC repository and nothing else, which means
 * the question "may this person change this file" cannot be answered by the
 * thing being changed — a public repository accepts whatever its token accepts.
 * It is answered here instead, once, and the answer is signed.
 *
 * ── What the signature is for ───────────────────────────────────────────────
 *
 * A commit's author line is a string the committer types. So the build does not
 * read it: it reads a detached Ed25519 signature over a receipt naming the
 * identity, the moment, and the exact set of items that identity was cleared
 * for. The private half is a Worker secret; the public half is published in the
 * site's own configuration and in the repository the build runs in, so the
 * person whose name is on a commit can prove — to anybody, with no access to
 * this Worker — that the commit really was theirs.
 *
 * HMAC would have been fewer lines and could only ever be checked by whoever
 * already holds VAULT_MASTER, which is the one party nobody needs convincing.
 *
 * ── What the submission key is for ──────────────────────────────────────────
 *
 * The payload a save pushes is sealed, because it lands in a public repository
 * and may carry a draft, an unpublished photograph or an encrypted article's
 * source. One key per save, drawn here and wrapped under an HKDF subkey of
 * VAULT_MASTER, so the runner opens it with a secret it already holds and this
 * Worker is not in the build path at all.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * Issuing a receipt is at most two D1 reads and no write. `vault_posts` carries
 * one row per editable item, so the scan behind an editor session is bounded by
 * the number of things the site has, and `moderation` is probed by primary key.
 */

const IV_BYTES = 12;

/* ─── encodings ────────────────────────────────────────────────────────────── */

export function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(str) {
  const s = String(str);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

/* ─── the panel grades ─────────────────────────────────────────────────────── */

/**
 * Which parts of Blog Management can be granted, and at what grades.
 *
 * Posts Management is deliberately absent. A collaborator always has it and
 * always at read-and-write — scoped, by `itemsFor` below, to the items they may
 * actually open — so there is no grade to store and nothing an admin could set
 * that would mean anything. The console renders it fixed rather than hiding it,
 * because a control that is not there reads as a control that was forgotten.
 *
 * Two of the five have no write grade because there is nothing to write:
 * analytics is a dashboard and the build log is a file the runner produced.
 * Announce has no READ grade for the mirror-image reason — it is a form that
 * sends something, and looking at an empty form is not a permission.
 *
 * Stored one letter per panel so the whole matrix is a short string on one row.
 */
export const PANELS = {
  analytics: { code: "a", grades: ["", "r"] },
  announce: { code: "x", grades: ["", "rw"] },
  notifications: { code: "n", grades: ["", "r", "rw"] },
  followers: { code: "f", grades: ["", "r", "rw"] },
  buildlog: { code: "b", grades: ["", "r"] },
};

const BY_CODE = Object.fromEntries(Object.entries(PANELS).map(([name, p]) => [p.code, name]));

/** `"a:r,n:rw"` → `{ analytics: "r", notifications: "rw", … }`, denied elsewhere. */
export function parsePanels(raw) {
  const out = {};
  for (const name of Object.keys(PANELS)) out[name] = "";
  for (const pair of splitList(raw)) {
    const [code, grade] = pair.split(":");
    const name = BY_CODE[String(code).trim()];
    if (!name) continue;
    const want = String(grade || "").trim();
    if (PANELS[name].grades.includes(want)) out[name] = want;
  }
  return out;
}

export function formatPanels(map) {
  const parts = [];
  for (const [name, panel] of Object.entries(PANELS)) {
    const grade = String((map && map[name]) || "");
    if (!grade || !panel.grades.includes(grade)) continue;
    parts.push(`${panel.code}:${grade}`);
  }
  return parts.join(",");
}

/** Everything, at the highest grade each panel actually has. */
export function adminPanels() {
  const out = {};
  for (const [name, panel] of Object.entries(PANELS)) out[name] = panel.grades[panel.grades.length - 1];
  return out;
}

/**
 * What this session may see in the console.
 *
 * One primary-key probe for anybody who is not an admin, and none at all for an
 * admin — the answer for them is a constant.
 */
export async function panelsFor(db, session) {
  if (session.isAdmin) return { panels: adminPanels(), admin: true, banned: false };

  const row = await db
    .prepare("SELECT panels, state FROM moderation WHERE github_id = ?1")
    .bind(session.id)
    .first();

  if (row && row.state === "banned") {
    return { panels: parsePanels(""), admin: false, banned: true };
  }
  return { panels: parsePanels(row && row.panels), admin: false, banned: false };
}

export async function setPanels(db, githubId, login, map) {
  const panels = formatPanels(map);
  await db
    .prepare(
      `INSERT INTO moderation (github_id, login, panels) VALUES (?1, ?2, ?3)
       ON CONFLICT(github_id) DO UPDATE SET
         login  = CASE WHEN ?2 != '' THEN ?2 ELSE moderation.login END,
         panels = ?3,
         updated_at = unixepoch()`
    )
    .bind(Number(githubId), String(login || ""), panels)
    .run();
  return panels;
}

/** Every identity an admin has decided anything about, for the console's matrix. */
export async function listPanels(db) {
  const { results } = await db
    .prepare("SELECT github_id, login, panels, state FROM moderation WHERE panels != '' OR state != ''")
    .all();
  return (results || []).map((row) => ({
    id: row.github_id,
    login: row.login || "",
    state: row.state || "",
    panels: parsePanels(row.panels),
  }));
}

/* ─── which items this session may open, and which it may change ───────────── */

/**
 * The editor's whole world, in one answer.
 *
 * `vault_posts` holds a row per editable item — every post, every album, and the
 * console's own page — so this is the list the editor builds Posts Management
 * from. An admin gets all of it. Anybody else gets exactly two things unioned:
 * the items whose `editors` name them, and the items their read grant names.
 *
 * `write` is what the console badges a row with and what `issueSubmission`
 * refuses on. It is decided here and nowhere else, so a client that asks for
 * something it was not given simply does not receive the key.
 *
 * Drafts are not special-cased. A draft is an item like any other and its
 * editors are its author; what a collaborator may not do is PUBLISH or
 * UNPUBLISH, which is not a file operation and is refused at its own route.
 */
export async function itemsFor(db, env, session, unwrap, panels) {
  const { results } = await db
    .prepare("SELECT id, slug, wrapped, kind, enc, draft, editors FROM vault_posts")
    .all();
  const rows = results || [];

  let readable = null;
  if (!session.isAdmin) {
    const grant = await db
      .prepare("SELECT vault, state FROM moderation WHERE github_id = ?1")
      .bind(session.id)
      .first();
    if (grant && grant.state === "banned") return [];
    readable = new Set(splitList(grant && grant.vault));
  }

  const me = String(session.id);
  const canLog = session.isAdmin || !!(panels && panels.buildlog);

  // Whether this identity may open masonry.yml at all, and which of the two
  // copies. Decided from the rows already in hand rather than by a second
  // query: an album this person may write is the only reason to hand over the
  // file the albums live in.
  const ownsAnAlbum =
    session.isAdmin ||
    rows.some((row) => row.kind === "album" && splitList(row.editors).includes(me));

  const out = [];
  for (const row of rows) {
    // masonry.yml, in its two versions. The admin opens the file as it is; a
    // collaborator opens the copy with every withheld album cut out, and the
    // runner merges whichever comes back one album at a time.
    if (row.kind === "masonry" || row.kind === "masonry-open") {
      const mine = row.kind === "masonry" ? session.isAdmin : !session.isAdmin && ownsAnAlbum;
      if (!mine) continue;
      let fileKey;
      try {
        fileKey = await unwrap(row.wrapped);
      } catch {
        continue;
      }
      out.push({ id: row.id, slug: row.slug, kind: row.kind, enc: 1, draft: 0, write: true, key: fileKey });
      continue;
    }

    // The build log is a section of the console, not an item anybody owns, so
    // its key follows the section's grade rather than an editor list. It is a
    // separate `kind` for exactly this reason: D1 stores no names, so without
    // one there would be no way to tell it apart from the console's own page.
    if (row.kind === "log") {
      if (!canLog) continue;
      let logKey;
      try {
        logKey = await unwrap(row.wrapped);
      } catch {
        continue;
      }
      out.push({ id: row.id, slug: row.slug, kind: "log", enc: 1, draft: 0, write: false, key: logKey });
      continue;
    }

    // The console's MARKUP goes to anybody who may reach the console at all.
    // What they then see inside it is the panel grades, applied by the page —
    // and by every route it calls, which check the same grades again.
    if (row.kind === "console") {
      let shellKey;
      try {
        shellKey = await unwrap(row.wrapped);
      } catch {
        continue;
      }
      out.push({ id: row.id, slug: row.slug, kind: "console", enc: 1, draft: 0, write: false, key: shellKey });
      continue;
    }

    const write = session.isAdmin || splitList(row.editors).includes(me);

    // A PUBLIC item is readable by everyone, because it is published. Posts
    // Management shows a collaborator the whole catalogue for that reason, with
    // Edit only on the rows they may write — a console that listed only the
    // encrypted articles somebody had been granted described the blog as three
    // articles long and gave them no way to see what they were working beside.
    //
    // Nothing is disclosed: `enc = 0` means the article is on the site, and the
    // key opens a copy of markdown anybody can already read rendered.
    const open = !row.enc && (row.kind === "post" || row.kind === "album");
    if (!write && !open && !(readable && readable.has(row.id))) continue;
    // The admin page's key opens the INVENTORY — every post on the site, named.
    // It is never handed out here: a collaborator scoped to three articles
    // builds their list from those three, not from a list of everything.
    if (row.kind === "page" && !session.isAdmin) continue;

    let key;
    try {
      key = await unwrap(row.wrapped);
    } catch {
      continue; // a row from before a rotation opens for nobody
    }
    out.push({
      id: row.id,
      slug: row.slug,
      kind: row.kind || "post",
      enc: row.enc ? 1 : 0,
      draft: row.draft ? 1 : 0,
      write,
      key,
    });
  }
  return out;
}

/** Replace the write list of ONE item. Admin-only at the route. */
export async function setEditors(db, id, ids) {
  const row = await db.prepare("SELECT id FROM vault_posts WHERE id = ?1").bind(id).first();
  if (!row) return { error: "no such item" };
  await db
    .prepare("UPDATE vault_posts SET editors = ?2 WHERE id = ?1")
    .bind(id, joinList(ids.map((v) => String(v.id || v))))
    .run();
  return { ok: true };
}

/** Who may write what, keyed by item id — the console's other half of a chip row. */
export async function listEditors(db) {
  const { results } = await db.prepare("SELECT id, editors FROM vault_posts WHERE editors != ''").all();
  const out = {};
  for (const row of results || []) out[row.id] = splitList(row.editors).map(Number);
  return out;
}

/* ─── the submission credential ────────────────────────────────────────────── */

/**
 * PKCS#8 around a raw Ed25519 seed, and SPKI around a raw public key.
 *
 * Both are fixed prefixes — an Ed25519 key has exactly one length — so this is
 * a concatenation rather than a DER encoder. It is what lets the secret be
 * stored as 32 base64url bytes, which is what `npm run editor:keygen` prints
 * and what a person can paste into `wrangler secret put` without a file.
 */
const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

let signingKeyCache = null;

async function importSigningKey(secret) {
  if (signingKeyCache && signingKeyCache.secret === secret) return signingKeyCache.key;

  const seed = b64urlToBytes(secret);
  if (seed.length !== 32) throw new Error("EDITOR_SIGNING_KEY must decode to 32 bytes");
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX, 0);
  pkcs8.set(seed, PKCS8_PREFIX.length);

  // workerd has answered to both spellings across compatibility dates, and a
  // deploy is not the moment to find out which one this one takes.
  let key = null;
  for (const name of ["Ed25519", "NODE-ED25519"]) {
    try {
      key = await crypto.subtle.importKey("pkcs8", pkcs8, { name }, false, ["sign"]);
      signingKeyCache = { secret, key, name };
      return key;
    } catch {
      /* try the other spelling */
    }
  }
  throw new Error("Ed25519 is not available in this runtime");
}

async function sign(secret, bytes) {
  const key = await importSigningKey(secret);
  const name = signingKeyCache.name;
  return new Uint8Array(await crypto.subtle.sign({ name }, key, bytes));
}

/* ─── the submission key ───────────────────────────────────────────────────── */

let submitKeyCache = null;

async function importSubmitKey(secret) {
  if (submitKeyCache && submitKeyCache.secret === secret) return submitKeyCache.key;
  const raw = b64urlToBytes(secret);
  if (raw.length !== 32) throw new Error("VAULT_MASTER must decode to 32 bytes");
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("rdfx-submit"),
    },
    base,
    256
  );
  const key = await crypto.subtle.importKey("raw", new Uint8Array(bits), { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  submitKeyCache = { secret, key };
  return key;
}

async function wrapSubmission(secret, raw) {
  const kek = await importSubmitKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, raw));
  const out = new Uint8Array(iv.length + body.length);
  out.set(iv, 0);
  out.set(body, iv.length);
  return bytesToB64url(out);
}

/* ─── issuing ──────────────────────────────────────────────────────────────── */

// How long a receipt is worth anything. Long enough for a slow upload of a
// twenty-megabyte album, short enough that one lifted out of a public commit is
// useless by the time anybody reads it.
const RECEIPT_TTL_S = 30 * 60;

// The widest save this will authorise. Not a size limit — the payload never
// touches this Worker — but a bound on how much one receipt can ever be made to
// cover if it is replayed inside its window.
const MAX_ITEMS = 60;

/**
 * Clear one save.
 *
 * `owners` is the set of item ids the payload touches, as the editor declares
 * them. Every one must be an item this session may WRITE; the build re-derives
 * the owner of each operation from the operation itself and checks it against
 * the list signed here, so a declaration that does not match what was actually
 * sent fails at the runner rather than being taken on trust.
 *
 * @returns {Promise<{key:string, wrapped:string, receipt:string, signature:string}>}
 */
export async function issueSubmission(db, env, session, { owners, hash, publish, key }) {
  if (!env.VAULT_MASTER) return { error: "Vault not configured", status: 503 };
  if (!env.EDITOR_SIGNING_KEY) return { error: "Editor signing is not configured", status: 503 };
  if (!/^[0-9a-f]{64}$/.test(String(hash || ""))) return { error: "Bad payload hash", status: 400 };

  const wanted = Array.from(new Set((owners || []).map((v) => String(v).trim()).filter(Boolean)));
  if (!wanted.length) return { error: "Nothing to save", status: 400 };
  if (wanted.length > MAX_ITEMS) return { error: "Too many items in one save", status: 400 };
  if (wanted.some((id) => !/^[0-9a-f]{16}$/.test(id))) return { error: "Bad item id", status: 400 };

  // Publishing and unpublishing change what the SITE shows, which is the one
  // decision that is never a collaborator's. Refused here rather than hidden in
  // the console, so the rule holds however the request is made.
  if (publish && !session.isAdmin) {
    return { error: "Only an admin may publish or unpublish", status: 403 };
  }

  if (!session.isAdmin) {
    const { results } = await db
      .prepare(
        `SELECT id, editors FROM vault_posts WHERE id IN (${wanted.map((_, i) => `?${i + 1}`).join(",")})`
      )
      .bind(...wanted)
      .all();

    const me = String(session.id);
    const allowed = new Set();
    for (const row of results || []) {
      if (splitList(row.editors).includes(me)) allowed.add(row.id);
    }
    // An id with no row is a brand-new item, and creating one is allowed.
    const known = new Set((results || []).map((r) => r.id));
    const fresh = [];
    for (const id of wanted) {
      if (!known.has(id)) {
        allowed.add(id);
        fresh.push(id);
      } else if (!allowed.has(id)) {
        return { error: `Not yours to change: ${id}`, status: 403 };
      }
    }

    // Whoever made it may open it. Claimed HERE rather than left to the build,
    // because the build has no idea who asked — it reconciles a keyring, and a
    // keyring records keys, not people. The row is a placeholder: no slug and no
    // wrapped key, so nothing can open it and nothing tries, and the first
    // reconcile after this fills both in while leaving `editors` alone.
    //
    // A write per NEW item, by a collaborator, which at blog scale is a handful
    // a month on the scarce side of a free plan.
    if (fresh.length) {
      await db.batch(
        fresh.map((id) =>
          db
            .prepare(
              `INSERT INTO vault_posts (id, slug, wrapped, kind, enc, editors)
               VALUES (?1, '', '', 'post', 0, ?2)
               ON CONFLICT(id) DO NOTHING`
            )
            .bind(id, String(session.id))
        )
      );
    }
  }

  // The key is the CLIENT's, because the payload has to be sealed before its
  // digest exists and the digest is what this receipt is issued against. Two
  // round trips would be the alternative — one for a key, one for the receipt —
  // and the key buys this Worker nothing either way: the receipt binds the
  // payload by hash, so a key reused across saves still cannot carry one
  // payload's authorisation onto another's bytes.
  let keyBytes;
  try {
    keyBytes = b64urlToBytes(String(key || ""));
  } catch {
    return { error: "Bad submission key", status: 400 };
  }
  if (keyBytes.length !== 32) return { error: "Bad submission key", status: 400 };

  const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
  const nonce = bytesToB64url(nonceBytes);

  const receipt = {
    v: 1,
    sub: Number(session.id),
    login: String(session.login || ""),
    admin: !!session.isAdmin,
    ts: Math.floor(Date.now() / 1000),
    ttl: RECEIPT_TTL_S,
    nonce,
    hash: String(hash),
    ids: wanted.sort(),
  };

  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(receipt)));
  const signature = bytesToB64url(await sign(env.EDITOR_SIGNING_KEY, new TextEncoder().encode(body)));

  return {
    wrapped: await wrapSubmission(env.VAULT_MASTER, keyBytes),
    receipt: body,
    signature,
    nonce,
  };
}
