"use strict";

/**
 * The local keyring — `.vault/keys.json`, the authority for every post key.
 *
 * A key is minted ONCE, the first time a post carries `vault:` front matter,
 * and never changes again: rebuilding must not invalidate what is already in
 * D1. The whole keyring is sent to the Worker at the end of every build
 * (`sync`), which registers what is in it and revokes what is not — so neither
 * activating a post nor retiring one is ever something a person has to do.
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
 *
 * An entry is `{key, slug, registered}` and nothing else. It used to carry the
 * post's title as well, which no code reads and which the two writers of this
 * file disagreed about: the build filled it in from the post, and the Worker —
 * which rebuilds the whole keyring whenever the editor mints, and deliberately
 * stores no titles — wrote it back empty. So `.vault/keys.enc` changed on
 * alternate commits, for a field that was never used.
 *
 * @returns {{key: Buffer, slug: string, fresh: boolean, rekeyed: boolean}}
 */
function ensurePost(id) {
  const s = load();
  let entry = s.keys[id];

  let rekeyed = false;
  if (entry && REKEY_FLAGS.has(String(entry.registered).toLowerCase())) {
    entry.key = vc.b64url(vc.randomKey());
    rekeyed = true;
    // Back to unregistered until `sync` has replaced the wrapped copy in D1.
    // Between the two, the row there still holds the OLD key and opens nothing.
    entry.registered = false;
    s.dirty = true;
    s.minted.push(id);
  }

  if (!entry) {
    entry = { key: vc.b64url(vc.randomKey()), slug: vc.randomSlug(), registered: false };
    // A slug collision would silently overwrite another post's blobs.
    const taken = new Set(Object.values(s.keys).map((e) => e.slug));
    while (taken.has(entry.slug)) entry.slug = vc.randomSlug();
    s.keys[id] = entry;
    s.dirty = true;
    s.minted.push(id);
  } else if (entry.title !== undefined) {
    // Written by a version of this file that recorded titles. Dropped on sight,
    // so one build settles the churn rather than every second commit carrying it.
    delete entry.title;
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

/**
 * The whole keyring as the Worker wants it: id, slug, and the wrapped key.
 *
 * `draft` is passed IN rather than stored here. The keyring is a key store and
 * nothing else — the Worker rebuilds `.vault/keys.enc` from its own rows every
 * time the editor mints, so any field the two sides did not both write would
 * churn the file on alternate saves.
 */
function rows(draftIds) {
  const s = load();
  return Object.entries(s.keys).map(([id, e]) => ({
    id,
    slug: e.slug,
    draft: !!(draftIds && draftIds.has(id)),
    wrapped: vc.wrapKey(s.master, vc.fromB64url(e.key)),
  }));
}

/**
 * Make D1 match the keyring — the WHOLE keyring, every build.
 *
 * Registration and revocation are both consequences of what carries `vault:`,
 * so neither is a command anybody issues. The keyring has already been pruned
 * down to the items this build actually sealed (`prune`), so sending it entire
 * says two things at once: these keys exist, and nothing else does. An item
 * whose flag was removed loses its row here, in the same build that stopped
 * publishing its ciphertext — there is no window in which a revoked post is
 * still openable, and no list for anyone to reconcile by hand.
 *
 * Both build paths reach this — `hexo generate` on the machine and the Gitea
 * Action — because both hold VAULT_MASTER, which is what signs the request.
 * There is no session and no second secret; see `verifyBuildSignature` in the
 * Worker.
 *
 * BEST EFFORT, always. A build with no network, or one run before the Worker
 * was deployed, leaves D1 alone and the next build that can reach it puts
 * everything right — which is exactly why the whole set travels rather than a
 * delta. Refusing to build over an unreachable backend would make the offline
 * case — the one that motivated the loopback CI — impossible.
 *
 * @returns {Promise<{registered:number, revoked:number}|null>} null when the
 *          backend is not configured
 */
async function sync(apiBase, draftIds) {
  const base = String(apiBase || "").replace(/\/+$/, "");
  if (!base) return null;

  const live = rows(draftIds);
  const body = JSON.stringify({
    posts: live.map((r) => ({ id: r.id, slug: r.slug, wrapped: r.wrapped, draft: r.draft })),
  });

  const res = await fetch(`${base}/api/admin/vault/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Vault-Signature": syncMac(body) },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${res.status} ${detail.slice(0, 200)}`);
  }

  const answer = await res.json().catch(() => ({}));

  // Only now, and only because the write landed: `registered` is what the
  // keyring records about D1, and the Worker rebuilds `.vault/keys.enc` from
  // its own rows with that flag set. Marking before the answer came back would
  // make the two files disagree on the next editor save.
  markRegistered();

  return {
    registered: live.length,
    revoked: Array.isArray(answer.revoked) ? answer.revoked.length : 0,
  };
}

/** HMAC over the request body, under an HKDF subkey of the master. */
function syncMac(body) {
  const key = vc.hkdf(load().master, "rdfx-vault-push");
  return "sha256=" + crypto.createHmac("sha256", key).update(body, "utf8").digest("hex");
}

/**
 * Drop every keyring entry whose item no longer carries `vault:`.
 *
 * The keyring is the local authority, so an entry that outlives its flag is a
 * key for content that is no longer sealed — and the next build that re-adds the
 * flag would silently reuse it, re-publishing under a key D1 already handed out.
 * What this leaves behind is picked up by `sync`, which sends the pruned keyring
 * entire and so revokes the wrapped copy in D1 in the same build.
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
    retired.push({ id, slug: entry.slug || "" });
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

/** What the keyring records about D1, once a sync has actually landed. */
function markRegistered() {
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
  sync,
  prune,
  seal,
  fail,
};
