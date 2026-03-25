/**
 * council.js — Loot council routes (all team members).
 *
 * GET /api/council/items
 * GET /api/council/candidates?itemId=<id>
 * GET /api/council/curio-candidates
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getItemDb, getRoster, getLootLog, getBisSubmissions,
  getEffectiveDefaultBis, getRaids, getConfig, getTierSnapshot,
  getWornBis, primeTeamCache,
} from '../../../lib/sheets.js';
import { toCanonical, getArmorType, canUseWeapon, getCharSpecs } from '../../../lib/specs.js';
import { matchesBis } from '../../../lib/bis-match.js';
import { log } from '../../../lib/logger.js';

const router = new Hono();
router.use('*', requireAuth);

/** Parse "Head:Mythic|Chest:Hero" → { Head: 'Mythic', Chest: 'Hero' } */
function parseTierDetail(detail) {
  const map = {};
  for (const piece of (detail ?? '').split('|').filter(Boolean)) {
    const [slot, track] = piece.split(':');
    if (slot) map[slot] = track ?? 'Unknown';
  }
  return map;
}

// Ring and Trinket items are stored without a number in the Item DB ("Ring", "Trinket")
// but Worn BIS uses the numbered slot names ("Ring 1", "Ring 2", "Trinket 1", "Trinket 2").
const SLOT_EXPANSIONS = { Ring: ['Ring 1', 'Ring 2'], Trinket: ['Trinket 1', 'Trinket 2'] };
const TRACK_ORDER = { '': -1, Crafted: 0, Veteran: 1, Champion: 2, Hero: 3, Mythic: 4 };

function mergeTrack(a, b) {
  return (TRACK_ORDER[a] ?? -1) >= (TRACK_ORDER[b] ?? -1) ? a : b;
}

function getWornTracksForSlot(wornBisMap, charId, spec, itemSlot) {
  const slots = SLOT_EXPANSIONS[itemSlot] ?? [itemSlot];
  const best  = { overallBISTrack: '', raidBISTrack: '', otherTrack: '' };
  for (const slot of slots) {
    const w = wornBisMap.get(`${charId}:${spec}:${slot}`);
    if (!w) continue;
    best.overallBISTrack = mergeTrack(best.overallBISTrack, w.overallBISTrack);
    best.raidBISTrack    = mergeTrack(best.raidBISTrack,    w.raidBISTrack);
    best.otherTrack      = mergeTrack(best.otherTrack,      w.otherTrack);
  }
  return best;
}

function isEligible(item, charArmorType, canonSpec) {
  if (item.slot === 'Weapon' || item.slot === 'Off-Hand') return canUseWeapon(canonSpec, item.weaponType);
  if (item.armorType === 'Accessory' || item.armorType === 'Tier Token') return true;
  return charArmorType === item.armorType;
}

/**
 * Compute BIS match fields for a single (char, spec, item) combination.
 * @returns {{ overallBisMatch, raidBisMatch, hasRaidBis, effectiveTrueBis }}
 */
function computeSpecBisMatch(charKey, spec, item, itemSlot, approvedBis, defaultBisMap) {
  const canonSpec  = toCanonical(spec);
  const armorType  = getArmorType(canonSpec);

  // For paired slots (Ring, Trinket) a character has separate BIS entries for slot 1 and slot 2.
  // We must check ALL slot variants and return the best match across them — stopping at the first
  // variant would miss a match in the other slot (e.g. Trinket 1 has a non-match but Trinket 2 has one).
  const slotVariants = [itemSlot, itemSlot + ' 1', itemSlot + ' 2'];

  const matchRank = v => v === true ? 3 : v === 'catalyst' ? 2 : v === 'crafted' ? 1 : 0;

  let overallBisMatch  = false;
  let raidBisMatch     = false;
  let hasRaidBis       = false;
  let effectiveTrueBis = '';

  for (const slotVar of slotVariants) {
    const sub = approvedBis[charKey + '|' + slotVar];
    if (sub?.spec && sub.spec.toLowerCase() !== spec.toLowerCase()) continue;

    const defRow = defaultBisMap[canonSpec + '|' + slotVar] ?? null;

    const trueBis   = sub?.trueBis       ?? defRow?.trueBis       ?? '';
    const trueBisId = sub?.trueBisItemId  ?? defRow?.trueBisItemId  ?? '';
    const raidBis   = sub?.raidBis       ?? defRow?.raidBis       ?? '';
    const raidBisId = sub?.raidBisItemId  ?? defRow?.raidBisItemId  ?? '';

    if (!trueBis && !raidBis) continue;
    if (!effectiveTrueBis) effectiveTrueBis = trueBis;

    let slotOvMatch;
    if      (trueBis === '<Crafted>')  slotOvMatch = 'crafted';
    else if (trueBis === '<Catalyst>') slotOvMatch = 'catalyst';
    else if (trueBis)                  slotOvMatch = matchesBis(trueBis, trueBisId, item, armorType, slotVar);
    else                               slotOvMatch = false;

    if (matchRank(slotOvMatch) > matchRank(overallBisMatch)) overallBisMatch = slotOvMatch;

    const resolvedRaidBis   = raidBis   || (trueBis !== '<Crafted>' ? trueBis   : '');
    const resolvedRaidBisId = raidBisId || (trueBis !== '<Crafted>' ? trueBisId : '');

    if (resolvedRaidBis) hasRaidBis = true;
    if (resolvedRaidBis && matchesBis(resolvedRaidBis, resolvedRaidBisId, item, armorType, slotVar)) raidBisMatch = true;
  }

  return { overallBisMatch, raidBisMatch, hasRaidBis, effectiveTrueBis };
}

router.get('/items', async (c) => {
  const { teamSheetId } = c.get('session').user;
  if (!teamSheetId) return c.json({ instances: [], currentInstance: '', currentDifficulty: '' });
  try {
    const [itemDb, config] = await Promise.all([getItemDb(), primeTeamCache(teamSheetId, ['config']).then(() => getConfig(teamSheetId))]);
    const instanceMap = new Map();
    for (const item of itemDb) {
      if (item.sourceType !== 'Raid' || !item.name) continue;
      if (!instanceMap.has(item.instance)) instanceMap.set(item.instance, new Map());
      const bosses = instanceMap.get(item.instance);
      if (!bosses.has(item.sourceName)) bosses.set(item.sourceName, []);
      bosses.get(item.sourceName).push({
        itemId: item.itemId, name: item.name, slot: item.slot,
        armorType: item.armorType, isTierToken: item.isTierToken,
        difficulty: item.difficulty, weaponType: item.weaponType ?? '',
      });
    }
    const instances = [];
    for (const [instance, bossMap] of instanceMap) {
      const bosses = [];
      for (const [boss, items] of bossMap) bosses.push({ name: boss, items });
      instances.push({ instance, bosses });
    }
    return c.json({
      instances,
      currentInstance:          config.raid_instance               ?? '',
      currentDifficulty:        config.current_difficulty          ?? 'Mythic',
      curioItemId:              config.curio_item_id               ?? '',
      tierDistributionPriority: config.tier_distribution_priority  || 'bonus-first',
      heroicWeight:             parseFloat(config.council_heroic_weight ?? '0.2'),
      nonBisWeight:             parseFloat(config.council_nonbis_weight ?? '0.333'),
    });
  } catch (err) {
    console.error('[council] GET /items error:', err);
    return c.json({ error: 'Failed to load item data' }, 500);
  }
});

router.get('/candidates', async (c) => {
  const itemId = c.req.query('itemId');
  if (!itemId) return c.json({ error: 'itemId is required' }, 400);
  const { teamSheetId } = c.get('session').user;
  if (!teamSheetId) return c.json({ error: 'No team configured' }, 400);
  try {
    const [, itemDb, effectiveBis] = await Promise.all([
      primeTeamCache(teamSheetId, ['roster', 'lootLog', 'bisSubmissions', 'raids', 'wornBis']),
      getItemDb(),
      getEffectiveDefaultBis(),
    ]);
    const [roster, lootLog, bisSubmissions, raids, wornBisMap] = await Promise.all([
      getRoster(teamSheetId), getLootLog(teamSheetId),
      getBisSubmissions(teamSheetId), getRaids(teamSheetId),
      getWornBis(teamSheetId),
    ]);

    const item = itemDb.find(i => String(i.itemId) === String(itemId));
    if (!item) return c.json({ error: 'Item not found' }, 404);
    const itemSlot = item.slot;

    // Tier snapshot — only needed when the item is a tier token
    const tierSnapshotMap = new Map(); // charId → { slot → track }
    if (item.isTierToken) {
      const snapshots = await getTierSnapshot(teamSheetId);
      for (const snap of snapshots) {
        if (snap.charId) tierSnapshotMap.set(snap.charId, parseTierDetail(snap.tierDetail));
      }
    }

    const stats = {};
    for (const entry of lootLog) {
      // Key by charId if available (post-migration), fall back to name (pre-migration)
      const n = entry.recipientCharId || (entry.recipientChar ?? '').toLowerCase();
      if (!n) continue;
      if (!stats[n]) stats[n] = { bisN: 0, bisH: 0, bisM: 0, nonBisN: 0, nonBisH: 0, nonBisM: 0, tertiary: 0, offspec: 0 };
      const s = stats[n]; const d = entry.difficulty ?? ''; const t = entry.upgradeType;
      if (t === 'BIS')     { if (d === 'Normal') s.bisN++; else if (d === 'Heroic') s.bisH++; else if (d === 'Mythic') s.bisM++; }
      else if (t === 'Non-BIS') { if (d === 'Normal') s.nonBisN++; else if (d === 'Heroic') s.nonBisH++; else if (d === 'Mythic') s.nonBisM++; }
      else if (t === 'Tertiary') s.tertiary++;
      else if (t === 'Offspec')  s.offspec++;
    }

    const raidsByOwner = {};
    for (const raid of raids) for (const id of raid.attendeeIds) raidsByOwner[id] = (raidsByOwner[id] ?? 0) + 1;

    const acctStats = {};
    for (const r of roster) {
      if (!r.ownerId) continue;
      const charKey = r.charId || r.charName.toLowerCase();
      const s = stats[charKey] ?? {};
      if (!acctStats[r.ownerId]) acctStats[r.ownerId] = { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      const a = acctStats[r.ownerId];
      a.bisH += s.bisH ?? 0; a.bisM += s.bisM ?? 0; a.nonBisH += s.nonBisH ?? 0; a.nonBisM += s.nonBisM ?? 0;
    }

    const approvedBis = {};
    for (const sub of bisSubmissions) {
      if (sub.status !== 'Approved') continue;
      if (sub.slot.replace(/ [12]$/, '') !== itemSlot) continue;
      const charKey = sub.charId || sub.charName.toLowerCase();
      approvedBis[charKey + '|' + sub.slot] = sub;
    }

    const defaultBisMap = {};
    for (const row of effectiveBis) {
      if (row.slot.replace(/ [12]$/, '') !== itemSlot) continue;
      defaultBisMap[row.spec + '|' + row.slot] = row;
    }

    const candidates = [];
    for (const char of roster) {
      if (char.status === 'Inactive') continue;
      const charKey  = char.charId || char.charName.toLowerCase();
      const charSpec = getCharSpecs(char);

      // Primary spec eligibility
      const primaryCanon   = toCanonical(charSpec.primary);
      const primaryArmor   = getArmorType(primaryCanon);
      if (!isEligible(item, primaryArmor, primaryCanon)) continue;

      const { overallBisMatch, raidBisMatch, hasRaidBis } =
        computeSpecBisMatch(charKey, charSpec.primary, item, itemSlot, approvedBis, defaultBisMap);

      const s    = stats[charKey] ?? { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      const acct = acctStats[char.ownerId] ?? { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };

      // Secondary spec BIS matches — only for specs eligible for this item
      const secondarySpecCandidates = charSpec.secondary
        .filter(spec => {
          const canonSpec = toCanonical(spec);
          const armorType = getArmorType(canonSpec);
          return isEligible(item, armorType, canonSpec);
        })
        .map(spec => {
          const { overallBisMatch: ovm, raidBisMatch: rbm, hasRaidBis: hrb } =
            computeSpecBisMatch(charKey, spec, item, itemSlot, approvedBis, defaultBisMap);
          return { spec, overallBisMatch: ovm, raidBisMatch: rbm, hasRaidBis: hrb,
            wornBis: getWornTracksForSlot(wornBisMap, char.charId, spec, itemSlot) };
        });

      candidates.push({
        charName: char.charName, class: char.class, spec: char.spec, role: char.role, status: char.status,
        bisH: s.bisH, bisM: s.bisM, nonBisH: s.nonBisH, nonBisM: s.nonBisM,
        acctBisH: acct.bisH, acctBisM: acct.bisM, acctNonBisH: acct.nonBisH, acctNonBisM: acct.nonBisM,
        raidsAttended: raidsByOwner[char.ownerId] ?? 0,
        overallBisMatch, raidBisMatch, hasRaidBis,
        wornBis: getWornTracksForSlot(wornBisMap, char.charId, char.spec, itemSlot),
        secondarySpecCandidates,
        ...(item.isTierToken && { tierSlots: tierSnapshotMap.get(char.charId) ?? {} }),
      });
    }

    log.verbose(`[council] /candidates item="${item.name}" (${item.slot}) → ${candidates.length} eligible candidates`);
    log.debug('[council] /candidates results:', candidates.map(c => ({
      char: c.charName, spec: c.spec,
      bisH: c.bisH, bisM: c.bisM, nonBisH: c.nonBisH, nonBisM: c.nonBisM,
      raids: c.raidsAttended,
      overallBis: c.overallBisMatch, raidBis: c.raidBisMatch,
    })));
    return c.json({ item: { itemId: item.itemId, name: item.name, slot: item.slot, armorType: item.armorType, isTierToken: item.isTierToken, sourceName: item.sourceName, difficulty: item.difficulty }, candidates });
  } catch (err) {
    console.error('[council] GET /candidates error:', err);
    return c.json({ error: 'Failed to load candidates' }, 500);
  }
});

const TIER_SLOTS = ['Head', 'Shoulders', 'Chest', 'Hands', 'Legs'];

router.get('/curio-candidates', async (c) => {
  const { teamSheetId } = c.get('session').user;
  if (!teamSheetId) return c.json({ error: 'No team configured' }, 400);
  try {
    const [, effectiveBis] = await Promise.all([
      primeTeamCache(teamSheetId, ['roster', 'lootLog', 'bisSubmissions', 'raids', 'config', 'tierSnapshot']),
      getEffectiveDefaultBis(),
    ]);
    const [roster, lootLog, bisSubmissions, raids, config, tierSnapshots] = await Promise.all([
      getRoster(teamSheetId), getLootLog(teamSheetId), getBisSubmissions(teamSheetId),
      getRaids(teamSheetId), getConfig(teamSheetId), getTierSnapshot(teamSheetId),
    ]);

    const tierSnapshotMap = new Map(); // charId → { slot → track }
    for (const snap of tierSnapshots) {
      if (snap.charId) tierSnapshotMap.set(snap.charId, parseTierDetail(snap.tierDetail));
    }

    const stats = {};
    for (const entry of lootLog) {
      const n = entry.recipientCharId || (entry.recipientChar ?? '').toLowerCase(); if (!n) continue;
      if (!stats[n]) stats[n] = { bisN: 0, bisH: 0, bisM: 0, nonBisN: 0, nonBisH: 0, nonBisM: 0, tertiary: 0, offspec: 0 };
      const s = stats[n]; const d = entry.difficulty ?? ''; const t = entry.upgradeType;
      if (t === 'BIS')     { if (d === 'Normal') s.bisN++; else if (d === 'Heroic') s.bisH++; else if (d === 'Mythic') s.bisM++; }
      else if (t === 'Non-BIS') { if (d === 'Normal') s.nonBisN++; else if (d === 'Heroic') s.nonBisH++; else if (d === 'Mythic') s.nonBisM++; }
      else if (t === 'Tertiary') s.tertiary++; else if (t === 'Offspec') s.offspec++;
    }

    const raidsByOwner = {};
    for (const raid of raids) for (const id of raid.attendeeIds) raidsByOwner[id] = (raidsByOwner[id] ?? 0) + 1;

    const acctStats = {};
    for (const r of roster) {
      if (!r.ownerId) continue;
      const charKey = r.charId || r.charName.toLowerCase();
      const s = stats[charKey] ?? {};
      if (!acctStats[r.ownerId]) acctStats[r.ownerId] = { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      const a = acctStats[r.ownerId];
      a.bisH += s.bisH ?? 0; a.bisM += s.bisM ?? 0; a.nonBisH += s.nonBisH ?? 0; a.nonBisM += s.nonBisM ?? 0;
    }

    const approvedBis = {};
    for (const sub of bisSubmissions) {
      if (sub.status !== 'Approved' || !TIER_SLOTS.includes(sub.slot)) continue;
      const charKey = sub.charId || sub.charName.toLowerCase();
      approvedBis[charKey + '|' + sub.slot] = sub;
    }

    const defaultBisMap = {};
    for (const row of effectiveBis) {
      if (!TIER_SLOTS.includes(row.slot)) continue;
      defaultBisMap[row.spec + '|' + row.slot] = row;
    }

    const candidates = [];
    for (const char of roster) {
      if (char.status === 'Inactive') continue;
      const canonSpec = toCanonical(char.spec);
      const charKeyTier = char.charId || char.charName.toLowerCase();
      const tierSlotsWanted = [];
      let overallTierWanted = false;
      for (const slot of TIER_SLOTS) {
        const personalSub = approvedBis[charKeyTier + '|' + slot] ?? null;
        const defRow      = defaultBisMap[canonSpec + '|' + slot] ?? null;
        const effectiveTrueBis = personalSub?.trueBis ?? defRow?.trueBis ?? '';
        const effectiveRaidBis = personalSub?.raidBis ?? defRow?.raidBis ?? '';
        const resolvedRaidBis  = effectiveRaidBis || (effectiveTrueBis !== '<Crafted>' ? effectiveTrueBis : '');
        if (effectiveTrueBis === '<Tier>') overallTierWanted = true;
        if (resolvedRaidBis === '<Tier>') tierSlotsWanted.push(slot);
      }
      const s    = stats[char.charId || char.charName.toLowerCase()]    ?? { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      const acct = acctStats[char.ownerId] ?? { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };

      // BIS match: curio can fill any tier slot, so check across all tier slots
      const overallBisMatch = overallTierWanted;
      const raidBisMatch    = !overallTierWanted && tierSlotsWanted.length > 0;

      candidates.push({
        charName: char.charName, class: char.class, spec: char.spec, status: char.status, tierSlotsWanted,
        tierSlots: tierSnapshotMap.get(char.charId) ?? {},
        bisH: s.bisH, bisM: s.bisM, nonBisH: s.nonBisH, nonBisM: s.nonBisM,
        acctBisH: acct.bisH, acctBisM: acct.bisM, acctNonBisH: acct.nonBisH, acctNonBisM: acct.nonBisM,
        raidsAttended: raidsByOwner[char.ownerId] ?? 0,
        overallBisMatch, raidBisMatch,
      });
    }

    log.verbose(`[council] /curio-candidates → ${candidates.length} candidates`);
    log.debug('[council] /curio-candidates results:', candidates.map(c => ({
      char: c.charName, spec: c.spec,
      tierSlotsWanted: c.tierSlotsWanted,
      bisH: c.bisH, bisM: c.bisM,
      raids: c.raidsAttended,
    })));
    return c.json({ curioItemId: config.curio_item_id ?? '', candidates });
  } catch (err) {
    console.error('[council] GET /curio-candidates error:', err);
    return c.json({ error: 'Failed to load curio candidates' }, 500);
  }
});

export default router;
