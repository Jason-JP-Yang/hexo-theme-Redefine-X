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
 * Splitting fan-out (cheap, one D1 write per recipient) from sending (expensive,
 * one subrequest per device) is what keeps a broadcast inside the Worker's
 * per-invocation limits: ingest never sends, and the cron never fans out.
 *
 * Idempotency lives entirely in `notifications.id`. Re-ingesting an entry that
 * already exists is a no-op, so webhook retries, a re-run over the same
 * changelog, and an edit to an already-delivered entry all cost nothing.
 */

import { sendWebPush } from "./webpush.js";

// Sending is one subrequest per device and the free plan allows 50 per
// invocation, so the batch stays under it with room for the D1 round-trips.
const DRAIN_BATCH = 40;
// A push service that keeps failing is not coming back within this job's
// lifetime; five attempts spread over the backoff below is enough to ride out a
// transient outage without queueing dead rows forever.
const MAX_ATTEMPTS = 5;
// Give the static deploy time to finish before the first send, so a notification
// never links to a page that is still 404. Overridable because locally there is
// no deploy to wait for — set NOTIFY_GRACE_SEC=0 in .dev.vars.
const DEPLOY_GRACE_SEC = 120;

function graceSeconds(env) {
  const raw = env && env.NOTIFY_GRACE_SEC;
  if (raw === undefined || raw === null || raw === "") return DEPLOY_GRACE_SEC;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEPLOY_GRACE_SEC;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const isoIn = (seconds) =>
  new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

// ─── settings helpers ────────────────────────────────────────
export async function getSetting(db, key) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?1`).bind(key).first();
  return row ? row.value : null;
}

export async function setSetting(db, key, value) {
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(key, String(value))
    .run();
}

/**
 * Dry run means "record it, do not send it". It is on when the env var says so
 * or when the database has never been bootstrapped — the guard that stops a
 * first deployment from pushing the entire back catalogue at everyone.
 */
export async function isDryRun(db, env) {
  if (String(env.NOTIFY_DRY_RUN || "") === "true") return true;
  return (await getSetting(db, "dry_run")) === "true";
}

// ─── entry normalisation ─────────────────────────────────────
/**
 * Coerce one raw changelog/admin entry into the row shape. Only id, title and
 * url are required; everything else has a defensible default so a hand-written
 * entry can stay as short as three lines.
 */
export function normalizeEntry(raw, defaults = {}) {
  if (!raw || !raw.id || !raw.title || !raw.url) return null;

  const audience =
    raw.audience && typeof raw.audience === "object"
      ? raw.audience
      : { kind: "topic" };

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
 * Which followers should receive this notification.
 *
 *   topic  — followers subscribed to it (an empty `topics` means "everything")
 *   all    — every follower, ignoring topic preferences
 *   users  — an explicit allowlist of GitHub logins and/or numeric ids
 *
 * A follower muted past `muted_until` is skipped in every case: muting is about
 * the reader's attention, not about what the author considers important.
 */
async function resolveAudience(db, notification) {
  let audience;
  try {
    audience = JSON.parse(notification.audience_json);
  } catch {
    audience = { kind: "topic" };
  }
  const now = nowIso();

  // `exclude` is applied to whatever the kind selected, so it works the same for
  // a topic fan-out, an `all` broadcast and an explicit user list. Its main use
  // is leaving out whoever triggered the notification.
  const excluded = new Set(
    (Array.isArray(audience.exclude) ? audience.exclude : []).map(String)
  );
  const withoutExcluded = (rows) =>
    (rows || []).map((r) => r.github_id).filter((id) => !excluded.has(String(id)));

  if (audience.kind === "users" && Array.isArray(audience.users)) {
    const wanted = audience.users.map((u) => String(u));
    if (wanted.length === 0) return [];
    const placeholders = wanted.map((_, i) => `?${i + 2}`).join(", ");
    const { results } = await db
      .prepare(
        `SELECT github_id FROM followers
         WHERE (muted_until IS NULL OR muted_until < ?1)
           AND (CAST(github_id AS TEXT) IN (${placeholders}) OR login IN (${placeholders}))`
      )
      .bind(now, ...wanted)
      .all();
    return withoutExcluded(results);
  }

  if (audience.kind === "all") {
    const { results } = await db
      .prepare(
        `SELECT github_id FROM followers WHERE muted_until IS NULL OR muted_until < ?1`
      )
      .bind(now)
      .all();
    return withoutExcluded(results);
  }

  // Default: topic. `topics = ''` is an explicit "no filter", which is the state
  // a reader is in until they touch the preference toggles.
  const { results } = await db
    .prepare(
      `SELECT github_id FROM followers
       WHERE (muted_until IS NULL OR muted_until < ?1)
         AND (topics = '' OR (',' || topics || ',') LIKE '%,' || ?2 || ',%')`
    )
    .bind(now, notification.topic)
    .all();
  return withoutExcluded(results);
}

// ─── ingest ──────────────────────────────────────────────────
/**
 * Record entries and fan them out.
 *
 * @returns {{ingested:string[], skipped:string[], deliveries:number, queued:number, dryRun:boolean}}
 */
export async function ingestEntries(db, env, rawEntries, defaults = {}) {
  const dryRun = await isDryRun(db, env);
  const result = { ingested: [], skipped: [], deliveries: 0, queued: 0, dryRun };

  for (const raw of rawEntries || []) {
    const entry = normalizeEntry(raw, defaults);
    if (!entry) continue;

    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO notifications
           (id, type, topic, title, body, url, image, tag, audience_json, silent, source, published_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
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
      .run();

    // Already known — this is the replay/edit case, and it must not resend.
    if (!inserted.meta || inserted.meta.changes === 0) {
      result.skipped.push(entry.id);
      continue;
    }
    result.ingested.push(entry.id);

    const recipients = await resolveAudience(db, entry);
    if (recipients.length === 0) continue;

    // Inbox rows are written even in a dry run: the record of what happened is
    // never the risky part, only the sending is.
    const inbox = recipients.map((githubId) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO deliveries (notification_id, github_id) VALUES (?1, ?2)`
        )
        .bind(entry.id, githubId)
    );
    await db.batch(inbox);
    result.deliveries += recipients.length;

    if (dryRun) continue;

    const placeholders = recipients.map((_, i) => `?${i + 1}`).join(", ");
    const { results: devices } = await db
      .prepare(`SELECT id FROM push_devices WHERE github_id IN (${placeholders})`)
      .bind(...recipients)
      .all();

    if (!devices || devices.length === 0) continue;

    const notBefore = isoIn(graceSeconds(env));
    const queue = devices.map((d) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO outbox (notification_id, device_id, not_before)
           VALUES (?1, ?2, ?3)`
        )
        .bind(entry.id, d.id, notBefore)
    );
    await db.batch(queue);
    result.queued += devices.length;
  }

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

// Exponential, in seconds, indexed by attempt count.
const BACKOFF = [60, 300, 900, 3600, 10800];

/**
 * Send one bounded batch of queued pushes.
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

  for (const row of rows) {
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
      res = await sendWebPush(
        { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
        payload,
        env,
        { ttl: 86400, urgency: row.silent ? "low" : "normal" }
      );

      if (!res.ok && classify(res.status) === "shrink") {
        res = await sendWebPush(
          { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
          null,
          env,
          { ttl: 86400 }
        );
      }
    } catch (e) {
      // sendWebPush only THROWS for configuration faults (missing or malformed
      // VAPID keys) — never for a delivery failure, which comes back as a status.
      // A config fault is not this row's problem and would be true of every other
      // row too, so marking them all dead would destroy the queue over one typo.
      // Abort instead, leave everything pending, and say why.
      stats.configError = String(e && e.message ? e.message : e);
      stats.aborted = true;
      return stats;
    }

    const stamp = nowIso();

    if (res.ok) {
      await db.batch([
        db
          .prepare(
            `UPDATE outbox SET state = 'sent', attempts = attempts + 1, updated_at = ?1 WHERE id = ?2`
          )
          .bind(stamp, row.outbox_id),
        db
          .prepare(`UPDATE push_devices SET last_ok_at = ?1, fail_count = 0 WHERE id = ?2`)
          .bind(stamp, row.device_id),
      ]);
      stats.sent++;
      continue;
    }

    const action = classify(res.status);
    const attempts = row.attempts + 1;
    const error = `${res.status} ${res.error || ""}`.trim().slice(0, 200);

    if (action === "drop") {
      // Deleting the device cascades naturally: its queued rows join to nothing
      // and are cleaned up by pruneOutbox().
      await db.batch([
        db.prepare(`DELETE FROM push_devices WHERE id = ?1`).bind(row.device_id),
        db
          .prepare(
            `UPDATE outbox SET state = 'dead', attempts = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4`
          )
          .bind(attempts, error, stamp, row.outbox_id),
      ]);
      stats.dropped++;
      continue;
    }

    if (action === "retry" && attempts < MAX_ATTEMPTS) {
      const delay = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)];
      await db.batch([
        db
          .prepare(
            `UPDATE outbox SET attempts = ?1, not_before = ?2, last_error = ?3, updated_at = ?4 WHERE id = ?5`
          )
          .bind(attempts, isoIn(delay), error, stamp, row.outbox_id),
        db
          .prepare(`UPDATE push_devices SET fail_count = fail_count + 1 WHERE id = ?1`)
          .bind(row.device_id),
      ]);
      stats.retried++;
      continue;
    }

    await db.batch([
      db
        .prepare(
          `UPDATE outbox SET state = 'dead', attempts = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4`
        )
        .bind(attempts, error, stamp, row.outbox_id),
      db
        .prepare(`UPDATE push_devices SET fail_count = fail_count + 1 WHERE id = ?1`)
        .bind(row.device_id),
    ]);
    stats.dead++;
  }

  const pending = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending' AND not_before <= ?1`
    )
    .bind(nowIso())
    .first();
  stats.remaining = pending ? pending.n : 0;

  return stats;
}

/**
 * Housekeeping: finished queue rows, rows whose device or notification no longer
 * exists, and devices that have failed far past any plausible recovery.
 */
export async function pruneOutbox(db) {
  const cutoff = new Date(Date.now() - 90 * 86400 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  await db.batch([
    db
      .prepare(`DELETE FROM outbox WHERE state IN ('sent','dead') AND created_at < ?1`)
      .bind(cutoff),
    db.prepare(
      `DELETE FROM outbox WHERE device_id NOT IN (SELECT id FROM push_devices)`
    ),
    db.prepare(`DELETE FROM push_devices WHERE fail_count > 10`),
  ]);
}
