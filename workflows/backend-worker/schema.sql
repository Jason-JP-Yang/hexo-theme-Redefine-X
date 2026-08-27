-- Redefine-X backend Worker — D1 schema
-- Run: wrangler d1 execute instant-notes-db --remote --file=./schema.sql
--
-- Idempotent: every statement is CREATE … IF NOT EXISTS (or DROP … IF EXISTS), so
-- re-running it over a live database adds the notification tables without
-- touching existing notes.

-- ════════════════════════════════════════════════════════════
-- Instant Notes
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT    NOT NULL CHECK(length(text) <= 200),
  emoji      TEXT    DEFAULT '',
  color      TEXT    DEFAULT 'default',
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Index for fast recent-notes query
CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);

-- ════════════════════════════════════════════════════════════
-- Notifications
-- ════════════════════════════════════════════════════════════

-- Who follows the blog. One row per GitHub identity, created the first time a
-- reader follows. `topics` is a comma-separated allowlist; empty means "all".
CREATE TABLE IF NOT EXISTS followers (
  github_id   INTEGER PRIMARY KEY,
  login       TEXT    NOT NULL,
  avatar      TEXT    DEFAULT '',
  topics      TEXT    NOT NULL DEFAULT '',
  muted_until TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Push subscriptions. Several devices may hang off one follower; the endpoint is
-- the natural key, so re-subscribing the same browser updates rather than
-- duplicates.
CREATE TABLE IF NOT EXISTS push_devices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id  INTEGER NOT NULL,
  endpoint   TEXT    NOT NULL UNIQUE,
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  ua         TEXT    DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_ok_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_push_devices_github ON push_devices(github_id);

-- The notification itself, independent of who receives it. `id` is a stable
-- dedupe key supplied by the source (e.g. "post:2026/08/22/Some-Title"), which
-- is what makes ingest idempotent across webhook retries and manual re-runs.
CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT    PRIMARY KEY,
  type          TEXT    NOT NULL DEFAULT 'post',
  topic         TEXT    NOT NULL DEFAULT 'posts',
  title         TEXT    NOT NULL,
  body          TEXT    DEFAULT '',
  url           TEXT    NOT NULL,
  image         TEXT    DEFAULT '',
  tag           TEXT    DEFAULT '',
  audience_json TEXT    NOT NULL DEFAULT '{"kind":"topic"}',
  silent        INTEGER NOT NULL DEFAULT 0,
  source        TEXT    NOT NULL DEFAULT 'changelog',
  published_at  TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_published ON notifications(published_at DESC);

-- The in-site inbox: one row per (notification, follower). Written even when the
-- follower has no push device, which is what lets the bell work for a reader who
-- declined the OS permission.
CREATE TABLE IF NOT EXISTS deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id TEXT    NOT NULL,
  github_id       INTEGER NOT NULL,
  read_at         TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(notification_id, github_id)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_user ON deliveries(github_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_unread ON deliveries(github_id, read_at);

-- The push queue: one row per (notification, device). Ingest drains the first
-- bounded batch itself and the cron carries the rest, so a fan-out of any size
-- stays inside the per-invocation CPU and subrequest ceilings.
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id TEXT    NOT NULL,
  device_id       INTEGER NOT NULL,
  state           TEXT    NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  not_before      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_error      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at      TEXT,
  UNIQUE(notification_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_outbox_drain ON outbox(state, not_before);

-- ════════════════════════════════════════════════════════════
-- Removed
-- ════════════════════════════════════════════════════════════

-- `settings` held three keys — dry_run, bootstrap_at, last_push_sha — and all
-- three are gone.
--
-- The first two existed to stop a fresh database from announcing the entire back
-- catalogue at once, which was a real hazard only while changelog.json listed
-- every recent post. It now lists what a deployment ADDED, so there is nothing
-- to guard against and no state to keep. The third was never read by anything
-- but a diagnostic.
DROP TABLE IF EXISTS settings;
