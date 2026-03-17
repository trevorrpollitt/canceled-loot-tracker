/**
 * dashboard.js — GET /api/dashboard
 *
 * Returns the logged-in player's loot history and BIS status.
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import { getLootLog, getBisSubmissions, getEffectiveDefaultBis, getItemDb, applyRaidBisInference } from '../../../lib/sheets.js';
import { toCanonical } from '../../../lib/specs.js';

const router = new Hono();

router.get('/', requireAuth, async (c) => {
  const { id: userId, teamSheetId, charName, spec } = c.get('session').user;

  if (!teamSheetId) {
    return c.json({ loot: [], bis: [], noTeam: true });
  }

  try {
    const [lootLog, bisSubmissions, effectiveBis, itemDb] = await Promise.all([
      getLootLog(teamSheetId),
      getBisSubmissions(teamSheetId),
      getEffectiveDefaultBis(),
      getItemDb(),
    ]);

    const itemIdByName = new Map();
    for (const item of itemDb) {
      if (item.name) itemIdByName.set(item.name.toLowerCase(), item.itemId);
    }

    const loot = lootLog
      .filter(e => (e.recipientChar ?? '').toLowerCase() === charName.toLowerCase())
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(e => ({
        ...e,
        itemId: itemIdByName.get((e.itemName ?? '').toLowerCase()) ?? '',
      }));

    const approvedBis = bisSubmissions.filter(
      s => s.charName.toLowerCase() === charName.toLowerCase() && s.status === 'Approved'
    );

    const canonicalSpec = toCanonical(spec);
    const specRows      = effectiveBis.filter(d => d.spec === canonicalSpec);
    const specDefaults  = applyRaidBisInference(specRows, itemDb);

    const allCharNames  = (c.get('session').user.chars ?? []).map(ch => ch.charName);
    const charBisStatus = Object.fromEntries(allCharNames.map(name => [name, {
      pending:  bisSubmissions.filter(s => s.charName.toLowerCase() === name.toLowerCase() && s.status === 'Pending').length,
      rejected: bisSubmissions.filter(s => s.charName.toLowerCase() === name.toLowerCase() && s.status === 'Rejected').length,
    }]));

    return c.json({ loot, bis: approvedBis, specDefaults, charName, charBisStatus });
  } catch (err) {
    console.error('[DASHBOARD] Error:', err);
    return c.json({ error: 'Failed to load dashboard data' }, 500);
  }
});

export default router;
