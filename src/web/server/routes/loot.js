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
  getLootLog, appendLootEntries,

} from '../../../lib/sheets.js';
import { parseRclcCsv, buildLootEntries, buildExistingKeys, isRecipeItem } from '../../../lib/rclc.js';

const COUNTED      = new Set(['BIS', 'Non-BIS']);
const TRACKED_DIFF = new Set(['Heroic', 'Mythic']);

const router = new Hono();
router.use('*', requireAuth);

// ── GET /history ──────────────────────────────────────────────────────────────

router.get('/history', async (c) => {
  if (!c.get('session').user?.isOfficer) {
    return c.json({ error: 'Officer access required.' }, 403);
  }

  const { teamSheetId } = c.get('session').user;

  await primeTeamCache(teamSheetId, ['roster', 'lootLog']);

  const [roster, lootLog] = await Promise.all([
    getRoster(teamSheetId),
    getLootLog(teamSheetId),
  ]);

  // Lookup maps for joining loot → roster
  const charById   = new Map(roster.map(r => [r.charId,                    r]));
  const charByName = new Map(roster.map(r => [r.charName.toLowerCase(),    r]));

  // Heroic and Mythic only — loot data is expected to be wiped between seasons
  const entries = lootLog.filter(e => TRACKED_DIFF.has(e.difficulty));

  // Group by character (charId preferred, charName fallback for old rows)
  const grouped = new Map(); // charId → { char, entries[] }
  for (const entry of entries) {
    const char = (entry.recipientCharId && charById.get(entry.recipientCharId))
      ?? charByName.get(entry.recipientChar.toLowerCase());
    if (!char) continue; // pug or deleted roster entry — skip

    if (!grouped.has(char.charId)) grouped.set(char.charId, { char, entries: [] });
    grouped.get(char.charId).entries.push(entry);
  }

  const players = [...grouped.values()].map(({ char, entries: charEntries }) => {
    // Per-difficulty counts for BIS and Non-BIS; flat count for Tertiary
    const counts = { BIS: {}, 'Non-BIS': {}, Tertiary: 0 };
    for (const e of charEntries) {
      if (e.upgradeType === 'Tertiary') {
        counts.Tertiary++;
      } else if (COUNTED.has(e.upgradeType)) {
        const d = e.difficulty || 'Unknown';
        counts[e.upgradeType][d] = (counts[e.upgradeType][d] ?? 0) + 1;
      }
    }

    const total = charEntries.filter(e => COUNTED.has(e.upgradeType)).length;

    // Newest first for the detail panel
    const loot = [...charEntries].sort((a, b) => b.date.localeCompare(a.date));

    return {
      charId:   char.charId,
      charName: char.charName,
      class:    char.class,
      spec:     char.spec,
      status:   char.status,
      counts,
      total,
      loot,
    };
  });

  // Primary sort: counted loot desc. Secondary: charName alpha.
  players.sort((a, b) => b.total - a.total || a.charName.localeCompare(b.charName));

  return c.json({ players });
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

    return c.json({ imported: entries.length, skipped, total: rows.length, warnings });
  } catch (err) {
    console.error('[LOOT IMPORT]', err);
    return c.json({ error: 'Import failed. Check server logs.' }, 500);
  }
});

export default router;
