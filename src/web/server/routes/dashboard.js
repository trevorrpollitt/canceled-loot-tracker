/**
 * dashboard.js — GET /api/dashboard
 *
 * Returns the logged-in player's loot history and BIS status.
 * Loot is filtered by Discord user ID. BIS shows approved personal
 * submissions; slot gaps fall back to spec defaults.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { getLootLog, getBisSubmissions, getEffectiveDefaultBis, getItemDb, applyRaidBisInference } from '../../../lib/sheets.js';
import { toCanonical } from '../../../lib/specs.js';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const { id: userId, teamSheetId, charName, spec } = req.session.user;

  if (!teamSheetId) {
    return res.json({ loot: [], bis: [], noTeam: true });
  }

  try {
    const [lootLog, bisSubmissions, effectiveBis, itemDb] = await Promise.all([
      getLootLog(teamSheetId),
      getBisSubmissions(teamSheetId),
      getEffectiveDefaultBis(teamSheetId),
      getItemDb(teamSheetId),
    ]);

    // Item name → itemId lookup from Item DB (case-insensitive, first match wins)
    const itemIdByName = new Map();
    for (const item of itemDb) {
      if (item.name) itemIdByName.set(item.name.toLowerCase(), item.itemId);
    }

    // Loot history for this character, newest first.
    // Filter by recipientChar (character name) so each character on an account
    // sees only their own loot, not all loot across the account.
    const loot = lootLog
      .filter(e => e.recipientChar === charName)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(e => ({
        ...e,
        itemId: itemIdByName.get((e.itemName ?? '').toLowerCase()) ?? '',
      }));

    // Approved personal BIS for this character
    const approvedBis = bisSubmissions.filter(
      s => s.charName === charName && s.status === 'Approved'
    );

    // Spec defaults from the preferred source (fallback for slots without a personal submission).
    // Session stores the sheet abbreviation (e.g. "Ele Shaman"); Default BIS uses full names.
    const canonicalSpec = toCanonical(spec);
    const specRows      = effectiveBis.filter(d => d.spec === canonicalSpec);
    const specDefaults  = applyRaidBisInference(specRows, itemDb);

    // BIS submission status counts for every character on this account.
    // Used by the character switcher to show pending / rejected indicators.
    const allCharNames  = (req.session.user.chars ?? []).map(c => c.charName);
    const charBisStatus = Object.fromEntries(allCharNames.map(name => [name, {
      pending:  bisSubmissions.filter(s => s.charName === name && s.status === 'Pending').length,
      rejected: bisSubmissions.filter(s => s.charName === name && s.status === 'Rejected').length,
    }]));

    res.json({ loot, bis: approvedBis, specDefaults, charName, charBisStatus });
  } catch (err) {
    console.error('[DASHBOARD] Error:', err);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

export default router;
