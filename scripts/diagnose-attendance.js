/**
 * diagnose-attendance.js
 *
 * Diagnoses why specific WCL reports produce 0 attendees in the backfill.
 * Calls the WCL API for a given report code and checks each step of the
 * resolution pipeline: actors, combatant events, and roster matching.
 *
 * Usage:
 *   node --env-file=.dev.vars scripts/diagnose-attendance.js <reportCode>
 *
 * Example:
 *   node --env-file=.dev.vars scripts/diagnose-attendance.js CRcvFx8Xd296A4jD
 */

import { openLocalDb }                           from './local-db.js';
import { getGlobalConfig, getTeamConfig, getRoster } from '../src/lib/db.js';
import { getReportFights, getCombatantInfo }      from '../src/lib/wcl.js';

const reportCode = process.argv[2];
if (!reportCode) {
  console.error('Usage: node --env-file=.dev.vars scripts/diagnose-attendance.js <reportCode>');
  process.exit(1);
}

function buildRosterLookup(roster) {
  const map = new Map();
  for (const char of roster) {
    const nameServer = `${char.char_name.toLowerCase()}|${(char.server ?? '').toLowerCase()}`;
    const nameOnly   = `${char.char_name.toLowerCase()}|`;
    map.set(nameServer, char);
    if (!map.has(nameOnly)) map.set(nameOnly, char);
  }
  return map;
}

function resolveActor(actor, rosterLookup) {
  const nameServer = `${actor.name.toLowerCase()}|${(actor.server ?? '').toLowerCase()}`;
  const nameOnly   = `${actor.name.toLowerCase()}|`;
  return rosterLookup.get(nameServer) ?? rosterLookup.get(nameOnly) ?? null;
}

const db = openLocalDb();

// Find the team that owns this report in D1
const raidRow = await db.prepare(
  'SELECT team_id FROM raids WHERE raid_id = ?'
).bind(reportCode).first();

if (!raidRow) {
  console.log(`Report ${reportCode} not found in D1 raids table — it would be treated as a new raid by the backfill.`);
}
const teamId = raidRow?.team_id ?? 1;
console.log(`Team ID: ${teamId}`);

const [globalConfig, teamConfig] = await Promise.all([
  getGlobalConfig(db),
  getTeamConfig(db, teamId),
]);

const clientId     = globalConfig.wcl_client_id;
const clientSecret = process.env.WCL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Missing WCL_CLIENT_ID or WCL_CLIENT_SECRET. Pass via --env-file=.dev.vars');
  process.exit(1);
}

console.log(`\n── Fetching report ${reportCode} from WCL ──`);
const reportData = await getReportFights(reportCode, clientId, clientSecret);

if (!reportData) {
  console.log('getReportFights returned null — report may not exist or is private.');
  process.exit(1);
}

const fights = reportData.fights ?? [];
const actors = reportData.masterData?.actors ?? [];

console.log(`fights:  ${fights.length} total`);
console.log(`actors:  ${actors.length} from masterData (type=Player filter applied in GQL)`);

if (actors.length > 0) {
  console.log('\nActors returned by WCL:');
  for (const a of actors) {
    console.log(`  id=${a.id}  name="${a.name}"  server="${a.server ?? ''}"  subType="${a.subType ?? ''}"`);
  }
} else {
  console.log('\n⚠ masterData.actors is EMPTY — this is the bug if fights exist.');
}

if (!fights.length) {
  console.log('\nNo fights to query CombatantInfo for.');
  process.exit(0);
}

// Try each completed fight from highest to lowest (mirrors updated backfill logic)
const completedFights = fights.filter(f => !f.inProgress).sort((a, b) => b.id - a.id);
const fightsToTry     = completedFights.length ? completedFights : [...fights].sort((a, b) => b.id - a.id);

console.log(`\n── Trying CombatantInfo for ${fightsToTry.length} fight(s) ──`);
let combatantEvents = [];
for (const fight of fightsToTry) {
  const events = await getCombatantInfo(reportCode, fight.id, clientId, clientSecret);
  console.log(`  fight ${fight.id}: ${events.length} event(s)`);
  if (events.length > 0) {
    combatantEvents = events;
    break;
  }
}

if (combatantEvents.length === 0) {
  console.log('\n⚠ getCombatantInfo returned 0 events for all fights.');
  process.exit(0);
}

// Load roster and try to resolve each event
const roster       = await getRoster(db, teamId);
const rosterLookup = buildRosterLookup(roster);
console.log(`\nRoster loaded: ${roster.length} characters`);

console.log('\n── Resolution results ──');
let resolved = 0, unresolved = 0, noOwnerId = 0;

for (const event of combatantEvents) {
  const actor = actors.find(a => a.id === event.sourceID);
  if (!actor) {
    console.log(`  sourceID=${event.sourceID}: ✗ no actor in masterData`);
    unresolved++;
    continue;
  }

  const char = resolveActor(actor, rosterLookup);
  if (!char) {
    console.log(`  "${actor.name}" (${actor.server ?? 'no server'}): ✗ not found in roster`);
    unresolved++;
    continue;
  }

  if (!char.owner_id) {
    console.log(`  "${actor.name}" → ${char.char_name}: ✗ no owner_id`);
    noOwnerId++;
    continue;
  }

  console.log(`  "${actor.name}" → ${char.char_name} (owner ${char.owner_id}): ✓`);
  resolved++;
}

console.log(`\nSummary: ${resolved} resolved, ${unresolved} unresolved, ${noOwnerId} missing owner_id`);
