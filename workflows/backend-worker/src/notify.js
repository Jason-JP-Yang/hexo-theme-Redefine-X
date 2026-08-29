/**
 * The notification pipeline.
 *
 * PRODUCE (an HTTP invocation — a webhook, a new note, an admin broadcast):
 *
 *   ingestEntries()   entry → notifications row      (INSERT OR IGNORE)
 *                           → followers.unread       (one UPDATE, whole audience)
 *                           → push_devices lookup    (one indexed SELECT)
 *                           → NOTIFY_QUEUE.sendBatch (25 devices per message)
 *
 * CONSUME (a queue invocation, one message at a time):
 *
 *   consumeBatch()    message → 25 parallel Web Push sends → ack
 *
 * The two halves share nothing but the queue. The consumer reads no D1 and
 * writes no D1 on the happy path, because the message already carries the
 * payload and the subscription keys; the only database statement it can issue
 * is a DELETE for endpoints the push service has declared permanently gone.
 *
 * ─── why 25 devices per message, and one message per invocation ───
 *
 * Three published limits decide this, and they do not point the same way:
 *
 *   Subrequests   50 per invocation on the free plan — and D1 and Queues calls
 *                 count toward it, not just fetch(). This is a HARD limit.
 *   CPU           10 ms per invocation, but documented as tolerant of occasional
 *                 overage; measured at 0.287 ms per push on real edge hardware
 *                 (dev/queue-cpu-probe, 482/482 invocations at n=25 succeeded,
 *                 mean 7.18 ms).
 *   Queues ops    10,000/day free, billed PER MESSAGE — a batch of 10 costs 10
 *                 writes, 10 reads and 10 deletes, exactly as 10 single messages
 *                 would. Consumer batching saves nothing here.
 *
 * So batching messages buys only fewer Worker invocations, out of a budget of
 * 100,000 a day that this workload cannot dent — and it pays for them in the one
 * budget that is hard: at 25 pushes a message, `max_batch_size = 2` would put
 * 50 fetches plus any D1 call past the 50-subrequest ceiling. Hence
 * `max_batch_size = 1` in wrangler.toml, which also happens to give retry the
 * smallest possible blast radius, since an unacked batch is retried whole.
 *
 * ─── why the fan-out is one UPDATE ───
 *
 * D1 bills rows, and an index makes a write cost two of them. The inbox used to
 * be a (notification × follower) table with two indexes, so one broadcast to
 * 150 readers wrote ~450 rows before a single push had been sent. The same
 * broadcast now writes 150 — one un-indexed column on each follower's own row —
 * because the inbox lives in `followers.unread` as JSON and SQLite does the
 * append itself.
 *
 * That last part is not a style choice. The append MUST happen inside SQLite
 * (`json_insert(unread, '$[#]', …)`, atomic within the statement). Reading the
 * array into the Worker, pushing onto it and writing it back would silently lose
 * one of any two notifications that overlap.
 */

import { sendWebPush } from "./webpush.js";

// Devices per queue message. See the header: bounded by the 50-subrequest
// ceiling (25 fetches leaves room for the dead-device DELETE and a re-enqueue),
// not by CPU, which measures ~7.2 ms here against a tolerant 10 ms.
export const PUSH_PER_MESSAGE = 25;

// Messages per sendBatch() call. The binding accepts 100 messages, but also caps
// a batch at 256 KB total — and a full 25-device message is ~8 KB, so size binds
// first at ~32. Twenty keeps a wide margin and costs only an extra subrequest
// per twenty messages (i.e. per 500 devices).
const MESSAGES_PER_SEND = 20;

// How many times one set of devices may be handed to the queue. A partial
// failure re-enqueues ONLY the endpoints that failed, so this counts rounds of
// that, not deliveries: 0 is the original send, 1 is the single retry.
const MAX_TRIES = 2;

// Seconds to wait before that retry. Long enough for a push service's transient
// 5xx to clear, short enough that the notification is still news.
const RETRY_DELAY_SEC = 60;

// D1 allows 100 bound parameters per query, and ?1/?2 are spoken for.
const MAX_EXPLICIT_USERS = 80;

// Longest stored notification body. Held here rather than as a CHECK so that
// raising it does not need a table rebuild.
export const BODY_MAX = 500;

// Above this many NEW entries in one ingest, record them and deliver none.
//
// A burst this large is never news. It is a back catalogue arriving at once — a
// fresh database seeing changelog.json for the first time, a regenerated set of
// ids, a changelog rebuilt from scratch — and the only useful response is to
// absorb it silently so that everything in it is deduped forever afterwards.
const MAX_ANNOUNCED_PER_INGEST = 10;

// Retention, in days — and it applies to INBOX REFERENCES only. Unread entries
// outlive read ones because an unread badge is a promise to the reader; a read
// one is only history.
//
// The `notifications` rows themselves have NO age limit. A post or a note is
// deleted the day nothing references it any more, which is a consequence of the
// two numbers below rather than a third clock; an announcement is the admin's
// own record and goes only when the admin deletes it.
const UNREAD_DAYS = 30;
const SEEN_DAYS = 14;

const now = () => Math.floor(Date.now() / 1000);
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
    // never storing more than fits. 500 UTF-8 characters is at most ~1.5 KB.
    body: String(raw.body || "").slice(0, BODY_MAX),
    url: String(raw.url),
    image: String(raw.image || ""),
    tag: String(raw.tag || raw.topic || "posts"),
    audience_json: JSON.stringify(audience),
    silent: raw.silent ? 1 : 0,
    source: String(raw.source || defaults.source || "changelog"),
  };
}

/** The push payload for one notification row. Built once, shared by 25 devices. */
export function payloadOf(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body || "",
    url: row.url,
    image: row.image || "",
    tag: row.tag || row.topic || "posts",
    silent: !!row.silent,
    type: row.type,
  };
}

// ─── audience resolution ─────────────────────────────────────
/**
 * Turn one entry's audience into a WHERE clause over `followers`.
 *
 *   topic  — followers subscribed to it (an empty `topics` means "everything")
 *   all    — every follower, ignoring topic preferences
 *   users  — an explicit allowlist of GitHub logins and/or numeric ids
 *   except — everyone EXCEPT that list, also ignoring topic preferences
 *
 * A follower muted past `muted_until` is skipped in every case: muting is about
 * the reader's attention, not about what the author considers important. So is
 * anyone the admin has muted or banned, and anyone on the global blocklist for
 * this entry's topic — the moderation probe below is appended to every kind,
 * because an audience the admin picked by hand must not be able to reach
 * somebody the same admin already excluded.
 *
 * Returned as SQL rather than as a list of ids so the audience is resolved
 * inside SQLite and the follower list never crosses the wire.
 *
 * The same clause has to run twice — once bare against `followers` in the
 * UPDATE, once alias-qualified inside a join in the SELECT — with the mute
 * timestamp landing on a different parameter number each time. Both are
 * arguments rather than something the caller patches afterwards, because a
 * WHERE clause rewritten by string replacement is a WHERE clause waiting to
 * match the wrong column.
 *
 * @param {object} entry            a normalised entry (needs audience_json, topic)
 * @param {{alias?:string, at?:number}} opts
 *        alias — table alias to qualify columns with, '' for none
 *        at    — parameter number holding the current timestamp; the audience's
 *                own parameters follow it
 * @returns {{where:string, params:string[]}|null} null means "nobody, deliberately"
 */
export function audienceWhere(entry, { alias = "", at = 1 } = {}) {
  let audience;
  try {
    audience = JSON.parse(entry.audience_json);
  } catch {
    audience = { kind: "topic" };
  }

  const q = alias ? `${alias}.` : "";
  const next = at + 1;
  const unmuted = `(${q}muted_until IS NULL OR ${q}muted_until < ?${at})`;

  let where;
  let params;

  if (audience.kind === "all") {
    where = unmuted;
    params = [];
  } else if (audience.kind === "users" || audience.kind === "except") {
    const wanted = (Array.isArray(audience.users) ? audience.users : [])
      .slice(0, MAX_EXPLICIT_USERS)
      .map(String);
    // An explicit allowlist of nobody is a no-op, not a broadcast. An exclusion
    // list of nobody is simply everybody.
    if (wanted.length === 0) {
      if (audience.kind === "users") return null;
      where = unmuted;
      params = [];
    } else {
      const list = wanted.map((_, i) => `?${next + i}`).join(", ");
      const named = `(CAST(${q}github_id AS TEXT) IN (${list}) OR ${q}login IN (${list}))`;
      where = `${unmuted} AND ${audience.kind === "except" ? `NOT ${named}` : named}`;
      params = wanted;
    }
  } else {
    // Default: topic. `topics = ''` is an explicit "no filter", which is the
    // state a reader is in until they touch the preference toggles.
    where = `${unmuted} AND (${q}topics = '' OR (',' || ${q}topics || ',') LIKE '%,' || ?${next} || ',%')`;
    params = [entry.topic];
  }

  // One primary-key probe into a table that only holds moderated identities.
  const owner = alias ? `${alias}.github_id` : "followers.github_id";
  const topicParam = next + params.length;
  return {
    where:
      `${where} AND NOT EXISTS (SELECT 1 FROM moderation m WHERE m.github_id = ${owner} ` +
      `AND (m.state <> '' OR instr(',' || m.blocked || ',', ',' || ?${topicParam} || ',') > 0))`,
    params: [...params, entry.topic],
  };
}

// ─── queue ───────────────────────────────────────────────────
/**
 * Hand a payload and its devices to the queue, 25 at a time.
 *
 * The message carries everything the consumer needs — the rendered payload and
 * each subscription's endpoint and keys — so that consuming costs no D1 read.
 * Devices are two-element-array packed rather than objects purely to keep a full
 * message near 8 KB, comfortably inside both the 128 KB message ceiling and the
 * 64 KB-per-operation billing chunk.
 *
 * @returns {Promise<number>} messages enqueued
 */
export async function enqueuePushes(env, payload, devices, attempt = 0) {
  if (!env.NOTIFY_QUEUE || !devices || devices.length === 0) return 0;

  const messages = [];
  for (let i = 0; i < devices.length; i += PUSH_PER_MESSAGE) {
    messages.push({
      body: {
        n: payload,
        d: devices
          .slice(i, i + PUSH_PER_MESSAGE)
          .map((d) => [d.id, d.endpoint, d.p256dh, d.auth]),
        t: attempt,
      },
    });
  }

  // One call per twenty messages rather than one per message: send() and
  // sendBatch() each cost a subrequest, and the producer has other things to
  // spend them on.
  for (let i = 0; i < messages.length; i += MESSAGES_PER_SEND) {
    await env.NOTIFY_QUEUE.sendBatch(messages.slice(i, i + MESSAGES_PER_SEND));
  }
  return messages.length;
}

/**
 * Fan one notification out to its audience and queue the pushes.
 *
 * ONE D1 round trip does both halves: the UPDATE writes the inbox and reports
 * how many readers matched, and the SELECT — filtered by the same audience
 * clause — returns their devices. Neither depends on the other's result, so
 * they travel together.
 *
 * @returns {Promise<{recipients:number, devices:number, messages:number}>}
 */
export async function fanOut(db, env, row) {
  // ?1 is the inbox entry, ?2 the timestamp, ?3+ the audience's own values.
  const inbox = audienceWhere(row, { at: 2 });
  // No entry to bind here, so everything shifts down one: ?1 timestamp, ?2+ audience.
  const lookup = audienceWhere(row, { alias: "f", at: 1 });
  if (!inbox || !lookup) return { recipients: 0, devices: 0, messages: 0 };

  const stamp = now();
  const entry = JSON.stringify([row.id, stamp]);
  // ?1 entry, ?2 timestamp, then the audience's own values — so the dedupe
  // guards below take the next number after those.
  const nextParam = 3 + inbox.params.length;

  const [delivered, found] = await db.batch([
    // The inbox is written for every recipient, push device or not — that is
    // what lets the bell work for a reader who declined the OS permission.
    //
    // The two NOT EXISTS guards make the append idempotent per reader: a resend,
    // a double-fired webhook, or any other second pass over the same id pushes
    // again without stacking a duplicate line in the panel. They walk the
    // reader's own JSON arrays, not a table, so they cost no additional rows.
    db
      .prepare(
        `UPDATE followers
            SET unread = json_insert(unread, '$[#]', json(?1))
          WHERE ${inbox.where}
            AND NOT EXISTS (SELECT 1 FROM json_each(followers.unread) j
                             WHERE j.value->>0 = ?${nextParam})
            AND NOT EXISTS (SELECT 1 FROM json_each(followers.seen) j
                             WHERE j.value->>0 = ?${nextParam})`
      )
      .bind(entry, stamp, ...inbox.params, row.id),
    // Same audience, one join further out. Independent of the statement above,
    // which is why both fit in a single round trip. `d.state = ''` is the
    // device-level half of moderation: a single browser can be silenced without
    // touching the rest of its owner's subscription.
    db
      .prepare(
        `SELECT d.id, d.endpoint, d.p256dh, d.auth
           FROM push_devices d
           JOIN followers f ON f.github_id = d.github_id
          WHERE d.state = '' AND ${lookup.where}`
      )
      .bind(stamp, ...lookup.params),
  ]);

  const devices = (found && found.results) || [];
  const messages = await enqueuePushes(env, payloadOf(row), devices);

  return { recipients: changesOf(delivered), devices: devices.length, messages };
}

// ─── ingest ──────────────────────────────────────────────────
/**
 * Record entries, fan them out, and queue the pushes.
 *
 * Idempotency lives entirely in `notifications.id`: re-ingesting an entry that
 * already exists is a no-op, so webhook retries, a re-run over the same
 * changelog, and an edit to an already-delivered entry all cost nothing.
 *
 * @returns {{ingested:string[], skipped:string[], recipients:number, devices:number, messages:number, absorbed?:boolean}}
 */
export async function ingestEntries(db, env, rawEntries, defaults = {}) {
  const result = { ingested: [], skipped: [], recipients: 0, devices: 0, messages: 0 };

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
             (id, type, topic, title, body, url, image, tag, audience_json, silent, source)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
          entry.source
        )
    )
  );

  const fresh = [];
  entries.forEach((entry, i) => {
    const res = inserts[i];
    // Two independent signals that the row was actually written, because getting
    // this wrong is the one failure mode with no symptom: read it as "nothing was
    // new" and the pipeline goes silent forever. An ignored insert reports zero
    // on both, so accepting either cannot over-deliver.
    const wrote = changesOf(res) > 0 || !!(res && res.results && res.results.length > 0);
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

  const counts = [];
  for (const entry of fresh) {
    const stats = await fanOut(db, env, entry);
    result.recipients += stats.recipients;
    result.devices += stats.devices;
    result.messages += stats.messages;
    counts.push({ id: entry.id, ...stats });
  }

  // Per-entry, for the admin receipt: a broadcast of several entries reaching
  // different audiences is otherwise reported as one indistinguishable total.
  result.counts = counts;

  // The audit numbers, folded into one round trip. They come from writes that
  // already happened, so this replaces what used to be an aggregate query over
  // a join table on every admin page load.
  await db.batch(
    counts.map((c) =>
      db
        .prepare(`UPDATE notifications SET recipients = ?2, devices = ?3 WHERE id = ?1`)
        .bind(c.id, c.recipients, c.devices)
    )
  );

  return result;
}

// ─── consume ─────────────────────────────────────────────────
/**
 * Classify a delivery failure into what to do about it.
 *
 *   404 / 410 — the subscription is gone for good; delete the device.
 *   429 / 5xx / network — transient; worth one more round.
 *   anything else (400, 401, 403, 413) — our fault, not the device's. Retrying
 *   would commit the same error two more times, so it stops here and is logged.
 */
function classify(status) {
  if (status === 404 || status === 410) return "drop";
  if (status === 429 || status === 0 || status >= 500) return "retry";
  return "dead";
}

/**
 * Queue consumer. One message, up to 25 pushes, sent in parallel.
 *
 * Parallel and not sequential because the runtime already paces this correctly:
 * only six connections may be waiting for response headers at once, and a
 * seventh "is queued until one of the existing connections receives its response
 * headers" rather than failing. So Promise.all over 25 self-throttles into about
 * five waves, turning 25 round trips of wall time into five, with identical CPU.
 *
 * A partial failure re-enqueues ONLY the endpoints that failed. The alternative
 * — letting the platform retry the message — would re-send to the 24 devices
 * that already succeeded, and paying one queue operation to avoid two dozen
 * duplicate notifications is not a close call.
 */
export async function consumeBatch(batch, env) {
  for (const message of batch.messages) {
    try {
      await handleMessage(message, env);
    } catch (e) {
      // Reaching here means something outside the per-push error handling broke
      // — a malformed body, or VAPID configuration so wrong that every send
      // throws. Retrying cannot fix either, and an unacked message would come
      // back to fail the same way, so record it and let it go.
      console.log(
        "[notify] consumer error",
        JSON.stringify({ error: String((e && e.message) || e) })
      );
    }
    message.ack();
  }
}

async function handleMessage(message, env) {
  const body = message.body || {};
  const payload = body.n;
  const devices = Array.isArray(body.d) ? body.d : [];
  const attempt = Number(body.t) || 0;
  if (!payload || devices.length === 0) return;

  const settled = await Promise.all(
    devices.map(async ([id, endpoint, p256dh, auth]) => {
      try {
        const res = await sendWebPush({ endpoint, p256dh, auth }, payload, env, {
          ttl: 86400,
          urgency: payload.silent ? "low" : "normal",
        });
        return { id, endpoint, p256dh, auth, ...res };
      } catch (e) {
        // sendWebPush only throws for configuration faults (missing or malformed
        // VAPID keys), which are true of every device in this message and not
        // this one's fault. Report as a non-retryable failure.
        return { id, ok: false, status: -1, error: String((e && e.message) || e) };
      }
    })
  );

  const drop = [];
  const again = [];
  let sent = 0;
  let failed = 0;

  for (const r of settled) {
    if (r.ok) {
      sent++;
      continue;
    }
    failed++;
    const action = classify(r.status);
    if (action === "drop") drop.push(r.id);
    else if (action === "retry") again.push(r);
  }

  const after = [];

  // The only D1 statement a consumer ever issues, and only when a push service
  // has said the subscription is permanently gone.
  if (drop.length > 0) {
    const list = drop.slice(0, 90).map((_, i) => `?${i + 1}`).join(", ");
    after.push(
      env.DB.prepare(`DELETE FROM push_devices WHERE id IN (${list})`)
        .bind(...drop.slice(0, 90))
        .run()
    );
  }

  if (again.length > 0 && attempt + 1 < MAX_TRIES) {
    after.push(
      enqueuePushes(
        env,
        payload,
        again.map((r) => ({ id: r.id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth })),
        attempt + 1
      )
    );
  }

  if (after.length > 0) await Promise.all(after);

  console.log(
    "[notify] push",
    JSON.stringify({
      id: payload.id,
      try: attempt,
      sent,
      failed,
      dropped: drop.length,
      requeued: again.length && attempt + 1 < MAX_TRIES ? again.length : 0,
      errors: settled
        .filter((r) => !r.ok)
        .slice(0, 3)
        .map((r) => `${r.status} ${String(r.error || "").slice(0, 80)}`),
    })
  );
}

// ─── retention ───────────────────────────────────────────────
/**
 * The daily sweep. One round trip, three statements, in this order because each
 * one depends on what the previous left behind.
 *
 * The guard on the UPDATE is the point of it: without the WHERE EXISTS, every
 * follower row would be rewritten every day whether or not anything in it had
 * expired — a write per follower per day, in the scarce direction, to change
 * nothing. With it, the sweep scans all of them (reads are 5M/day) and writes
 * only the rows that actually lost an entry.
 *
 * Age expires REFERENCES, never rows. A notification is deleted because nothing
 * points at it any more, not because a clock ran out — so an announcement
 * nobody has read is still there next year, and a post is gone the day its last
 * reader's inbox entry expires.
 */
export async function pruneInboxes(db) {
  const t = now();
  const unreadCutoff = t - UNREAD_DAYS * 86400;
  const seenCutoff = t - SEEN_DAYS * 86400;

  const [swept, unreferenced, orphans] = await db.batch([
    db
      .prepare(
        `UPDATE followers
            SET unread = (SELECT COALESCE(json_group_array(json(j.value)), '[]')
                            FROM json_each(followers.unread) j
                           WHERE j.value->>1 >= ?1),
                seen   = (SELECT COALESCE(json_group_array(json(j.value)), '[]')
                            FROM json_each(followers.seen) j
                           WHERE j.value->>2 >= ?2)
          WHERE EXISTS (SELECT 1 FROM json_each(followers.unread) j WHERE j.value->>1 < ?1)
             OR EXISTS (SELECT 1 FROM json_each(followers.seen)   j WHERE j.value->>2 < ?2)`
      )
      .bind(unreadCutoff, seenCutoff),
    // Posts and notes have no life of their own: once the sweep above has taken
    // the last inbox entry pointing at one, the row can never be rendered again.
    // Runs after that UPDATE, in the same transaction, so it sees the result.
    //
    // Announcements are never swept. They are the admin's own record, and the
    // management list is meant to be what the database actually still holds —
    // including one that reached an audience of nobody.
    db.prepare(
      `DELETE FROM notifications
        WHERE type IN ('post', 'note')
          AND id NOT IN (
                SELECT j.value->>0 FROM followers f, json_each(f.unread) j
                 WHERE j.value->>0 IS NOT NULL
                 UNION
                SELECT j.value->>0 FROM followers f, json_each(f.seen) j
                 WHERE j.value->>0 IS NOT NULL)`
    ),
    // A subscription whose owner unfollowed. Banned ones stay: that is the whole
    // reason unfollow leaves them behind, and a sweep that removed them would
    // hand back the one-click escape the ban is meant to close.
    db.prepare(
      `DELETE FROM push_devices
        WHERE state <> 'banned'
          AND NOT EXISTS (SELECT 1 FROM followers f WHERE f.github_id = push_devices.github_id)`
    ),
  ]);

  return {
    followersSwept: changesOf(swept),
    unreferenced: changesOf(unreferenced),
    orphanDevices: changesOf(orphans),
  };
}

/**
 * Delete one notification and every reference to it.
 *
 * The EXISTS guards mean only the readers who actually hold the id pay a row
 * write. A push already handed to the queue still lands — the consumer carries
 * its own payload and reads no D1 — which is deliberate: chasing a message
 * that is already in flight would cost a database read on every push forever,
 * to catch a race measured in seconds.
 */
export async function deleteNotification(db, id) {
  const [swept, removed] = await db.batch([
    db
      .prepare(
        `UPDATE followers
            SET unread = (SELECT COALESCE(json_group_array(json(j.value)), '[]')
                            FROM json_each(followers.unread) j WHERE j.value->>0 <> ?1),
                seen   = (SELECT COALESCE(json_group_array(json(j.value)), '[]')
                            FROM json_each(followers.seen)   j WHERE j.value->>0 <> ?1)
          WHERE EXISTS (SELECT 1 FROM json_each(followers.unread) j WHERE j.value->>0 = ?1)
             OR EXISTS (SELECT 1 FROM json_each(followers.seen)   j WHERE j.value->>0 = ?1)`
      )
      .bind(id),
    db.prepare(`DELETE FROM notifications WHERE id = ?1`).bind(id),
  ]);

  return { inboxes: changesOf(swept), removed: changesOf(removed) };
}
