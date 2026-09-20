-- Fine-grained collaborator permissions.
--
-- Three facts move into `vault_posts`, which already holds one row per editable
-- item and is therefore the only table that can answer "may this person touch
-- this thing" with a primary-key probe:
--
--   kind     post | album | page. The editor needs to know what a row IS before
--            it can open the right blob for it, and the reader-facing grant
--            query must not hand a page key to somebody asking for articles.
--   enc      1 when the item itself is encrypted on the published site. Every
--            post now has a row here — that is what lets the editor read the
--            source without a repository token — so this is what separates
--            "sealed for readers" from "sealed only so the editor can open it".
--            The reader-facing /api/vault/keys filters on it.
--   editors  comma-separated GitHub ids that may WRITE this item. Kept here
--            rather than on `moderation` because a write check is per-item and
--            a read check is per-person: `moderation.vault` already answers the
--            second one, and inverting either would cost a scan.
--
-- No index on `editors`. Every question asked of it is either a primary-key
-- probe or the editor's one full scan of a table with a row per post, and an
-- index would be a second row written per save in the scarce direction.
ALTER TABLE vault_posts ADD COLUMN kind    TEXT    NOT NULL DEFAULT 'post';
ALTER TABLE vault_posts ADD COLUMN enc     INTEGER NOT NULL DEFAULT 1;
ALTER TABLE vault_posts ADD COLUMN editors TEXT    NOT NULL DEFAULT '';

-- Which parts of Blog Management this identity may see, and whether they may
-- act there. One compact string rather than a row per panel: it is read on
-- every console request and written only when an admin changes it.
--
--   "a:r,n:rw,f:r"   analytics read, notifications read+write, followers read
--
-- Absent or empty means denied everywhere. Posts Management is not in here at
-- all — a collaborator always has it, scoped to the items they may open, and a
-- grade that cannot be set is not configuration.
ALTER TABLE moderation ADD COLUMN panels TEXT NOT NULL DEFAULT '';
