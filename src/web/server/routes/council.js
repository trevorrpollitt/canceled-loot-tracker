/**
 * council.js — Officer loot council routes.
 *
 * GET /api/council/items
 * GET /api/council/candidates?itemId=<id>
 * GET /api/council/curio-candidates
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getItemDb, getRoster, getLootLog, getBisSubmissions,
  getEffectiveDefaultBis, getRaids, getConfig,
} from '../../../lib/sheets.js';
import { toCanonical, getArmorType, canUseWeapon } from '../../../lib/specs.js';
import { log } from '../../../lib/logger.js';

const router = new Hono();
router.use('*', requireAuth);
router.use('*', async (c, next) => {
  if (!c.get('session').user?.isOfficer) return c.json({ error: 'Officer only' }, 403);
  await next();
});

function matchesBis(bisValue, bisItemId, item, charArmorType, slot) {
  if (!bisValue) return false;
  if (bisValue === '<Crafted>') return false;
  if (bisValue === '<Tier>')    return item.isTierToken === true;
  if (bisValue === '<Catalyst>') {
    const normalizedSlot = slot.replace(/ [12]$/, '');
    return item.slot === normalizedSlot &&
      (item.armorType === charArmorType || item.armorType === 'Accessory');
  }
  if (bisItemId && String(bisItemId) === String(item.itemId)) return true;
  return item.name.toLowerCase() === bisValue.toLowerCase();
}

function isEligible(item, charArmorType, canonSpec) {
  if (item.slot === 'Weapon' || item.slot === 'Off-Hand') return canUseWeapon(canonSpec, item.weaponType);
  if (item.armorType === 'Accessory' || item.armorType === 'Tier Token') return true;
  return charArmorType === item.armorType;
}

router.get('/items', async (c) => {
  const { teamSheetId } = c.get('session').user;
  if (!teamSheetId) return c.json({ instances: [], currentInstance: '', currentDifficulty: '' });
  try {
    const [itemDb, config] = await Promise.all([getItemDb(), getConfig(teamSheetId)]);
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
      currentInstance:   config.raid_instance      ?? '',
      currentDifficulty: config.current_difficulty ?? 'Mythic',
      curioItemId:       config.curio_item_id       ?? '',
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
    const [itemDb, roster, lootLog, bisSubmissions, effectiveBis, raids] = await Promise.all([
      getItemDb(), getRoster(teamSheetId), getLootLog(teamSheetId),
      getBisSubmissions(teamSheetId), getEffectiveDefaultBis(), getRaids(teamSheetId),
    ]);

    const item = itemDb.find(i => String(i.itemId) === String(itemId));
    if (!item) return c.json({ error: 'Item not found' }, 404);
    const itemSlot = item.slot;

    const stats = {};
    for (const entry of lootLog) {
      const n = entry.recipientChar;
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
      const s = stats[r.charName] ?? {};
      if (!acctStats[r.ownerId]) acctStats[r.ownerId] = { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      const a = acctStats[r.ownerId];
      a.bisH += s.bisH ?? 0; a.bisM += s.bisM ?? 0; a.nonBisH += s.nonBisH ?? 0; a.nonBisM += s.nonBisM ?? 0;
    }

    const approvedBis = {};
    for (const sub of bisSubmissions) {
      if (sub.status !== 'Approved') continue;
      if (sub.slot.replace(/ [12]$/, '') !== itemSlot) continue;
      approvedBis[sub.charName + '|' + sub.slot] = sub;
    }

    const defaultBisMap = {};
    for (const row of effectiveBis) {
      if (row.slot.replace(/ [12]$/, '') !== itemSlot) continue;
      defaultBisMap[row.spec + '|' + row.slot] = row;
    }

    const candidates = [];
    for (const char of roster) {
      if (char.status !== 'Active') continue;
      const canonSpec = toCanonical(char.spec);
      const armorType = getArmorType(canonSpec);
      if (!isEligible(item, armorType, canonSpec)) continue;

      let personalSub = null;
      for (const key of [char.charName + '|' + itemSlot, char.charName + '|' + itemSlot + ' 1', char.charName + '|' + itemSlot + ' 2']) {
        if (approvedBis[key]) { personalSub = approvedBis[key]; break; }
      }

      const defRow = defaultBisMap[canonSpec + '|' + itemSlot]
                  ?? defaultBisMap[canonSpec + '|' + itemSlot + ' 1']
                  ?? defaultBisMap[canonSpec + '|' + itemSlot + ' 2']
                  ?? null;

      const effectiveTrueBis   = personalSub?.trueBis      ?? defRow?.trueBis      ?? '';
      const effectiveTrueBisId = personalSub?.trueBisItemId ?? defRow?.trueBisItemId ?? '';
      const effectiveRaidBis   = personalSub?.raidBis      ?? defRow?.raidBis      ?? '';
      const effectiveRaidBisId = personalSub?.raidBisItemId ?? defRow?.raidBisItemId ?? '';

      let overallBisMatch;
      if (effectiveTrueBis === '<Crafted>') overallBisMatch = 'crafted';
      else overallBisMatch = matchesBis(effectiveTrueBis, effectiveTrueBisId, item, armorType, itemSlot);

      const resolvedRaidBis   = effectiveRaidBis   || (effectiveTrueBis   !== '<Crafted>' ? effectiveTrueBis   : '');
      const resolvedRaidBisId = effectiveRaidBisId || (effectiveTrueBis   !== '<Crafted>' ? effectiveTrueBisId : '');
      const raidBisMatch      = resolvedRaidBis ? matchesBis(resolvedRaidBis, resolvedRaidBisId, item, armorType, itemSlot) : false;

      const s    = stats[char.charName]  ?? { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      const acct = acctStats[char.ownerId] ?? { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };

      candidates.push({
        charName: char.charName, class: char.class, spec: char.spec, role: char.role,
        bisH: s.bisH, bisM: s.bisM, nonBisH: s.nonBisH, nonBisM: s.nonBisM,
        acctBisH: acct.bisH, acctBisM: acct.bisM, acctNonBisH: acct.nonBisH, acctNonBisM: acct.nonBisM,
        raidsAttended: raidsByOwner[char.ownerId] ?? 0,
        overallBisMatch, raidBisMatch, hasRaidBis: Boolean(resolvedRaidBis),
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
    const [roster, lootLog, bisSubmissions, effectiveBis, raids, config] = await Promise.all([
      getRoster(teamSheetId), getLootLog(teamSheetId), getBisSubmissions(teamSheetId),
      getEffectiveDefaultBis(), getRaids(teamSheetId), getConfig(teamSheetId),
    ]);

    const stats = {};
    for (const entry of lootLog) {
      const n = entry.recipientChar; if (!n) continue;
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
      const s = stats[r.charName] ?? {};
      if (!acctStats[r.ownerId]) acctStats[r.ownerId] = { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      const a = acctStats[r.ownerId];
      a.bisH += s.bisH ?? 0; a.bisM += s.bisM ?? 0; a.nonBisH += s.nonBisH ?? 0; a.nonBisM += s.nonBisM ?? 0;
    }

    const approvedBis = {};
    for (const sub of bisSubmissions) {
      if (sub.status !== 'Approved' || !TIER_SLOTS.includes(sub.slot)) continue;
      approvedBis[sub.charName + '|' + sub.slot] = sub;
    }

    const defaultBisMap = {};
    for (const row of effectiveBis) {
      if (!TIER_SLOTS.includes(row.slot)) continue;
      defaultBisMap[row.spec + '|' + row.slot] = row;
    }

    const candidates = [];
    for (const char of roster) {
      if (char.status !== 'Active') continue;
      const canonSpec = toCanonical(char.spec);
      const tierSlotsWanted = [];
      for (const slot of TIER_SLOTS) {
        const personalSub = approvedBis[char.charName + '|' + slot] ?? null;
        const defRow      = defaultBisMap[canonSpec + '|' + slot] ?? null;
        const effectiveTrueBis = personalSub?.trueBis ?? defRow?.trueBis ?? '';
        const effectiveRaidBis = personalSub?.raidBis ?? defRow?.raidBis ?? '';
        const resolvedRaidBis  = effectiveRaidBis || (effectiveTrueBis !== '<Crafted>' ? effectiveTrueBis : '');
        if (resolvedRaidBis === '<Tier>') tierSlotsWanted.push(slot);
      }
      const s    = stats[char.charName]    ?? { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      const acct = acctStats[char.ownerId] ?? { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      candidates.push({
        charName: char.charName, class: char.class, spec: char.spec, tierSlotsWanted,
        bisH: s.bisH, bisM: s.bisM, nonBisH: s.nonBisH, nonBisM: s.nonBisM,
        acctBisH: acct.bisH, acctBisM: acct.bisM, acctNonBisH: acct.nonBisH, acctNonBisM: acct.nonBisM,
        raidsAttended: raidsByOwner[char.ownerId] ?? 0,
      });
    }

    candidates.sort((a, b) => {
      const diff = b.tierSlotsWanted.length - a.tierSlotsWanted.length;
      if (diff !== 0) return diff;
      return (a.bisN + a.bisH + a.bisM) - (b.bisN + b.bisH + b.bisM);
    });

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
