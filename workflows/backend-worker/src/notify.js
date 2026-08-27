/**
 * The notification pipeline.
 *
 * One path in, one path out, whatever the trigger:
 *
 *   ingestEntries()  entry → notifications row (INSERT OR IGNORE)
 *                          → deliveries rows   (the in-site inbox)
 *                          → outbox rows       (the push queue)
 *   drainOutbox()    outbox rows → sendWebPush() → sent | retried | dead
 *
 * Splitting fan-out (cheap) from sending (one subrequest and a round of
 * public-key crypto per device) is what keeps a broadcast inside the Worker's
 * per-invocation limits however many followers there are. Ingest queues the
 * whole audience and drains only the first few itself; the cron drains the rest.
 *
 * Idempotency lives entirely in `notifications.id`. Re-ingesting an entry that
 * already exists is a no-op, so webhook retries, a re-run over the same
 * changelog, and an edit to an already-delivered entry all cost nothing.
 *
 * ─── on the shape of the SQL ─────────────────────────────────
 * Every write here is phrased so that rows do NOT cross the wire. Fan-out is
 * `INSERT … SELECT`, so the audience is resolved inside SQLite and the Worker
 * never sees the follower list at all; batches of statements go out through
 * `db.batch()`, which is ONE round trip and one implicit transaction. What that
 * replaced was a loop of `.run()` calls — a round trip per entry and per
 * recipient, which is where essentially all of the old latency lived.
 */

import { sendWebPush } from "./webpush.js";

// How many pushes one invocation sends.
//
// Two ceilings bound this, and on the Workers FREE plan the CPU one binds first:
// 50 subrequests per invocation, but only 10ms of CPU — and a single push costs
// an ECDH key pair, an ECDH agreement, three HKDF chains and an AES-GCM seal.
// (VAPID no longer counts: its signature is cached per push service.) Twelve
// leaves comfortable headroom inside 10ms. On the paid plan this can go to ~45
// before the subrequest ceiling starts to matter.
export const DRAIN_BATCH = 12;

// How many of those the INGEST path sends itself, before handing the rest to the
// cron. Ingest has already spent CPU on the changelog fetch and the fan-out, so
// it takes a smaller bite — enough that a small audience is served entirely in
// the moment, without risking the invocation that owns the durable writes.
export const INLINE_BATCH = 6;

// A push service that keeps failing is not coming back within this job's
// lifetime; five attempts spread over the backoff below is enough to ride out a
// transient outage without queueing dead rows forever.
const MAX_ATTEMPTS = 5;

// Exponential, in seconds, indexed by attempt count.
const BACKOFF = [60, 300, 900, 3600, 10800];

// D1 allows 100 bound parameters per query, and ?1/?2 are spoken for.
const MAX_EXPLICIT_USERS = 90;

// Above this many NEW entries in one ingest, record them and deliver none.
//
// A burst this large is never news. It is a back catalogue arriving at once —
// a fresh database seeing changelog.json for the first time, a regenerated set
// of ids, a changelog rebuilt from scratch — and the only useful response is to
// absorb it silently so that everything in it is deduped forever afterwards.
//
// This replaced a `settings` row that had to be flipped by hand and a
// bootstrap flag that only ever fired once. Being stateless is the point: it
// needs no migration, cannot be left in the wrong position, and keeps guarding
// the case where a burst happens on a database that is years old.
const MAX_ANNOUNCED_PER_INGEST = 10;

// Finished queue rows are kept this long, purely so the admin history can show
// what happened to a notification.
const OUTBOX_RETENTION_DAYS = 90;

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const isoIn = (seconds) =>
  new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const changesOf = (result) => (result && result.meta && result.meta.changes) || 0;

// ─── entry normalisation ─────────────────────────────────────
/**
 * Coerce one raw changelog/admin entry into the row shape. Only id, title and
 * url are required; everything else has a defensible default so a hand-written
 * entry can stay as short as three lines.
 */
export function normalizeEntry(raw, defaults = {}) {
  if (!raw || !raw.id || !raw.title || !raw.url) return null;

  const audience =
    raw.audience && typeof raw.audience === "object" ? raw.audience : { kind: "topic" };

  return {
    id: String(raw.id),
    type: String(raw.type || "post"),
    topic: String(raw.topic || "posts"),
    title: String(raw.title).slice(0, 120),
    // Truncated here rather than at send time: the inbox and the OS tray should
    // show the same text, and the 4 KB payload ceiling is easiest to respect by
    // never storing more than fits.
    body: String(raw.body || "").slice(0, 200),
    url: String(raw.url),
    image: String(raw.image || ""),
    tag: String(raw.tag || raw.topic || "posts"),
    audience_json: JSON.stringify(audience),
    silent: raw.silent ? 1 : 0,
    source: String(raw.source || defaults.source || "changelog"),
    published_at: String(raw.published_at || defaults.published_at || nowIso()),
  };
}

// ─── audience resolution ─────────────────────────────────────
/**
 * Turn one entry's audience into a WHERE clause over `followers`.
 *
 *   topic  — followers subscribed to it (an empty `topics` means "everything")
 *   all    — every follower, ignoring topic preferences
 *   users  — an explicit allowlist of GitHub logins and/or numeric ids
 *
 * A follower muted past `muted_until` is skipped in every case: muting is about
 * the reader's attention, not about what the author considers important.
 *
 * Returned as SQL rather than as a list of ids on purpose — see the note at the
 * top of the file. ?1 is the notification id and ?2 is the current timestamp;
 * anything this adds starts at ?3.
 */
function audienceWhere(entry) {
  let audience;
  try {
    audience = JSON.parse(entry.audience_json);
  } catch {
    audience = { kind: "topic" };
  }

  const unmuted = "(muted_until IS NULL OR muted_until < ?2)";

  if (audience.kind === "all") {
    return { where: unmuted, params: [] };
  }

  if (audience.kind === "users") {
    const wanted = (Array.isArray(audience.users) ? audience.users : [])
      .slice(0, MAX_EXPLICIT_USERS)
      .map(String);
    // An explicit audience of nobody is a no-op, not a broadcast.
    if (wanted.length === 0) return null;
    const list = wanted.map((_, i) => `?${i + 3}`).join(", ");
    return {
      where: `${unmuted} AND (CAST(github_id AS TEXT) IN (${list}) OR login IN (${list}))`,
      params: wanted,
    };
  }

  // Default: topic. `topics = ''` is an explicit "no filter", which is the state
  // a reader is in until they touch the preference toggles.
  return {
    where: `${unmuted} AND (topics = '' OR (',' || topics || ',') LIKE '%,' || ?3 || ',%')`,
    params: [entry.topic],
  };
}

// ─── ingest ──────────────────────────────────────────────────
/**
 * Record entries, fan them out, and queue the pushes.
 *
 * Two round trips whatever the input size: one batch that inserts the
 * notifications and reports which of them were new, and one batch that writes
 * the inbox and the queue for exactly those.
 *
 * @returns {{ingested:string[], skipped:string[], deliveries:number, queued:number, absorbed?:boolean}}
 */
export async function ingestEntries(db, env, rawEntries, defaults = {}) {
  const result = { ingested: [], skipped: [], deliveries: 0, queued: 0 };

  const entries = (rawEntries || [])
    .map((raw) => normalizeEntry(raw, defaults))
    .filter(Boolean);
  if (entries.length === 0) return result;

  // `RETURNING id` is what makes this one round trip instead of a read followed
  // by a write: an ignored row returns nothing, so the response itself says
  // which entries were new without a second query to find out.
  const inserts = await db.batch(
    entries.map((entry) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO notifications
             (id, type, topic, title, body, url, image, tag, audience_json, silent, source, published_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
           RETURNING id`
        )
        .bind(
          entry.id,
          entry.type,
          entry.topic,
          entry.title,
          entry.body,
          entry.url,
          entry.image,
          entry.tag,
          entry.audience_json,
          entry.silent,
          entry.source,
          entry.published_at
        )
    )
  );

  const fresh = [];
  entries.forEach((entry, i) => {
    const res = inserts[i];
    // Two independent signals that the row was actually written, because
    // getting this wrong is the one failure mode with no symptom: read it as
    // "nothing was new" and the pipeline goes silent forever. `meta.changes` is
    // D1's documented field; `RETURNING` is the more direct answer. An ignored
    // insert reports zero on both, so accepting either cannot over-deliver.
    const wrote =
      changesOf(res) > 0 || !!(res && res.results && res.results.length > 0);
    // Already known — this is the replay/edit case, and it must not resend.
    if (!wrote) {
      result.skipped.push(entry.id);
      return;
    }
    result.ingested.push(entry.id);
    fresh.push(entry);
  });

  if (fresh.length === 0) return result;

  // Recorded above, deliberately undelivered: the rows now exist, so every one
  // of these ids is deduped from here on and the NEXT deployment announces only
  // what it actually added.
  if (fresh.length > MAX_ANNOUNCED_PER_INGEST) {
    result.absorbed = true;
    return result;
  }

  const now = nowIso();
  const statements = [];
  const kinds = []; // parallel to `statements`, so the counts can be attributed

  for (const entry of fresh) {
    const audience = audienceWhere(entry);
    if (!audience) continue;

    // The inbox is written for every recipient, push device or not — that is
    // what lets the bell work for a reader who declined the OS permission.
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO deliveries (notification_id, github_id)
           SELECT ?1, github_id FROM followers WHERE ${audience.where}`
        )
        .bind(entry.id, now, ...audience.params)
    );
    kinds.push("delivery");

    // Queued straight off the rows the statement above just wrote, so the
    // audience is resolved exactly once and never leaves the database.
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO outbox (notification_id, device_id, not_before)
           SELECT ?1, p.id, ?2
             FROM push_devices p
            WHERE p.github_id IN (SELECT github_id FROM deliveries WHERE notification_id = ?1)`
        )
        .bind(entry.id, now)
    );
    kinds.push("queued");
  }

  if (statements.length === 0) return result;

  // Sequential and transactional: the outbox statement for an entry always sees
  // the deliveries the statement before it wrote.
  const written = await db.batch(statements);
  written.forEach((res, i) => {
    if (kinds[i] === "delivery") result.deliveries += changesOf(res);
    else result.queued += changesOf(res);
  });

  return result;
}

// ─── drain ───────────────────────────────────────────────────
/**
 * Classify a delivery failure into what to do about it.
 *
 *   404 / 410 — the subscription is gone for good; delete the device.
 *   429 / 5xx / network — transient; retry with backoff.
 *   413 — payload too large; retry once with no body (the SW falls back to a
 *         generic notification, which beats silence).
 *   anything else (400, 401, 403) — our fault, not the device's; stop trying.
 */
function classify(status) {
  if (status === 404 || status === 410) return "drop";
  if (status === 429 || status === 0 || status >= 500) return "retry";
  if (status === 413) return "shrink";
  return "dead";
}

/**
 * Send one bounded batch of queued pushes.
 *
 * Two round trips regardless of batch size: one SELECT to claim the work, and
 * one batch at the end carrying every state change plus the "how much is left"
 * count. The sends themselves happen in between, holding no transaction — a
 * slow push service therefore delays nothing but itself.
 *
 * @returns {{sent:number, dropped:number, retried:number, dead:number, remaining:number}}
 */
export async function drainOutbox(db, env, limit = DRAIN_BATCH) {
  const stats = { sent: 0, dropped: 0, retried: 0, dead: 0, remaining: 0 };

  const { results: rows } = await db
    .prepare(
      `SELECT o.id       AS outbox_id,
              o.attempts AS attempts,
              o.notification_id,
              d.id       AS device_id,
              d.endpoint, d.p256dh, d.auth,
              n.title, n.body, n.url, n.image, n.tag, n.silent, n.type, n.topic
         FROM outbox o
         JOIN push_devices  d ON d.id = o.device_id
         JOIN notifications n ON n.id = o.notification_id
        WHERE o.state = 'pending' AND o.not_before <= ?1
        ORDER BY o.not_before ASC
        LIMIT ?2`
    )
    .bind(nowIso(), limit)
    .all();

  if (!rows || rows.length === 0) return stats;

  const writes = [];

  for (const row of rows) {
    const device = { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth };
    const payload = {
      id: row.notification_id,
      title: row.title,
      body: row.body || "",
      url: row.url,
      image: row.image || "",
      tag: row.tag || row.topic || "posts",
      silent: !!row.silent,
      type: row.type,
    };

    let res;
    try {
      res = await sendWebPush(device, payload, env, {
        ttl: 86400,
        urgency: row.silent ? "low" : "normal",
      });
      if (!res.ok && classify(res.status) === "shrink") {
        res = await sendWebPush(device, null, env, { ttl: 86400 });
      }
    } catch (e) {
      // sendWebPush only THROWS for configuration faults (missing or malformed
      // VAPID keys) — never for a delivery failure, which comes back as a status.
      // A config fault is not this row's problem and would be true of every other
      // row too, so marking them all dead would destroy the queue over one typo.
      // Stop here, flush whatever already succeeded, leave the rest pending.
      stats.configError = String(e && e.message ? e.message : e);
      stats.aborted = true;
      break;
    }

    const stamp = nowIso();

    if (res.ok) {
      writes.push(
        db
          .prepare(
            `UPDATE outbox SET state = 'sent', attempts = attempts + 1, updated_at = ?1 WHERE id = ?2`
          )
          .bind(stamp, row.outbox_id),
        db
          .prepare(`UPDATE push_devices SET last_ok_at = ?1, fail_count = 0 WHERE id = ?2`)
          .bind(stamp, row.device_id)
      );
      stats.sent++;
      continue;
    }

    const action = classify(res.status);
    const attempts = row.attempts + 1;
    const error = `${res.status} ${res.error || ""}`.trim().slice(0, 200);

    if (action === "drop") {
      // Deleting the device cascades naturally: its queued rows join to nothing
      // and are cleaned up by pruneOutbox().
      writes.push(
        db.prepare(`DELETE FROM push_devices WHERE id = ?1`).bind(row.device_id),
        db
          .prepare(
            `UPDATE outbox SET state = 'dead', attempts = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4`
          )
          .bind(attempts, error, stamp, row.outbox_id)
      );
      stats.dropped++;
      continue;
    }

    if (action === "retry" && attempts < MAX_ATTEMPTS) {
      const delay = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)];
      writes.push(
        db
          .prepare(
            `UPDATE outbox SET attempts = ?1, not_before = ?2, last_error = ?3, updated_at = ?4 WHERE id = ?5`
          )
          .bind(attempts, isoIn(delay), error, stamp, row.outbox_id),
        db
          .prepare(`UPDATE push_devices SET fail_count = fail_count + 1 WHERE id = ?1`)
          .bind(row.device_id)
      );
      stats.retried++;
      continue;
    }

    writes.push(
      db
        .prepare(
          `UPDATE outbox SET state = 'dead', attempts = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4`
        )
        .bind(attempts, error, stamp, row.outbox_id),
      db
        .prepare(`UPDATE push_devices SET fail_count = fail_count + 1 WHERE id = ?1`)
        .bind(row.device_id)
    );
    stats.dead++;
  }

  // The backlog count rides along on the write batch rather than paying for a
  // round trip of its own. It is the last statement, so it counts what is left
  // AFTER everything above has landed.
  writes.push(
    db
      .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending' AND not_before <= ?1`)
      .bind(nowIso())
  );

  const written = await db.batch(writes);
  const tail = written[written.length - 1];
  const count = tail && tail.results && tail.results[0];
  stats.remaining = count ? count.n : 0;

  return stats;
}

/**
 * Housekeeping: finished queue rows, rows whose device no longer exists, and
 * devices that have failed far past any plausible recovery. One round trip.
 */
export async function pruneOutbox(db) {
  const cutoff = new Date(Date.now() - OUTBOX_RETENTION_DAYS * 86400 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  await db.batch([
    db
      .prepare(`DELETE FROM outbox WHERE state IN ('sent','dead') AND created_at < ?1`)
      .bind(cutoff),
    db.prepare(`DELETE FROM outbox WHERE device_id NOT IN (SELECT id FROM push_devices)`),
    db.prepare(`DELETE FROM push_devices WHERE fail_count > 10`),
  ]);
}
