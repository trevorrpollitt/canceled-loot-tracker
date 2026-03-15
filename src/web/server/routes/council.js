/**
 * council.js — Officer loot council routes.
 *
 * GET /api/council/items
 *   Returns all Item DB entries grouped by instance → boss,
 *   plus currentInstance / currentDifficulty from Config.
 *
 * GET /api/council/candidates?itemId=<id>
 *   Fetches all data in parallel and computes per-character stats
 *   + BIS match for the specific item.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getItemDb, getRoster, getLootLog, getBisSubmissions,
  getEffectiveDefaultBis, getRaids, getConfig,
} from '../../../lib/sheets.js';
import { toCanonical, getArmorType, canUseWeapon } from '../../../lib/specs.js';

const router = Router();
router.use(requireAuth);

// Officer-only
router.use((req, res, next) => {
  if (!req.session.user?.isOfficer) return res.status(403).json({ error: 'Officer only' });
  next();
});

// ── BIS matching ──────────────────────────────────────────────────────────────

function matchesBis(bisValue, bisItemId, item, charArmorType, slot) {
  if (!bisValue) return false;
  if (bisValue === '<Crafted>') return false;
  if (bisValue === '<Tier>')    return item.isTierToken === true;
  if (bisValue === '<Catalyst>') {
    const normalizedSlot = slot.replace(/ [12]$/, '');
    return item.slot === normalizedSlot &&
      (item.armorType === charArmorType || item.armorType === 'Accessory');
  }
  // Named item — match by ID first, then name (case-insensitive)
  if (bisItemId && String(bisItemId) === String(item.itemId)) return true;
  return item.name.toLowerCase() === bisValue.toLowerCase();
}

// ── Eligibility ───────────────────────────────────────────────────────────────

function isEligible(item, charArmorType, canonSpec) {
  if (item.slot === 'Weapon' || item.slot === 'Off-Hand') {
    return canUseWeapon(canonSpec, item.weaponType);
  }
  // Accessories and non-equip class-group tokens (Conqueror/Protector/Vanquisher)
  // are usable by any armor type.
  if (item.armorType === 'Accessory' || item.armorType === 'Tier Token') return true;
  // Equippable tier set pieces carry a real armor type (Cloth/Leather/Mail/Plate)
  // and must be filtered the same as any other armor piece.
  return charArmorType === item.armorType;
}

// ── GET /api/council/items ────────────────────────────────────────────────────

router.get('/items', async (req, res) => {
  const { teamSheetId } = req.session.user;
  if (!teamSheetId) return res.json({ instances: [], currentInstance: '', currentDifficulty: '' });

  try {
    const [itemDb, config] = await Promise.all([
      getItemDb(teamSheetId),
      getConfig(teamSheetId),
    ]);

    // Group items by instance → boss
    const instanceMap = new Map(); // instanceName → Map<bossName, items[]>
    for (const item of itemDb) {
      if (item.sourceType !== 'Raid') continue;
      if (!item.name) continue;
      if (!instanceMap.has(item.instance)) instanceMap.set(item.instance, new Map());
      const bosses = instanceMap.get(item.instance);
      if (!bosses.has(item.sourceName)) bosses.set(item.sourceName, []);
      bosses.get(item.sourceName).push({
        itemId:      item.itemId,
        name:        item.name,
        slot:        item.slot,
        armorType:   item.armorType,
        isTierToken: item.isTierToken,
        difficulty:  item.difficulty,
        weaponType:  item.weaponType ?? '',
      });
    }

    const instances = [];
    for (const [instance, bossMap] of instanceMap) {
      const bosses = [];
      for (const [boss, items] of bossMap) {
        bosses.push({ name: boss, items });
      }
      instances.push({ instance, bosses });
    }

    res.json({
      instances,
      currentInstance:   config.raid_instance       ?? '',
      currentDifficulty: config.current_difficulty  ?? 'Mythic',
      curioItemId:       config.curio_item_id        ?? '',
    });
  } catch (err) {
    console.error('[council] GET /items error:', err);
    res.status(500).json({ error: 'Failed to load item data' });
  }
});

// ── GET /api/council/candidates?itemId=<id> ───────────────────────────────────

router.get('/candidates', async (req, res) => {
  const { itemId } = req.query;
  if (!itemId) return res.status(400).json({ error: 'itemId is required' });

  const { teamSheetId } = req.session.user;
  if (!teamSheetId) return res.status(400).json({ error: 'No team configured' });

  try {
    const [itemDb, roster, lootLog, bisSubmissions, effectiveBis, raids] = await Promise.all([
      getItemDb(teamSheetId),
      getRoster(teamSheetId),
      getLootLog(teamSheetId),
      getBisSubmissions(teamSheetId),
      getEffectiveDefaultBis(teamSheetId),
      getRaids(teamSheetId),
    ]);

    const item = itemDb.find(i => String(i.itemId) === String(itemId));
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const itemSlot = item.slot; // e.g. 'Ring', 'Trinket', 'Head'

    // ── Per-character loot stats ──────────────────────────────────────────────
    const stats = {};
    for (const entry of lootLog) {
      const n = entry.recipientChar;
      if (!n) continue;
      if (!stats[n]) stats[n] = { bisN: 0, bisH: 0, bisM: 0, nonBisN: 0, nonBisH: 0, nonBisM: 0, tertiary: 0, offspec: 0 };
      const s = stats[n];
      const d = entry.difficulty ?? '';
      const t = entry.upgradeType;
      if (t === 'BIS') {
        if (d === 'Normal')  s.bisN++;
        else if (d === 'Heroic') s.bisH++;
        else if (d === 'Mythic') s.bisM++;
      } else if (t === 'Non-BIS') {
        if (d === 'Normal')  s.nonBisN++;
        else if (d === 'Heroic') s.nonBisH++;
        else if (d === 'Mythic') s.nonBisM++;
      } else if (t === 'Tertiary') {
        s.tertiary++;
      } else if (t === 'Offspec') {
        s.offspec++;
      }
    }

    // ── Per-owner raid attendance ─────────────────────────────────────────────
    const raidsByOwner = {};
    for (const raid of raids) {
      for (const id of raid.attendeeIds) {
        raidsByOwner[id] = (raidsByOwner[id] ?? 0) + 1;
      }
    }

    // ── Account-level H/M stats (all chars sharing the same Discord account) ──
    // Intentionally includes ALL roster characters regardless of status so that
    // loot received by Bench/Inactive alts still counts toward the account total.
    const acctStats = {};
    for (const r of roster) {
      if (!r.ownerId) continue;
      const s = stats[r.charName] ?? {};
      if (!acctStats[r.ownerId]) acctStats[r.ownerId] = { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      const a = acctStats[r.ownerId];
      a.bisH    += s.bisH    ?? 0;
      a.bisM    += s.bisM    ?? 0;
      a.nonBisH += s.nonBisH ?? 0;
      a.nonBisM += s.nonBisM ?? 0;
    }

    // ── Approved personal BIS indexed by (charName, slot) ────────────────────
    // Slot in submissions uses 'Ring 1', 'Ring 2', etc.; normalize for lookup.
    const approvedBis = {};
    for (const sub of bisSubmissions) {
      if (sub.status !== 'Approved') continue;
      const subSlot = sub.slot.replace(/ [12]$/, '');
      if (subSlot !== itemSlot) continue;
      approvedBis[`${sub.charName}|${sub.slot}`] = sub;
    }

    // ── Default BIS indexed by (canonSpec, slot) ──────────────────────────────
    const defaultBisMap = {};
    for (const row of effectiveBis) {
      const rowSlot = row.slot.replace(/ [12]$/, '');
      if (rowSlot !== itemSlot) continue;
      defaultBisMap[`${row.spec}|${row.slot}`] = row;
    }

    // ── Build candidate list ──────────────────────────────────────────────────
    const candidates = [];
    for (const char of roster) {
      if (char.status !== 'Active') continue;

      const canonSpec  = toCanonical(char.spec);
      const armorType  = getArmorType(canonSpec);

      if (!isEligible(item, armorType, canonSpec)) continue;

      // Approved personal BIS — check bare slot and numbered variants
      let personalSub = null;
      for (const key of [
        `${char.charName}|${itemSlot}`,
        `${char.charName}|${itemSlot} 1`,
        `${char.charName}|${itemSlot} 2`,
      ]) {
        if (approvedBis[key]) { personalSub = approvedBis[key]; break; }
      }

      // Default BIS — bare slot and numbered variants
      const defRow = defaultBisMap[`${canonSpec}|${itemSlot}`]
                  ?? defaultBisMap[`${canonSpec}|${itemSlot} 1`]
                  ?? defaultBisMap[`${canonSpec}|${itemSlot} 2`]
                  ?? null;

      // Effective BIS: personal approved overrides spec default
      const effectiveTrueBis   = personalSub?.trueBis      ?? defRow?.trueBis      ?? '';
      const effectiveTrueBisId = personalSub?.trueBisItemId ?? defRow?.trueBisItemId ?? '';
      const effectiveRaidBis   = personalSub?.raidBis      ?? defRow?.raidBis      ?? '';
      const effectiveRaidBisId = personalSub?.raidBisItemId ?? defRow?.raidBisItemId ?? '';

      // Overall BIS match
      let overallBisMatch;
      if (effectiveTrueBis === '<Crafted>') {
        overallBisMatch = 'crafted';
      } else {
        overallBisMatch = matchesBis(effectiveTrueBis, effectiveTrueBisId, item, armorType, itemSlot);
      }

      // Raid BIS: if no explicit Raid BIS set, fall back to Overall BIS
      // (unless Overall BIS is <Crafted>, which can never drop from a raid)
      const resolvedRaidBis   = effectiveRaidBis
        || (effectiveTrueBis !== '<Crafted>' ? effectiveTrueBis   : '');
      const resolvedRaidBisId = effectiveRaidBisId
        || (effectiveTrueBis !== '<Crafted>' ? effectiveTrueBisId : '');

      const raidBisMatch = resolvedRaidBis
        ? matchesBis(resolvedRaidBis, resolvedRaidBisId, item, armorType, itemSlot)
        : false;

      const s    = stats[char.charName] ?? { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      const acct = acctStats[char.ownerId] ?? { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };

      candidates.push({
        charName:      char.charName,
        class:         char.class,
        spec:          char.spec,
        role:          char.role,
        bisH:          s.bisH,
        bisM:          s.bisM,
        nonBisH:       s.nonBisH,
        nonBisM:       s.nonBisM,
        acctBisH:      acct.bisH,
        acctBisM:      acct.bisM,
        acctNonBisH:   acct.nonBisH,
        acctNonBisM:   acct.nonBisM,
        raidsAttended: raidsByOwner[char.ownerId] ?? 0,
        overallBisMatch,
        raidBisMatch,
        hasRaidBis:    Boolean(resolvedRaidBis),
      });
    }

    res.json({
      item: {
        itemId:      item.itemId,
        name:        item.name,
        slot:        item.slot,
        armorType:   item.armorType,
        isTierToken: item.isTierToken,
        sourceName:  item.sourceName,
        difficulty:  item.difficulty,
      },
      candidates,
    });
  } catch (err) {
    console.error('[council] GET /candidates error:', err);
    res.status(500).json({ error: 'Failed to load candidates' });
  }
});

// ── GET /api/council/curio-candidates ────────────────────────────────────────
// Returns all active characters with which tier slots they want (<Tier> BIS),
// plus loot stats. Curios can be turned in for any tier piece by any class.

const TIER_SLOTS = ['Head', 'Shoulders', 'Chest', 'Hands', 'Legs'];

router.get('/curio-candidates', async (req, res) => {
  const { teamSheetId } = req.session.user;
  if (!teamSheetId) return res.status(400).json({ error: 'No team configured' });

  try {
    const [roster, lootLog, bisSubmissions, effectiveBis, raids, config] = await Promise.all([
      getRoster(teamSheetId),
      getLootLog(teamSheetId),
      getBisSubmissions(teamSheetId),
      getEffectiveDefaultBis(teamSheetId),
      getRaids(teamSheetId),
      getConfig(teamSheetId),
    ]);

    // Per-character loot stats
    const stats = {};
    for (const entry of lootLog) {
      const n = entry.recipientChar;
      if (!n) continue;
      if (!stats[n]) stats[n] = { bisN: 0, bisH: 0, bisM: 0, nonBisN: 0, nonBisH: 0, nonBisM: 0, tertiary: 0, offspec: 0 };
      const s = stats[n];
      const d = entry.difficulty ?? '';
      const t = entry.upgradeType;
      if (t === 'BIS') {
        if (d === 'Normal') s.bisN++; else if (d === 'Heroic') s.bisH++; else if (d === 'Mythic') s.bisM++;
      } else if (t === 'Non-BIS') {
        if (d === 'Normal') s.nonBisN++; else if (d === 'Heroic') s.nonBisH++; else if (d === 'Mythic') s.nonBisM++;
      } else if (t === 'Tertiary') { s.tertiary++; } else if (t === 'Offspec') { s.offspec++; }
    }

    // Per-owner raid attendance
    const raidsByOwner = {};
    for (const raid of raids) {
      for (const id of raid.attendeeIds) raidsByOwner[id] = (raidsByOwner[id] ?? 0) + 1;
    }

    // Account-level H/M stats — intentionally includes ALL roster characters
    // regardless of status so that Bench/Inactive alts' loot counts toward the total.
    const acctStats = {};
    for (const r of roster) {
      if (!r.ownerId) continue;
      const s = stats[r.charName] ?? {};
      if (!acctStats[r.ownerId]) acctStats[r.ownerId] = { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      const a = acctStats[r.ownerId];
      a.bisH    += s.bisH    ?? 0;
      a.bisM    += s.bisM    ?? 0;
      a.nonBisH += s.nonBisH ?? 0;
      a.nonBisM += s.nonBisM ?? 0;
    }

    // Approved personal BIS for tier slots only
    const approvedBis = {};
    for (const sub of bisSubmissions) {
      if (sub.status !== 'Approved') continue;
      if (!TIER_SLOTS.includes(sub.slot)) continue;
      approvedBis[`${sub.charName}|${sub.slot}`] = sub;
    }

    // Default BIS for tier slots only
    const defaultBisMap = {};
    for (const row of effectiveBis) {
      if (!TIER_SLOTS.includes(row.slot)) continue;
      defaultBisMap[`${row.spec}|${row.slot}`] = row;
    }

    const candidates = [];
    for (const char of roster) {
      if (char.status !== 'Active') continue;
      const canonSpec = toCanonical(char.spec);
      const tierSlotsWanted = [];

      for (const slot of TIER_SLOTS) {
        const personalSub = approvedBis[`${char.charName}|${slot}`] ?? null;
        const defRow      = defaultBisMap[`${canonSpec}|${slot}`] ?? null;
        const effectiveTrueBis = personalSub?.trueBis ?? defRow?.trueBis ?? '';
        const effectiveRaidBis = personalSub?.raidBis ?? defRow?.raidBis ?? '';
        const resolvedRaidBis  = effectiveRaidBis
          || (effectiveTrueBis !== '<Crafted>' ? effectiveTrueBis : '');
        if (resolvedRaidBis === '<Tier>') tierSlotsWanted.push(slot);
      }

      const s    = stats[char.charName] ?? { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      const acct = acctStats[char.ownerId] ?? { bisH: 0, bisM: 0, nonBisH: 0, nonBisM: 0 };
      candidates.push({
        charName:       char.charName,
        class:          char.class,
        spec:           char.spec,
        tierSlotsWanted,
        bisH:           s.bisH,
        bisM:           s.bisM,
        nonBisH:        s.nonBisH,
        nonBisM:        s.nonBisM,
        acctBisH:       acct.bisH,
        acctBisM:       acct.bisM,
        acctNonBisH:    acct.nonBisH,
        acctNonBisM:    acct.nonBisM,
        raidsAttended:  raidsByOwner[char.ownerId] ?? 0,
      });
    }

    candidates.sort((a, b) => {
      const diff = b.tierSlotsWanted.length - a.tierSlotsWanted.length;
      if (diff !== 0) return diff;
      return (a.bisN + a.bisH + a.bisM) - (b.bisN + b.bisH + b.bisM);
    });

    res.json({ curioItemId: config.curio_item_id ?? '', candidates });
  } catch (err) {
    console.error('[council] GET /curio-candidates error:', err);
    res.status(500).json({ error: 'Failed to load curio candidates' });
  }
});

export default router;
