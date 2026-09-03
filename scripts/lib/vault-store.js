"use strict";

/**
 * The local keyring — `.vault/keys.json`, the authority for every post key.
 *
 * A key is minted ONCE, the first time a post carries `vault:` front matter,
 * and never changes again: rebuilding must not invalidate what is already in
 * D1. The wrapped copy the Worker needs is PUSHED at the end of every build
 * (`push`), and only if that cannot be done is it printed for a human to paste.
 *
 * FAIL CLOSED. Every path that cannot produce a key throws, because the
 * alternative — carrying on and rendering the post — publishes it in the clear.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const secrets = require("./secrets");
const vc = require("./vault-crypto");

const MASTER_ENV = "VAULT_MASTER";
const ENC_FILE = path.join(secrets.ROOT, ".vault", "keys.enc");

let state = null;

function fail(message) {
  const err = new Error("[vault] " + message);
  err.vault = true;
  throw err;
}

function loadMaster() {
  const raw = secrets.env(MASTER_ENV);
  if (!raw) {
    fail(
      `${MASTER_ENV} is not set. Encrypted posts cannot be built without it, and ` +
        `building them without encryption would publish them in the clear.\n` +
        `  Generate one:  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"\n` +
        `  Put it in .env AND in the Worker:  wrangler secret put ${MASTER_ENV}`
    );
  }
  const key = vc.fromB64url(raw);
  if (key.length !== vc.KEY_BYTES) {
    fail(`${MASTER_ENV} must decode to exactly ${vc.KEY_BYTES} bytes, got ${key.length}.`);
  }
  return key;
}

/**
 * Take into `keys.json` every key `keys.enc` holds that it does not.
 *
 * `keys.json` is gitignored and `keys.enc` is committed, so a fresh clone — a
 * CI runner, or your own machine after pulling what CI pushed — starts with no
 * local keyring at all. Without this the build treats every encrypted post as
 * new, mints a SECOND key for it, registers that with the backend, and the
 * ciphertext already published stops opening. Opening is therefore part of
 * loading rather than a command someone has to remember.
 *
 * Local entries win a conflict and are never overwritten: a key minted here and
 * not yet sealed is the only copy of itself.
 */
function absorbSealed(master, keys) {
  let sealed;
  try {
    sealed = fs.readFileSync(ENC_FILE, "utf8").trim();
  } catch (e) {
    return 0;
  }
  if (!sealed) return 0;

  let opened;
  try {
    opened = JSON.parse(vc.open(master, vc.fromB64url(sealed)).toString("utf8"));
  } catch (e) {
    fail(".vault/keys.enc does not open under this VAULT_MASTER.");
  }

  let taken = 0;
  for (const [id, entry] of Object.entries(opened)) {
    if (keys[id]) continue;
    keys[id] = entry;
    taken++;
  }
  return taken;
}

function load() {
  if (state) return state;

  const master = loadMaster();
  const keys = secrets.readKeyring() || {};
  const taken = absorbSealed(master, keys);
  if (taken) secrets.writeKeyring(keys);

  state = { master, keys, dirty: false, minted: [], opened: taken };
  return state;
}

// Written by hand into .vault/keys.json to retire a post's key. The slug is NOT
// reissued: links already handed out keep working, and the point of the exercise
// is that the old ciphertext stops opening.
const REKEY_FLAGS = new Set(["regenerate", "regen"]);

/**
 * The key and slug for a post, minting them on first sight.
 * @returns {{key: Buffer, slug: string, fresh: boolean}}
 */
function ensurePost(id, title) {
  const s = load();
  let entry = s.keys[id];

  let rekeyed = false;
  if (entry && REKEY_FLAGS.has(String(entry.registered).toLowerCase())) {
    entry.key = vc.b64url(vc.randomKey());
    rekeyed = true;
    // Back to unregistered: D1 still holds the OLD wrapped key, so until the
    // new activation line is pasted, nobody — the author included — can open
    // this post. `report()` prints that line at the end of the build.
    entry.registered = false;
    s.dirty = true;
    s.minted.push(id);
  }

  if (!entry) {
    entry = {
      key: vc.b64url(vc.randomKey()),
      slug: vc.randomSlug(),
      title: title || "",
      registered: false,
    };
    // A slug collision would silently overwrite another post's blobs.
    const taken = new Set(Object.values(s.keys).map((e) => e.slug));
    while (taken.has(entry.slug)) entry.slug = vc.randomSlug();
    s.keys[id] = entry;
    s.dirty = true;
    s.minted.push(id);
  } else if (title && entry.title !== title) {
    entry.title = title;
    s.dirty = true;
  }

  const key = vc.fromB64url(entry.key);
  if (key.length !== vc.KEY_BYTES) {
    fail(`.vault/keys.json entry "${id}" has a malformed key.`);
  }
  return { key, slug: entry.slug, fresh: s.minted.includes(id), rekeyed };
}

function flush() {
  if (!state || !state.dirty) return;
  secrets.writeKeyring(state.keys);
  state.dirty = false;
}

/** Entries the admin console has not been told about yet. */
function pending() {
  const s = load();
  return Object.entries(s.keys)
    .filter(([, e]) => e.registered !== true)
    .map(([id, e]) => ({
      id,
      slug: e.slug,
      title: e.title || "",
      wrapped: vc.wrapKey(s.master, vc.fromB64url(e.key)),
    }));
}

/**
 * Register every unactivated key with the Worker, and mark them done.
 *
 * The whole point of doing it here: a commit that carries a post's ciphertext
 * must never be a commit whose key nobody has. Both build paths reach this —
 * `hexo generate` on the machine and the Gitea Action — because both hold
 * VAULT_MASTER, which is what signs the request. There is no session and no
 * second secret; see `verifyBuildSignature` in the Worker.
 *
 * BEST EFFORT, always. A build with no network, or one run before the Worker
 * was deployed, falls back to `report()` and prints the paste block instead.
 * Refusing to build over an unreachable backend would make the offline case —
 * the one that motivated the loopback CI — impossible.
 *
 * @returns {Promise<{pushed:number}|null>} null when nothing was pushed
 */
async function push(apiBase) {
  const rows = pending();
  if (!rows.length) return null;

  const base = String(apiBase || "").replace(/\/+$/, "");
  if (!base) return null;

  const body = JSON.stringify({
    posts: rows.map((r) => ({ id: r.id, slug: r.slug, wrapped: r.wrapped })),
  });

  const res = await fetch(`${base}/api/admin/vault/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Vault-Signature": pushMac(body) },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${res.status} ${detail.slice(0, 200)}`);
  }

  // Only now. `acknowledge` is what stops the next build re-sending them, and
  // marking them before the write landed would lose a key silently.
  acknowledge();
  return { pushed: rows.length };
}

/** HMAC over the request body, under an HKDF subkey of the master. */
function pushMac(body) {
  const key = vc.hkdf(load().master, "rdfx-vault-push");
  return "sha256=" + crypto.createHmac("sha256", key).update(body, "utf8").digest("hex");
}

/**
 * What the admin pastes into Management → Encrypted Posts, when and only when
 * the push above could not be made. One JSON line per post so a copy that clips
 * a newline is rejected rather than half-applied.
 */
function report(log) {
  const rows = pending();
  if (!rows.length) return;

  const lines = rows.map((r) =>
    JSON.stringify({ id: r.id, slug: r.slug, wrapped: r.wrapped })
  );

  log.warn(
    `[vault] ${rows.length} encrypted post${rows.length === 1 ? "" : "s"} ` +
      `not yet activated. Until each is registered in D1, nobody — not even you — can read it.\n\n` +
      `  Blog Management → Encrypted Posts → Add, paste ONE line per post:\n\n` +
      rows.map((r, i) => `    ${lines[i]}   # ${r.title || r.id}`).join("\n") +
      `\n\n  Then run:  node themes/redefine-x/bin/vault-ack.js\n`
  );
}

/**
 * Drop every keyring entry whose item no longer carries `vault:`.
 *
 * The keyring is the local authority, so an entry that outlives its flag is a
 * key for content that is no longer sealed — and the next build that re-adds the
 * flag would silently reuse it, re-publishing under a key D1 already handed out.
 * Removing it here is only half the job: the WRAPPED copy in D1 is what actually
 * grants access, and nothing at build time can reach the Worker to delete it.
 * `reportRetired` is what tells the admin to.
 *
 * Deliberately independent of the master key: pruning never needs one, and a
 * site that has just removed its last `vault:` flag may have unset VAULT_MASTER
 * already.
 *
 * @param {Set<string>} liveIds  ids that still carry `vault:` this build
 */
function prune(liveIds) {
  const keys = state ? state.keys : secrets.readKeyring();
  if (!keys) return [];

  const retired = [];
  for (const id of Object.keys(keys)) {
    if (liveIds.has(id)) continue;
    const entry = keys[id] || {};
    retired.push({ id, slug: entry.slug || "", title: entry.title || "" });
    delete keys[id];
  }
  if (!retired.length) return [];

  if (state) {
    state.dirty = true;
    flush();
  } else {
    secrets.writeKeyring(keys);
  }
  return retired;
}

/** What `prune` removed locally and the admin still has to remove from D1. */
function reportRetired(log, retired) {
  if (!retired || !retired.length) return;
  const one = retired.length === 1;

  log.warn(
    `[vault] ${retired.length} keyring entr${one ? "y" : "ies"} no longer carr${one ? "ies" : "y"} ` +
      `\`vault:\` and ${one ? "was" : "were"} removed from .vault/keys.json.\n` +
      `  D1 STILL HOLDS THE WRAPPED KEY for each one, which is what actually grants access.\n` +
      `  Delete ${one ? "it" : "them"} by hand:  Blog Management → Encrypted Posts → Revoke\n\n` +
      retired.map((r) => `    ${r.id}  ${r.slug}   # ${r.title || "(untitled)"}`).join("\n") +
      `\n`
  );
}

/** Sorted, so two machines sealing the same keyring produce the same bytes. */
function canonical(map) {
  const out = {};
  for (const id of Object.keys(map).sort()) out[id] = map[id];
  return JSON.stringify(out, null, 2) + "\n";
}

/**
 * `.vault/keys.json` → `.vault/keys.enc`.
 *
 * Called at the end of every build. Only the sealed copy is committed, so the
 * commit that carries a post's ciphertext has to carry the key for it in the
 * same commit — which it cannot do if sealing is a separate command someone has
 * to remember.
 *
 * The nonce is fresh on every seal, so an unchanged keyring is left alone: a
 * rewrite would show up as a change in git on every build.
 */
function seal() {
  const keys = secrets.readKeyring();
  if (!keys) return null;

  const master = load().master;
  const text = canonical(keys);

  let current = null;
  try {
    const sealed = fs.readFileSync(ENC_FILE, "utf8").trim();
    current = JSON.parse(vc.open(master, vc.fromB64url(sealed)).toString("utf8"));
  } catch (e) {
    /* absent, or written under a different master — either way, write it */
  }

  const count = Object.keys(keys).length;
  if (current && canonical(current) === text) return { changed: false, count };

  fs.mkdirSync(path.dirname(ENC_FILE), { recursive: true });
  fs.writeFileSync(ENC_FILE, vc.b64url(vc.seal(master, text)) + "\n", "utf8");
  return { changed: true, count };
}

/** Marks everything registered. Run after the console has taken the block. */
function acknowledge() {
  const s = load();
  let n = 0;
  for (const entry of Object.values(s.keys)) {
    if (entry.registered !== true) {
      entry.registered = true;
      n++;
    }
  }
  if (n) {
    s.dirty = true;
    flush();
  }
  return n;
}

module.exports = {
  load,
  ensurePost,
  flush,
  pending,
  push,
  report,
  prune,
  reportRetired,
  seal,
  acknowledge,
  fail,
};
