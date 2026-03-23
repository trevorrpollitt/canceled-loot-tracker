/**
 * dashboard.js — GET /api/dashboard
 *
 * Returns the logged-in player's loot history and BIS status.
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import { getLootLog, getBisSubmissions, getEffectiveDefaultBis, getItemDb, applyRaidBisInference, getWornBis, primeTeamCache, getRoster, getGlobalConfig, getTierItems, upsertWornBis, upsertTierSnapshot } from '../../../lib/sheets.js';
import { toCanonical, getCharSpecs, getArmorType, buildTrackRanges, getItemTrack, mergeTrack } from '../../../lib/specs.js';
import { matchesBis, PAIRED_BIS_SLOTS } from '../../../lib/bis-match.js';
import { parseSimcGear } from '../../../lib/simc.js';

const router = new Hono();

router.get('/', requireAuth, async (c) => {
  const { id: userId, teamSheetId, charId, charName, spec } = c.get('session').user;

  if (!teamSheetId) {
    return c.json({ loot: [], bis: [], noTeam: true });
  }

  try {
    // Batch-load all team sheet tabs in one API call; master sheet reads run in parallel.
    const [, effectiveBis, itemDb] = await Promise.all([
      primeTeamCache(teamSheetId, ['roster', 'lootLog', 'bisSubmissions', 'wornBis']),
      getEffectiveDefaultBis(),
      getItemDb(),
    ]);
    const [roster, lootLog, bisSubmissions, wornBisMap] = await Promise.all([
      getRoster(teamSheetId),
      getLootLog(teamSheetId),
      getBisSubmissions(teamSheetId),
      getWornBis(teamSheetId),
    ]);

    const rosterEntry = roster.find(r =>
      charId && r.charId ? r.charId === charId : r.charName.toLowerCase() === charName.toLowerCase()
    );
    const charSpecs = rosterEntry ? getCharSpecs(rosterEntry) : { primary: spec, secondary: [], pending: null, all: [spec] };

    // ?spec= param allows browsing any of the character's specs on the dashboard
    const requestedSpec = c.req.query('spec') || charSpecs.primary;
    const activeSpec    = charSpecs.all.includes(requestedSpec) ? requestedSpec : charSpecs.primary;

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

    const charApprovedBis = bisSubmissions.filter(s =>
      s.status === 'Approved' &&
      (charId && s.charId ? s.charId === charId : s.charName.toLowerCase() === charName.toLowerCase())
    );

    // BIS data for the requested spec
    const approvedBis = charApprovedBis.filter(s =>
      s.spec ? s.spec.toLowerCase() === activeSpec.toLowerCase() : activeSpec === charSpecs.primary
    );
    const canonicalSpec = toCanonical(activeSpec);
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

    // Build slot→tracks map for the current character + active spec from the Worn BIS sheet
    const wornBis = {};
    for (const row of wornBisMap.values()) {
      if (row.charId !== charId) continue;
      if (row.spec.toLowerCase() !== activeSpec.toLowerCase()) continue;
      wornBis[row.slot] = {
        overallBISTrack: row.overallBISTrack ?? '',
        raidBISTrack:    row.raidBISTrack    ?? '',
        otherTrack:      row.otherTrack      ?? '',
      };
    }

    return c.json({
      loot, bis: approvedBis, specDefaults, charName,
      activeSpec,
      availableSpecs: charSpecs.all.map(s => ({ spec: s, isPrimary: s === charSpecs.primary })),
      charBisStatus, wornBis,
    });
  } catch (err) {
    console.error('[DASHBOARD] Error:', err);
    return c.json({ error: 'Failed to load dashboard data' }, 500);
  }
});

/**
 * POST /api/dashboard/simc
 *
 * Parse a SimulationCraft export and update the character's Worn BIS and
 * Tier Snapshot using the same "best ever seen" logic as WCL sync.
 *
 * Body: { simcText: string, spec: string }
 */
router.post('/simc', requireAuth, async (c) => {
  const { teamSheetId, charId, charName, spec: sessionSpec } = c.get('session').user;
  if (!teamSheetId) return c.json({ error: 'No team' }, 400);

  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const { simcText, spec: requestedSpec } = body ?? {};
  if (!simcText || typeof simcText !== 'string') return c.json({ error: 'simcText is required' }, 400);

  try {
    const [, globalConfig, itemDbRows, tierItemRows, allSubs, effectiveDefaultBis, roster] = await Promise.all([
      primeTeamCache(teamSheetId, ['roster', 'bisSubmissions', 'wornBis', 'tierSnapshot']),
      getGlobalConfig(),
      getItemDb(),
      getTierItems(),
      getBisSubmissions(teamSheetId),
      getEffectiveDefaultBis(),
      getRoster(teamSheetId),
    ]);

    const rosterEntry = roster.find(r =>
      charId && r.charId ? r.charId === charId : r.charName.toLowerCase() === charName.toLowerCase()
    );
    if (!rosterEntry) return c.json({ error: 'Character not found on roster' }, 404);

    const charSpecs  = getCharSpecs(rosterEntry);
    const activeSpec = charSpecs.all.includes(requestedSpec) ? requestedSpec : charSpecs.primary;
    const charClass  = rosterEntry.class;
    const armorType  = getArmorType(toCanonical(activeSpec));

    // Build track ranges and crafted item ID set from global config
    const { wcl_veteran_bonus_id, wcl_crafted_bonus_ids } = globalConfig;
    const trackRanges    = buildTrackRanges(Number(wcl_veteran_bonus_id) || 0);
    const craftedBonusIds = new Set(
      String(wcl_crafted_bonus_ids ?? '').split('|').map(Number).filter(Boolean)
    );

    // Build item DB lookup: itemId (number) → { slot, armorType, isTierToken, name }
    const itemDbMap = new Map();
    for (const row of itemDbRows) itemDbMap.set(Number(row.itemId), row);

    // Build tier items for this character's class: itemId → slot
    const tierItemsForClass = new Map();
    for (const { class: cls, slot, itemId } of tierItemRows) {
      if (cls === charClass) tierItemsForClass.set(Number(itemId), slot);
    }

    // Build BIS slot map for this character + spec (approved submissions > spec defaults)
    const defaultBisBySpec = new Map();
    for (const row of effectiveDefaultBis) {
      if (!defaultBisBySpec.has(row.spec)) defaultBisBySpec.set(row.spec, []);
      defaultBisBySpec.get(row.spec).push(row);
    }
    const charSubs = allSubs.filter(s =>
      s.status === 'Approved' &&
      (charId && s.charId ? s.charId === charId : s.charName.toLowerCase() === charName.toLowerCase())
    );
    const bisSlotMap = new Map(); // slot → { trueBis, trueBisItemId, raidBis, raidBisItemId }
    for (const row of defaultBisBySpec.get(toCanonical(activeSpec)) ?? []) {
      bisSlotMap.set(row.slot, { trueBis: row.trueBis, trueBisItemId: row.trueBisItemId, raidBis: row.raidBis, raidBisItemId: row.raidBisItemId });
    }
    const specSubs = charSubs.filter(s => s.spec ? s.spec === activeSpec : activeSpec === charSpecs.primary);
    for (const sub of specSubs) {
      bisSlotMap.set(sub.slot, { trueBis: sub.trueBis, trueBisItemId: sub.trueBisItemId, raidBis: sub.raidBis, raidBisItemId: sub.raidBisItemId });
    }

    // Parse SimC export
    const gear = parseSimcGear(simcText);
    if (!gear.length) return c.json({ error: 'No gear found in SimC export' }, 400);

    // Process each gear item
    const wornBisMap  = new Map(); // slot → { overallBISTrack, raidBISTrack, otherTrack }
    const tierPieces  = new Map(); // tierSlot → track

    for (const { slot, itemId, bonusIds } of gear) {
      const rawTrack        = getItemTrack(bonusIds, trackRanges);
      const matchedCrafted  = rawTrack === 'Unknown' ? bonusIds.find(id => craftedBonusIds.has(id)) : undefined;
      const isCrafted       = matchedCrafted !== undefined;
      if (rawTrack === 'Unknown' && !isCrafted) continue; // skip unrecognised-track items

      const recordTrack = isCrafted ? 'Crafted' : rawTrack;
      const dbEntry     = itemDbMap.get(itemId);
      const itemShape   = {
        itemId:      String(itemId),
        name:        dbEntry?.name ?? '',
        slot:        dbEntry?.slot ?? '',
        armorType:   dbEntry?.armorType ?? '',
        isTierToken: dbEntry?.isTierToken ?? false,
      };

      // Tier snapshot — non-token tier pieces identified by class-specific item ID list
      const tierSlot = tierItemsForClass.get(itemId);
      if (tierSlot && rawTrack !== 'Unknown') {
        tierPieces.set(tierSlot, mergeTrack(tierPieces.get(tierSlot) ?? '', rawTrack));
      }

      // Check BIS match across paired slots (rings/trinkets cross-match)
      const bisSlots     = PAIRED_BIS_SLOTS[slot] ?? [slot];
      let matchedAnyBis  = false;

      for (const bisSlot of bisSlots) {
        const charBis = bisSlotMap.get(bisSlot);
        if (!charBis) continue;

        const matchesOverall = (isCrafted && charBis.trueBis === '<Crafted>') ||
          charBis.trueBis === '<Catalyst>' ||
          matchesBis(charBis.trueBis, charBis.trueBisItemId, itemShape, armorType, bisSlot);
        const matchesRaid    = (isCrafted && charBis.raidBis === '<Crafted>') ||
          charBis.raidBis === '<Catalyst>' ||
          matchesBis(charBis.raidBis, charBis.raidBisItemId, itemShape, armorType, bisSlot);

        if (!matchesOverall && !matchesRaid) continue;
        matchedAnyBis = true;

        const prev = wornBisMap.get(bisSlot) ?? { overallBISTrack: '', raidBISTrack: '', otherTrack: '' };
        wornBisMap.set(bisSlot, {
          overallBISTrack: matchesOverall ? mergeTrack(prev.overallBISTrack, recordTrack) : prev.overallBISTrack,
          raidBISTrack:    matchesRaid    ? mergeTrack(prev.raidBISTrack,    recordTrack) : prev.raidBISTrack,
          otherTrack:      mergeTrack(prev.otherTrack, recordTrack),
        });
      }

      if (!matchedAnyBis) {
        const prev = wornBisMap.get(slot) ?? { overallBISTrack: '', raidBISTrack: '', otherTrack: '' };
        wornBisMap.set(slot, { ...prev, otherTrack: mergeTrack(prev.otherTrack, recordTrack) });
      }
    }

    // Write worn BIS (upsertWornBis merges best-ever with existing sheet data)
    const wornBisRows = [...wornBisMap.entries()].map(([slot, tracks]) => ({
      charId:   rosterEntry.charId,
      charName: rosterEntry.charName,
      spec:     activeSpec,
      slot,
      ...tracks,
    }));
    if (wornBisRows.length) await upsertWornBis(teamSheetId, wornBisRows);

    // Write tier snapshot (upsertTierSnapshot merges best-ever with existing sheet data)
    if (tierPieces.size) {
      const tierDetail = [...tierPieces.entries()].map(([s, t]) => `${s}:${t}`).join('|');
      await upsertTierSnapshot(teamSheetId, [{
        charId:    rosterEntry.charId,
        charName:  rosterEntry.charName,
        raidId:    'simc-import',
        tierCount: tierPieces.size,
        tierDetail,
        updatedAt: new Date().toISOString(),
      }]);
    }

    return c.json({ updated: wornBisRows.length, tierPieces: tierPieces.size });
  } catch (err) {
    console.error('[DASHBOARD] SimC import error:', err);
    return c.json({ error: 'SimC import failed' }, 500);
  }
});

export default router;
