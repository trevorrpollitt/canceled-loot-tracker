/**
 * test-wcl-sync.js — Dry-run the WCL sync pipeline end-to-end.
 *
 * Reads real config from your sheets, hits the real WCL API, does all the
 * character matching and tier-piece detection — but prints results instead
 * of writing anything to the sheet.
 *
 * Usage:
 *   node --env-file=.env scripts/test-wcl-sync.js
 *
 * Flags:
 *   --team <name>    Only process the named team (case-insensitive)
 *   --report <code>  Only process a specific WCL report code
 */

import { getGlobalConfig, getConfig, getTeamRegistry, getRoster, getTierItems } from '../src/lib/sheets.js';
import { getValidEncounterIds, getEncounterZone, getReportsForGuild, getReportFights, getCombatantInfo } from '../src/lib/wcl.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const args        = process.argv.slice(2);
const teamIdx      = args.indexOf('--team');
const reportIdx    = args.indexOf('--report');
const filterTeam   = teamIdx   >= 0 ? args[teamIdx   + 1]?.toLowerCase() : undefined;
const filterReport = reportIdx >= 0 ? args[reportIdx + 1]               : undefined;

function pass(msg)  { console.log(`  ✓ ${msg}`); }
function fail(msg)  { console.log(`  ✗ ${msg}`); }
function info(msg)  { console.log(`    ${msg}`); }
function section(msg) { console.log(`\n── ${msg}`); }

const SLOT_MAP = {
  HEAD: 'Head', SHOULDER: 'Shoulders', CHEST: 'Chest',
  ROBE: 'Chest', HAND: 'Hands', LEGS: 'Legs',
};

// Handles ISO strings ("2026-01-07") and Sheets date serials (46025 = days since Dec 30 1899)
function parseSheetDateMs(value) {
  if (!value) return 0;
  const num = Number(value);
  if (!isNaN(num) && num > 0 && num < 200000) {
    return (num - 25569) * 86400 * 1000;
  }
  const ms = new Date(String(value)).getTime();
  return isNaN(ms) ? 0 : ms;
}

const TRACK_NAMES = ['Veteran', 'Champion', 'Hero', 'Mythic'];
function buildTrackRanges(veteranStartId) {
  if (!veteranStartId) return [];
  return TRACK_NAMES.map((track, i) => ({ bonusId: veteranStartId + i * 8, track }));
}

function buildRosterLookup(roster) {
  const map = new Map();
  for (const char of roster) {
    const nameServer = `${char.charName.toLowerCase()}|${(char.server ?? '').toLowerCase()}`;
    const nameOnly   = `${char.charName.toLowerCase()}|`;
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

function findTierPieces(gear, tierItemMap, trackRanges) {
  const pieces = [];
  for (const item of gear ?? []) {
    const slot = tierItemMap.get(Number(item.id));
    if (slot == null) continue;
    let track = 'Unknown';
    for (const bonusId of item.bonusIDs ?? []) {
      const row = trackRanges.find(r => bonusId >= r.bonusId && bonusId <= r.bonusId + 7);
      if (row) { track = row.track; break; }
    }
    pieces.push({ slot, track, itemId: item.id, bonusIDs: item.bonusIDs ?? [] });
  }
  return pieces;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('WCL Sync — Dry Run\n');

  // ── Step 1: Global config ──────────────────────────────────────────────────
  section('Step 1: Load global config');
  const globalConfig = await getGlobalConfig();
  const { wcl_client_id, wcl_zone_ids, season_start, wcl_veteran_bonus_id } = globalConfig;
  const trackRanges = buildTrackRanges(Number(wcl_veteran_bonus_id) || 0);
  const wcl_client_secret = process.env.WCL_CLIENT_SECRET;

  wcl_client_id          ? pass(`wcl_client_id:           ${wcl_client_id}`) : fail('wcl_client_id not set in Global Config');
  wcl_client_secret      ? pass('WCL_CLIENT_SECRET:        (set in env)')     : fail('WCL_CLIENT_SECRET not set in env');
  wcl_zone_ids           ? pass(`wcl_zone_ids:            ${wcl_zone_ids}`)  : fail('wcl_zone_ids not set in Global Config');
  season_start           ? pass(`season_start:            ${season_start}  →  ${new Date(parseSheetDateMs(season_start)).toISOString().split('T')[0]}`) : fail('season_start not set in Global Config');
  wcl_veteran_bonus_id   ? pass(`wcl_veteran_bonus_id:    ${wcl_veteran_bonus_id}  →  ${trackRanges.map(r => `${r.track} ${r.bonusId}–${r.bonusId+7}`).join(', ')}`) : fail('wcl_veteran_bonus_id not set in Global Config — tier track levels will show as Unknown');

  if (!wcl_client_id || !wcl_client_secret) {
    console.error('\nCannot proceed without WCL credentials.');
    process.exit(1);
  }

  const zoneIds       = String(wcl_zone_ids ?? '').split('|').map(Number).filter(Boolean);
  const seasonStartMs = parseSheetDateMs(season_start);

  // ── Step 2: WCL auth ───────────────────────────────────────────────────────
  section('Step 2: WCL OAuth token');
  try {
    // Trigger token fetch by making a real API call
    await getValidEncounterIds([], wcl_client_id, wcl_client_secret);
    pass('Token acquired successfully');
  } catch (err) {
    fail(`Auth failed: ${err.message}`);
    process.exit(1);
  }

  // ── Step 3: Zone encounter IDs ─────────────────────────────────────────────
  section(`Step 3: Resolve encounter IDs for zone(s): ${zoneIds.join(', ')}`);
  let validEncounterIds;
  if (!zoneIds.length) {
    fail('No zone IDs configured — skipping encounter resolution');
    validEncounterIds = new Set();
  } else {
    try {
      validEncounterIds = await getValidEncounterIds(zoneIds, wcl_client_id, wcl_client_secret);
      pass(`${validEncounterIds.size} valid encounter ID(s) found`);
      for (const id of validEncounterIds) info(`encounter ${id}`);
    } catch (err) {
      fail(`Failed: ${err.message}`);
      validEncounterIds = new Set();
    }
  }

  // ── Step 4: Tier items ─────────────────────────────────────────────────────
  section('Step 4: Load Tier Items from master sheet');
  const tierItemRows = await getTierItems();
  if (tierItemRows.length) {
    pass(`${tierItemRows.length} tier item row(s) loaded`);
    const byClass = {};
    for (const r of tierItemRows) {
      if (!byClass[r.class]) byClass[r.class] = [];
      byClass[r.class].push(r.slot);
    }
    for (const [cls, slots] of Object.entries(byClass).sort()) {
      info(`${cls.padEnd(20)} ${slots.join(', ')}`);
    }
  } else {
    fail('Tier Items tab is empty — run seed-tier-items.js first');
  }

  const tierItemsByClass = new Map();
  for (const { class: cls, slot, itemId } of tierItemRows) {
    if (!tierItemsByClass.has(cls)) tierItemsByClass.set(cls, new Map());
    tierItemsByClass.get(cls).set(Number(itemId), slot);
  }

  // ── Step 5: Teams ──────────────────────────────────────────────────────────
  section('Step 5: Load teams');
  const registry = await getTeamRegistry();
  const teams    = registry.filter(t => !filterTeam || t.name.toLowerCase() === filterTeam);

  if (!teams.length) {
    fail(filterTeam ? `No team named "${filterTeam}"` : 'No teams found in registry');
    process.exit(1);
  }
  pass(`${teams.length} team(s) to process`);

  // ── Step 6: Per-team ───────────────────────────────────────────────────────
  for (const team of teams) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`Team: ${team.name}  (sheet: ...${team.sheetId.slice(-6)})`);
    console.log('═'.repeat(60));

    const config     = await getConfig(team.sheetId);
    const wclGuildId = config.wcl_guild_id ? Number(config.wcl_guild_id) : null;

    if (!wclGuildId) {
      fail('wcl_guild_id not set in team Config — skipping');
      continue;
    }
    pass(`wcl_guild_id: ${wclGuildId}`);

    const MIN_VALID_MS = 1577836800000; // Jan 1 2020 — guards against Sheets date serial leak
    const rawLastCheck = Number(config.wcl_last_check);
    const lastCheckMs  = (rawLastCheck && rawLastCheck > MIN_VALID_MS) ? rawLastCheck : seasonStartMs;
    if (config.wcl_last_check && rawLastCheck <= MIN_VALID_MS) {
      info(`wcl_last_check value "${config.wcl_last_check}" looks like a Sheets date serial — ignoring, using season_start instead`);
      info('(delete the wcl_last_check row from your Config tab; the cron will recreate it after the first successful run)');
    }
    info(`Last check: ${new Date(lastCheckMs).toISOString()}`);

    // Fetch reports
    section('  Reports');
    let reports;
    try {
      reports = await getReportsForGuild(wclGuildId, lastCheckMs, wcl_client_id, wcl_client_secret);
      reports.sort((a, b) => a.startTime - b.startTime); // oldest first → most recent snapshot wins
      pass(`${reports.length} report(s) found`);
    } catch (err) {
      fail(`Failed to fetch reports: ${err.message}`);
      continue;
    }

    if (!reports.length) {
      info('No new reports since last check.');
      continue;
    }

    // Apply season_start filter and show what we'd process
    const relevant = reports.filter(r => r.startTime >= seasonStartMs);
    info(`${relevant.length} report(s) after season_start filter`);

    const toProcess = filterReport
      ? relevant.filter(r => r.code === filterReport)
      : relevant.slice(0, 3); // cap at 3 for the test run

    if (filterReport && !toProcess.length) {
      fail(`Report ${filterReport} not found in results`);
      continue;
    }
    if (!filterReport && relevant.length > 3) {
      info(`(showing first 3 — use --report <code> to test a specific one)`);
    }

    // Load roster
    const roster       = await getRoster(team.sheetId);
    const rosterLookup = buildRosterLookup(roster);
    pass(`Roster: ${roster.length} character(s)`);

    // Process each report
    for (const report of toProcess) {
      const status = report.endTime > 0 ? 'complete' : 'LIVE';
      console.log(`\n  ── Report ${report.code}  [${status}]  ${report.zone?.name ?? '?'}  ${new Date(report.startTime).toISOString().split('T')[0]}`);

      let reportData;
      try {
        reportData = await getReportFights(report.code, wcl_client_id, wcl_client_secret);
      } catch (err) {
        fail(`    Failed to fetch fights: ${err.message}`);
        continue;
      }

      const { fights = [], masterData = {} } = reportData;
      const actors = masterData.actors ?? [];

      const validFights = fights.filter(
        f => f.encounterID !== 0 && validEncounterIds.has(f.encounterID),
      );

      info(`  ${fights.length} total fight(s), ${validFights.length} valid boss fight(s) after zone filter`);

      if (!validFights.length) {
        info('  No valid boss fights — would skip this report');
        // Show what encounter IDs were in the fights vs what we expected
        const bossEncounterIds = [...new Set(fights.filter(f => f.encounterID !== 0).map(f => f.encounterID))];
        if (bossEncounterIds.length) {
          info(`  Fight encounter IDs in report: ${bossEncounterIds.join(', ')}`);
          info(`  Valid encounter IDs from zone config: ${[...validEncounterIds].join(', ') || '(none)'}`);
          const missing = bossEncounterIds.filter(id => !validEncounterIds.has(id));
          if (missing.length) {
            info(`  ⚠  Unrecognised IDs (not in wcl_zone_ids zones): ${missing.join(', ')}`);
            if (!validEncounterIds.size) {
              // Zone IDs are probably wrong — look up the zone for every encounter in the report
              info('  Attempting to auto-detect correct zone ID(s) from report encounters...');
              try {
                const zoneMap = new Map(); // zoneId → zoneName
                for (const encId of bossEncounterIds) {
                  const enc = await getEncounterZone(encId, wcl_client_id, wcl_client_secret);
                  if (enc?.zoneId) {
                    zoneMap.set(enc.zoneId, enc.zoneName);
                    info(`  Encounter ${enc.encounterId} "${enc.encounterName}" → zone ${enc.zoneId} "${enc.zoneName}"`);
                  }
                }
                if (zoneMap.size) {
                  const ids = [...zoneMap.keys()].join('|');
                  info(`  → Set wcl_zone_ids = ${ids} in your Global Config sheet`);
                } else {
                  info('  Could not resolve any zones — check wcl_client_id is correct');
                }
              } catch (e) {
                info(`  Zone lookup failed: ${e.message}`);
              }
            }
          }
        } else {
          info('  No boss fights at all (all fights are trash — encounterID === 0)');
        }
        continue;
      }

      // CombatantInfo / tier gear — source of truth for both snapshots and attendance
      const latestFight = fights.reduce((a, b) => b.id > a.id ? b : a);
      info(`  Fetching CombatantInfo from fight ${latestFight.id} (latest)…`);
      let combatantEvents;
      try {
        combatantEvents = await getCombatantInfo(report.code, latestFight.id, wcl_client_id, wcl_client_secret);
      } catch (err) {
        fail(`  Failed to fetch CombatantInfo: ${err.message}`);
        combatantEvents = [];
      }

      // Roster matching — keyed off CombatantInfo participants, not session actors
      const snapshotPreview = [];
      const combatantPugs   = [];
      for (const event of combatantEvents) {
        const actor = actors.find(a => a.id === event.sourceID);
        if (!actor) continue;
        const char = resolveActor(actor, rosterLookup);
        if (!char) {
          combatantPugs.push(`${actor.name}-${actor.server ?? '?'}`);
          continue;
        }
        const tierMap    = tierItemsByClass.get(actor.subType) ?? new Map();
        const tierPieces = findTierPieces(event.gear, tierMap, trackRanges);
        snapshotPreview.push({ name: char.charName, count: tierPieces.length, detail: tierPieces.map(p => `${p.slot}:${p.track}`).join('|') || 'none' });
      }

      const combatantTotal = snapshotPreview.length + combatantPugs.length;
      info(`  Combatants: ${combatantTotal} total, ${snapshotPreview.length} roster match(es), ${combatantPugs.length} pug(s)`);
      if (combatantPugs.length) {
        for (const p of combatantPugs) info(`    pug: ${p}`);
      }

      if (snapshotPreview.length) {
        info(`  Tier Snapshot rows that would be written (${snapshotPreview.length}):`);
        const hasUnknown = snapshotPreview.some(s => s.detail.includes('Unknown'));
        for (const s of snapshotPreview) {
          info(`    ${s.name.padEnd(20)} ${s.count} piece(s)  ${s.detail}`);
        }
        if (hasUnknown) {
          info('');
          info('  ⚠  Some tier pieces have Unknown track — bonus IDs not in TRACK_BY_BONUS_ID map.');
          info('  Bonus IDs found on Unknown-track tier pieces:');
          const unknownBonusIds = new Set();
          for (const event of combatantEvents) {
            const actor = actors.find(a => a.id === event.sourceID);
            if (!actor) continue;
            if (!resolveActor(actor, rosterLookup)) continue;
            const tierMap = tierItemsByClass.get(actor.subType) ?? new Map();
            for (const item of event.gear ?? []) {
              if (tierMap.has(Number(item.id))) {
                const hasKnown = (item.bonusIDs ?? []).some(b =>
                  trackRanges.some(r => b >= r.bonusId && b <= r.bonusId + 7),
                );
                if (!hasKnown) {
                  for (const b of item.bonusIDs ?? []) unknownBonusIds.add(b);
                }
              }
            }
          }
          info(`  [${[...unknownBonusIds].sort((a, b) => a - b).join(', ')}]`);
          info('  Update wcl_veteran_bonus_id in Global Config to the Veteran track start bonus ID');
        }
      } else {
        info('  No tier snapshot rows (no CombatantInfo matched to roster)');
      }

      // Encounter summary (complete reports only)
      if (report.endTime > 0) {
        const byEnc = new Map();
        for (const f of validFights) {
          if (!byEnc.has(f.encounterID)) byEnc.set(f.encounterID, { name: f.name, fights: [] });
          byEnc.get(f.encounterID).fights.push(f);
        }
        info(`  Raid Encounters rows that would be written (${byEnc.size}):`);
        for (const [, { name, fights: ef }] of byEnc) {
          const killed  = ef.some(f => f.kill);
          const bestPct = killed ? 0 : Math.min(...ef.map(f => f.bossPercentage ?? 100));
          info(`    ${name.padEnd(35)} ${ef.length} pull(s)  ${killed ? 'KILLED' : `best ${bestPct.toFixed(1)}%`}`);
        }

        // Attendance from combatantEvents — players present in the latest boss fight only
        const attendeeIds = [...new Set(
          combatantEvents
            .map(event => {
              const actor = actors.find(a => a.id === event.sourceID);
              if (!actor) return null;
              return resolveActor(actor, rosterLookup)?.ownerId ?? null;
            })
            .filter(Boolean),
        )];
        info(`  Raids row: ${new Date(report.startTime).toISOString().split('T')[0]}  ${report.zone?.name}  ${attendeeIds.length} attendee(s) (from CombatantInfo, not session actors)`);
      } else {
        info('  (live report — Raids + Raid Encounters rows skipped until complete)');
      }
    }
  }

  console.log('\n\nDry run complete — nothing was written to any sheet.');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
