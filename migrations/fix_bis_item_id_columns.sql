-- Migrate bis_submissions: change true_bis_item_id and raid_bis_item_id from
-- INTEGER FK to TEXT so they can store Blizzard item IDs directly.

ALTER TABLE bis_submissions RENAME TO bis_submissions_old;

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

INSERT INTO bis_submissions SELECT * FROM bis_submissions_old;

CREATE UNIQUE INDEX idx_bis_submissions_upsert ON bis_submissions(team_id, char_id, slot);
CREATE INDEX        idx_bis_team_char_status   ON bis_submissions(team_id, char_id, status);

DROP TABLE bis_submissions_old;
