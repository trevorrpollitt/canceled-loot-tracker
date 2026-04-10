/**
 * dashboard.js — GET /api/dashboard
 *
 * Returns the logged-in player's loot history and BIS status.
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getLootLogForChar, getBisSubmissionsForChar, getEffectiveDefaultBisForSpec,
  getWornBisForChar, getRosterMember, getGlobalConfig, getTierItems,
  upsertWornBis, upsertTierSnapshot,
} from '../../../lib/db.js';
import { toCanonical, getCharSpecs, getArmorType, buildTrackRanges, getItemTrack, mergeTrack } from '../../../lib/specs.js';
import { matchesBis, applyRaidBisInference, PAIRED_BIS_SLOTS } from '../../../lib/bis-match.js';
import { parseSimcGear, parseSimcHeader } from '../../../lib/simc.js';

const router = new Hono();

router.get('/', requireAuth, async (c) => {
  const { id: userId, teamId, charId, charName, spec } = c.get('session').user;

  if (!teamId) {
    return c.json({ loot: [], bis: [], noTeam: true });
  }

  const db = c.env.DB;

  try {
    // Phase 1 — resolve the character's roster entry and active spec
    const rosterEntry   = charId ? await getRosterMember(db, charId) : null;
    const charSpecs     = rosterEntry ? getCharSpecs(rosterEntry) : { primary: spec, secondary: [], pending: null, all: [spec] };
    const requestedSpec = c.req.query('spec') || charSpecs.primary;
    const activeSpec    = charSpecs.all.includes(requestedSpec) ? requestedSpec : charSpecs.primary;
    const canonicalSpec = toCanonical(activeSpec);

    // Phase 2 — all narrow queries in parallel; each scoped to this char/spec
    const [lootLog, bisSubmissions, wornBisMap, effectiveBis] = await Promise.all([
      getLootLogForChar(db, teamId, charId, charName),
      getBisSubmissionsForChar(db, teamId, charId, charName),
      getWornBisForChar(db, charId),
      getEffectiveDefaultBisForSpec(db, canonicalSpec),
    ]);

    const loot = lootLog
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(e => ({
        ...e,
        // item_blizzard_id is pre-joined in getLootLogForChar
        itemId: e.item_blizzard_id ?? '',
      }));

    const charApprovedBis = bisSubmissions.filter(s =>
      s.status === 'Approved' &&
      (charId && s.char_id ? s.char_id === charId : s.char_name.toLowerCase() === charName.toLowerCase())
    );

    const approvedBis = charApprovedBis
      .filter(s => s.spec ? s.spec.toLowerCase() === activeSpec.toLowerCase() : activeSpec === charSpecs.primary)
      .map(s => ({
        slot:          s.slot,
        spec:          s.spec          ?? '',
        status:        s.status        ?? '',
        trueBis:       s.true_bis      ?? '',
        trueBisItemId: s.true_bis_item_id ?? '',
        raidBis:       s.raid_bis      ?? '',
        raidBisItemId: s.raid_bis_item_id ?? '',
        rationale:     s.rationale     ?? '',
        officerNote:   s.officer_note  ?? '',
      }));

    // true_bis_source_type is pre-joined in getEffectiveDefaultBisForSpec — no itemDb needed
    const specDefaults = applyRaidBisInference(effectiveBis);

    const allChars      = c.get('session').user.chars ?? [];
    const allCharSubs   = await Promise.all(
      allChars.map(ch => getBisSubmissionsForChar(db, teamId, ch.charId, ch.charName))
    );
    const charBisStatus = Object.fromEntries(allChars.map((ch, i) => [ch.charName, {
      pending:  allCharSubs[i].filter(s => s.status === 'Pending').length,
      rejected: allCharSubs[i].filter(s => s.status === 'Rejected').length,
    }]));

    // Build slot→tracks map for the current character + active spec from Worn BIS
    const wornBis = {};
    for (const [key, row] of wornBisMap) {
      if (row.spec.toLowerCase() !== activeSpec.toLowerCase()) continue;
      wornBis[row.slot] = {
        overallBISTrack: row.overall_bis_track ?? '',
        raidBISTrack:    row.raid_bis_track    ?? '',
        otherTrack:      row.other_track       ?? '',
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
  const { teamId, charId, charName, spec: sessionSpec } = c.get('session').user;
  if (!teamId) return c.json({ error: 'No team' }, 400);

  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const { simcText, spec: requestedSpec } = body ?? {};
  if (!simcText || typeof simcText !== 'string') return c.json({ error: 'simcText is required' }, 400);

  const db = c.env.DB;

  try {
    const [globalConfig, itemDbRows, tierItemRows, allSubs, effectiveDefaultBis, roster] = await Promise.all([
      getGlobalConfig(db),
      getItemDb(db),
      getTierItems(db),
      getBisSubmissions(db, teamId),
      getEffectiveDefaultBis(db),
      getRoster(db, teamId),
    ]);

    const rosterEntry = roster.find(r =>
      charId ? r.id === charId : r.char_name.toLowerCase() === charName.toLowerCase()
    );
    if (!rosterEntry) return c.json({ error: 'Character not found on roster' }, 404);

    const charSpecs  = getCharSpecs(rosterEntry);
    const activeSpec = charSpecs.all.includes(requestedSpec) ? requestedSpec : charSpecs.primary;
    const charClass  = rosterEntry.class;
    const armorType  = getArmorType(toCanonical(activeSpec));

    const { wcl_veteran_bonus_id, wcl_crafted_bonus_ids } = globalConfig;
    const trackRanges    = buildTrackRanges(Number(wcl_veteran_bonus_id) || 0);
    const craftedBonusIds = new Set(
      String(wcl_crafted_bonus_ids ?? '').split('|').map(Number).filter(Boolean)
    );

    const itemDbMap = new Map();
    for (const row of itemDbRows) itemDbMap.set(Number(row.item_id), row);

    const tierItemsForClass = new Map();
    for (const { class: cls, slot, item_id } of tierItemRows) {
      if (cls === charClass) tierItemsForClass.set(Number(item_id), slot);
    }

    const defaultBisBySpec = new Map();
    for (const row of effectiveDefaultBis) {
      if (!defaultBisBySpec.has(row.spec)) defaultBisBySpec.set(row.spec, []);
      defaultBisBySpec.get(row.spec).push(row);
    }
    const charSubs = allSubs.filter(s =>
      s.status === 'Approved' &&
      (charId && s.char_id ? s.char_id === charId : s.char_name.toLowerCase() === charName.toLowerCase())
    );
    const bisSlotMap = new Map();
    for (const row of defaultBisBySpec.get(toCanonical(activeSpec)) ?? []) {
      bisSlotMap.set(row.slot, { trueBis: row.true_bis, trueBisItemId: row.true_bis_item_id, raidBis: row.raid_bis, raidBisItemId: row.raid_bis_item_id });
    }
    const specSubs = charSubs.filter(s => s.spec ? s.spec === activeSpec : activeSpec === charSpecs.primary);
    for (const sub of specSubs) {
      bisSlotMap.set(sub.slot, { trueBis: sub.true_bis, trueBisItemId: sub.true_bis_item_id, raidBis: sub.raid_bis, raidBisItemId: sub.raid_bis_item_id });
    }

    const gear = parseSimcGear(simcText);
    if (!gear.length) return c.json({ error: 'No gear found in SimC export' }, 400);

    const simcHeader = parseSimcHeader(simcText);
    if (simcHeader) {
      const nameMatch = simcHeader.charName.toLowerCase() === rosterEntry.char_name.toLowerCase();
      if (!nameMatch) {
        return c.json({
          error: `SimC profile is for "${simcHeader.charName}" but you are importing for "${rosterEntry.char_name}". Please export the correct character.`,
        }, 400);
      }
      if (simcHeader.spec && simcHeader.spec.toLowerCase() !== toCanonical(activeSpec).toLowerCase()) {
        return c.json({
          error: `SimC profile is for ${simcHeader.spec} but the selected spec is ${activeSpec}. Please export the correct spec or switch specs before importing.`,
        }, 400);
      }
    }

    const wornBisMap  = new Map();
    const tierPieces  = new Map();

    for (const { slot, itemId, bonusIds } of gear) {
      const rawTrack       = getItemTrack(bonusIds, trackRanges);
      const matchedCrafted = rawTrack === 'Unknown' ? bonusIds.find(id => craftedBonusIds.has(id)) : undefined;
      const isCrafted      = matchedCrafted !== undefined;
      if (rawTrack === 'Unknown' && !isCrafted) continue;

      const recordTrack = isCrafted ? 'Crafted' : rawTrack;
      const dbEntry     = itemDbMap.get(itemId);
      const itemShape   = {
        itemId:      String(itemId),
        name:        dbEntry?.name ?? '',
        slot:        dbEntry?.slot ?? '',
        armorType:   dbEntry?.armor_type ?? '',
        isTierToken: dbEntry?.is_tier_token === 1,
      };

      const tierSlot = tierItemsForClass.get(itemId);
      if (tierSlot && rawTrack !== 'Unknown') {
        tierPieces.set(tierSlot, mergeTrack(tierPieces.get(tierSlot) ?? '', rawTrack));
      }

      const bisSlots    = PAIRED_BIS_SLOTS[slot] ?? [slot];
      let matchedAnyBis = false;

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

    for (const [tierSlot, track] of tierPieces) {
      const charBis = bisSlotMap.get(tierSlot);
      if (!charBis) continue;
      const matchesOverall = charBis.trueBis === '<Tier>';
      const matchesRaid    = charBis.raidBis  === '<Tier>';
      if (!matchesOverall && !matchesRaid) continue;
      const prev = wornBisMap.get(tierSlot) ?? { overallBISTrack: '', raidBISTrack: '', otherTrack: '' };
      wornBisMap.set(tierSlot, {
        overallBISTrack: matchesOverall ? mergeTrack(prev.overallBISTrack, track) : prev.overallBISTrack,
        raidBISTrack:    matchesRaid    ? mergeTrack(prev.raidBISTrack,    track) : prev.raidBISTrack,
        otherTrack:      mergeTrack(prev.otherTrack, track),
      });
    }

    const updatedAt  = new Date().toISOString();
    const wornBisRows = [...wornBisMap.entries()].map(([slot, tracks]) => ({
      charId:   rosterEntry.id,
      spec:     activeSpec,
      slot,
      updatedAt,
      ...tracks,
    }));
    if (wornBisRows.length) await upsertWornBis(db, teamId, wornBisRows);

    if (tierPieces.size) {
      const tierDetail = [...tierPieces.entries()].map(([s, t]) => `${s}:${t}`).join('|');
      await upsertTierSnapshot(db, teamId, [{
        charId:    rosterEntry.id,
        raidId:    null,
        tierCount: tierPieces.size,
        tierDetail,
        updatedAt,
      }]);
    }

    return c.json({ updated: wornBisRows.length, tierPieces: tierPieces.size });
  } catch (err) {
    console.error('[DASHBOARD] SimC import error:', err);
    return c.json({ error: 'SimC import failed' }, 500);
  }
});

export default router;
