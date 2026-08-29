"use strict";

/**
 * The local keyring — `.vault/keys.json`, the authority for every post key.
 *
 * A key is minted ONCE, the first time a post carries `vault:` front matter,
 * and never changes again: rebuilding must not invalidate what is already in
 * D1. The wrapped copy that the Worker needs is printed for the admin console
 * to take; nothing here talks to the network.
 *
 * FAIL CLOSED. Every path that cannot produce a key throws, because the
 * alternative — carrying on and rendering the post — publishes it in the clear.
 */

const secrets = require("./secrets");
const vc = require("./vault-crypto");

const MASTER_ENV = "VAULT_MASTER";

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

function load() {
  if (state) return state;
  state = {
    master: loadMaster(),
    keys: secrets.readKeyring() || {},
    dirty: false,
    minted: [],
  };
  return state;
}

/**
 * The key and slug for a post, minting them on first sight.
 * @returns {{key: Buffer, slug: string, fresh: boolean}}
 */
function ensurePost(id, title) {
  const s = load();
  let entry = s.keys[id];

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
  return { key, slug: entry.slug, fresh: s.minted.includes(id) };
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
 * What the admin pastes into Management → Encrypted Posts. One JSON line per
 * post so a copy that clips a newline is rejected rather than half-applied.
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
      `\n\n  Then run:  npm run vault:ack\n`
  );
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

module.exports = { load, ensurePost, flush, pending, report, acknowledge, fail };
