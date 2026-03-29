/**
 * routes/loot.js — Loot Log endpoints.
 *
 * GET  /api/loot/history   Officer — per-player loot totals + itemised history
 * POST /api/loot/import    Officer — import a RCLC CSV export
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  primeTeamCache,
  getRoster, getRclcResponseMap,
  getLootLog, appendLootEntries, patchLootEntryDifficulties, patchLootEntryIgnored,
  reassignLootEntries, backfillLootEntryIds, getRaids,
  getConfig,
} from '../../../lib/sheets.js';
import { parseRclcCsv, buildLootEntries, buildExistingKeys, isRecipeItem } from '../../../lib/rclc.js';

const COUNTED      = new Set(['BIS', 'Non-BIS']);
const TRACKED_DIFF = new Set(['Normal', 'Heroic', 'Mythic']);

const router = new Hono();
router.use('*', requireAuth);

// ── GET /history ──────────────────────────────────────────────────────────────

router.get('/history', async (c) => {
  if (!c.get('session').user?.isOfficer) {
    return c.json({ error: 'Officer access required.' }, 403);
  }

  const { teamSheetId } = c.get('session').user;

  await primeTeamCache(teamSheetId, ['roster', 'lootLog', 'raids', 'config']);

  const [roster, lootLog, raids, config] = await Promise.all([
    getRoster(teamSheetId),
    getLootLog(teamSheetId),
    getRaids(teamSheetId),
    getConfig(teamSheetId),
  ]);

  const heroicWeight = parseFloat(config.council_heroic_weight ?? '0.2');
  const normalWeight = parseFloat(config.council_normal_weight ?? '0');
  const nonBisWeight = parseFloat(config.council_nonbis_weight ?? '0.333');

  // Attendance count by Discord user ID
  const raidsByOwner = {};
  for (const raid of raids) for (const id of raid.attendeeIds) raidsByOwner[id] = (raidsByOwner[id] ?? 0) + 1;

  // Lookup maps for joining loot → roster
  const charById   = new Map(roster.map(r => [r.charId,                    r]));
  const charByName = new Map(roster.map(r => [r.charName.toLowerCase(),    r]));

  // Track skipped rows for diagnostic display
  const skipped = { wrongDifficulty: [], noRosterMatch: [], tertiary: [], manuallyIgnored: [] };

  // Normal/Heroic/Mythic only — loot data is expected to be wiped between seasons
  const entries = [];
  for (const e of lootLog) {
    if (e.ignored) {
      skipped.manuallyIgnored.push({ ...e, skipReason: 'Manually ignored' });
      continue;
    }
    if (!TRACKED_DIFF.has(e.difficulty)) {
      skipped.wrongDifficulty.push({ ...e, skipReason: `Difficulty "${e.difficulty || '(blank)'}" not tracked` });
    } else {
      entries.push(e);
    }
  }

  // Seed every roster member so characters with no loot still appear
  const grouped = new Map(); // charId → { char, entries[] }
  for (const char of roster) grouped.set(char.charId, { char, entries: [] });

  for (const entry of entries) {
    const char = (entry.recipientCharId && charById.get(entry.recipientCharId))
      ?? charByName.get(entry.recipientChar.toLowerCase());
    if (!char) {
      skipped.noRosterMatch.push({ ...entry, skipReason: `No roster match for "${entry.recipientChar}"${entry.recipientCharId ? ` (charId: ${entry.recipientCharId})` : ''}` });
      continue;
    }

    if (!grouped.has(char.charId)) grouped.set(char.charId, { char, entries: [] });
    grouped.get(char.charId).entries.push(entry);
  }

  const players = [...grouped.values()].map(({ char, entries: charEntries }) => {
    // Per-difficulty counts for BIS and Non-BIS (Tertiary excluded from display)
    const counts = { BIS: {}, 'Non-BIS': {} };
    for (const e of charEntries) {
      if (COUNTED.has(e.upgradeType)) {
        const d = e.difficulty || 'Unknown';
        counts[e.upgradeType][d] = (counts[e.upgradeType][d] ?? 0) + 1;
      }
    }

    const raidsAttended = raidsByOwner[char.ownerId] ?? 0;

    // Same weighted formula as the council loot-density multiplier
    const bisM    = counts.BIS['Mythic']        ?? 0;
    const bisH    = counts.BIS['Heroic']        ?? 0;
    const bisN    = counts.BIS['Normal']        ?? 0;
    const nonBisM = counts['Non-BIS']['Mythic'] ?? 0;
    const nonBisH = counts['Non-BIS']['Heroic'] ?? 0;
    const nonBisN = counts['Non-BIS']['Normal'] ?? 0;
    const weighted = bisM + bisH * heroicWeight + bisN * normalWeight
      + (nonBisM + nonBisH * heroicWeight + nonBisN * normalWeight) * nonBisWeight;
    const lootPerRaid = weighted / Math.max(raidsAttended, 1);

    // Collect Tertiary rows into skipped (only once — use char's first pass)
    for (const e of charEntries) {
      if (!COUNTED.has(e.upgradeType)) {
        skipped.tertiary.push({ ...e, skipReason: `Upgrade type "${e.upgradeType}" excluded from loot score` });
      }
    }

    // Newest first for the detail panel; exclude Tertiary
    const loot = [...charEntries]
      .filter(e => COUNTED.has(e.upgradeType))
      .sort((a, b) => b.date.localeCompare(a.date));

    return {
      charId:       char.charId,
      charName:     char.charName,
      class:        char.class,
      spec:         char.spec,
      status:       char.status,
      counts,
      raidsAttended,
      lootPerRaid,
      loot,
    };
  });

  // Primary sort: lootPerRaid desc. Secondary: charName alpha.
  players.sort((a, b) => b.lootPerRaid - a.lootPerRaid || a.charName.localeCompare(b.charName));

  // Send active + bench roster so the client can populate the reassignment dropdown
  const rosterMembers = roster
    .filter(r => r.status === 'Active' || r.status === 'Bench')
    .map(r => ({ charId: r.charId, charName: r.charName, spec: r.spec, status: r.status }))
    .sort((a, b) => a.charName.localeCompare(b.charName));

  return c.json({ players, heroicWeight, normalWeight, nonBisWeight, skipped, rosterMembers });
});

// ── POST /reprocess ───────────────────────────────────────────────────────────
// Re-runs the roster ID backfill over the entire loot log. Call this after adding
// missing roster entries so that previously-unresolvable rows get their CharId and
// RecipientId populated without a full sheet migration run.

router.post('/reprocess', async (c) => {
  if (!c.get('session').user?.isOfficer) {
    return c.json({ error: 'Officer access required.' }, 403);
  }
  const { teamSheetId } = c.get('session').user;
  const result = await backfillLootEntryIds(teamSheetId);
  return c.json(result);
});

// ── PATCH /entries/reassign ───────────────────────────────────────────────────
// Manually reassign loot entries to a specific roster character (rename fix).

router.patch('/entries/reassign', async (c) => {
  if (!c.get('session').user?.isOfficer) {
    return c.json({ error: 'Officer access required.' }, 403);
  }
  const { assignments } = await c.req.json();
  if (!Array.isArray(assignments) || !assignments.length) {
    return c.json({ error: 'assignments must be a non-empty array of { id, charId }.' }, 400);
  }

  const { teamSheetId } = c.get('session').user;
  const roster  = await getRoster(teamSheetId);
  const charById = new Map(roster.map(r => [r.charId, r]));

  const resolved = assignments
    .map(({ id, charId }) => {
      const char = charById.get(charId);
      return char ? { id, charId, charName: char.charName, ownerId: char.ownerId } : null;
    })
    .filter(Boolean);

  if (!resolved.length) return c.json({ error: 'No valid charIds found in roster.' }, 400);

  const updated = await reassignLootEntries(teamSheetId, resolved);
  return c.json({ updated });
});

// ── PATCH /ignored ────────────────────────────────────────────────────────────
// Set or clear the Ignored flag (col L) for a list of entry IDs.

router.patch('/ignored', async (c) => {
  if (!c.get('session').user?.isOfficer) {
    return c.json({ error: 'Officer access required.' }, 403);
  }
  const { ids, ignored } = await c.req.json();
  if (!Array.isArray(ids) || !ids.length || typeof ignored !== 'boolean') {
    return c.json({ error: 'ids (string[]) and ignored (boolean) are required.' }, 400);
  }
  const { teamSheetId } = c.get('session').user;
  const updated = await patchLootEntryIgnored(teamSheetId, ids, ignored);
  return c.json({ updated });
});

// ── PATCH /entries ────────────────────────────────────────────────────────────

router.patch('/entries', async (c) => {
  if (!c.get('session').user?.isOfficer) {
    return c.json({ error: 'Officer access required.' }, 403);
  }

  const { corrections } = await c.req.json();
  if (!Array.isArray(corrections) || !corrections.length) {
    return c.json({ error: 'corrections must be a non-empty array of { id, difficulty }.' }, 400);
  }

  const VALID_DIFF = new Set(['Normal', 'Heroic', 'Mythic']);
  const correctionById = new Map();
  for (const { id, difficulty } of corrections) {
    if (id && VALID_DIFF.has(difficulty)) correctionById.set(id, difficulty);
  }
  if (!correctionById.size) {
    return c.json({ error: 'No valid corrections supplied.' }, 400);
  }

  const { teamSheetId } = c.get('session').user;
  const updated = await patchLootEntryDifficulties(teamSheetId, correctionById);
  if (!updated) return c.json({ error: 'No matching loot log entries found.' }, 404);

  return c.json({ updated });
});

// ── POST /import ──────────────────────────────────────────────────────────────

router.post('/import', async (c) => {
  if (!c.get('session').user?.isOfficer) {
    return c.json({ error: 'Officer access required.' }, 403);
  }

  const { csvText } = await c.req.json();
  if (!csvText || typeof csvText !== 'string') {
    return c.json({ error: 'csvText is required.' }, 400);
  }

  try {
    const { teamSheetId } = c.get('session').user;
    const rows = parseRclcCsv(csvText);
    if (!rows.length) return c.json({ error: 'CSV appears to be empty or invalid.' }, 400);

    const [roster, responseMap, existingLog] = await Promise.all([
      getRoster(teamSheetId),
      getRclcResponseMap(teamSheetId),
      getLootLog(teamSheetId),
    ]);

    const existingKeys = buildExistingKeys(existingLog);
    const { entries, warnings, skipped } = buildLootEntries(rows, roster, responseMap, existingKeys);

    if (entries.length) await appendLootEntries(teamSheetId, entries);

    // Count error rows among the newly imported entries so the UI can warn the user
    const errorRows = {
      noRosterMatch:   entries.filter(e => !e.recipientCharId).length,
      wrongDifficulty: entries.filter(e => !TRACKED_DIFF.has(e.difficulty)).length,
    };

    return c.json({ imported: entries.length, skipped, total: rows.length, warnings, errorRows });
  } catch (err) {
    console.error('[LOOT IMPORT]', err);
    return c.json({ error: 'Import failed. Check server logs.' }, 500);
  }
});

export default router;
