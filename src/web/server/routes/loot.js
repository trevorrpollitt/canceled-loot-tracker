/**
 * routes/loot.js — Loot Log endpoints.
 *
 * POST /api/loot/import   Officer — import a RCLC CSV export
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getRoster, getRclcResponseMap,
  getLootLog, appendLootEntries,
} from '../../../lib/sheets.js';
import { parseRclcCsv, buildLootEntries, buildExistingKeys } from '../../../lib/rclc.js';

const router = Router();
router.use(requireAuth);

// ── POST /api/loot/import ─────────────────────────────────────────────────────

router.post('/import', async (req, res) => {
  if (!req.session.user?.isOfficer) {
    return res.status(403).json({ error: 'Officer access required.' });
  }

  const { csvText } = req.body;
  if (!csvText || typeof csvText !== 'string') {
    return res.status(400).json({ error: 'csvText is required.' });
  }

  try {
    const { teamSheetId } = req.session.user;

    const rows = parseRclcCsv(csvText);
    if (!rows.length) {
      return res.status(400).json({ error: 'CSV appears to be empty or invalid.' });
    }

    const [roster, responseMap, existingLog] = await Promise.all([
      getRoster(teamSheetId),
      getRclcResponseMap(teamSheetId),
      getLootLog(teamSheetId),
    ]);

    const existingKeys = buildExistingKeys(existingLog);
    const { entries, warnings, skipped } = buildLootEntries(rows, roster, responseMap, existingKeys);

    if (entries.length) {
      await appendLootEntries(teamSheetId, entries);
    }

    res.json({
      imported: entries.length,
      skipped,
      total:    rows.length,
      warnings,
    });
  } catch (err) {
    console.error('[LOOT IMPORT]', err);
    res.status(500).json({ error: 'Import failed. Check server logs.' });
  }
});

export default router;
