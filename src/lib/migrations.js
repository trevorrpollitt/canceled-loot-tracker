/**
 * migrations.js — In-process D1 migration registry.
 *
 * Each entry has:
 *   name        Filename-style identifier — used as the primary key in schema_migrations.
 *   description Human-readable summary shown in the admin UI.
 *   check       Async (db) → boolean — returns true if the migration has already been
 *               applied (either via this runner or via a manual `wrangler d1 execute`).
 *               Allows safely running the migration button on databases that were set up
 *               from schema.sql directly, without getting spurious errors.
 *   sql         The SQL to run when not already applied.  Passed to db.exec() which
 *               handles multi-statement strings.  Do NOT include leading/trailing
 *               whitespace-only lines — some D1 versions choke on them.
 *
 * Append new entries to the END of the array.  Never reorder or delete entries —
 * the check function is the source of truth for "already applied", and the name
 * is recorded permanently in schema_migrations once applied.
 */

export const MIGRATIONS = [
  {
    name: '0001_fix_bis_item_id_columns',
    description: 'Change bis_submissions item ID columns from INTEGER FK to TEXT (Blizzard IDs)',
    check: async (db) => {
      // Applied if true_bis_item_id is TEXT rather than INTEGER
      const row = await db.prepare(
        "SELECT type FROM pragma_table_info('bis_submissions') WHERE name = 'true_bis_item_id'"
      ).first();
      return row?.type?.toUpperCase() === 'TEXT';
    },
    sql: `
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
`.trim(),
  },

  {
    name: '0002_loot_summary',
    description: 'Create loot_summary materialized aggregate table',
    check: async (db) => {
      const row = await db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'loot_summary'"
      ).first();
      return !!row;
    },
    sql: `
CREATE TABLE IF NOT EXISTS loot_summary (
  team_id       INTEGER NOT NULL REFERENCES teams(id),
  char_id       INTEGER NOT NULL REFERENCES roster(id),
  owner_id      TEXT    NOT NULL DEFAULT '',
  bis_mythic    INTEGER NOT NULL DEFAULT 0,
  bis_heroic    INTEGER NOT NULL DEFAULT 0,
  bis_normal    INTEGER NOT NULL DEFAULT 0,
  nonbis_mythic INTEGER NOT NULL DEFAULT 0,
  nonbis_heroic INTEGER NOT NULL DEFAULT 0,
  nonbis_normal INTEGER NOT NULL DEFAULT 0,
  tertiary      INTEGER NOT NULL DEFAULT 0,
  offspec       INTEGER NOT NULL DEFAULT 0,
  last_updated  TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (team_id, char_id)
);
CREATE INDEX IF NOT EXISTS idx_loot_summary_owner ON loot_summary(team_id, owner_id);
`.trim(),
  },

  {
    name: '0003_attendance_adjustment',
    description: 'Add attendance_adjustment column to roster for manual corrections',
    check: async (db) => {
      const row = await db.prepare(
        "SELECT 1 FROM pragma_table_info('roster') WHERE name = 'attendance_adjustment'"
      ).first();
      return !!row;
    },
    sql: `ALTER TABLE roster ADD COLUMN attendance_adjustment INTEGER NOT NULL DEFAULT 0`,
  },
];
