-- ─────────────────────────────────────────────────────────────────────────────
-- Canceled Loot Tracker — D1 Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Guild-wide tables (master sheet equivalents) ──────────────────────────────

CREATE TABLE teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE global_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Raid and M+ item database, seeded via /admin → Sync Loot Tables
CREATE TABLE item_db (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       TEXT    NOT NULL UNIQUE,  -- Blizzard item ID
  name          TEXT    NOT NULL,
  slot          TEXT    NOT NULL,
  source_type   TEXT    NOT NULL,  -- Raid | Mythic+
  source_name   TEXT    NOT NULL,
  instance      TEXT    NOT NULL,
  difficulty    TEXT    NOT NULL,
  armor_type    TEXT    NOT NULL,  -- Cloth | Leather | Mail | Plate | Accessory | Tier Token
  is_tier_token INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_item_db_slot     ON item_db(slot);
CREATE INDEX idx_item_db_instance ON item_db(source_type, instance);

-- Spec BIS defaults, seeded via /admin
CREATE TABLE default_bis (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  spec             TEXT    NOT NULL,
  slot             TEXT    NOT NULL,
  true_bis         TEXT    NOT NULL DEFAULT '',
  true_bis_item_id INTEGER REFERENCES item_db(id),
  raid_bis         TEXT    NOT NULL DEFAULT '',
  raid_bis_item_id INTEGER REFERENCES item_db(id),
  source           TEXT    NOT NULL DEFAULT '',  -- Icy Veins | Wowhead | Maxroll | Class Discord | Manual
  UNIQUE (spec, slot, source)
);

CREATE INDEX idx_default_bis_spec ON default_bis(spec);

-- Per-spec preferred BIS source override
CREATE TABLE spec_bis_config (
  spec   TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT ''
);

-- Current season tier piece item IDs, seeded via /admin → Sync Tier Items
CREATE TABLE tier_items (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  class   TEXT    NOT NULL,
  slot    TEXT    NOT NULL,
  item_id TEXT    NOT NULL,
  UNIQUE (class, slot)
);

-- Cross-team transfer audit log
CREATE TABLE transfers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  char_name TEXT    NOT NULL,
  from_team INTEGER NOT NULL REFERENCES teams(id),
  to_team   INTEGER NOT NULL REFERENCES teams(id),
  date      TEXT    NOT NULL,
  reason    TEXT    NOT NULL DEFAULT ''
);

-- ── Team-scoped tables ────────────────────────────────────────────────────────

-- Team-specific config key/value pairs (officer_role_id, raid_days, wcl_guild_id, etc.)
CREATE TABLE team_config (
  team_id INTEGER NOT NULL REFERENCES teams(id),
  key     TEXT    NOT NULL,
  value   TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (team_id, key)
);

-- Characters and their owners
-- Rename via UPDATE on char_name only — all foreign keys reference id (integer), not name
-- legacy_char_id: the UUID from Google Sheets, used during migration only; NULL for new characters
CREATE TABLE roster (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id         INTEGER NOT NULL REFERENCES teams(id),
  char_name       TEXT    NOT NULL,
  legacy_char_id  TEXT    UNIQUE,
  class      TEXT    NOT NULL,
  spec       TEXT    NOT NULL,
  role       TEXT    NOT NULL,  -- auto-derived from spec, never written directly
  status     TEXT    NOT NULL DEFAULT 'Active',  -- Active | Bench | Inactive
  owner_id   TEXT    NOT NULL DEFAULT '',        -- Discord user ID (snowflake)
  owner_nick          TEXT    NOT NULL DEFAULT '',
  server              TEXT    NOT NULL DEFAULT '',  -- only set when name conflicts exist
  secondary_specs     TEXT    NOT NULL DEFAULT '',  -- pipe-separated spec names
  pending_primary_spec TEXT   NOT NULL DEFAULT ''   -- spec awaiting officer approval
);

CREATE UNIQUE INDEX idx_roster_name_server ON roster(team_id, char_name, server);
CREATE INDEX        idx_roster_team_status ON roster(team_id, status);
CREATE INDEX        idx_roster_team_owner  ON roster(team_id, owner_id);

-- All loot awarded to a team
-- recipient_char_id is the FK to roster; recipient_name is stored for display/fallback
-- (unresolved "no roster match" entries have NULL recipient_char_id)
CREATE TABLE loot_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id           INTEGER NOT NULL REFERENCES teams(id),
  date              TEXT    NOT NULL,
  boss              TEXT    NOT NULL,
  item_name         TEXT    NOT NULL,
  difficulty        TEXT    NOT NULL DEFAULT '',  -- Normal | Heroic | Mythic
  recipient_id      TEXT    NOT NULL DEFAULT '',  -- Discord user ID
  recipient_name    TEXT    NOT NULL DEFAULT '',  -- raw character name from import
  recipient_char_id INTEGER REFERENCES roster(id),
  upgrade_type      TEXT    NOT NULL DEFAULT '',  -- BIS | Non-BIS | Tertiary
  notes             TEXT    NOT NULL DEFAULT '',
  ignored           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_loot_log_team_char ON loot_log(team_id, recipient_char_id);
CREATE INDEX idx_loot_log_team_date ON loot_log(team_id, date);

-- Player BIS submissions
CREATE TABLE bis_submissions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id          INTEGER NOT NULL REFERENCES teams(id),
  char_id          INTEGER REFERENCES roster(id),
  char_name        TEXT    NOT NULL DEFAULT '',  -- stored for display/fallback
  spec             TEXT    NOT NULL,
  slot             TEXT    NOT NULL,
  true_bis         TEXT    NOT NULL DEFAULT '',  -- item name or sentinel
  raid_bis         TEXT    NOT NULL DEFAULT '',
  rationale        TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT 'Pending',  -- Pending | Approved | Rejected
  submitted_at     TEXT    NOT NULL DEFAULT '',
  reviewed_by      TEXT    NOT NULL DEFAULT '',         -- officer Discord user ID
  officer_note     TEXT    NOT NULL DEFAULT '',
  true_bis_item_id TEXT    DEFAULT NULL,  -- Blizzard item ID string; no FK (client-supplied)
  raid_bis_item_id TEXT    DEFAULT NULL
);

CREATE UNIQUE INDEX idx_bis_submissions_upsert ON bis_submissions(team_id, char_id, slot);
CREATE INDEX        idx_bis_team_char_status  ON bis_submissions(team_id, char_id, status);

-- Raid sessions (one row per WCL report)
-- raid_id = WCL report code (e.g. "AbCdEf12") — natural key used for dedup
CREATE TABLE raids (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  raid_id    TEXT    NOT NULL,
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  date       TEXT    NOT NULL,
  instance   TEXT    NOT NULL,
  difficulty TEXT    NOT NULL,
  UNIQUE (raid_id, team_id)
);

CREATE INDEX idx_raids_team_date ON raids(team_id, date);

-- Raid attendance — normalised out of the pipe-separated AttendeeIds column
CREATE TABLE raid_attendees (
  raid_id INTEGER NOT NULL REFERENCES raids(id),
  user_id TEXT    NOT NULL,  -- Discord user ID
  PRIMARY KEY (raid_id, user_id)
);

CREATE INDEX idx_raid_attendees_user ON raid_attendees(user_id);

-- Per-boss results per WCL report
CREATE TABLE raid_encounters (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  raid_id      INTEGER NOT NULL REFERENCES raids(id),
  encounter_id INTEGER NOT NULL,
  boss_name    TEXT    NOT NULL,
  pulls        INTEGER NOT NULL DEFAULT 0,
  killed       INTEGER NOT NULL DEFAULT 0,
  best_pct     REAL    NOT NULL DEFAULT 0,
  UNIQUE (raid_id, encounter_id)
);

-- Current tier piece status per character — upserted on every WCL sync
-- tier_detail = pipe-separated slot:track pairs e.g. "Head:Mythic|Chest:Hero"
CREATE TABLE tier_snapshot (
  char_id     INTEGER NOT NULL REFERENCES roster(id),
  raid_id     INTEGER REFERENCES raids(id),
  tier_count  INTEGER NOT NULL DEFAULT 0,
  tier_detail TEXT    NOT NULL DEFAULT '',
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (char_id)
);

-- Highest upgrade track ever worn per character × slot × spec
CREATE TABLE worn_bis (
  char_id           INTEGER NOT NULL REFERENCES roster(id),
  slot              TEXT    NOT NULL,
  spec              TEXT    NOT NULL DEFAULT '',
  overall_bis_track TEXT    NOT NULL DEFAULT '',  -- Veteran | Champion | Hero | Mythic
  raid_bis_track    TEXT    NOT NULL DEFAULT '',
  other_track       TEXT    NOT NULL DEFAULT '',
  updated_at        TEXT    NOT NULL,
  PRIMARY KEY (char_id, slot, spec)
);

-- RCLC button → internal upgrade type mapping
CREATE TABLE rclc_response_map (
  team_id           INTEGER NOT NULL REFERENCES teams(id),
  rclc_button       TEXT    NOT NULL,
  internal_type     TEXT    NOT NULL,
  counted_in_totals INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (team_id, rclc_button)
);

-- Officer overrides for spec default BIS — keyed by spec × slot × source.
-- Replaces the old bis_submissions sentinel (char_id=0) approach, which could
-- not store per-spec overrides for the same slot due to the team/char/slot unique
-- constraint. This table has no FK dependencies and supports all specs independently.
CREATE TABLE default_bis_overrides (
  spec             TEXT NOT NULL,
  slot             TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT '',
  true_bis         TEXT NOT NULL DEFAULT '',
  true_bis_item_id TEXT         DEFAULT NULL,
  raid_bis         TEXT NOT NULL DEFAULT '',
  raid_bis_item_id TEXT         DEFAULT NULL,
  PRIMARY KEY (spec, slot, source)
);

-- ── Sentinel rows — satisfy FK constraints for any legacy bis_submissions rows ──
-- team_id=0 / char_id=0 rows are excluded from all normal queries via
-- WHERE id > 0 on teams and WHERE team_id = ? on roster.
INSERT OR IGNORE INTO teams  (id, name)                                                VALUES (0, '__default__');
INSERT OR IGNORE INTO roster (id, team_id, char_name, class, spec, role, owner_id, owner_nick) VALUES (0, 0, '__default__', '', '', '', '', '');
