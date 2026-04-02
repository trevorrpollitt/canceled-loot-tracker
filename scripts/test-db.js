/**
 * test-db.js
 *
 * Smoke-tests the db.js query layer against the local D1 SQLite file.
 * Usage: node scripts/test-db.js
 */

import { openLocalDb } from './local-db.js';
import {
  getAllTeams, getGlobalConfig, getTeamConfig,
  getRoster, getLootLog, getBisSubmissions,
  getItemDb, getDefaultBis, getSpecBisConfig, getEffectiveDefaultBis,
  getTierItems, getRaids, getRaidEncounters,
  getTierSnapshot, getWornBis, getRclcResponseMap,
} from '../src/lib/db.js';

const db = openLocalDb();

function check(label, value) {
  const ok = value !== null && value !== undefined && (Array.isArray(value) ? value.length >= 0 : true);
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${Array.isArray(value) ? `${value.length} rows` : JSON.stringify(value)}`);
  return ok;
}

console.log('\n── Global ───────────────────────────────────────');
const teams     = await getAllTeams(db);
const globalCfg = await getGlobalConfig(db);
const itemDb    = await getItemDb(db);
const defaultBis = await getDefaultBis(db);
const specCfg   = await getSpecBisConfig(db);
const effectiveBis = await getEffectiveDefaultBis(db);
const tierItems = await getTierItems(db);

check('teams',          teams);
check('global_config',  Object.keys(globalCfg));
check('item_db',        itemDb);
check('default_bis',    defaultBis);
check('spec_bis_config', [...specCfg.entries()]);
check('effective_bis',  effectiveBis);
check('tier_items',     tierItems);

for (const team of teams) {
  console.log(`\n── Team: ${team.name} (id=${team.id}) ────────────────────────`);
  const config       = await getTeamConfig(db, team.id);
  const roster       = await getRoster(db, team.id);
  const lootLog      = await getLootLog(db, team.id);
  const bisSubs      = await getBisSubmissions(db, team.id);
  const raids        = await getRaids(db, team.id);
  const encounters   = await getRaidEncounters(db, team.id);
  const tierSnapshot = await getTierSnapshot(db, team.id);
  const wornBis      = await getWornBis(db, team.id);
  const rclcMap      = await getRclcResponseMap(db, team.id);

  check('team_config',    Object.keys(config));
  check('roster',         roster);
  check('loot_log',       lootLog);
  check('bis_submissions', bisSubs);
  check('raids',          raids);
  check('raid_encounters', encounters);
  check('tier_snapshot',  tierSnapshot);
  check('worn_bis',       [...wornBis.values()]);
  check('rclc_map',       [...rclcMap.entries()]);

  if (roster.length) {
    console.log(`  sample roster[0]: ${roster[0].char_name} (${roster[0].spec}) — ${roster[0].status}`);
  }
  if (lootLog.length) {
    const e = lootLog[0];
    console.log(`  sample loot[0]:   ${e.item_name} → ${e.resolved_char_name ?? e.recipient_name} (${e.date})`);
  }
}

console.log('\nDone.');
