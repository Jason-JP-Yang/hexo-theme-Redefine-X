-- Encrypted posts.
--
-- One row per post, holding the WRAPPED key and nothing else. No title, no
-- date, no body, no image: a full dump of this database tells you how many
-- encrypted posts exist and who may read them, never what any of them says.
-- The unwrapping key is VAULT_MASTER, a Worker secret that is never in D1.
--
-- No secondary index, for the same reason `followers` has none: every read here
-- is a primary-key probe or an admin page, and an index would be a second row
-- written per registration to serve neither.
CREATE TABLE IF NOT EXISTS vault_posts (
  id         TEXT    PRIMARY KEY,
  slug       TEXT    NOT NULL,
  wrapped    TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Who may open which posts, as a comma-separated list of post ids.
--
-- It goes on `moderation` rather than on `followers` because unfollowing
-- DELETES the follower row: a grant kept there would be revoked by the reader's
-- own privacy switch and silently re-lock their posts. `moderation` is already
-- the table for what an admin decided ABOUT an identity, and it already
-- survives an unfollow for exactly this reason.
ALTER TABLE moderation ADD COLUMN vault TEXT NOT NULL DEFAULT '';
