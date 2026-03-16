/**
 * routes/loot.js — Loot Log endpoints.
 *
 * POST /api/loot/import   Officer — import a RCLC CSV export
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getRoster, getRclcResponseMap,
  getLootLog, appendLootEntries,
} from '../../../lib/sheets.js';
import { parseRclcCsv, buildLootEntries, buildExistingKeys } from '../../../lib/rclc.js';

const router = new Hono();
router.use('*', requireAuth);

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
