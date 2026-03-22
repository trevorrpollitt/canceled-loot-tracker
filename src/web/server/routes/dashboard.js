/**
 * dashboard.js — GET /api/dashboard
 *
 * Returns the logged-in player's loot history and BIS status.
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import { getLootLog, getBisSubmissions, getEffectiveDefaultBis, getItemDb, applyRaidBisInference, getWornBis, primeTeamCache } from '../../../lib/sheets.js';
import { toCanonical } from '../../../lib/specs.js';

const router = new Hono();

router.get('/', requireAuth, async (c) => {
  const { id: userId, teamSheetId, charId, charName, spec } = c.get('session').user;

  if (!teamSheetId) {
    return c.json({ loot: [], bis: [], noTeam: true });
  }

  try {
    // Batch-load all team sheet tabs in one API call; master sheet reads run in parallel.
    const [, effectiveBis, itemDb] = await Promise.all([
      primeTeamCache(teamSheetId, ['lootLog', 'bisSubmissions', 'wornBis']),
      getEffectiveDefaultBis(),
      getItemDb(),
    ]);
    const [lootLog, bisSubmissions, wornBisMap] = await Promise.all([
      getLootLog(teamSheetId),
      getBisSubmissions(teamSheetId),
      getWornBis(teamSheetId),
    ]);

    const itemIdByName = new Map();
    for (const item of itemDb) {
      if (item.name) itemIdByName.set(item.name.toLowerCase(), item.itemId);
    }

    const loot = lootLog
      .filter(e => charId && e.recipientCharId
        ? e.recipientCharId === charId
        : (e.recipientChar ?? '').toLowerCase() === charName.toLowerCase())
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(e => ({
        ...e,
        itemId: itemIdByName.get((e.itemName ?? '').toLowerCase()) ?? '',
      }));

    const approvedBis = bisSubmissions.filter(s =>
      s.status === 'Approved' &&
      (charId && s.charId ? s.charId === charId : s.charName.toLowerCase() === charName.toLowerCase())
    );

    const canonicalSpec = toCanonical(spec);
    const specRows      = effectiveBis.filter(d => d.spec === canonicalSpec);
    const specDefaults  = applyRaidBisInference(specRows, itemDb);

    const allChars      = c.get('session').user.chars ?? [];
    const charBisStatus = Object.fromEntries(allChars.map(ch => [ch.charName, {
      pending:  bisSubmissions.filter(s =>
        s.status === 'Pending' &&
        (ch.charId && s.charId ? s.charId === ch.charId : s.charName.toLowerCase() === ch.charName.toLowerCase())
      ).length,
      rejected: bisSubmissions.filter(s =>
        s.status === 'Rejected' &&
        (ch.charId && s.charId ? s.charId === ch.charId : s.charName.toLowerCase() === ch.charName.toLowerCase())
      ).length,
    }]));

    // Build slot→tracks map for the current character from the Worn BIS sheet
    const wornBis = {};
    for (const [key, row] of wornBisMap) {
      const [rowCharId, ...slotParts] = key.split(':');
      if (rowCharId !== charId) continue;
      const slot = slotParts.join(':');
      wornBis[slot] = {
        overallBISTrack: row.overallBISTrack ?? '',
        raidBISTrack:    row.raidBISTrack    ?? '',
        otherTrack:      row.otherTrack      ?? '',
      };
    }

    return c.json({ loot, bis: approvedBis, specDefaults, charName, charBisStatus, wornBis });
  } catch (err) {
    console.error('[DASHBOARD] Error:', err);
    return c.json({ error: 'Failed to load dashboard data' }, 500);
  }
});

export default router;
