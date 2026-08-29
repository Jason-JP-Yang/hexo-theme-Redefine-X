-- Redefine-X backend Worker — D1 schema
-- Run: wrangler d1 execute instant-notes-db --remote --file=./schema.sql
--
-- `notes` is created only if missing and is never dropped — it holds real data.
-- The notification tables ARE dropped and rebuilt: the subsystem is still in
-- development, and its rows are all reconstructible (a reader re-follows, a
-- browser re-subscribes, a deployment re-announces).
--
-- ════════════════════════════════════════════════════════════
-- What this schema is shaped by
-- ════════════════════════════════════════════════════════════
--
-- D1 bills ROWS, not statements, and the two directions are wildly asymmetric on
-- the free plan: 5,000,000 rows read a day against 100,000 rows written. So the
-- design pressure is entirely on writes — and writes are charged per row AND per
-- index touched:
--
--   "Indexes will add an additional written row when writes include the indexed
--    column: one to the table itself, and one to the index."
--
-- A (notification × recipient) table is therefore the most expensive object this
-- schema could contain, because a single broadcast writes one row per reader
-- times one row per index. Two of them used to exist. Both are gone: the inbox
-- now lives in two JSON columns on the follower's own row, so a broadcast costs
-- exactly one un-indexed row write per reader, and the push queue lives in
-- Cloudflare Queues, which costs D1 nothing at all.
--
-- Extra COLUMNS, by contrast, are free — a row is billed the same "regardless of
-- the size of each row" — so nothing here is trimmed for width. What was removed
-- from `push_devices` was removed because it forced a WRITE on every successful
-- push, not because it took up space.
--
-- Timestamps are INTEGER unix epoch throughout the notification tables: the
-- retention sweep compares them numerically instead of lexically, and inserting
-- one costs no strftime() call.

-- ════════════════════════════════════════════════════════════
-- Instant Notes  (untouched — real data lives here)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT    NOT NULL CHECK(length(text) <= 200),
  emoji      TEXT    DEFAULT '',
  color      TEXT    DEFAULT 'default',
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);

-- ════════════════════════════════════════════════════════════
-- Notifications  (rebuilt)
-- ════════════════════════════════════════════════════════════

-- This file REBUILDS. A database that already has followers and live push
-- subscriptions is brought forward with the numbered files in migrations/
-- instead — running this against it would delete data no reader can recreate.
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS deliveries;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS push_devices;
DROP TABLE IF EXISTS followers;
DROP TABLE IF EXISTS moderation;
DROP TABLE IF EXISTS settings;

-- One row per GitHub identity, created the first time a reader follows.
--
-- This row is ALSO the reader's inbox. `unread` and `seen` are JSON arrays of
-- two-element entries:
--
--   unread : [["post:2026/08/28/x", 1756339200], ...]        id, delivered
--   seen   : [["note:41", 1756339200, 1756341000], ...]      id, delivered, read
--
-- Two columns rather than one flagged list, because the hottest read in the
-- whole system is the bell badge — and `json_array_length(unread)` answers it
-- from a single primary-key row with no json_each and no join.
--
-- A read entry carries BOTH timestamps because the two are needed for different
-- things: the panel dates an item by when it arrived, while retention expires it
-- by when it was read (30 days unread, 14 days after reading). Collapsing them
-- would make a week-old notification claim to be new the moment it was opened.
-- See pruneInboxes() in src/notify.js.
--
-- Deliberately carries NO secondary index. Every index here would be a second
-- row written per recipient per broadcast, and nothing queries followers by
-- anything but the primary key or a full scan that has to happen anyway.
-- `name` is the GitHub display name, carried in the session token and stored on
-- upsert. `avatar` is NOT stored: it is derivable from the id
-- (avatars.githubusercontent.com/u/<id>), so holding a copy would only let it
-- go stale.
CREATE TABLE followers (
  github_id   INTEGER PRIMARY KEY,
  login       TEXT    NOT NULL,
  name        TEXT    NOT NULL DEFAULT '',
  avatar      TEXT    NOT NULL DEFAULT '',
  topics      TEXT    NOT NULL DEFAULT '',     -- comma-separated; '' means all
  muted_until INTEGER,                         -- unix epoch, NULL when not muted
  unread      TEXT    NOT NULL DEFAULT '[]',
  seen        TEXT    NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Push subscriptions. Several devices may hang off one follower.
--
-- `endpoint` is UNIQUE and that constraint is load-bearing, not decoration: it
-- makes re-subscribing the same browser an update rather than a duplicate row,
-- and it makes it structurally impossible for one browser to end up registered
-- under two GitHub accounts and receive everything twice. It is the reason this
-- is a table and not a third JSON column on `followers`.
--
-- `last_ok_at` and `fail_count` are gone. They were the only reason a SUCCESSFUL
-- push had to write to D1 at all — one row per device per notification, in the
-- scarce direction, to record something nothing depended on. A subscription that
-- is really finished says so with a 404 or a 410, which is authoritative and
-- immediate; the consumer deletes on that instead of counting up to a threshold.
-- `device` is the one fact about a subscription its User-Agent cannot carry: a
-- laptop and a desktop send byte-identical strings, and only the machine itself
-- knows which it is. The subscribing browser works it out once and sends it; the
-- management panel renders browser and OS from `ua` and the machine class from
-- here. Empty means the client declined to guess, which the panel shows as
-- "Unknown" rather than picking one.
--
-- `state` is admin moderation of ONE subscription: '' | 'muted' | 'banned'.
-- Both stop the fan-out from selecting the row; only 'banned' is shown to its
-- owner, and only 'banned' survives an unfollow — otherwise leaving and
-- re-following would shed the ban with one click. See migrations/.
--
-- Existing databases take these as migrations rather than a rebuild — this table
-- holds live subscriptions that cannot be recreated without every reader
-- re-granting permission.
CREATE TABLE push_devices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id  INTEGER NOT NULL,
  endpoint   TEXT    NOT NULL UNIQUE,
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  ua         TEXT    NOT NULL DEFAULT '',
  device     TEXT    NOT NULL DEFAULT '',
  state      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- The one secondary index that pays for itself: fan-out looks devices up by
-- owner, and without it that read is a full scan of every device on every
-- broadcast. It costs one extra row written per SUBSCRIBE, which happens once
-- per browser rather than once per notification.
CREATE INDEX idx_devices_owner ON push_devices(github_id);

-- The notification itself, independent of who receives it. `id` is a stable
-- dedupe key supplied by the source (e.g. "post:2026/08/22/Some-Title"), which
-- is what makes ingest idempotent across webhook retries and manual re-runs.
--
-- `recipients` is filled from the fan-out UPDATE's own `changes` count — the
-- number is a by-product of a write that had to happen anyway, so the admin
-- history costs no aggregate query over a join table that no longer exists.
CREATE TABLE notifications (
  id            TEXT    PRIMARY KEY,
  type          TEXT    NOT NULL DEFAULT 'post',
  topic         TEXT    NOT NULL DEFAULT 'posts',
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL DEFAULT '',
  url           TEXT    NOT NULL,
  image         TEXT    NOT NULL DEFAULT '',
  tag           TEXT    NOT NULL DEFAULT '',
  audience_json TEXT    NOT NULL DEFAULT '{"kind":"topic"}',
  silent        INTEGER NOT NULL DEFAULT 0,
  source        TEXT    NOT NULL DEFAULT 'changelog',
  recipients    INTEGER NOT NULL DEFAULT 0,
  devices       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_notifications_recent ON notifications(created_at DESC);

-- ════════════════════════════════════════════════════════════
-- Moderation
-- ════════════════════════════════════════════════════════════

-- Everything an admin decides ABOUT a reader, kept apart from the reader's own
-- row so that unfollowing — which deletes that row and is the reader's own
-- privacy switch — cannot also clear a ban.
--
--   state    '' | 'muted' | 'banned'. Both stop delivery; only 'banned' is
--            visible to the reader and blocks their writes.
--   blocked  comma-separated TOPICS this reader is excluded from
--            (posts, notes, announcements) — the global per-type blocklists.
--   login    kept so the admin list can name someone who has since unfollowed.
--
-- A row exists only for a moderated identity, so this table stays in the tens of
-- rows and the fan-out's NOT EXISTS against it is a primary-key probe.
CREATE TABLE moderation (
  github_id  INTEGER PRIMARY KEY,
  login      TEXT    NOT NULL DEFAULT '',
  state      TEXT    NOT NULL DEFAULT '',
  blocked    TEXT    NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
