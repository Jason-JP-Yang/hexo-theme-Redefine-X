-- Instant Notes D1 Schema
-- Run: wrangler d1 execute instant-notes-db --file=./schema.sql

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
