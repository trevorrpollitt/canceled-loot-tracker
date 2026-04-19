/**
 * routes/loot.js — Loot Log endpoints.
 *
 * GET   /api/loot/history                Officer — per-player loot totals (no itemised loot)
 * GET   /api/loot/history/:charId        Officer — itemised loot for one character (lazy)
 * GET   /api/loot/audit                  Officer — full log grouped by date for audit view
 * PATCH /api/loot/entries/upgrade-type   Officer — patch upgrade_type on entries
 * POST  /api/loot/import                 Officer — import a RCLC CSV export
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getRoster, getRclcResponseMap,
  getLootLog, getLootLogForChar, getLootSummary,
  appendLootEntries, patchLootEntryDifficulties, patchLootEntryUpgradeType, patchLootEntryIgnored,
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

  const [roster, lootLog, lootSummaryRows, raids, config] = await Promise.all([
    getRoster(db, teamId),
    getLootLog(db, teamId),
    getLootSummary(db, teamId),
    getRaids(db, teamId),
    getTeamConfig(db, teamId),
  ]);

  const heroicWeight = parseFloat(config.council_heroic_weight ?? '0.2');
  const normalWeight = parseFloat(config.council_normal_weight ?? '0');
  const nonBisWeight = parseFloat(config.council_nonbis_weight ?? '0.333');

  // Attendance count by Discord user ID
  const raidsByOwner = {};
  for (const raid of raids) for (const id of raid.attendeeIds) raidsByOwner[id] = (raidsByOwner[id] ?? 0) + 1;

  // Pre-aggregated counts from loot_summary — no JS-side aggregation loop needed
  const summaryByChar = new Map(lootSummaryRows.map(s => [s.char_id, s]));

  // Full loot log needed for skipped-entry audit only — itemised loot is lazy-loaded per char
  const charById   = new Map(roster.map(r => [r.id,                      r]));
  const charByName = new Map(roster.map(r => [r.char_name.toLowerCase(), r]));

  const skipped = { wrongDifficulty: [], noRosterMatch: [], tertiary: [], manuallyIgnored: [] };

  for (const e of lootLog) {
    if (e.ignored) {
      skipped.manuallyIgnored.push({ ...e, skipReason: 'Manually ignored' });
      continue;
    }
    if (!TRACKED_DIFF.has(e.difficulty)) {
      skipped.wrongDifficulty.push({ ...e, skipReason: `Difficulty "${e.difficulty || '(blank)'}" not tracked` });
      continue;
    }
    if (!COUNTED.has(e.upgrade_type)) {
      skipped.tertiary.push({ ...e, skipReason: `Upgrade type "${e.upgrade_type}" excluded from loot score` });
      continue;
    }
    const char = (e.recipient_char_id && charById.get(e.recipient_char_id))
      ?? charByName.get((e.recipient_name ?? '').toLowerCase());
    if (!char) {
      skipped.noRosterMatch.push({ ...e, skipReason: `No roster match for "${e.recipient_name}"${e.recipient_char_id ? ` (charId: ${e.recipient_char_id})` : ''}` });
    }
  }

  const players = roster.map(char => {
    const s           = summaryByChar.get(char.id);
    const raidsAttended = raidsByOwner[char.owner_id] ?? 0;

    const bisM    = s?.bis_mythic    ?? 0;
    const bisH    = s?.bis_heroic    ?? 0;
    const bisN    = s?.bis_normal    ?? 0;
    const nonBisM = s?.nonbis_mythic ?? 0;
    const nonBisH = s?.nonbis_heroic ?? 0;
    const nonBisN = s?.nonbis_normal ?? 0;

    const weighted    = bisM + bisH * heroicWeight + bisN * normalWeight
      + (nonBisM + nonBisH * heroicWeight + nonBisN * normalWeight) * nonBisWeight;
    const lootPerRaid = weighted / Math.max(raidsAttended, 1);

    // counts in the legacy shape expected by the client
    const counts = {
      BIS:       { Mythic: bisM,    Heroic: bisH,    Normal: bisN    },
      'Non-BIS': { Mythic: nonBisM, Heroic: nonBisH, Normal: nonBisN },
    };

    return {
      charId: char.id, charName: char.char_name, class: char.class,
      spec: char.spec, status: char.status,
      counts, raidsAttended, lootPerRaid,
      // loot is NOT included here — fetched on demand via GET /api/loot/history/:charId
    };
  });

  players.sort((a, b) => b.lootPerRaid - a.lootPerRaid || a.charName.localeCompare(b.charName));

  const rosterMembers = roster
    .filter(r => r.status === 'Active' || r.status === 'Bench')
    .map(r => ({ charId: r.id, charName: r.char_name, spec: r.spec, status: r.status }))
    .sort((a, b) => a.charName.localeCompare(b.charName));

  return c.json({ players, heroicWeight, normalWeight, nonBisWeight, skipped, rosterMembers });
});

// ── GET /history/:charId ──────────────────────────────────────────────────────
// Lazy-loaded itemised loot for one character — called when a row is expanded.

router.get('/history/:charId', async (c) => {
  if (!c.get('session').user?.isOfficer) {
    return c.json({ error: 'Officer access required.' }, 403);
  }
  const { teamId } = c.get('session').user;
  const charId     = Number(c.req.param('charId'));
  if (!charId) return c.json({ error: 'charId is required' }, 400);
  const db = c.env.DB;
  try {
    const roster   = await getRoster(db, teamId);
    const char     = roster.find(r => r.id === charId);
    if (!char) return c.json({ error: 'Character not found' }, 404);
    const entries  = await getLootLogForChar(db, teamId, charId, char.char_name);
    const loot     = entries
      .filter(e => COUNTED.has(e.upgrade_type))
      .sort((a, b) => b.date.localeCompare(a.date));
    return c.json({ loot });
  } catch (err) {
    console.error('[loot] GET /history/:charId error:', err);
    return c.json({ error: 'Failed to load loot' }, 500);
  }
});

// ── GET /audit ────────────────────────────────────────────────────────────────
// Full loot log for the date-grouped audit view — all entries incl. ignored.

router.get('/audit', async (c) => {
  if (!c.get('session').user?.isOfficer) {
    return c.json({ error: 'Officer access required.' }, 403);
  }
  const { teamId } = c.get('session').user;
  const db = c.env.DB;
  try {
    const [lootLog, roster] = await Promise.all([
      getLootLog(db, teamId),
      getRoster(db, teamId),
    ]);
    const entries = [...lootLog].sort((a, b) =>
      b.date.localeCompare(a.date) || b.id - a.id
    );
    const rosterMembers = roster
      .filter(r => r.status === 'Active' || r.status === 'Bench')
      .map(r => ({ charId: r.id, charName: r.char_name, spec: r.spec, status: r.status }))
      .sort((a, b) => a.charName.localeCompare(b.charName));
    return c.json({ entries, rosterMembers });
  } catch (err) {
    console.error('[LOOT AUDIT]', err);
    return c.json({ error: 'Failed to load loot audit data.' }, 500);
  }
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

  await reassignLootEntries(db, teamId, resolved);
  return c.json({ updated: resolved.length });
});

// ── PATCH /entries/upgrade-type ───────────────────────────────────────────────

router.patch('/entries/upgrade-type', async (c) => {
  if (!c.get('session').user?.isOfficer) {
    return c.json({ error: 'Officer access required.' }, 403);
  }
  const { corrections } = await c.req.json();
  if (!Array.isArray(corrections) || !corrections.length) {
    return c.json({ error: 'corrections must be a non-empty array of { id, upgradeType }.' }, 400);
  }
  const VALID_TYPES = new Set(['BIS', 'Non-BIS', 'Tertiary']);
  const valid = corrections.filter(({ id, upgradeType }) => id && VALID_TYPES.has(upgradeType));
  if (!valid.length) return c.json({ error: 'No valid corrections supplied.' }, 400);
  const db = c.env.DB;
  const { teamId } = c.get('session').user;
  await patchLootEntryUpgradeType(db, teamId, valid);
  return c.json({ updated: valid.length });
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
  const { teamId } = c.get('session').user;
  await patchLootEntryIgnored(db, teamId, ids, ignored);
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
  const { teamId } = c.get('session').user;
  await patchLootEntryDifficulties(db, teamId, valid);
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
