/**
 * migrate-sheets-to-d1.js
 *
 * Reads all data from Google Sheets and generates a SQL file for D1 import.
 * Safe to run multiple times — drops and recreates all tables before inserting.
 *
 * Usage:
 *   node --env-file=.env scripts/migrate-sheets-to-d1.js
 *   npx wrangler d1 execute canceled-loot-tracker --local --file=migration-output.sql
 */

import { writeFileSync, readFileSync } from 'fs';
import { getTeamRegistry, getGlobalConfig, getItemDb, getDefaultBis,
         getDefaultBisOverrides, getSpecBisConfig, getTierItems, getRoster, getLootLog,
         getBisSubmissions, getRaids, getRaidEncounters, getTierSnapshot,
         getWornBis, getRclcResponseMap, getConfig } from '../src/lib/sheets.js';

// ── SQL helpers ───────────────────────────────────────────────────────────────

/** Escape a value as a SQL string literal. */
const s  = v => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;

/** Emit an integer or NULL. */
const n  = v => (v == null || v === '') ? 'NULL' : Number(v);

/** Emit 1/0 for a boolean. */
const b  = v => (v === true || String(v).toUpperCase() === 'TRUE') ? 1 : 0;

/** Subquery: resolve roster integer PK from legacy UUID (preferred) or name+server fallback. */
const rosterRef = (teamId, charId, charName, server = '') =>
  charId
    ? `(SELECT id FROM roster WHERE legacy_char_id=${s(charId)})`
    : `(SELECT id FROM roster WHERE team_id=${teamId} AND char_name=${s(charName)} AND server=${s(server)})`;

/** Subquery: resolve raids integer PK from (raid_id, team_id). */
const raidRef = (raidId, teamId) =>
  `(SELECT id FROM raids WHERE raid_id=${s(raidId)} AND team_id=${teamId})`;

/** Subquery: resolve item_db integer PK from Blizzard item_id string. */
const itemRef = id =>
  id ? `(SELECT id FROM item_db WHERE item_id=${s(id)})` : 'NULL';

// ── Main ──────────────────────────────────────────────────────────────────────

const lines = [];
const emit  = sql => lines.push(sql);

console.log('Reading from Google Sheets…');

process.stdout.write('  teams…');
const teams = await getTeamRegistry();
console.log(` ${teams.length}`);

process.stdout.write('  global config…');
const globalCfg = await getGlobalConfig();
console.log(' done');

process.stdout.write('  item DB…');
const itemDbRaw = await getItemDb();
const itemDb    = [];
{ const seen = new Set();
  for (const item of itemDbRaw) {
    if (seen.has(item.itemId)) { console.warn(`  WARN item_db: duplicate item_id ${item.itemId} ("${item.name}") — skipping`); }
    else { seen.add(item.itemId); itemDb.push(item); }
  }
}
console.log(` ${itemDb.length} items`);

process.stdout.write('  default BIS…');
const defaultBisRaw = await getDefaultBis();
const defaultBis    = [];
{ const seen = new Set();
  for (const row of defaultBisRaw) {
    const key = `${row.spec}|${row.slot}|${row.source}`;
    if (seen.has(key)) { console.warn(`  WARN default_bis: duplicate (${row.spec}, ${row.slot}, ${row.source}) — skipping`); }
    else { seen.add(key); defaultBis.push(row); }
  }
}
console.log(` ${defaultBis.length} rows`);

process.stdout.write('  default BIS overrides…');
const bisOverrides = await getDefaultBisOverrides();
console.log(` ${bisOverrides.length} rows`);

process.stdout.write('  spec BIS config…');
const specBisCfg = await getSpecBisConfig();
console.log(` ${specBisCfg.size} rows`);

process.stdout.write('  tier items…');
const tierItems = await getTierItems();
console.log(` ${tierItems.length} rows`);

// ── Drop and recreate all tables ─────────────────────────────────────────────

emit('BEGIN TRANSACTION;');
emit('');
emit('-- ── Drop & recreate ────────────────────────────────────────────────────────────');
for (const tbl of [
  'worn_bis', 'tier_snapshot', 'raid_encounters', 'raid_attendees', 'raids',
  'bis_submissions', 'loot_log', 'rclc_response_map', 'roster', 'team_config',
  'transfers', 'tier_items', 'spec_bis_config', 'default_bis_overrides', 'default_bis',
  'item_db', 'global_config', 'teams',
]) {
  emit(`DROP TABLE IF EXISTS ${tbl};`);
}
emit('');
emit(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));

// ── Guild-wide data ───────────────────────────────────────────────────────────

emit('');
emit('-- ── Teams ─────────────────────────────────────────────────────────────────────');
for (const t of teams) {
  emit(`INSERT INTO teams (name) VALUES (${s(t.name)});`);
}

emit('');
emit('-- ── Global Config ──────────────────────────────────────────────────────────────');
for (const [key, value] of Object.entries(globalCfg)) {
  emit(`INSERT INTO global_config (key, value) VALUES (${s(key)}, ${s(value)});`);
}

emit('');
emit('-- ── Item DB ─────────────────────────────────────────────────────────────────────');
for (const item of itemDb) {
  emit(`INSERT INTO item_db (item_id, name, slot, source_type, source_name, instance, difficulty, armor_type, is_tier_token) VALUES (${[
    s(item.itemId), s(item.name), s(item.slot), s(item.sourceType),
    s(item.sourceName), s(item.instance), s(item.difficulty),
    s(item.armorType), b(item.isTierToken),
  ].join(', ')});`);
}

emit('');
emit('-- ── Default BIS ─────────────────────────────────────────────────────────────────');
for (const row of defaultBis) {
  emit(`INSERT INTO default_bis (spec, slot, true_bis, true_bis_item_id, raid_bis, raid_bis_item_id, source) VALUES (${[
    s(row.spec), s(row.slot), s(row.trueBis),
    itemRef(row.trueBisItemId),
    s(row.raidBis),
    itemRef(row.raidBisItemId),
    s(row.source),
  ].join(', ')});`);
}

emit('');
emit('-- ── Default BIS Overrides ───────────────────────────────────────────────────────');
for (const row of bisOverrides) {
  emit(`INSERT INTO default_bis_overrides (spec, slot, source, true_bis, true_bis_item_id, raid_bis, raid_bis_item_id) VALUES (${[
    s(row.spec), s(row.slot), s(row.source ?? ''),
    s(row.trueBis ?? ''),
    itemRef(row.trueBisItemId),
    s(row.raidBis ?? ''),
    itemRef(row.raidBisItemId),
  ].join(', ')});`);
}

emit('');
emit('-- ── Spec BIS Config ─────────────────────────────────────────────────────────────');
for (const [spec, source] of specBisCfg) {
  emit(`INSERT INTO spec_bis_config (spec, source) VALUES (${s(spec)}, ${s(source)});`);
}

emit('');
emit('-- ── Tier Items ──────────────────────────────────────────────────────────────────');
for (const item of tierItems) {
  emit(`INSERT INTO tier_items (class, slot, item_id) VALUES (${s(item.class)}, ${s(item.slot)}, ${s(item.itemId)});`);
}

// ── Per-team data ─────────────────────────────────────────────────────────────

for (const team of teams) {
  const { name, sheetId } = team;
  process.stdout.write(`\n  Team: ${name}\n`);

  process.stdout.write('    fetching all tabs…');
  const [config, roster, lootLog, bisSubs, raids, raidEncounters,
         tierSnapshotRaw, wornBis, rclcMap] = await Promise.all([
    getConfig(sheetId),
    getRoster(sheetId),
    getLootLog(sheetId),
    getBisSubmissions(sheetId),
    getRaids(sheetId),
    getRaidEncounters(sheetId),
    getTierSnapshot(sheetId),
    getWornBis(sheetId),
    getRclcResponseMap(sheetId),
  ]);

  const rosterCharIds = new Set(roster.map(r => r.charId).filter(Boolean));

  const tierSnapshot = [];
  for (const snap of tierSnapshotRaw) {
    if (!rosterCharIds.has(snap.charId)) {
      console.warn(`  WARN tier_snapshot [${name}]: charId ${snap.charId} ("${snap.charName}") not in roster — skipping`);
    } else {
      tierSnapshot.push(snap);
    }
  }

  console.log(` done`);
  console.log(`    roster=${roster.length} loot=${lootLog.length} bis=${bisSubs.length} raids=${raids.length} encounters=${raidEncounters.length}`);

  const teamIdExpr = `(SELECT id FROM teams WHERE name=${s(name)})`;

  emit('');
  emit(`-- ── Team: ${name} ${'─'.repeat(Math.max(0, 70 - name.length))}`);

  // Team config
  emit('');
  for (const [key, value] of Object.entries(config)) {
    emit(`INSERT INTO team_config (team_id, key, value) VALUES (${teamIdExpr}, ${s(key)}, ${s(value)});`);
  }

  // Roster — must come before anything that references roster(id)
  emit('');
  for (const char of roster) {
    emit(`INSERT INTO roster (team_id, char_name, class, spec, role, status, owner_id, owner_nick, server, legacy_char_id) VALUES (${[
      teamIdExpr, s(char.charName), s(char.class), s(char.spec), s(char.role),
      s(char.status), s(char.ownerId), s(char.ownerNick), s(char.server),
      s(char.charId || null),
    ].join(', ')});`);
  }

  // Raids — must come before raid_attendees and raid_encounters
  emit('');
  for (const raid of raids) {
    emit(`INSERT INTO raids (raid_id, team_id, date, instance, difficulty) VALUES (${[
      s(raid.raidId), teamIdExpr, s(raid.date), s(raid.instance), s(raid.difficulty),
    ].join(', ')});`);
  }

  // Raid attendees
  emit('');
  for (const raid of raids) {
    for (const userId of raid.attendeeIds) {
      emit(`INSERT INTO raid_attendees (raid_id, user_id) VALUES (${raidRef(raid.raidId, teamIdExpr)}, ${s(userId)});`);
    }
  }

  // Raid encounters
  emit('');
  for (const enc of raidEncounters) {
    emit(`INSERT INTO raid_encounters (raid_id, encounter_id, boss_name, pulls, killed, best_pct) VALUES (${[
      raidRef(enc.raidId, teamIdExpr), n(enc.encounterId), s(enc.bossName),
      n(enc.pulls), b(enc.killed), n(enc.bestPct),
    ].join(', ')});`);
  }

  // Loot log
  emit('');
  for (const entry of lootLog) {
    // Resolve via UUID if available, name fallback for entries missing recipientCharId
    const charRef = rosterRef(teamIdExpr, entry.recipientCharId, entry.recipientChar);
    emit(`INSERT INTO loot_log (team_id, date, boss, item_name, difficulty, recipient_id, recipient_name, recipient_char_id, upgrade_type, notes, ignored) VALUES (${[
      teamIdExpr, s(entry.date), s(entry.boss), s(entry.itemName),
      s(entry.difficulty), s(entry.recipientId), s(entry.recipientChar),
      charRef,
      s(entry.upgradeType), s(entry.notes), b(entry.ignored),
    ].join(', ')});`);
  }

  // BIS submissions
  emit('');
  for (const sub of bisSubs) {
    const charRef = rosterRef(teamIdExpr, sub.charId, sub.charName);
    emit(`INSERT INTO bis_submissions (team_id, char_id, char_name, spec, slot, true_bis, raid_bis, rationale, status, submitted_at, reviewed_by, officer_note, true_bis_item_id, raid_bis_item_id) VALUES (${[
      teamIdExpr, charRef, s(sub.charName), s(sub.spec), s(sub.slot),
      s(sub.trueBis), s(sub.raidBis), s(sub.rationale), s(sub.status),
      s(sub.submittedAt), s(sub.reviewedBy), s(sub.officerNote),
      itemRef(sub.trueBisItemId), itemRef(sub.raidBisItemId),
    ].join(', ')});`);
  }

  // RCLC response map
  emit('');
  for (const [button, { internalType, counted }] of rclcMap) {
    emit(`INSERT INTO rclc_response_map (team_id, rclc_button, internal_type, counted_in_totals) VALUES (${[
      teamIdExpr, s(button), s(internalType), b(counted),
    ].join(', ')});`);
  }

  // Tier snapshot
  emit('');
  for (const snap of tierSnapshot) {
    const charRef = rosterRef(teamIdExpr, snap.charId, snap.charName);
    const raidFk  = snap.raidId ? raidRef(snap.raidId, teamIdExpr) : 'NULL';
    emit(`INSERT INTO tier_snapshot (char_id, raid_id, tier_count, tier_detail, updated_at) VALUES (${[
      charRef, raidFk, n(snap.tierCount), s(snap.tierDetail), s(snap.updatedAt),
    ].join(', ')});`);
  }

  // Worn BIS
  emit('');
  for (const entry of wornBis.values()) {
    if (!rosterCharIds.has(entry.charId)) {
      console.warn(`  WARN worn_bis [${name}]: charId ${entry.charId} ("${entry.charName}") not in roster — skipping`);
      continue;
    }
    const charRef = rosterRef(teamIdExpr, entry.charId, entry.charName);
    emit(`INSERT INTO worn_bis (char_id, slot, spec, overall_bis_track, raid_bis_track, other_track, updated_at) VALUES (${[
      charRef, s(entry.slot), s(entry.spec),
      s(entry.overallBISTrack), s(entry.raidBISTrack), s(entry.otherTrack),
      s(entry.updatedAt),
    ].join(', ')});`);
  }
}

// ── Write output ──────────────────────────────────────────────────────────────

emit('');
emit('COMMIT;');

const output = lines.join('\n') + '\n';
writeFileSync('migration-output.sql', output);
console.log(`\nWrote migration-output.sql (${lines.length} statements)`);
console.log('Apply with:');
console.log('  npx wrangler d1 execute canceled-loot-tracker --local --file=migration-output.sql');
