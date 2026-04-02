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
  getEffectiveDefaultBis, getRaids, getTeamConfig, getGlobalConfig, getTierSnapshot,
  getWornBis,
} from '../../../lib/db.js';
import { toCanonical, getArmorType, canUseWeapon, canDualWield, getCharSpecs } from '../../../lib/specs.js';
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

const SLOT_EXPANSIONS = { Ring: ['Ring 1', 'Ring 2'], Trinket: ['Trinket 1', 'Trinket 2'] };
const TRACK_ORDER = { '': -1, Crafted: 0, Veteran: 1, Champion: 2, Hero: 3, Mythic: 4 };

function mergeTrack(a, b) {
  return (TRACK_ORDER[a] ?? -1) >= (TRACK_ORDER[b] ?? -1) ? a : b;
}

function minTrack(a, b) {
  const ra = TRACK_ORDER[a] ?? -1;
  const rb = TRACK_ORDER[b] ?? -1;
  if (ra === -1 && rb === -1) return '';
  if (ra === -1) return b;
  if (rb === -1) return a;
  return ra <= rb ? a : b;
}

function getWornTracksForSlot(wornBisMap, charId, spec, itemSlot) {
  const slots    = SLOT_EXPANSIONS[itemSlot] ?? [itemSlot];
  const isPaired = slots.length > 1;
  const best     = { overallBISTrack: '', raidBISTrack: '', otherTrack: '' };
  let minOvBIS   = null;

  for (const slot of slots) {
    const w = wornBisMap.get(`${charId}:${spec}:${slot}`);
    if (isPaired) {
      const slotOvBIS = w?.overall_bis_track ?? '';
      if (minOvBIS === null) {
        minOvBIS = slotOvBIS;
      } else {
        minOvBIS = (TRACK_ORDER[slotOvBIS] ?? -1) < (TRACK_ORDER[minOvBIS] ?? -1)
          ? slotOvBIS : minOvBIS;
      }
    }
    if (!w) continue;
    best.overallBISTrack = mergeTrack(best.overallBISTrack, w.overall_bis_track);
    best.raidBISTrack    = mergeTrack(best.raidBISTrack,    w.raid_bis_track);
    best.otherTrack = isPaired
      ? minTrack(best.otherTrack, w.other_track)
      : mergeTrack(best.otherTrack, w.other_track);
  }

  if (isPaired) best.minOverallBISTrack = minOvBIS ?? '';
  return best;
}

function isEligible(item, charArmorType, canonSpec) {
  if (item.slot === 'Weapon' || item.slot === 'Off-Hand') return canUseWeapon(canonSpec, item.weapon_type ?? '');
  if (item.armor_type === 'Accessory' || item.armor_type === 'Tier Token') return true;
  return charArmorType === item.armor_type;
}

function computeSpecBisMatch(charId, spec, item, itemSlot, approvedBis, defaultBisMap) {
  const canonSpec  = toCanonical(spec);
  const armorType  = getArmorType(canonSpec);

  let slotVariants;
  if (itemSlot === 'Ring' || itemSlot === 'Trinket') {
    slotVariants = [itemSlot, itemSlot + ' 1', itemSlot + ' 2'];
  } else if (itemSlot === 'Weapon' && canDualWield(canonSpec)) {
    slotVariants = ['Weapon', 'Off-Hand'];
  } else {
    slotVariants = [itemSlot];
  }

  const matchRank  = v => v === true ? 3 : v === 'catalyst' ? 2 : v === 'crafted' ? 1 : 0;
  const expandSlot = s => SLOT_EXPANSIONS[s] ?? [s];

  let overallBisMatch  = false;
  let raidBisMatch     = false;
  let hasRaidBis       = false;
  let effectiveTrueBis = '';
  const overallMatchSlots = new Set();
  const raidMatchSlots    = new Set();

  for (const slotVar of slotVariants) {
    const sub = approvedBis[charId + '|' + slotVar];
    if (sub?.spec && sub.spec.toLowerCase() !== spec.toLowerCase()) continue;

    const defRow = defaultBisMap[canonSpec + '|' + slotVar] ?? null;

    const trueBis   = sub?.true_bis       ?? defRow?.true_bis       ?? '';
    const trueBisId = sub?.true_bis_item_id ?? defRow?.true_bis_item_id ?? '';
    const raidBis   = sub?.raid_bis       ?? defRow?.raid_bis       ?? '';
    const raidBisId = sub?.raid_bis_item_id ?? defRow?.raid_bis_item_id ?? '';

    if (!trueBis && !raidBis) continue;
    if (!effectiveTrueBis) effectiveTrueBis = trueBis;

    const itemShape = {
      itemId:      String(item.item_id),
      name:        item.name,
      slot:        item.slot,
      armorType:   item.armor_type,
      isTierToken: item.is_tier_token === 1,
    };

    let slotOvMatch;
    if      (trueBis === '<Crafted>')  slotOvMatch = 'crafted';
    else if (trueBis === '<Catalyst>') slotOvMatch = 'catalyst';
    else if (trueBis)                  slotOvMatch = matchesBis(trueBis, trueBisId, itemShape, armorType, slotVar);
    else                               slotOvMatch = false;

    const slotRank = matchRank(slotOvMatch);
    const bestRank = matchRank(overallBisMatch);
    if (slotRank > 0) {
      if (slotRank > bestRank) {
        overallBisMatch = slotOvMatch;
        overallMatchSlots.clear();
      }
      if (slotRank >= matchRank(overallBisMatch)) {
        for (const s of expandSlot(slotVar)) overallMatchSlots.add(s);
      }
    }

    const resolvedRaidBis   = raidBis   || (trueBis !== '<Crafted>' ? trueBis   : '');
    const resolvedRaidBisId = raidBisId || (trueBis !== '<Crafted>' ? trueBisId : '');

    if (resolvedRaidBis) hasRaidBis = true;
    if (resolvedRaidBis && matchesBis(resolvedRaidBis, resolvedRaidBisId, itemShape, armorType, slotVar)) {
      raidBisMatch = true;
      for (const s of expandSlot(slotVar)) raidMatchSlots.add(s);
    }
  }

  return { overallBisMatch, raidBisMatch, hasRaidBis, effectiveTrueBis, overallMatchSlots, raidMatchSlots };
}

function minWornTrackForSlots(wornBisMap, charId, spec, slots, field) {
  let min = null;
  for (const slot of slots) {
    const w = wornBisMap.get(`${charId}:${spec}:${slot}`);
    const track = w?.[field] ?? '';
    if (min === null) { min = track; continue; }
    if ((TRACK_ORDER[track] ?? -1) < (TRACK_ORDER[min] ?? -1)) min = track;
  }
  return min ?? '';
}

router.get('/items', async (c) => {
  const { teamId } = c.get('session').user;
  if (!teamId) return c.json({ instances: [], currentInstance: '', currentDifficulty: '' });
  const db = c.env.DB;
  try {
    const [itemDb, config, globalConfig] = await Promise.all([getItemDb(db), getTeamConfig(db, teamId), getGlobalConfig(db)]);
    const instanceMap = new Map();
    for (const item of itemDb) {
      if (item.source_type !== 'Raid' || !item.name) continue;
      if (!instanceMap.has(item.instance)) instanceMap.set(item.instance, new Map());
      const bosses = instanceMap.get(item.instance);
      if (!bosses.has(item.source_name)) bosses.set(item.source_name, []);
      bosses.get(item.source_name).push({
        itemId: item.item_id, name: item.name, slot: item.slot,
        armorType: item.armor_type, isTierToken: item.is_tier_token === 1,
        difficulty: item.difficulty, weaponType: item.weapon_type ?? '',
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
      curioItemId:              globalConfig.curio_item_id         ?? '',
      tierDistributionPriority: config.tier_distribution_priority  || 'bonus-first',
      heroicWeight:             parseFloat(config.council_heroic_weight  ?? '0.2'),
      normalWeight:             parseFloat(config.council_normal_weight  ?? '0'),
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
  const { teamId } = c.get('session').user;
  if (!teamId) return c.json({ error: 'No team configured' }, 400);
  const db = c.env.DB;
  try {
    const [itemDb, effectiveBis, roster, lootLog, bisSubmissions, raids, wornBisMap] = await Promise.all([
      getItemDb(db), getEffectiveDefaultBis(db),
      getRoster(db, teamId), getLootLog(db, teamId),
      getBisSubmissions(db, teamId), getRaids(db, teamId),
      getWornBis(db, teamId),
    ]);

    const item = itemDb.find(i => String(i.item_id) === String(itemId));
    if (!item) return c.json({ error: 'Item not found' }, 404);
    const itemSlot = item.slot;

    const tierSnapshotMap = new Map();
    if (item.is_tier_token) {
      const snapshots = await getTierSnapshot(db, teamId);
      for (const snap of snapshots) {
        if (snap.char_id) tierSnapshotMap.set(snap.char_id, parseTierDetail(snap.tier_detail));
      }
    }

    const stats = {};
    for (const entry of lootLog) {
      const n = entry.recipient_char_id ?? null;
      if (!n) continue;
      if (!stats[n]) stats[n] = { bisN: 0, bisH: 0, bisM: 0, nonBisN: 0, nonBisH: 0, nonBisM: 0, tertiary: 0, offspec: 0 };
      const s = stats[n]; const d = entry.difficulty ?? ''; const t = entry.upgrade_type;
      if (t === 'BIS')          { if (d === 'Normal') s.bisN++; else if (d === 'Heroic') s.bisH++; else if (d === 'Mythic') s.bisM++; }
      else if (t === 'Non-BIS') { if (d === 'Normal') s.nonBisN++; else if (d === 'Heroic') s.nonBisH++; else if (d === 'Mythic') s.nonBisM++; }
      else if (t === 'Tertiary') s.tertiary++;
      else if (t === 'Offspec')  s.offspec++;
    }

    const raidsByOwner = {};
    for (const raid of raids) for (const id of raid.attendeeIds) raidsByOwner[id] = (raidsByOwner[id] ?? 0) + 1;

    const acctStats = {};
    for (const r of roster) {
      if (!r.owner_id) continue;
      const s = stats[r.id] ?? {};
      if (!acctStats[r.owner_id]) acctStats[r.owner_id] = { bisN: 0, bisH: 0, bisM: 0, nonBisN: 0, nonBisH: 0, nonBisM: 0 };
      const a = acctStats[r.owner_id];
      a.bisN += s.bisN ?? 0; a.bisH += s.bisH ?? 0; a.bisM += s.bisM ?? 0;
      a.nonBisN += s.nonBisN ?? 0; a.nonBisH += s.nonBisH ?? 0; a.nonBisM += s.nonBisM ?? 0;
    }

    const approvedBis = {};
    for (const sub of bisSubmissions) {
      if (sub.status !== 'Approved') continue;
      if (sub.slot.replace(/ [12]$/, '') !== itemSlot) continue;
      approvedBis[sub.char_id + '|' + sub.slot] = sub;
    }

    const defaultBisMap = {};
    for (const row of effectiveBis) {
      if (row.slot.replace(/ [12]$/, '') !== itemSlot) continue;
      defaultBisMap[row.spec + '|' + row.slot] = row;
    }

    const candidates = [];
    for (const char of roster) {
      if (char.status === 'Inactive') continue;
      const charSpec = getCharSpecs(char);

      const primaryCanon = toCanonical(charSpec.primary);
      const primaryArmor = getArmorType(primaryCanon);
      if (!isEligible(item, primaryArmor, primaryCanon)) continue;

      const { overallBisMatch, raidBisMatch, hasRaidBis, overallMatchSlots, raidMatchSlots } =
        computeSpecBisMatch(char.id, charSpec.primary, item, itemSlot, approvedBis, defaultBisMap);

      const s    = stats[char.id] ?? { bisN: 0, bisH: 0, bisM: 0, nonBisN: 0, nonBisH: 0, nonBisM: 0 };
      const acct = acctStats[char.owner_id] ?? { bisN: 0, bisH: 0, bisM: 0, nonBisN: 0, nonBisH: 0, nonBisM: 0 };

      const ovMatchWornTrack   = minWornTrackForSlots(wornBisMap, char.id, char.spec, overallMatchSlots, 'overall_bis_track');
      const raidMatchWornTrack = minWornTrackForSlots(wornBisMap, char.id, char.spec, raidMatchSlots,    'raid_bis_track');

      const secondarySpecCandidates = charSpec.secondary
        .filter(spec => {
          const canonSpec = toCanonical(spec);
          const armorType = getArmorType(canonSpec);
          return isEligible(item, armorType, canonSpec);
        })
        .map(spec => {
          const { overallBisMatch: ovm, raidBisMatch: rbm, hasRaidBis: hrb } =
            computeSpecBisMatch(char.id, spec, item, itemSlot, approvedBis, defaultBisMap);
          return { spec, overallBisMatch: ovm, raidBisMatch: rbm, hasRaidBis: hrb,
            wornBis: getWornTracksForSlot(wornBisMap, char.id, spec, itemSlot) };
        });

      candidates.push({
        charName: char.char_name, class: char.class, spec: char.spec, role: char.role, status: char.status,
        bisN: s.bisN, bisH: s.bisH, bisM: s.bisM, nonBisN: s.nonBisN, nonBisH: s.nonBisH, nonBisM: s.nonBisM,
        acctBisN: acct.bisN, acctBisH: acct.bisH, acctBisM: acct.bisM, acctNonBisN: acct.nonBisN, acctNonBisH: acct.nonBisH, acctNonBisM: acct.nonBisM,
        raidsAttended: raidsByOwner[char.owner_id] ?? 0,
        overallBisMatch, raidBisMatch, hasRaidBis,
        wornBis: { ...getWornTracksForSlot(wornBisMap, char.id, char.spec, itemSlot), ovMatchWornTrack, raidMatchWornTrack },
        secondarySpecCandidates,
        ...(item.is_tier_token && { tierSlots: tierSnapshotMap.get(char.id) ?? {} }),
      });
    }

    log.verbose(`[council] /candidates item="${item.name}" (${item.slot}) → ${candidates.length} eligible candidates`);
    return c.json({
      item: { itemId: item.item_id, name: item.name, slot: item.slot, armorType: item.armor_type, isTierToken: item.is_tier_token === 1, sourceName: item.source_name, difficulty: item.difficulty },
      candidates,
    });
  } catch (err) {
    console.error('[council] GET /candidates error:', err);
    return c.json({ error: 'Failed to load candidates' }, 500);
  }
});

const TIER_SLOTS = ['Head', 'Shoulders', 'Chest', 'Hands', 'Legs'];

router.get('/curio-candidates', async (c) => {
  const { teamId } = c.get('session').user;
  if (!teamId) return c.json({ error: 'No team configured' }, 400);
  const db = c.env.DB;
  try {
    const [effectiveBis, roster, lootLog, bisSubmissions, raids, globalConfig, tierSnapshots] = await Promise.all([
      getEffectiveDefaultBis(db),
      getRoster(db, teamId), getLootLog(db, teamId), getBisSubmissions(db, teamId),
      getRaids(db, teamId), getGlobalConfig(db), getTierSnapshot(db, teamId),
    ]);

    const tierSnapshotMap = new Map();
    for (const snap of tierSnapshots) {
      if (snap.char_id) tierSnapshotMap.set(snap.char_id, parseTierDetail(snap.tier_detail));
    }

    const stats = {};
    for (const entry of lootLog) {
      const n = entry.recipient_char_id ?? null; if (!n) continue;
      if (!stats[n]) stats[n] = { bisN: 0, bisH: 0, bisM: 0, nonBisN: 0, nonBisH: 0, nonBisM: 0, tertiary: 0, offspec: 0 };
      const s = stats[n]; const d = entry.difficulty ?? ''; const t = entry.upgrade_type;
      if (t === 'BIS')          { if (d === 'Normal') s.bisN++; else if (d === 'Heroic') s.bisH++; else if (d === 'Mythic') s.bisM++; }
      else if (t === 'Non-BIS') { if (d === 'Normal') s.nonBisN++; else if (d === 'Heroic') s.nonBisH++; else if (d === 'Mythic') s.nonBisM++; }
      else if (t === 'Tertiary') s.tertiary++; else if (t === 'Offspec') s.offspec++;
    }

    const raidsByOwner = {};
    for (const raid of raids) for (const id of raid.attendeeIds) raidsByOwner[id] = (raidsByOwner[id] ?? 0) + 1;

    const acctStats = {};
    for (const r of roster) {
      if (!r.owner_id) continue;
      const s = stats[r.id] ?? {};
      if (!acctStats[r.owner_id]) acctStats[r.owner_id] = { bisN: 0, bisH: 0, bisM: 0, nonBisN: 0, nonBisH: 0, nonBisM: 0 };
      const a = acctStats[r.owner_id];
      a.bisN += s.bisN ?? 0; a.bisH += s.bisH ?? 0; a.bisM += s.bisM ?? 0;
      a.nonBisN += s.nonBisN ?? 0; a.nonBisH += s.nonBisH ?? 0; a.nonBisM += s.nonBisM ?? 0;
    }

    const approvedBis = {};
    for (const sub of bisSubmissions) {
      if (sub.status !== 'Approved' || !TIER_SLOTS.includes(sub.slot)) continue;
      approvedBis[sub.char_id + '|' + sub.slot] = sub;
    }

    const defaultBisMap = {};
    for (const row of effectiveBis) {
      if (!TIER_SLOTS.includes(row.slot)) continue;
      defaultBisMap[row.spec + '|' + row.slot] = row;
    }

    const candidates = [];
    for (const char of roster) {
      if (char.status === 'Inactive') continue;
      const canonSpec   = toCanonical(char.spec);
      const tierSlotsWanted   = [];
      let overallTierWanted   = false;
      for (const slot of TIER_SLOTS) {
        const personalSub      = approvedBis[char.id + '|' + slot] ?? null;
        const defRow           = defaultBisMap[canonSpec + '|' + slot] ?? null;
        const effectiveTrueBis = personalSub?.true_bis ?? defRow?.true_bis ?? '';
        const effectiveRaidBis = personalSub?.raid_bis ?? defRow?.raid_bis ?? '';
        const resolvedRaidBis  = effectiveRaidBis || (effectiveTrueBis !== '<Crafted>' ? effectiveTrueBis : '');
        if (effectiveTrueBis === '<Tier>') overallTierWanted = true;
        if (resolvedRaidBis === '<Tier>') tierSlotsWanted.push(slot);
      }
      const s    = stats[char.id] ?? { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      const acct = acctStats[char.owner_id] ?? { bisN: 0, bisH: 0, bisM: 0, nonBisN: 0, nonBisH: 0, nonBisM: 0 };

      const overallBisMatch = overallTierWanted;
      const raidBisMatch    = !overallTierWanted && tierSlotsWanted.length > 0;

      candidates.push({
        charName: char.char_name, class: char.class, spec: char.spec, status: char.status, tierSlotsWanted,
        tierSlots: tierSnapshotMap.get(char.id) ?? {},
        bisN: s.bisN, bisH: s.bisH, bisM: s.bisM, nonBisN: s.nonBisN, nonBisH: s.nonBisH, nonBisM: s.nonBisM,
        acctBisN: acct.bisN, acctBisH: acct.bisH, acctBisM: acct.bisM, acctNonBisN: acct.nonBisN, acctNonBisH: acct.nonBisH, acctNonBisM: acct.nonBisM,
        raidsAttended: raidsByOwner[char.owner_id] ?? 0,
        overallBisMatch, raidBisMatch,
      });
    }

    log.verbose(`[council] /curio-candidates → ${candidates.length} candidates`);
    return c.json({ curioItemId: globalConfig.curio_item_id ?? '', candidates });
  } catch (err) {
    console.error('[council] GET /curio-candidates error:', err);
    return c.json({ error: 'Failed to load curio candidates' }, 500);
  }
});

export default router;
