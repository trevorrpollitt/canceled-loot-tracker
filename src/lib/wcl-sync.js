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
import { getAllTeams } from './teams.js';
import {
  getGlobalConfig,
  getConfig,
  setConfigValue,
  getTierItems,
  getRoster,
  getRaids,
  upsertRaid,
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

// ── Upgrade track bonus ID map ─────────────────────────────────────────────────
// Maps WCL/WoW bonus IDs to human-readable tier piece track names.
// Update once per major patch when new bonus IDs are introduced.
const TRACK_BY_BONUS_ID = {
  10387: 'Veteran',
  10388: 'Champion',
  10389: 'Hero',
  10390: 'Mythic',
};

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
 */
function findTierPieces(gear, tierItemMap) {
  const pieces = [];
  for (const item of gear ?? []) {
    const slot = tierItemMap.get(Number(item.id));
    if (slot == null) continue;

    let track = 'Unknown';
    for (const bonusId of item.bonusIDs ?? []) {
      if (TRACK_BY_BONUS_ID[bonusId]) {
        track = TRACK_BY_BONUS_ID[bonusId];
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
 * Run a full WCL sync across all configured teams.
 * Called by the Cloudflare Worker `scheduled` handler.
 */
export async function runWclSync() {
  log.verbose('[wcl-sync] Starting sync run');
  let globalConfig;
  try {
    globalConfig = await getGlobalConfig();
  } catch (err) {
    log.error('[wcl-sync] Failed to load global config:', err.message);
    return;
  }

  const { wcl_client_id, wcl_zone_ids, season_start } = globalConfig;
  // Secret lives in env (Cloudflare Worker secret / .dev.vars locally) — never in the sheet
  const wcl_client_secret = process.env.WCL_CLIENT_SECRET;

  if (!wcl_client_id || !wcl_client_secret) {
    log.verbose('[wcl-sync] WCL credentials not configured — skipping');
    return;
  }

  const zoneIds = (wcl_zone_ids ?? '').split('|').map(Number).filter(Boolean);
  if (!zoneIds.length) {
    log.verbose('[wcl-sync] wcl_zone_ids not configured — skipping');
    return;
  }

  const seasonStartMs = season_start ? new Date(season_start).getTime() : 0;

  // Fetch valid encounter IDs for all configured zones (one query per zone, done once)
  let validEncounterIds;
  try {
    validEncounterIds = await getValidEncounterIds(zoneIds, wcl_client_id, wcl_client_secret);
    log.verbose(`[wcl-sync] Valid encounter IDs: [${[...validEncounterIds].join(', ')}]`);
  } catch (err) {
    log.error('[wcl-sync] Failed to fetch zone encounter IDs:', err.message);
    return;
  }

  if (!validEncounterIds.size) {
    log.warn('[wcl-sync] No encounters found for configured zone IDs — check wcl_zone_ids');
    return;
  }

  // Load tier items once (master sheet)
  let tierItemRows;
  try {
    tierItemRows = await getTierItems();
  } catch (err) {
    log.error('[wcl-sync] Failed to load Tier Items:', err.message);
    return;
  }

  // Build per-class Map<itemId, slot>
  const tierItemsByClass = new Map();
  for (const { class: cls, slot, itemId } of tierItemRows) {
    if (!tierItemsByClass.has(cls)) tierItemsByClass.set(cls, new Map());
    tierItemsByClass.get(cls).set(Number(itemId), slot);
  }

  // Sync each team
  const teams = getAllTeams();
  for (const team of teams) {
    try {
      await syncTeam(
        team,
        globalConfig,
        validEncounterIds,
        tierItemsByClass,
        seasonStartMs,
        wcl_client_id,
        wcl_client_secret,
      );
    } catch (err) {
      log.error(`[wcl-sync] Team "${team.name}" sync failed:`, err.message);
    }
  }

  log.verbose('[wcl-sync] Sync run complete');
}

// ── Per-team sync ──────────────────────────────────────────────────────────────

async function syncTeam(team, globalConfig, validEncounterIds, tierItemsByClass, seasonStartMs, clientId, clientSecret) {
  const config     = await getConfig(team.sheetId);
  const wclGuildId = config.wcl_guild_id ? Number(config.wcl_guild_id) : null;

  if (!wclGuildId) {
    log.verbose(`[wcl-sync] Team "${team.name}": no wcl_guild_id — skipping`);
    return;
  }

  // Use last-check timestamp to limit report queries; fall back to season start
  const lastCheckMs = config.wcl_last_check ? Number(config.wcl_last_check) : seasonStartMs;
  log.verbose(`[wcl-sync] Team "${team.name}": fetching reports since ${new Date(lastCheckMs).toISOString()}`);

  const reports = await getReportsForGuild(wclGuildId, lastCheckMs, clientId, clientSecret);
  log.verbose(`[wcl-sync] Team "${team.name}": ${reports.length} report(s) to process`);

  if (!reports.length) return;

  const roster       = await getRoster(team.sheetId);
  const rosterLookup = buildRosterLookup(roster);

  for (const report of reports) {
    try {
      await syncReport(report, team, validEncounterIds, tierItemsByClass, rosterLookup, seasonStartMs, clientId, clientSecret);
    } catch (err) {
      log.error(`[wcl-sync] Team "${team.name}" report ${report.code} failed:`, err.message);
    }
  }

  // Advance the last-check cursor to now so the next run only fetches new reports
  await setConfigValue(team.sheetId, 'wcl_last_check', String(Date.now()));
}

// ── Per-report sync ────────────────────────────────────────────────────────────

async function syncReport(report, team, validEncounterIds, tierItemsByClass, rosterLookup, seasonStartMs, clientId, clientSecret) {
  // Cheap pre-filter: skip anything before season start
  if (report.startTime < seasonStartMs) return;

  const reportData = await getReportFights(report.code, clientId, clientSecret);
  if (!reportData) return;

  const { fights = [], masterData = {} } = reportData;
  const actors = masterData.actors ?? [];

  // Filter fights: must be a boss encounter belonging to a configured zone
  const validFights = fights.filter(
    f => f.encounterID !== 0 && validEncounterIds.has(f.encounterID),
  );

  if (!validFights.length) {
    log.verbose(`[wcl-sync] Report ${report.code}: no valid boss fights — skipping`);
    return;
  }

  // ── Tier Snapshot (live + complete) ─────────────────────────────────────────
  // CombatantInfo from the highest-ID fight (most recent gear snapshot)
  const latestFight = fights.reduce((a, b) => b.id > a.id ? b : a);
  const combatantEvents = await getCombatantInfo(report.code, latestFight.id, clientId, clientSecret);

  const snapshotRows = [];
  for (const event of combatantEvents) {
    const actor = actors.find(a => a.id === event.sourceID);
    if (!actor) continue;

    const char = resolveActor(actor, rosterLookup);
    if (!char) continue; // pug — skip

    const tierItemMap = tierItemsByClass.get(actor.subType) ?? new Map();
    const tierPieces  = findTierPieces(event.gear, tierItemMap);

    snapshotRows.push({
      charId:     char.charId,
      charName:   char.charName,
      raidId:     report.code,
      tierCount:  tierPieces.length,
      tierDetail: tierPieces.map(p => `${p.slot}:${p.track}`).join('|'),
      updatedAt:  new Date().toISOString(),
    });
  }

  if (snapshotRows.length) {
    log.verbose(`[wcl-sync] Report ${report.code}: upserting ${snapshotRows.length} tier snapshot row(s)`);
    await upsertTierSnapshot(team.sheetId, snapshotRows);
  }

  // ── Completed reports only ───────────────────────────────────────────────────
  const isComplete = Number(reportData.endTime) > 0;
  if (!isComplete) {
    log.verbose(`[wcl-sync] Report ${report.code}: still in progress — tier snapshot only`);
    return;
  }

  // ── Raids row ────────────────────────────────────────────────────────────────
  // Attendance: actors who map to a roster character with a Discord owner
  const attendeeIds = [...new Set(
    actors
      .map(a => resolveActor(a, rosterLookup))
      .filter(c => c?.ownerId)
      .map(c => c.ownerId),
  )];

  // Dominant difficulty among valid boss fights
  const diffCounts = {};
  for (const f of validFights) {
    if (f.difficulty != null) {
      diffCounts[f.difficulty] = (diffCounts[f.difficulty] ?? 0) + 1;
    }
  }
  const topDiffId    = Object.entries(diffCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const difficultyLabel = DIFFICULTY_LABEL[Number(topDiffId)] ?? String(topDiffId ?? '');

  const raidDate = new Date(report.startTime).toISOString().split('T')[0];
  const instance = report.zone?.name ?? '';

  log.verbose(`[wcl-sync] Report ${report.code}: upserting Raids row (${raidDate} ${instance} ${difficultyLabel}, ${attendeeIds.length} attendees)`);
  await upsertRaid(team.sheetId, {
    raidId:      report.code,
    date:        raidDate,
    instance,
    difficulty:  difficultyLabel,
    attendeeIds: attendeeIds.join('|'),
  });

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
    // Best % = lowest bossPercentage (0 = dead; null when killed → treat as 0)
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

  if (encounterRows.length) {
    log.verbose(`[wcl-sync] Report ${report.code}: upserting ${encounterRows.length} encounter row(s)`);
    await upsertRaidEncounters(team.sheetId, encounterRows);
  }
}
