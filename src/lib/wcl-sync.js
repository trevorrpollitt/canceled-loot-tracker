/**
 * wcl-sync.js — WCL sync orchestration.
 *
 * Called by the Cloudflare Worker scheduled handler (wrangler cron trigger).
 * For each team with a wcl_guild_id configured:
 *
 *   Every run (live + complete reports):
 *     • Fetch CombatantInfo from the latest pull → upsert Tier Snapshot
 *
 *   Completed reports only (endTime > 0):
 *     • Upsert Raids row (attendance, date, instance, difficulty)
 *     • Upsert Raid Encounters rows (boss pulls, kill status, best %)
 *
 * Dedup strategy:
 *   Raids          — keyed by RaidId (WCL report code); upsert in place
 *   Raid Encounters — keyed by RaidId + EncounterId; upsert in place
 *   Tier Snapshot  — one row per CharId; always overwrite with latest
 *
 * Fight filtering:
 *   • Reports before season_start are skipped entirely (cheap pre-filter)
 *   • Fights with encounterID === 0 (trash) are excluded
 *   • Fights whose encounterID doesn't belong to a configured wcl_zone_ids
 *     zone are excluded (dirty-log guard)
 */

import { log } from './logger.js';

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Parse a date value that may come from Google Sheets as either:
 *   - An ISO string: "2026-01-07"
 *   - A Sheets date serial: 46025  (days since Dec 30 1899; returned by
 *     UNFORMATTED_VALUE when the cell is date-formatted)
 *
 * Returns a Unix millisecond timestamp, or 0 if falsy/unparseable.
 * Serials < 200000 are treated as Sheets date serials (covers dates up to ~2447).
 */
function parseSheetDateMs(value) {
  if (!value) return 0;
  const num = Number(value);
  if (!isNaN(num) && num > 0 && num < 200000) {
    // Sheets date serial → Unix ms  (25569 = days from Dec 30 1899 to Jan 1 1970)
    return (num - 25569) * 86400 * 1000;
  }
  const ms = new Date(String(value)).getTime();
  return isNaN(ms) ? 0 : ms;
}
import { getAllTeams } from './teams.js';
import {
  getGlobalConfig,
  getConfig,
  setConfigValue,
  getTierItems,
  getRoster,
  getRaids,
  upsertRaids,
  getRaidEncounters,
  upsertRaidEncounters,
  upsertTierSnapshot,
} from './sheets.js';
import {
  getValidEncounterIds,
  getReportsForGuild,
  getReportFights,
  getCombatantInfo,
} from './wcl.js';

// Upgrade tracks in order — each spans 8 consecutive bonus IDs from veteran_start
const TRACK_NAMES = ['Veteran', 'Champion', 'Hero', 'Mythic'];

/**
 * Build the 4 upgrade-track ranges from the Veteran start bonus ID.
 * Each track covers [startId + i*8, startId + i*8 + 7] inclusive.
 * Returns an empty array if veteranStartId is falsy (tracks will show Unknown).
 */
function buildTrackRanges(veteranStartId) {
  if (!veteranStartId) return [];
  return TRACK_NAMES.map((track, i) => ({ bonusId: veteranStartId + i * 8, track }));
}

// WCL difficulty integer → human label
const DIFFICULTY_LABEL = {
  3:  'Normal',
  4:  'Heroic',
  5:  'Mythic',
  10: 'LFR',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Given a gear array from a CombatantInfo event and a Map<itemId, slot> of
 * current-season tier item IDs for the character's class, return an array of
 * { slot, track } for each tier piece found.
 *
 * trackRanges is an array of { bonusId: startId, track } rows from the
 * Track Bonus IDs sheet tab. Each track spans [startId, startId + 7] inclusive
 * (8 upgrade levels per track).
 */
function findTierPieces(gear, tierItemMap, trackRanges) {
  const pieces = [];
  for (const item of gear ?? []) {
    const slot = tierItemMap.get(Number(item.id));
    if (slot == null) continue;

    let track = 'Unknown';
    for (const bonusId of item.bonusIDs ?? []) {
      const row = trackRanges.find(r => bonusId >= r.bonusId && bonusId <= r.bonusId + 7);
      if (row) {
        track = row.track;
        break;
      }
    }
    pieces.push({ slot, track });
  }
  return pieces;
}

/**
 * Build a two-key roster lookup map.
 * Primary key:   `${name.lower()}|${server.lower()}`  (used when server is set)
 * Fallback key:  `${name.lower()}|`                   (used when server is empty)
 */
function buildRosterLookup(roster) {
  const map = new Map();
  for (const char of roster) {
    const nameServer = `${char.charName.toLowerCase()}|${(char.server ?? '').toLowerCase()}`;
    const nameOnly   = `${char.charName.toLowerCase()}|`;
    map.set(nameServer, char);
    // Only set name-only key if not already claimed by a char with a server
    if (!map.has(nameOnly)) map.set(nameOnly, char);
  }
  return map;
}

/**
 * Resolve an actor (WCL name + server) to a roster character.
 * Returns null if no match (pug — skip).
 */
function resolveActor(actor, rosterLookup) {
  const nameServer = `${actor.name.toLowerCase()}|${(actor.server ?? '').toLowerCase()}`;
  const nameOnly   = `${actor.name.toLowerCase()}|`;
  return rosterLookup.get(nameServer) ?? rosterLookup.get(nameOnly) ?? null;
}

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * Build shared WCL sync context (global config, encounter IDs, tier items).
 * Throws if credentials or zone IDs are missing.
 */
async function buildWclContext() {
  const globalConfig = await getGlobalConfig();
  const { wcl_client_id, wcl_zone_ids, season_start, wcl_veteran_bonus_id } = globalConfig;
  const trackRanges      = buildTrackRanges(Number(wcl_veteran_bonus_id) || 0);
  const wcl_client_secret = process.env.WCL_CLIENT_SECRET;

  if (!wcl_client_id || !wcl_client_secret) throw new Error('WCL credentials not configured');

  const zoneIds = String(wcl_zone_ids ?? '').split('|').map(Number).filter(Boolean);
  if (!zoneIds.length) throw new Error('wcl_zone_ids not configured');

  const seasonStartMs     = parseSheetDateMs(season_start);
  const validEncounterIds = await getValidEncounterIds(zoneIds, wcl_client_id, wcl_client_secret);
  if (!validEncounterIds.size) throw new Error('No encounters found for configured zone IDs — check wcl_zone_ids');

  if (!trackRanges.length) {
    log.warn('[wcl-sync] wcl_veteran_bonus_id not set in Global Config — tier track detection will show Unknown');
  }
  log.verbose(`[wcl-sync] Valid encounter IDs: [${[...validEncounterIds].join(', ')}]`);

  const tierItemRows     = await getTierItems();
  const tierItemsByClass = new Map();
  for (const { class: cls, slot, itemId } of tierItemRows) {
    if (!tierItemsByClass.has(cls)) tierItemsByClass.set(cls, new Map());
    tierItemsByClass.get(cls).set(Number(itemId), slot);
  }

  return { globalConfig, validEncounterIds, tierItemsByClass, trackRanges, seasonStartMs, wcl_client_id, wcl_client_secret };
}

/**
 * Run a full WCL sync across all configured teams.
 * Called by the Cloudflare Worker `scheduled` handler.
 */
export async function runWclSync() {
  log.verbose('[wcl-sync] Starting sync run');
  let ctx;
  try {
    ctx = await buildWclContext();
  } catch (err) {
    log.error('[wcl-sync] Setup failed:', err.message);
    return;
  }
  const { globalConfig, validEncounterIds, tierItemsByClass, trackRanges, seasonStartMs, wcl_client_id, wcl_client_secret } = ctx;

  for (const team of getAllTeams()) {
    try {
      await syncTeam(team, globalConfig, validEncounterIds, tierItemsByClass, trackRanges, seasonStartMs, wcl_client_id, wcl_client_secret);
    } catch (err) {
      log.error(`[wcl-sync] Team "${team.name}" sync failed:`, err.message);
    }
  }
  log.verbose('[wcl-sync] Sync run complete');
}

/**
 * Run WCL sync for a single team.
 * Called by the web admin manual trigger.
 *
 * @param {{ name: string, sheetId: string }} team
 */
export async function runWclSyncForTeam(team) {
  log.warn(`[wcl-sync] Manual sync triggered for team "${team.name}"`);
  const ctx = await buildWclContext();
  const { globalConfig, validEncounterIds, tierItemsByClass, trackRanges, seasonStartMs, wcl_client_id, wcl_client_secret } = ctx;
  await syncTeam(team, globalConfig, validEncounterIds, tierItemsByClass, trackRanges, seasonStartMs, wcl_client_id, wcl_client_secret);
  log.warn(`[wcl-sync] Manual sync complete for team "${team.name}"`);
}

// ── Per-team sync ──────────────────────────────────────────────────────────────

async function syncTeam(team, globalConfig, validEncounterIds, tierItemsByClass, trackRanges, seasonStartMs, clientId, clientSecret) {
  const config     = await getConfig(team.sheetId);
  const wclGuildId = config.wcl_guild_id ? Number(config.wcl_guild_id) : null;

  if (!wclGuildId) {
    log.verbose(`[wcl-sync] Team "${team.name}": no wcl_guild_id — skipping`);
    return;
  }

  // Use last-check timestamp to limit report queries; fall back to season start.
  // Guard against Google Sheets auto-formatting the value as a date serial
  // (e.g. 46088 days ≈ today in Sheets, but 46088 ms ≈ epoch). Any real Unix ms
  // timestamp for a raid log will be > Jan 1 2020 (1577836800000).
  const MIN_VALID_MS = 1577836800000; // Jan 1 2020
  const rawLastCheck = Number(config.wcl_last_check);
  const lastCheckMs  = (rawLastCheck && rawLastCheck > MIN_VALID_MS) ? rawLastCheck : seasonStartMs;
  log.verbose(`[wcl-sync] Team "${team.name}": fetching reports since ${new Date(lastCheckMs).toISOString()}`);

  const reports = await getReportsForGuild(wclGuildId, lastCheckMs, clientId, clientSecret);
  // Sort ascending so the most recent report is processed last — its tier snapshot wins
  reports.sort((a, b) => a.startTime - b.startTime);
  log.verbose(`[wcl-sync] Team "${team.name}": ${reports.length} report(s) to process`);

  if (!reports.length) return;

  const roster       = await getRoster(team.sheetId);
  const rosterLookup = buildRosterLookup(roster);

  // Accumulate data from all reports before writing — reduces Sheets API calls from
  // O(reports × characters) to O(1 read + 1 batchUpdate) per tab per team sync.
  const allSnapshots    = new Map(); // charId → snapshotRow  (latest report wins; sorted asc)
  const allRaidRows     = [];
  const allEncounterRows = [];

  for (let i = 0; i < reports.length; i++) {
    const report = reports[i];
    log.warn(`[wcl-sync] Team "${team.name}": processing report ${i + 1}/${reports.length} — ${report.code}`);
    try {
      const result = await processReport(report, team, validEncounterIds, tierItemsByClass, trackRanges, rosterLookup, seasonStartMs, clientId, clientSecret);
      if (!result) continue;
      const { snapshotRows, raidRow, encounterRows } = result;
      for (const snap of snapshotRows) allSnapshots.set(snap.charId, snap);
      if (raidRow) allRaidRows.push(raidRow);
      allEncounterRows.push(...encounterRows);
    } catch (err) {
      log.error(`[wcl-sync] Team "${team.name}" report ${report.code} failed:`, err.message);
    }
  }

  // Bulk-write all accumulated data (one read + one batchUpdate per tab)
  const snapshotList = [...allSnapshots.values()];
  if (snapshotList.length) {
    log.warn(`[wcl-sync] Team "${team.name}": writing ${snapshotList.length} tier snapshot row(s)`);
    await upsertTierSnapshot(team.sheetId, snapshotList);
  }
  if (allRaidRows.length) {
    log.warn(`[wcl-sync] Team "${team.name}": writing ${allRaidRows.length} raid row(s)`);
    await upsertRaids(team.sheetId, allRaidRows);
  }
  if (allEncounterRows.length) {
    log.warn(`[wcl-sync] Team "${team.name}": writing ${allEncounterRows.length} encounter row(s)`);
    await upsertRaidEncounters(team.sheetId, allEncounterRows);
  }

  // Advance the last-check cursor to now so the next run only fetches new reports
  await setConfigValue(team.sheetId, 'wcl_last_check', String(Date.now()));
}

// ── Per-report data extraction ─────────────────────────────────────────────────
// Returns { snapshotRows, raidRow, encounterRows } — no Sheets writes.
// syncTeam accumulates results across all reports and bulk-writes at the end.

async function processReport(report, team, validEncounterIds, tierItemsByClass, trackRanges, rosterLookup, seasonStartMs, clientId, clientSecret) {
  // Cheap pre-filter: skip anything before season start
  if (report.startTime < seasonStartMs) {
    log.verbose(`[wcl-sync] Report ${report.code}: before season start — skipping`);
    return null;
  }

  const reportData = await getReportFights(report.code, clientId, clientSecret);
  if (!reportData) return null;

  const { fights = [], masterData = {} } = reportData;
  const actors = masterData.actors ?? [];

  // Filter fights: must be a boss encounter belonging to a configured zone
  const validFights = fights.filter(
    f => f.encounterID !== 0 && validEncounterIds.has(f.encounterID),
  );

  if (!validFights.length) {
    log.verbose(`[wcl-sync] Report ${report.code}: no valid boss fights — skipping`);
    return null;
  }

  // ── Tier Snapshot (live + complete) ─────────────────────────────────────────
  // CombatantInfo from the highest-ID fight (most recent gear snapshot)
  const latestFight     = fights.reduce((a, b) => b.id > a.id ? b : a);
  const combatantEvents = await getCombatantInfo(report.code, latestFight.id, clientId, clientSecret);

  const snapshotRows = [];
  for (const event of combatantEvents) {
    const actor = actors.find(a => a.id === event.sourceID);
    if (!actor) continue;

    const char = resolveActor(actor, rosterLookup);
    if (!char) continue; // pug — skip

    const tierItemMap = tierItemsByClass.get(actor.subType) ?? new Map();
    const tierPieces  = findTierPieces(event.gear, tierItemMap, trackRanges);

    snapshotRows.push({
      charId:     char.charId,
      charName:   char.charName,
      raidId:     report.code,
      tierCount:  tierPieces.length,
      tierDetail: tierPieces.map(p => `${p.slot}:${p.track}`).join('|'),
      updatedAt:  new Date().toISOString(),
    });
  }
  log.verbose(`[wcl-sync] Report ${report.code}: ${snapshotRows.length} tier snapshot row(s)`);

  // ── Completed reports only ───────────────────────────────────────────────────
  const isComplete = Number(reportData.endTime) > 0;
  if (!isComplete) {
    log.verbose(`[wcl-sync] Report ${report.code}: still in progress — tier snapshot only`);
    return { snapshotRows, raidRow: null, encounterRows: [] };
  }

  // ── Raids row ────────────────────────────────────────────────────────────────
  const attendeeIds = [...new Set(
    combatantEvents
      .map(event => {
        const actor = actors.find(a => a.id === event.sourceID);
        if (!actor) return null;
        return resolveActor(actor, rosterLookup)?.ownerId ?? null;
      })
      .filter(Boolean),
  )];

  const diffCounts = {};
  for (const f of validFights) {
    if (f.difficulty != null) {
      diffCounts[f.difficulty] = (diffCounts[f.difficulty] ?? 0) + 1;
    }
  }
  const topDiffId      = Object.entries(diffCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const difficultyLabel = DIFFICULTY_LABEL[Number(topDiffId)] ?? String(topDiffId ?? '');
  const raidDate        = new Date(report.startTime).toISOString().split('T')[0];
  const instance        = report.zone?.name ?? '';

  log.verbose(`[wcl-sync] Report ${report.code}: ${raidDate} ${instance} ${difficultyLabel}, ${attendeeIds.length} attendee(s)`);
  const raidRow = {
    raidId:      report.code,
    date:        raidDate,
    instance,
    difficulty:  difficultyLabel,
    attendeeIds: attendeeIds.join('|'),
  };

  // ── Raid Encounters rows ─────────────────────────────────────────────────────
  const byEncounter = new Map();
  for (const f of validFights) {
    if (!byEncounter.has(f.encounterID)) {
      byEncounter.set(f.encounterID, { name: f.name, fights: [] });
    }
    byEncounter.get(f.encounterID).fights.push(f);
  }

  const encounterRows = [];
  for (const [encId, { name, fights: encFights }] of byEncounter) {
    const killed  = encFights.some(f => f.kill === true);
    const bestPct = killed
      ? 0
      : Math.min(...encFights.map(f => f.bossPercentage ?? 100));

    encounterRows.push({
      raidId:      report.code,
      encounterId: encId,
      bossName:    name,
      pulls:       encFights.length,
      killed,
      bestPct:     Number(bestPct.toFixed(1)),
    });
  }
  log.verbose(`[wcl-sync] Report ${report.code}: ${encounterRows.length} encounter row(s)`);

  return { snapshotRows, raidRow, encounterRows };
}
