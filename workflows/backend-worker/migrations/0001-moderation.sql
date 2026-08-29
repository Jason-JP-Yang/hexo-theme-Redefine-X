-- 0001 — admin moderation (mute / ban / global blocklists) + follower name.
--
-- Brings a LIVE database up to the shape schema.sql now describes, without the
-- DROPs that file carries. Run once:
--   wrangler d1 execute instant-notes-db --remote --file=./migrations/0001-moderation.sql

ALTER TABLE followers    ADD COLUMN name  TEXT NOT NULL DEFAULT '';
ALTER TABLE push_devices ADD COLUMN state TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS moderation (
  github_id  INTEGER PRIMARY KEY,
  login      TEXT    NOT NULL DEFAULT '',
  state      TEXT    NOT NULL DEFAULT '',
  blocked    TEXT    NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
