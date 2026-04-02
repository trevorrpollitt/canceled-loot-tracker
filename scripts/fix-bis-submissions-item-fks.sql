-- Remove FK constraints from bis_submissions.true_bis_item_id and raid_bis_item_id.
-- These columns store Blizzard item ID strings supplied by the client; they do not
-- reference the internal item_db integer PK and must not have a FK constraint.
--
-- SQLite does not support DROP CONSTRAINT, so we rebuild the table.

PRAGMA foreign_keys = OFF;

-- 1. Rename existing table
ALTER TABLE bis_submissions RENAME TO bis_submissions_old;

-- 2. Drop old indexes
DROP INDEX IF EXISTS idx_bis_submissions_upsert;
DROP INDEX IF EXISTS idx_bis_team_char_status;

-- 3. Recreate without item FK constraints
CREATE TABLE bis_submissions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id          INTEGER NOT NULL REFERENCES teams(id),
  char_id          INTEGER REFERENCES roster(id),
  char_name        TEXT    NOT NULL DEFAULT '',
  spec             TEXT    NOT NULL,
  slot             TEXT    NOT NULL,
  true_bis         TEXT    NOT NULL DEFAULT '',
  raid_bis         TEXT    NOT NULL DEFAULT '',
  rationale        TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT 'Pending',
  submitted_at     TEXT    NOT NULL DEFAULT '',
  reviewed_by      TEXT    NOT NULL DEFAULT '',
  officer_note     TEXT    NOT NULL DEFAULT '',
  true_bis_item_id TEXT    DEFAULT NULL,
  raid_bis_item_id TEXT    DEFAULT NULL
);

CREATE UNIQUE INDEX idx_bis_submissions_upsert ON bis_submissions(team_id, char_id, slot);
CREATE INDEX        idx_bis_team_char_status  ON bis_submissions(team_id, char_id, status);

-- 4. Copy data
INSERT INTO bis_submissions
  SELECT id, team_id, char_id, char_name, spec, slot, true_bis, raid_bis,
         rationale, status, submitted_at, reviewed_by, officer_note,
         true_bis_item_id, raid_bis_item_id
  FROM bis_submissions_old;

-- 5. Drop old table
DROP TABLE bis_submissions_old;

PRAGMA foreign_keys = ON;
