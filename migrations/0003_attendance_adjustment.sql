-- Manual attendance adjustment per character.
-- Stored on every roster row; when updated via the API the value is written to
-- ALL characters sharing the same (team_id, owner_id) so that loot-history
-- attendance counts are consistent across a player's alts.
-- Can be positive (player attended more than WCL recorded) or negative.

ALTER TABLE roster ADD COLUMN attendance_adjustment INTEGER NOT NULL DEFAULT 0;
