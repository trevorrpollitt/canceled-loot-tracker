/**
 * wcl-sync.js — WCL sync orchestration.
 *
 * Called by the Cloudflare Worker scheduled handler (wrangler cron trigger).
 * For each team with a wcl_guild_id configured:
 *
 *   Every report processed:
 *     • Fetch CombatantInfo → upsert Tier Snapshot
 *     • Upsert Raids row (attendance, date, instance, difficulty)
 *     • Upsert Raid Encounters rows (boss pulls, kill status, best %)
 *
 * All reports are treated as complete. WCL provides no reliable API field to
 * distinguish a live-logging report from a finished one. Instead, reports less
 * than 24 hours old are stored in wcl_pending_reports and re-checked on the
 * next run. If their endTime has changed (WCL uploaded more fights), they are
 * reprocessed; if unchanged, they are skipped.
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
import { getAllTeams, initTeams } from './teams.js';
import {
  getGlobalConfig,
  getTeamConfig,
  setTeamConfigValue,
  getTierItems,
  getRoster,
  upsertRaids,
  upsertRaidEncounters,
  upsertTierSnapshot,
  getBisSubmissions,
  getEffectiveDefaultBis,
  getItemDb,
  getWornBis,
  upsertWornBis,
} from './db.js';
import {
  getValidEncounterIds,
  getReportsForGuild,
  getReportFights,
  getCombatantInfo,
} from './wcl.js';
import { matchesBis, PAIRED_BIS_SLOTS } from './bis-match.js';
import { getArmorType, toCanonical, getCharSpecs, WOW_SPEC_ID_TO_NAME, mergeTrack, TRACK_ORDER, buildTrackRanges, getItemTrack } from './specs.js';

// WCL difficulty integer → human label
const DIFFICULTY_LABEL = {
  3:  'Normal',
  4:  'Heroic',
  5:  'Mythic',
  10: 'LFR',
};

// WoW equipment slot index → canonical slot name (matches BIS Submissions slot column)
const WCL_SLOT_MAP = {
  0:  'Head',      1:  'Neck',       2:  'Shoulders',
  /* 3 = Shirt — skip */
  4:  'Chest',     5:  'Waist',      6:  'Legs',       7:  'Feet',
  8:  'Wrists',    9:  'Hands',      10: 'Ring 1',     11: 'Ring 2',
  12: 'Trinket 1', 13: 'Trinket 2',  14: 'Back',       15: 'Weapon',
  16: 'Off-Hand',
};


/**
 * Extract worn BIS data from CombatantInfo events for a single report.
 *
 * Returns Map<`${charId}:${bisSlot}`, { charId, charName, slot, overallBISTrack, raidBISTrack, otherTrack }>
 * For each character × slot, records the best upgrade track worn in each category.
 * Items with Unknown track are skipped entirely.
 */
function extractWornBis(combatantEvents, actors, rosterLookup, bisLookup, itemDbMap, trackRanges, craftedBonusIds) {
  const result = new Map();

  for (const event of combatantEvents) {
    const actor = actors.find(a => a.id === event.sourceID);
    if (!actor) continue;

    const char = resolveActor(actor, rosterLookup);
    if (!char) continue; // pug — skip

    const armorType = getArmorType(actor.subType); // actor.subType is the WoW class name

    // Resolve the spec the character was actually playing in this report.
    // event.specID is the WoW spec ID from CombatantInfo. Fall back to roster primary spec
    // if specID is missing or unrecognised (e.g. older logs, unknown specs).
    const specFromEvent = event.specID ? WOW_SPEC_ID_TO_NAME[event.specID] : undefined;
    const charSpec      = specFromEvent ?? char.spec;

    // bisLookup is keyed as id:spec (all specs) or "name:<char_name>" fallback for primary
    const bisKey     = char.id ? `${char.id}:${charSpec}` : `name:${char.char_name.toLowerCase()}`;
    const charBisMap = bisLookup.get(bisKey) ?? bisLookup.get(`name:${char.char_name.toLowerCase()}`);

    for (const [slotIdx, slotName] of Object.entries(WCL_SLOT_MAP)) {
      const gearItem = (event.gear ?? [])[Number(slotIdx)];
      if (!gearItem || !gearItem.id || gearItem.id === 0) continue;

      const rawTrack = getItemTrack(gearItem.bonusIDs, trackRanges);
      // Crafted items are identified by a specific bonus ID in the global config
      // (wcl_crafted_bonus_ids). They have no upgrade-track bonus IDs so rawTrack
      // will be 'Unknown', but we still record them as 'Crafted' for BIS/Other slots.
      // Other Unknown-track items (old gear, world drops, etc.) are skipped.
      const matchedCraftedId = rawTrack === 'Unknown'
        ? (gearItem.bonusIDs ?? []).find(id => craftedBonusIds.has(id))
        : undefined;
      const isCrafted = matchedCraftedId !== undefined;
      if (rawTrack === 'Unknown') {
        log.verbose(`[worn-bis] ${char.char_name} slot ${slotName} item ${gearItem.id}: Unknown track — bonusIDs=[${(gearItem.bonusIDs ?? []).join(',')}] isCrafted=${isCrafted}${isCrafted ? ` (matched ${matchedCraftedId})` : ''}`);
        if (!isCrafted) continue;
      }

      const dbEntry = itemDbMap.get(Number(gearItem.id));
      // Build item shape for matchesBis
      const itemShape = {
        itemId:      String(gearItem.id),
        name:        dbEntry?.name ?? '',
        slot:        dbEntry?.slot ?? '',
        armorType:   dbEntry?.armorType ?? '',
        isTierToken: dbEntry?.isTierToken ?? false,
      };

      // Slots to check against BIS entries (rings/trinkets pair with both)
      const bisSlots = PAIRED_BIS_SLOTS[slotName] ?? [slotName];

      let matchedAnyBis = false;

      for (const bisSlot of bisSlots) {
        const charBis = charBisMap?.get(bisSlot);
        if (!charBis) continue;

        // <Catalyst>: any item worn in this slot qualifies — characters can only
        // equip their own armor type, so the armor-type check is already implicit.
        const matchesOverall = (isCrafted && charBis.trueBis === '<Crafted>') ||
          charBis.trueBis === '<Catalyst>' ||
          matchesBis(charBis.trueBis, charBis.trueBisItemId, itemShape, armorType, bisSlot);
        const matchesRaid    = (isCrafted && charBis.raidBis === '<Crafted>') ||
          charBis.raidBis === '<Catalyst>' ||
          matchesBis(charBis.raidBis, charBis.raidBisItemId, itemShape, armorType, bisSlot);

        if (!matchesOverall && !matchesRaid) continue;
        matchedAnyBis = true;

        const recordTrack = isCrafted ? 'Crafted' : rawTrack;
        const key  = `${char.id}:${charSpec}:${bisSlot}`;
        const prev = result.get(key) ?? { charId: char.id, charName: char.char_name, spec: charSpec, slot: bisSlot, overallBISTrack: '', raidBISTrack: '', otherTrack: '' };
        result.set(key, {
          ...prev,
          overallBISTrack: matchesOverall ? mergeTrack(prev.overallBISTrack, recordTrack) : prev.overallBISTrack,
          raidBISTrack:    matchesRaid    ? mergeTrack(prev.raidBISTrack,    recordTrack) : prev.raidBISTrack,
          // OtherTrack is the highest track seen in this slot regardless of BIS category
          otherTrack:      mergeTrack(prev.otherTrack, recordTrack),
        });
      }

      // If item didn't match any BIS entry, record it under the physical slot as Other.
      // Crafted items (Unknown track) get 'Crafted' so the row still exists — name-based
      // BIS matching is impossible without the item name, which WCL gear data omits.
      if (!matchedAnyBis) {
        const key      = `${char.id}:${charSpec}:${slotName}`;
        const prev     = result.get(key) ?? { charId: char.id, charName: char.char_name, spec: charSpec, slot: slotName, overallBISTrack: '', raidBISTrack: '', otherTrack: '' };
        const otherVal = isCrafted ? 'Crafted' : rawTrack;
        result.set(key, { ...prev, otherTrack: mergeTrack(prev.otherTrack, otherVal) });
      }
    }
  }

  return result;
}

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
    const nameServer = `${char.char_name.toLowerCase()}|${(char.server ?? '').toLowerCase()}`;
    const nameOnly   = `${char.char_name.toLowerCase()}|`;
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
async function buildWclContext(db) {
  const globalConfig = await getGlobalConfig(db);
  const { wcl_client_id, wcl_zone_ids, season_start, wcl_veteran_bonus_id, wcl_crafted_bonus_ids } = globalConfig;
  const trackRanges      = buildTrackRanges(Number(wcl_veteran_bonus_id) || 0);
  // Pipe-separated list of bonus IDs that identify crafted items, e.g. "9481|9513|9484"
  const craftedBonusIds  = new Set(
    String(wcl_crafted_bonus_ids ?? '').split('|').map(Number).filter(Boolean)
  );
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
  if (!craftedBonusIds.size) {
    log.warn('[wcl-sync] wcl_crafted_bonus_ids not set in Global Config — crafted items will not be detected');
  }
  log.verbose(`[wcl-sync] Valid encounter IDs: [${[...validEncounterIds].join(', ')}]`);

  const tierItemRows     = await getTierItems(db);
  const tierItemsByClass = new Map();
  for (const { class: cls, slot, item_id } of tierItemRows) {
    if (!tierItemsByClass.has(cls)) tierItemsByClass.set(cls, new Map());
    tierItemsByClass.get(cls).set(Number(item_id), slot);
  }

  const itemDbRows = await getItemDb(db);
  const itemDbMap  = new Map();
  for (const row of itemDbRows) {
    itemDbMap.set(Number(row.item_id), { slot: row.slot, armorType: row.armor_type, isTierToken: row.is_tier_token === 1, name: row.name });
  }

  return { globalConfig, validEncounterIds, tierItemsByClass, trackRanges, craftedBonusIds, seasonStartMs, wcl_client_id, wcl_client_secret, itemDbMap };
}

/**
 * Run a full WCL sync across all configured teams.
 * Called by the Cloudflare Worker `scheduled` handler.
 *
 * @param {object} db  D1 database binding (env.DB from the Worker)
 */
export async function runWclSync(db) {
  log.verbose('[wcl-sync] Starting sync run');

  // Populate the in-memory team registry from D1 before iterating teams.
  await initTeams(db);

  let ctx;
  try {
    ctx = await buildWclContext(db);
  } catch (err) {
    log.error('[wcl-sync] Setup failed:', err.message);
    return;
  }
  const { globalConfig, validEncounterIds, tierItemsByClass, trackRanges, craftedBonusIds, seasonStartMs, wcl_client_id, wcl_client_secret, itemDbMap } = ctx;

  for (const team of getAllTeams()) {
    try {
      await syncTeam(db, team, globalConfig, validEncounterIds, tierItemsByClass, trackRanges, craftedBonusIds, seasonStartMs, wcl_client_id, wcl_client_secret, itemDbMap);
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
 * @param {object} db  D1 database binding
 * @param {{ id: number, name: string }} team
 */
export async function runWclSyncForTeam(db, team) {
  log.warn(`[wcl-sync] Manual sync triggered for team "${team.name}"`);
  const ctx = await buildWclContext(db);
  const { globalConfig, validEncounterIds, tierItemsByClass, trackRanges, craftedBonusIds, seasonStartMs, wcl_client_id, wcl_client_secret, itemDbMap } = ctx;
  await syncTeam(db, team, globalConfig, validEncounterIds, tierItemsByClass, trackRanges, craftedBonusIds, seasonStartMs, wcl_client_id, wcl_client_secret, itemDbMap);
  log.warn(`[wcl-sync] Manual sync complete for team "${team.name}"`);
}

export async function runWclSyncWornBisOnly(db, team) {
  log.warn(`[wcl-sync] Worn BIS-only resync triggered for team "${team.name}"`);
  const ctx = await buildWclContext(db);
  const { globalConfig, validEncounterIds, tierItemsByClass, trackRanges, craftedBonusIds, seasonStartMs, wcl_client_id, wcl_client_secret, itemDbMap } = ctx;
  await syncTeam(db, team, globalConfig, validEncounterIds, tierItemsByClass, trackRanges, craftedBonusIds, seasonStartMs, wcl_client_id, wcl_client_secret, itemDbMap, { wornBisOnly: true });
  log.warn(`[wcl-sync] Worn BIS-only resync complete for team "${team.name}"`);
}

// ── Per-team sync ──────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

async function syncTeam(db, team, globalConfig, validEncounterIds, tierItemsByClass, trackRanges, craftedBonusIds, seasonStartMs, clientId, clientSecret, itemDbMap, options = {}) {
  const { wornBisOnly = false } = options;
  const config     = await getTeamConfig(db, team.id);
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
  const lastCheckMs  = wornBisOnly
    ? seasonStartMs  // reprocess all season reports so best-ever tracks are accurate
    : (rawLastCheck && rawLastCheck > MIN_VALID_MS) ? rawLastCheck : seasonStartMs;
  log.verbose(`[wcl-sync] Team "${team.name}": fetching reports since ${new Date(lastCheckMs).toISOString()}`);

  // Parse pending re-check map: code → { startTime, storedEndTime, zoneName }
  // Entries older than 24 hours are dropped by not re-adding them to newPending below.
  const pendingMap = new Map();
  for (const entry of (config.wcl_pending_reports ?? '').split('|').filter(Boolean)) {
    const [code, startTime, storedEndTime, ...zoneParts] = entry.split(':');
    pendingMap.set(code, {
      startTime:     Number(startTime),
      storedEndTime: Number(storedEndTime),
      zoneName:      zoneParts.join(':'),
    });
  }

  // Fetch new reports since last check; merge pending re-checks not already in batch
  const newReports = await getReportsForGuild(wclGuildId, lastCheckMs, clientId, clientSecret);
  newReports.sort((a, b) => a.startTime - b.startTime);

  const newCodes   = new Set(newReports.map(r => r.code));
  const allReports = [
    ...newReports.map(r => ({ ...r, isRecheck: false })),
    ...[...pendingMap.entries()]
      .filter(([code]) => !newCodes.has(code))
      .map(([code, d]) => ({ code, startTime: d.startTime, zone: { name: d.zoneName }, isRecheck: true })),
  ];
  allReports.sort((a, b) => a.startTime - b.startTime);

  const recheckCount = allReports.filter(r => r.isRecheck).length;
  if (recheckCount) {
    log.warn(`[wcl-sync] Team "${team.name}": ${allReports.length} report(s) to process (${recheckCount} re-check)`);
  } else {
    log.verbose(`[wcl-sync] Team "${team.name}": ${allReports.length} report(s) to process`);
  }

  if (!allReports.length) {
    await setTeamConfigValue(db, team.id, 'wcl_last_check', String(Date.now()));
    return;
  }

  const roster       = await getRoster(db, team.id);
  const rosterLookup = buildRosterLookup(roster);

  // Build BIS lookup per character: effective BIS = personal approved submission > spec default.
  // Keyed by roster id:spec when present; falls back to "name:<char_name>" for legacy rows.
  const [allSubs, effectiveDefaultBis] = await Promise.all([
    getBisSubmissions(db, team.id),
    getEffectiveDefaultBis(db),
  ]);

  // Group defaults by spec for fast lookup
  const defaultBisBySpec = new Map();
  for (const row of effectiveDefaultBis) {
    if (!defaultBisBySpec.has(row.spec)) defaultBisBySpec.set(row.spec, []);
    defaultBisBySpec.get(row.spec).push(row);
  }

  // Build BIS lookup per character per spec: keyed as "id:spec" covering all specs.
  const bisLookup = new Map();
  for (const char of roster) {
    const charSpecs = getCharSpecs(char); // { primary, secondary[], all[] }
    const charSubs  = allSubs.filter(s =>
      s.status === 'Approved' &&
      (char.id && s.char_id ? s.char_id === char.id : s.char_name.toLowerCase() === char.char_name.toLowerCase())
    );

    for (const spec of charSpecs.all) {
      const slots = new Map();
      // Seed from spec defaults for this spec
      for (const row of defaultBisBySpec.get(toCanonical(spec)) ?? []) {
        slots.set(row.slot, { trueBis: row.true_bis, trueBisItemId: row.true_bis_item_id, raidBis: row.raid_bis, raidBisItemId: row.raid_bis_item_id });
      }
      // Override with personal approved submissions for this spec
      const specSubs = charSubs.filter(s => s.spec ? s.spec === spec : spec === charSpecs.primary);
      for (const sub of specSubs) {
        slots.set(sub.slot, { trueBis: sub.true_bis, trueBisItemId: sub.true_bis_item_id, raidBis: sub.raid_bis, raidBisItemId: sub.raid_bis_item_id });
      }
      bisLookup.set(`${char.id}:${spec}`, slots);
    }
  }

  const existingWornBis = await getWornBis(db, team.id); // Map<char_id:spec:slot, row>

  // Accumulate data from all reports before writing — reduces Sheets API calls from
  // O(reports × characters) to O(1 read + 1 batchUpdate) per tab per team sync.
  const allSnapshots    = new Map(); // charId → snapshotRow (latest report wins; sorted asc)
  const allRaidRows     = [];
  const allEncounterRows = [];
  const allWornBis      = new Map(); // charId:slot → row (keeps max track per category)
  const newPending      = new Map(); // code → { startTime, storedEndTime, zoneName }

  for (let i = 0; i < allReports.length; i++) {
    const report = allReports[i];
    log.warn(`[wcl-sync] Team "${team.name}": processing report ${i + 1}/${allReports.length} — ${report.code}`);
    try {
      let reportData;
      try {
        reportData = await getReportFights(report.code, clientId, clientSecret);
      } catch (err) {
        log.error(`[wcl-sync] Report ${report.code}: failed to fetch — ${err.message}`);
        continue;
      }
      if (!reportData) continue;

      const currentEndTime = Number(reportData.endTime);

      // Re-checks: skip if WCL hasn't uploaded new fights since last run
      if (report.isRecheck) {
        const stored = pendingMap.get(report.code);
        if (currentEndTime === stored.storedEndTime) {
          log.verbose(`[wcl-sync] Report ${report.code}: unchanged — skipping`);
          if (Date.now() - report.startTime < DAY_MS) {
            newPending.set(report.code, { startTime: report.startTime, storedEndTime: currentEndTime, zoneName: report.zone?.name ?? '' });
          }
          continue;
        }
        log.warn(`[wcl-sync] Report ${report.code}: endTime updated — reprocessing`);
      }

      const result = await processReport(report, reportData, validEncounterIds, tierItemsByClass, trackRanges, craftedBonusIds, rosterLookup, seasonStartMs, clientId, clientSecret, bisLookup, itemDbMap);

      // Track all recent reports for re-check regardless of result
      if (Date.now() - report.startTime < DAY_MS) {
        newPending.set(report.code, { startTime: report.startTime, storedEndTime: currentEndTime, zoneName: report.zone?.name ?? '' });
      }

      if (!result) continue;
      const { snapshotRows, raidRow, encounterRows, wornBisRows } = result;
      for (const snap of snapshotRows) allSnapshots.set(snap.charId, snap);
      if (raidRow) allRaidRows.push(raidRow);
      allEncounterRows.push(...encounterRows);

      // Merge worn BIS rows into accumulator (keep max track per category)
      for (const [key, row] of wornBisRows) {
        if (allWornBis.has(key)) {
          const prev = allWornBis.get(key);
          allWornBis.set(key, {
            ...prev,
            overallBISTrack: mergeTrack(prev.overallBISTrack, row.overallBISTrack),
            raidBISTrack:    mergeTrack(prev.raidBISTrack, row.raidBISTrack),
            otherTrack:      mergeTrack(prev.otherTrack, row.otherTrack),
          });
        } else {
          allWornBis.set(key, row);
        }
      }
    } catch (err) {
      log.error(`[wcl-sync] Team "${team.name}" report ${report.code} failed:`, err.message);
    }
  }

  // Bulk-write all accumulated data
  const snapshotList = [...allSnapshots.values()];
  if (!wornBisOnly) {
    if (snapshotList.length) {
      log.warn(`[wcl-sync] Team "${team.name}": writing ${snapshotList.length} tier snapshot row(s)`);
      await upsertTierSnapshot(db, team.id, snapshotList);
    }
    if (allRaidRows.length) {
      log.warn(`[wcl-sync] Team "${team.name}": writing ${allRaidRows.length} raid row(s)`);
      await upsertRaids(db, team.id, allRaidRows);
    }
    if (allEncounterRows.length) {
      log.warn(`[wcl-sync] Team "${team.name}": writing ${allEncounterRows.length} encounter row(s)`);
      await upsertRaidEncounters(db, team.id, allEncounterRows);
    }
  }

  // Merge accumulated worn BIS with existing DB data (best-ever logic), then write
  if (allWornBis.size) {
    const wornBisToWrite = [];
    for (const [key, row] of allWornBis) {
      const existing = existingWornBis.get(key);
      wornBisToWrite.push({
        ...row,
        updatedAt:       new Date().toISOString(),
        overallBISTrack: mergeTrack(existing?.overall_bis_track, row.overallBISTrack),
        raidBISTrack:    mergeTrack(existing?.raid_bis_track,    row.raidBISTrack),
        otherTrack:      mergeTrack(existing?.other_track,       row.otherTrack),
      });
    }
    log.warn(`[wcl-sync] Team "${team.name}": writing ${wornBisToWrite.length} worn BIS row(s)`);
    await upsertWornBis(db, team.id, wornBisToWrite);
  }

  if (!wornBisOnly) {
    // Advance cursor; persist pending re-checks (reports < 24h old)
    await setTeamConfigValue(db, team.id, 'wcl_last_check', String(Date.now()));
    await setTeamConfigValue(db, team.id, 'wcl_pending_reports',
      [...newPending.entries()].map(([code, d]) => `${code}:${d.startTime}:${d.storedEndTime}:${d.zoneName}`).join('|'),
    );
  }
}

// ── Per-report data extraction ─────────────────────────────────────────────────
// reportData is pre-fetched by the caller (syncTeam) so endTime can be checked
// before deciding whether to reprocess. Returns { snapshotRows, raidRow,
// encounterRows, wornBisRows } or null if there is nothing to write.

async function processReport(report, reportData, validEncounterIds, tierItemsByClass, trackRanges, craftedBonusIds, rosterLookup, seasonStartMs, clientId, clientSecret, bisLookup, itemDbMap) {
  // Cheap pre-filter: skip anything before season start
  if (report.startTime < seasonStartMs) {
    log.verbose(`[wcl-sync] Report ${report.code}: before season start — skipping`);
    return null;
  }

  const { fights = [], masterData = {} } = reportData;
  const actors = masterData.actors ?? [];

  if (!fights.length) {
    log.verbose(`[wcl-sync] Report ${report.code}: no fights yet — skipping`);
    return null;
  }

  // ── Tier Snapshot ────────────────────────────────────────────────────────────
  // Prefer the most recent completed fight for CombatantInfo — WCL may not have
  // finalised gear data for an actively in-progress pull yet.
  const completedFights  = fights.filter(f => !f.inProgress);
  const fightForSnapshot = (completedFights.length ? completedFights : fights)
    .reduce((a, b) => b.id > a.id ? b : a);
  const combatantEvents  = await getCombatantInfo(report.code, fightForSnapshot.id, clientId, clientSecret);
  log.verbose(`[wcl-sync] Report ${report.code}: ${combatantEvents.length} combatant event(s) from fight ${fightForSnapshot.id}`);

  const snapshotRows = [];
  for (const event of combatantEvents) {
    const actor = actors.find(a => a.id === event.sourceID);
    if (!actor) continue;

    const char = resolveActor(actor, rosterLookup);
    if (!char) continue; // pug — skip

    const tierItemMap = tierItemsByClass.get(actor.subType) ?? new Map();
    const tierPieces  = findTierPieces(event.gear, tierItemMap, trackRanges);

    snapshotRows.push({
      charId:     char.id,
      charName:   char.char_name,
      raidId:     report.code,
      tierCount:  tierPieces.length,
      tierDetail: tierPieces.map(p => `${p.slot}:${p.track}`).join('|'),
      updatedAt:  new Date().toISOString(),
    });
  }
  log.verbose(`[wcl-sync] Report ${report.code}: ${snapshotRows.length} tier snapshot row(s)`);

  // ── Worn BIS ─────────────────────────────────────────────────────────────────
  // Fetch CombatantInfo from the last pull of each boss encounter rather than
  // just the single last fight. This ensures:
  //   • Characters benched for the final boss still get their gear recorded
  //   • Characters who switched specs between bosses get per-spec Worn BIS updated
  // Falls back to fightForSnapshot if no completed boss fights exist yet.
  const completedBossFights = fights.filter(
    f => f.encounterID !== 0 && validEncounterIds.has(f.encounterID) && !f.inProgress,
  );
  const lastPullByBoss = new Map(); // encounterID → last completed fight
  for (const f of completedBossFights) {
    if (!lastPullByBoss.has(f.encounterID) || f.id > lastPullByBoss.get(f.encounterID).id) {
      lastPullByBoss.set(f.encounterID, f);
    }
  }
  const bossLastPulls = lastPullByBoss.size > 0 ? [...lastPullByBoss.values()] : [fightForSnapshot];

  const perBossEvents = await Promise.all(
    bossLastPulls.map(f => getCombatantInfo(report.code, f.id, clientId, clientSecret)),
  );
  const wornBisCombatantEvents = perBossEvents.flat();
  log.verbose(`[wcl-sync] Report ${report.code}: ${wornBisCombatantEvents.length} combatant event(s) across ${bossLastPulls.length} boss fight(s) for Worn BIS`);

  // Build spec-per-charId from all boss combatant events (last event per character wins)
  const specByCharId = new Map();
  for (const event of wornBisCombatantEvents) {
    const actor = actors.find(a => a.id === event.sourceID);
    if (!actor) continue;
    const char = resolveActor(actor, rosterLookup);
    if (!char || !char.id) continue;
    const specFromEvent = event.specID ? WOW_SPEC_ID_TO_NAME[event.specID] : undefined;
    specByCharId.set(char.id, specFromEvent ?? char.spec); // overwrite = last boss wins
  }

  const wornBisRows = extractWornBis(wornBisCombatantEvents, actors, rosterLookup, bisLookup ?? new Map(), itemDbMap ?? new Map(), trackRanges, craftedBonusIds ?? new Set());

  // For slots where BIS is <Tier>, extractWornBis can't match (it doesn't have
  // tierItemsByClass). Pull the track from snapshotRows instead.
  for (const snap of snapshotRows) {
    if (!snap.tierDetail) continue;
    const charSpec   = specByCharId.get(snap.charId) ?? snap.spec ?? '';
    const charBisMap = (bisLookup ?? new Map()).get(`${snap.charId}:${charSpec}`)
                    ?? (bisLookup ?? new Map()).get(`name:${snap.charName.toLowerCase()}`);
    if (!charBisMap) continue;
    for (const piece of snap.tierDetail.split('|').filter(Boolean)) {
      const colonIdx = piece.lastIndexOf(':');
      if (colonIdx < 0) continue;
      const slot  = piece.slice(0, colonIdx);
      const track = piece.slice(colonIdx + 1);
      if (!track || track === 'Unknown') continue;
      const charBis = charBisMap.get(slot);
      if (!charBis) continue;
      const matchesOverall = charBis.trueBis === '<Tier>';
      const matchesRaid    = charBis.raidBis  === '<Tier>';
      if (!matchesOverall && !matchesRaid) continue;
      const key  = `${snap.charId}:${charSpec}:${slot}`;
      const prev = wornBisRows.get(key) ?? { charId: snap.charId, charName: snap.charName, spec: charSpec, slot, overallBISTrack: '', raidBISTrack: '', otherTrack: '' };
      wornBisRows.set(key, {
        ...prev,
        overallBISTrack: matchesOverall ? mergeTrack(prev.overallBISTrack, track) : prev.overallBISTrack,
        raidBISTrack:    matchesRaid    ? mergeTrack(prev.raidBISTrack, track)    : prev.raidBISTrack,
        otherTrack:      mergeTrack(prev.otherTrack, track),
      });
    }
  }
  log.verbose(`[wcl-sync] Report ${report.code}: ${wornBisRows.size} worn BIS entry(s)`);

  // ── Raids + Encounters ───────────────────────────────────────────────────────
  // Filter fights: must be a boss encounter belonging to a configured zone
  const validFights = fights.filter(
    f => f.encounterID !== 0 && validEncounterIds.has(f.encounterID),
  );

  if (!validFights.length) {
    log.verbose(`[wcl-sync] Report ${report.code}: no valid boss fights — skipping raids/encounters`);
    return { snapshotRows, raidRow: null, encounterRows: [], wornBisRows };
  }

  // ── Raids row ────────────────────────────────────────────────────────────────
  const attendeeIds = [...new Set(
    wornBisCombatantEvents
      .map(event => {
        const actor = actors.find(a => a.id === event.sourceID);
        if (!actor) return null;
        return resolveActor(actor, rosterLookup)?.owner_id ?? null;
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

  return { snapshotRows, raidRow, encounterRows, wornBisRows };
}

