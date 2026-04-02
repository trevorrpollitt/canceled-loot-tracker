/**
 * routes/loot.js — Loot Log endpoints.
 *
 * GET  /api/loot/history   Officer — per-player loot totals + itemised history
 * POST /api/loot/import    Officer — import a RCLC CSV export
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getRoster, getRclcResponseMap,
  getLootLog, appendLootEntries, patchLootEntryDifficulties, patchLootEntryIgnored,
  reassignLootEntries, backfillLootEntryIds, getRaids,
  getTeamConfig,
} from '../../../lib/db.js';
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

  const { teamId } = c.get('session').user;
  const db = c.env.DB;

  const [roster, lootLog, raids, config] = await Promise.all([
    getRoster(db, teamId),
    getLootLog(db, teamId),
    getRaids(db, teamId),
    getTeamConfig(db, teamId),
  ]);

  const heroicWeight = parseFloat(config.council_heroic_weight ?? '0.2');
  const normalWeight = parseFloat(config.council_normal_weight ?? '0');
  const nonBisWeight = parseFloat(config.council_nonbis_weight ?? '0.333');

  // Attendance count by Discord user ID
  const raidsByOwner = {};
  for (const raid of raids) for (const id of raid.attendeeIds) raidsByOwner[id] = (raidsByOwner[id] ?? 0) + 1;

  // Lookup maps for joining loot → roster
  const charById   = new Map(roster.map(r => [r.id,                          r]));
  const charByName = new Map(roster.map(r => [r.char_name.toLowerCase(),     r]));

  const skipped = { wrongDifficulty: [], noRosterMatch: [], tertiary: [], manuallyIgnored: [] };

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
  const grouped = new Map();
  for (const char of roster) grouped.set(char.id, { char, entries: [] });

  for (const entry of entries) {
    const char = (entry.recipient_char_id && charById.get(entry.recipient_char_id))
      ?? charByName.get((entry.recipient_name ?? '').toLowerCase());
    if (!char) {
      skipped.noRosterMatch.push({ ...entry, skipReason: `No roster match for "${entry.recipient_name}"${entry.recipient_char_id ? ` (charId: ${entry.recipient_char_id})` : ''}` });
      continue;
    }

    if (!grouped.has(char.id)) grouped.set(char.id, { char, entries: [] });
    grouped.get(char.id).entries.push(entry);
  }

  const players = [...grouped.values()].map(({ char, entries: charEntries }) => {
    const counts = { BIS: {}, 'Non-BIS': {} };
    for (const e of charEntries) {
      if (COUNTED.has(e.upgrade_type)) {
        const d = e.difficulty || 'Unknown';
        counts[e.upgrade_type][d] = (counts[e.upgrade_type][d] ?? 0) + 1;
      }
    }

    const raidsAttended = raidsByOwner[char.owner_id] ?? 0;

    const bisM    = counts.BIS['Mythic']        ?? 0;
    const bisH    = counts.BIS['Heroic']        ?? 0;
    const bisN    = counts.BIS['Normal']        ?? 0;
    const nonBisM = counts['Non-BIS']['Mythic'] ?? 0;
    const nonBisH = counts['Non-BIS']['Heroic'] ?? 0;
    const nonBisN = counts['Non-BIS']['Normal'] ?? 0;
    const weighted = bisM + bisH * heroicWeight + bisN * normalWeight
      + (nonBisM + nonBisH * heroicWeight + nonBisN * normalWeight) * nonBisWeight;
    const lootPerRaid = weighted / Math.max(raidsAttended, 1);

    for (const e of charEntries) {
      if (!COUNTED.has(e.upgrade_type)) {
        skipped.tertiary.push({ ...e, skipReason: `Upgrade type "${e.upgrade_type}" excluded from loot score` });
      }
    }

    const loot = [...charEntries]
      .filter(e => COUNTED.has(e.upgrade_type))
      .sort((a, b) => b.date.localeCompare(a.date));

    return {
      charId:       char.id,
      charName:     char.char_name,
      class:        char.class,
      spec:         char.spec,
      status:       char.status,
      counts,
      raidsAttended,
      lootPerRaid,
      loot,
    };
  });

  players.sort((a, b) => b.lootPerRaid - a.lootPerRaid || a.charName.localeCompare(b.charName));

  const rosterMembers = roster
    .filter(r => r.status === 'Active' || r.status === 'Bench')
    .map(r => ({ charId: r.id, charName: r.char_name, spec: r.spec, status: r.status }))
    .sort((a, b) => a.charName.localeCompare(b.charName));

  return c.json({ players, heroicWeight, normalWeight, nonBisWeight, skipped, rosterMembers });
});

// ── POST /reprocess ───────────────────────────────────────────────────────────

router.post('/reprocess', async (c) => {
  if (!c.get('session').user?.isOfficer) {
    return c.json({ error: 'Officer access required.' }, 403);
  }
  const { teamId } = c.get('session').user;
  const db = c.env.DB;
  await backfillLootEntryIds(db, teamId);
  return c.json({ ok: true });
});

// ── PATCH /entries/reassign ───────────────────────────────────────────────────

router.patch('/entries/reassign', async (c) => {
  if (!c.get('session').user?.isOfficer) {
    return c.json({ error: 'Officer access required.' }, 403);
  }
  const { assignments } = await c.req.json();
  if (!Array.isArray(assignments) || !assignments.length) {
    return c.json({ error: 'assignments must be a non-empty array of { id, charId }.' }, 400);
  }

  const { teamId } = c.get('session').user;
  const db = c.env.DB;
  const roster   = await getRoster(db, teamId);
  const charById = new Map(roster.map(r => [r.id, r]));

  const resolved = assignments
    .map(({ id, charId }) => {
      const char = charById.get(Number(charId));
      return char ? { id: Number(id), rosterId: char.id } : null;
    })
    .filter(Boolean);

  if (!resolved.length) return c.json({ error: 'No valid charIds found in roster.' }, 400);

  await reassignLootEntries(db, resolved);
  return c.json({ updated: resolved.length });
});

// ── PATCH /ignored ────────────────────────────────────────────────────────────

router.patch('/ignored', async (c) => {
  if (!c.get('session').user?.isOfficer) {
    return c.json({ error: 'Officer access required.' }, 403);
  }
  const { ids, ignored } = await c.req.json();
  if (!Array.isArray(ids) || !ids.length || typeof ignored !== 'boolean') {
    return c.json({ error: 'ids (number[]) and ignored (boolean) are required.' }, 400);
  }
  const db = c.env.DB;
  await patchLootEntryIgnored(db, ids, ignored);
  return c.json({ updated: ids.length });
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
  const valid = corrections.filter(({ id, difficulty }) => id && VALID_DIFF.has(difficulty));
  if (!valid.length) {
    return c.json({ error: 'No valid corrections supplied.' }, 400);
  }

  const db = c.env.DB;
  await patchLootEntryDifficulties(db, valid);
  return c.json({ updated: valid.length });
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
    const { teamId } = c.get('session').user;
    const db = c.env.DB;
    const rows = parseRclcCsv(csvText);
    if (!rows.length) return c.json({ error: 'CSV appears to be empty or invalid.' }, 400);

    const [roster, responseMap, existingLog] = await Promise.all([
      getRoster(db, teamId),
      getRclcResponseMap(db, teamId),
      getLootLog(db, teamId),
    ]);

    // rclc.js expects roster/lootLog with camelCase fields — adapt the D1 snake_case rows
    const rosterForRclc = roster.map(r => ({
      charId:   r.id,
      charName: r.char_name,
      class:    r.class,
      spec:     r.spec,
      ownerId:  r.owner_id,
      server:   r.server,
      status:   r.status,
    }));
    const lootLogForRclc = existingLog.map(e => ({
      id:              e.id,
      date:            e.date,
      boss:            e.boss,
      itemName:        e.item_name,
      difficulty:      e.difficulty,
      recipientId:     e.recipient_id,
      recipientChar:   e.recipient_name,
      recipientCharId: e.recipient_char_id,
      upgradeType:     e.upgrade_type,
      notes:           e.notes,
    }));

    const existingKeys = buildExistingKeys(lootLogForRclc);
    const { entries, warnings, skipped } = buildLootEntries(rows, rosterForRclc, responseMap, existingKeys);

    if (entries.length) await appendLootEntries(db, teamId, entries);

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
