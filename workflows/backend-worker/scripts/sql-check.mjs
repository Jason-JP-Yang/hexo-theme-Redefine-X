/**
 * Run every hand-written statement in the Worker against a real SQLite engine,
 * on the real schema.sql, and assert what it did.
 *
 * `node --check` proves a file parses as JavaScript. It says nothing about
 * whether a SQL string inside it is valid, binds the right number of parameters,
 * or matches the rows it was meant to — and D1 reports all three the same way at
 * runtime, in production, after a deploy. This closes that gap before the deploy
 * instead of after it.
 *
 * The fan-out clause is imported from src/notify.js rather than copied, so this
 * exercises the SQL the Worker will actually issue.
 *
 * Run: npm run sql:check
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { audienceWhere, normalizeEntry } from "../src/notify.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = new DatabaseSync(":memory:");

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    pass++;
    console.log(`  ok   ${name}${detail ? "  → " + detail : ""}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
};
const eq = (got, want, what) => {
  if (got !== want) {
    throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
};

const AT = "2026-08-28T00:00:00Z";
const NOW = Math.floor(Date.parse(AT) / 1000);
const changes = (r) => Number(r.changes);

console.log(`\nsqlite ${db.prepare("select sqlite_version() v").get().v}`);

// ─── schema ──────────────────────────────────────────────────
console.log("\n── schema ──");
check("schema.sql applies", () => {
  db.exec(readFileSync(join(ROOT, "schema.sql"), "utf8"));
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    )
    .all()
    .map((r) => r.name);
  eq(tables.length, 4, "table count");
  return tables.join(", ");
});

check("schema.sql is re-runnable", () => {
  db.exec(readFileSync(join(ROOT, "schema.sql"), "utf8"));
  eq(db.prepare(`SELECT COUNT(*) n FROM notes`).get().n, 0, "notes survives");
});

check("only one secondary index on the notification tables", () => {
  const idx = db
    .prepare(
      `SELECT name, tbl_name FROM sqlite_master
        WHERE type='index' AND sql IS NOT NULL AND tbl_name <> 'notes' ORDER BY name`
    )
    .all();
  // Every index here is a second row written per row touched. followers must
  // have none: it is the table a broadcast writes once per reader.
  eq(idx.filter((i) => i.tbl_name === "followers").length, 0, "indexes on followers");
  return idx.map((i) => `${i.tbl_name}.${i.name}`).join(", ");
});

// ─── fixtures ────────────────────────────────────────────────
console.log("\n── fixtures ──");
const UPSERT_FOLLOWER = `INSERT INTO followers (github_id, login, avatar, topics)
   VALUES (?1, ?2, '', ?3)
   ON CONFLICT(github_id) DO UPDATE SET
     login  = excluded.login,
     topics = COALESCE(?4, followers.topics)`;

const UPSERT_DEVICE = `INSERT INTO push_devices (github_id, endpoint, p256dh, auth, ua)
   VALUES (?1, ?2, ?3, ?4, ?5)
   ON CONFLICT(endpoint) DO UPDATE SET
     github_id = excluded.github_id,
     p256dh    = excluded.p256dh,
     auth      = excluded.auth,
     ua        = excluded.ua`;

check("upsertFollower — insert then rename, keeping topics", () => {
  const f = db.prepare(UPSERT_FOLLOWER);
  f.run(1, "alice", "", null); // all topics
  f.run(2, "bob", "posts", "posts"); // posts only
  f.run(3, "carol", "notes", "notes"); // notes only
  f.run(4, "dave", "", null);
  db.prepare(`UPDATE followers SET muted_until = ?1 WHERE github_id = 4`).run(NOW + 86400);
  f.run(2, "bob-renamed", "", null);
  const row = db.prepare(`SELECT login, topics FROM followers WHERE github_id = 2`).get();
  eq(row.login, "bob-renamed", "login updated");
  eq(row.topics, "posts", "topics preserved by COALESCE");
  return "4 followers (dave muted)";
});

check("push_devices upsert — re-subscribe rewrites, never duplicates", () => {
  const d = db.prepare(UPSERT_DEVICE);
  d.run(1, "https://fcm/a", "p", "a", "ua");
  d.run(1, "https://fcm/b", "p", "a", "ua");
  d.run(2, "https://fcm/c", "p", "a", "ua");
  d.run(3, "https://fcm/d", "p", "a", "ua");
  d.run(1, "https://fcm/a", "p2", "a2", "ua2"); // same browser again
  eq(db.prepare(`SELECT COUNT(*) n FROM push_devices`).get().n, 4, "devices");
  eq(
    db.prepare(`SELECT p256dh FROM push_devices WHERE endpoint='https://fcm/a'`).get().p256dh,
    "p2",
    "keys rewritten"
  );
  return "4 devices — alice x2, bob, carol";
});

// ─── ingest + fan-out (the real SQL from notify.js) ──────────
console.log("\n── ingest + fan-out ──");
const INSERT_N = `INSERT OR IGNORE INTO notifications
     (id, type, topic, title, body, url, image, tag, audience_json, silent, source)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
   RETURNING id`;

const insertEntry = (raw) => {
  const e = normalizeEntry(raw);
  return {
    entry: e,
    returned: db
      .prepare(INSERT_N)
      .all(
        e.id, e.type, e.topic, e.title, e.body, e.url, e.image, e.tag,
        e.audience_json, e.silent, e.source
      ),
  };
};

/** Exactly what fanOut() builds, statement for statement. */
function fanOut(entry, stamp) {
  const inbox = audienceWhere(entry, { at: 2 });
  const lookup = audienceWhere(entry, { alias: "f", at: 1 });
  if (!inbox || !lookup) return { recipients: 0, devices: [] };
  const nextParam = 3 + inbox.params.length;

  const delivered = db
    .prepare(
      `UPDATE followers
          SET unread = json_insert(unread, '$[#]', json(?1))
        WHERE ${inbox.where}
          AND NOT EXISTS (SELECT 1 FROM json_each(followers.unread) j
                           WHERE j.value->>0 = ?${nextParam})
          AND NOT EXISTS (SELECT 1 FROM json_each(followers.seen) j
                           WHERE j.value->>0 = ?${nextParam})`
    )
    .run(JSON.stringify([entry.id, stamp]), stamp, ...inbox.params, entry.id);

  const devices = db
    .prepare(
      `SELECT d.id, d.endpoint, d.p256dh, d.auth
         FROM push_devices d
         JOIN followers f ON f.github_id = d.github_id
        WHERE ${lookup.where}`
    )
    .all(stamp, ...lookup.params);

  return { recipients: changes(delivered), devices };
}

check("INSERT OR IGNORE … RETURNING id distinguishes new from replay", () => {
  const first = insertEntry({ id: "post:x", title: "T", url: "https://s/x", body: "B" });
  eq(first.returned.length, 1, "new row returns one");
  const again = insertEntry({ id: "post:x", title: "T", url: "https://s/x", body: "B" });
  eq(again.returned.length, 0, "replay returns none");
});

check("fan-out — topic audience, mute honoured, both statements agree", () => {
  const e = normalizeEntry({ id: "post:x", title: "T", url: "https://s/x" });
  const r = fanOut(e, NOW);
  eq(r.recipients, 2, "recipients"); // alice (all) + bob (posts); carol notes-only, dave muted
  eq(r.devices.length, 3, "devices"); // alice x2 + bob
  eq(
    db.prepare(`SELECT unread FROM followers WHERE github_id=1`).get().unread,
    `[["post:x",${NOW}]]`,
    "alice inbox"
  );
  eq(db.prepare(`SELECT unread FROM followers WHERE github_id=3`).get().unread, "[]", "carol");
  eq(db.prepare(`SELECT unread FROM followers WHERE github_id=4`).get().unread, "[]", "dave");
  return "2 readers, 3 devices → 1 queue message";
});

check("fan-out is idempotent — a resend pushes again but does not stack", () => {
  const e = normalizeEntry({ id: "post:x", title: "T", url: "https://s/x" });
  const r = fanOut(e, NOW + 10);
  eq(r.recipients, 0, "nobody re-added to the inbox");
  eq(r.devices.length, 3, "but the devices still resolve, so the push resends");
  eq(
    JSON.parse(db.prepare(`SELECT unread FROM followers WHERE github_id=1`).get().unread).length,
    1,
    "still one entry"
  );
});

check("fan-out — second notification appends", () => {
  insertEntry({ id: "post:y", title: "T2", url: "https://s/y" });
  const e = normalizeEntry({ id: "post:y", title: "T2", url: "https://s/y" });
  eq(fanOut(e, NOW + 60).recipients, 2, "recipients");
  const a = JSON.parse(db.prepare(`SELECT unread FROM followers WHERE github_id=1`).get().unread);
  eq(a.length, 2, "alice has two");
  eq(a[1][0], "post:y", "appended at the end");
});

check("fan-out — 'notes' topic reaches all-topics and notes-only", () => {
  insertEntry({ id: "note:1", type: "note", topic: "notes", title: "N", url: "https://s/#n" });
  const e = normalizeEntry({ id: "note:1", type: "note", topic: "notes", title: "N", url: "https://s/#n" });
  eq(fanOut(e, NOW + 120).recipients, 2, "alice + carol");
});

check("fan-out — audience 'all' ignores topics but not mutes", () => {
  insertEntry({ id: "ann:1", topic: "announcements", title: "A", url: "https://s/a", audience: { kind: "all" } });
  const e = normalizeEntry({ id: "ann:1", topic: "announcements", title: "A", url: "https://s/a", audience: { kind: "all" } });
  eq(fanOut(e, NOW + 180).recipients, 3, "alice + bob + carol, not dave");
});

check("fan-out — audience 'users', repeated params across two IN lists", () => {
  insertEntry({ id: "dm:1", title: "D", url: "https://s/d", audience: { kind: "users", users: ["2", "carol"] } });
  const e = normalizeEntry({ id: "dm:1", title: "D", url: "https://s/d", audience: { kind: "users", users: ["2", "carol"] } });
  eq(fanOut(e, NOW + 240).recipients, 2, "matched one by id, one by login");
});

check("audit counts write back", () => {
  db.prepare(`UPDATE notifications SET recipients = ?2, devices = ?3 WHERE id = ?1`).run("post:x", 2, 3);
  const row = db.prepare(`SELECT recipients, devices FROM notifications WHERE id='post:x'`).get();
  eq(row.recipients, 2, "recipients");
  eq(row.devices, 3, "devices");
});

// ─── inbox (the real SQL from index.js) ──────────────────────
console.log("\n── inbox ──");
const INBOX = `SELECT n.id, n.type, n.topic, n.title, n.body, n.url, n.image,
                strftime('%Y-%m-%dT%H:%M:%SZ', j.value->>1, 'unixepoch') AS published_at,
                NULL AS read_at
           FROM followers f, json_each(f.unread) j
           JOIN notifications n ON n.id = j.value->>0
          WHERE f.github_id = ?1
          UNION ALL
         SELECT n.id, n.type, n.topic, n.title, n.body, n.url, n.image,
                strftime('%Y-%m-%dT%H:%M:%SZ', j.value->>1, 'unixepoch') AS published_at,
                strftime('%Y-%m-%dT%H:%M:%SZ', j.value->>2, 'unixepoch') AS read_at
           FROM followers f, json_each(f.seen) j
           JOIN notifications n ON n.id = j.value->>0
          WHERE f.github_id = ?1
          ORDER BY published_at DESC
          LIMIT ?2`;

const META = `SELECT json_array_length(f.unread) AS unread, f.topics, f.muted_until,
                (SELECT COUNT(*) FROM push_devices WHERE github_id = ?1) AS devices
           FROM followers f
          WHERE f.github_id = ?1`;

check("inbox query — newest first, ISO timestamps, read flag", () => {
  const rows = db.prepare(INBOX).all(1, 30);
  eq(rows.length, 4, "alice items"); // post:x, post:y, note:1, ann:1
  eq(rows[0].id, "ann:1", "newest first");
  eq(rows[0].read_at, null, "unread");
  eq(rows[3].published_at, AT, "ISO shape the panel parses");
  return rows.map((r) => r.id).join(", ");
});

check("badge is a scalar off one primary-key row", () => {
  const m = db.prepare(META).get(1);
  eq(m.unread, 4, "unread");
  eq(m.devices, 2, "devices");
});

check("meta returns nothing for a stranger → following:false", () => {
  eq(db.prepare(META).get(999) ?? null, null, "no row");
});

// ─── mark read ───────────────────────────────────────────────
console.log("\n── mark read ──");
const READ_SOME = (list) => `UPDATE followers
            SET unread = (SELECT COALESCE(json_group_array(json(j.value)), '[]')
                            FROM json_each(followers.unread) j
                           WHERE j.value->>0 NOT IN (${list})),
                seen   = (SELECT json_group_array(json(v)) FROM (
                            SELECT j.value AS v FROM json_each(followers.seen) j
                            UNION ALL
                            SELECT json_array(j.value->>0, j.value->>1, ?2)
                              FROM json_each(followers.unread) j
                             WHERE j.value->>0 IN (${list})))
          WHERE github_id = ?1`;

const READ_ALL = `UPDATE followers
            SET seen   = (SELECT json_group_array(json(v)) FROM (
                            SELECT j.value AS v FROM json_each(followers.seen) j
                            UNION ALL
                            SELECT json_array(j.value->>0, j.value->>1, ?2)
                              FROM json_each(followers.unread) j)),
                unread = '[]'
          WHERE github_id = ?1 AND unread <> '[]'`;

check("mark ONE read — moves it, keeps the delivery time, stamps the read time", () => {
  const r = db.prepare(READ_SOME("?3")).run(1, NOW + 500, "post:x");
  eq(changes(r), 1, "one row written");
  const row = db.prepare(`SELECT unread, seen FROM followers WHERE github_id=1`).get();
  eq(JSON.parse(row.unread).length, 3, "remaining unread");
  const seen = JSON.parse(row.seen);
  eq(seen.length, 1, "moved to seen");
  eq(seen[0][0], "post:x", "the right one");
  eq(seen[0][1], NOW, "DELIVERY time preserved");
  eq(seen[0][2], NOW + 500, "READ time stamped");
});

check("the panel still dates a read item by when it arrived", () => {
  const rows = db.prepare(INBOX).all(1, 30);
  const x = rows.find((r) => r.id === "post:x");
  eq(x.published_at, AT, "arrival, not the read moment");
  eq(x.read_at, new Date((NOW + 500) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), "read moment");
});

check("mark ALL read", () => {
  db.prepare(READ_ALL).run(1, NOW + 600);
  const row = db.prepare(`SELECT unread, seen FROM followers WHERE github_id=1`).get();
  eq(row.unread, "[]", "cleared");
  eq(JSON.parse(row.seen).length, 4, "all four in seen");
  eq(db.prepare(META).get(1).unread, 0, "badge is zero");
});

check("mark ALL read on an empty inbox writes nothing", () => {
  eq(changes(db.prepare(READ_ALL).run(1, NOW + 700)), 0, "no row written");
});

// ─── retention sweep ─────────────────────────────────────────
console.log("\n── retention sweep ──");
const PRUNE = `UPDATE followers
            SET unread = (SELECT COALESCE(json_group_array(json(j.value)), '[]')
                            FROM json_each(followers.unread) j
                           WHERE j.value->>1 >= ?1),
                seen   = (SELECT COALESCE(json_group_array(json(j.value)), '[]')
                            FROM json_each(followers.seen) j
                           WHERE j.value->>2 >= ?2)
          WHERE EXISTS (SELECT 1 FROM json_each(followers.unread) j WHERE j.value->>1 < ?1)
             OR EXISTS (SELECT 1 FROM json_each(followers.seen)   j WHERE j.value->>2 < ?2)`;

check("sweep writes ONLY the rows that actually lost an entry", () => {
  // bob: one ancient unread, one fresh unread, one ancient read.
  db.prepare(`UPDATE followers SET unread=?2, seen=?3 WHERE github_id=?1`).run(
    2,
    JSON.stringify([["post:old", NOW - 40 * 86400], ["post:y", NOW]]),
    JSON.stringify([["post:seen-old", NOW - 30 * 86400, NOW - 20 * 86400]])
  );
  const aliceBefore = db.prepare(`SELECT seen FROM followers WHERE github_id=2`).get();
  const carolBefore = db.prepare(`SELECT unread FROM followers WHERE github_id=3`).get().unread;

  const r = db.prepare(PRUNE).run(NOW - 30 * 86400, NOW - 14 * 86400);
  eq(changes(r), 1, "rows written — only bob");

  const bob = db.prepare(`SELECT unread, seen FROM followers WHERE github_id=2`).get();
  eq(JSON.parse(bob.unread).length, 1, "the ancient unread is gone");
  eq(JSON.parse(bob.unread)[0][0], "post:y", "the fresh one survived");
  eq(bob.seen, "[]", "empty array, never NULL");
  eq(
    db.prepare(`SELECT unread FROM followers WHERE github_id=3`).get().unread,
    carolBefore,
    "carol untouched byte-for-byte"
  );
  return "4 rows scanned, 1 written";
});

check("sweep is a no-op when nothing has expired", () => {
  eq(changes(db.prepare(PRUNE).run(NOW - 30 * 86400, NOW - 14 * 86400)), 0, "rows written");
});

check("notification sweep is a single indexed range", () => {
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN DELETE FROM notifications WHERE created_at < ?1`)
    .all()
    .map((r) => r.detail)
    .join(" | ");
  if (!/idx_notifications_recent/.test(plan)) throw new Error(`full scan: ${plan}`);
  return plan;
});

// ─── consumer ────────────────────────────────────────────────
console.log("\n── consumer ──");
check("dead-device DELETE binds a variable-length IN list", () => {
  const ids = db.prepare(`SELECT id FROM push_devices LIMIT 2`).all().map((r) => r.id);
  const list = ids.map((_, i) => `?${i + 1}`).join(", ");
  const r = db.prepare(`DELETE FROM push_devices WHERE id IN (${list})`).run(...ids);
  eq(changes(r), 2, "deleted");
});

check("device lookup uses the owner index, not a scan", () => {
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT d.id FROM push_devices d JOIN followers f ON f.github_id = d.github_id
        WHERE (f.muted_until IS NULL OR f.muted_until < ?1)`
    )
    .all()
    .map((r) => r.detail)
    .join(" | ");
  if (!/idx_devices_owner|USING INDEX/.test(plan)) throw new Error(`no index: ${plan}`);
  return plan;
});

// ─── message size ────────────────────────────────────────────
console.log("\n── queue message ──");
check("a full 25-device message stays inside one 64 KB billing chunk", () => {
  const device = [
    12345,
    "https://fcm.googleapis.com/fcm/send/" + "e".repeat(152),
    "B" + "k".repeat(86),
    "a".repeat(22),
  ];
  const message = {
    n: {
      id: "post:2026/08/28/some-reasonably-long-post-slug",
      title: "A".repeat(120),
      body: "B".repeat(200),
      url: "https://blog.jason-yang.top/2026/08/28/some-reasonably-long-post-slug/",
      image: "https://blog.jason-yang.top/images/cover-img/something.png",
      tag: "posts",
      silent: false,
      type: "post",
    },
    d: Array.from({ length: 25 }, () => device),
    t: 0,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(message)).length;
  if (bytes > 64 * 1024) throw new Error(`${bytes} bytes — would bill as two operations`);
  if (bytes > 128 * 1024) throw new Error(`${bytes} bytes — over the message ceiling`);
  return `${(bytes / 1024).toFixed(1)} KB of a 64 KB chunk, 128 KB ceiling`;
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
