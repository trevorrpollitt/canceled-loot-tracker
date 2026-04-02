-- Create default_bis_overrides table and migrate existing sentinel rows from bis_submissions

CREATE TABLE IF NOT EXISTS default_bis_overrides (
  spec             TEXT NOT NULL,
  slot             TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT '',
  true_bis         TEXT NOT NULL DEFAULT '',
  true_bis_item_id TEXT         DEFAULT NULL,
  raid_bis         TEXT NOT NULL DEFAULT '',
  raid_bis_item_id TEXT         DEFAULT NULL,
  PRIMARY KEY (spec, slot, source)
);

-- Migrate any existing sentinel rows (char_id=0) from bis_submissions.
-- The old sentinel approach had no source column, so source defaults to ''.
INSERT OR IGNORE INTO default_bis_overrides (spec, slot, source, true_bis, true_bis_item_id, raid_bis, raid_bis_item_id)
  SELECT spec, slot, '', true_bis, true_bis_item_id, raid_bis, raid_bis_item_id
  FROM bis_submissions
  WHERE char_id = 0 AND status = 'Approved' AND spec != '';
