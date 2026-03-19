/**
 * bis.js — Raider BIS submission routes.
 *
 * GET  /api/bis
 * POST /api/bis
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getBisSubmissions, getItemDb, getEffectiveDefaultBis, applyRaidBisInference,
  batchUpsertBisSubmissions, clearPendingBisSubmission, clearRejectedBisSubmission,
  clearBisSubmission, resetBisRaidBisField,
} from '../../../lib/sheets.js';
import { toCanonical, getArmorType, canUseWeapon, canDualWield } from '../../../lib/specs.js';

const ALL_SLOTS = [
  'Head', 'Neck', 'Shoulders', 'Back', 'Chest', 'Wrists',
  'Hands', 'Waist', 'Legs', 'Feet',
  'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2', 'Weapon', 'Off-Hand',
];

const TIER_SLOTS     = new Set(['Head', 'Shoulders', 'Chest', 'Hands', 'Legs']);
const CATALYST_SLOTS = new Set(['Neck', 'Back', 'Wrists', 'Waist', 'Feet']);
const DIFF_ORDER     = { Mythic: 0, Heroic: 1, Normal: 2, 'Mythic+': 3 };

function itemOptionsForSlot(itemDb, slot, armorType, { raidOnly = false, canonSpec = '' } = {}) {
  let dbSlot = slot.replace(/ [12]$/, '');
  // Dual-wield specs equip a weapon in the off-hand, not a shield/frill.
  // Redirect the lookup to 'Weapon' so they see 1H/2H weapon options.
  if (dbSlot === 'Off-Hand' && canonSpec && canDualWield(canonSpec)) dbSlot = 'Weapon';
  return itemDb
    .filter(item => {
      if (item.slot !== dbSlot)   return false;
      if (item.isTierToken)       return false;
      if (raidOnly && item.sourceType !== 'Raid') return false;
      if (item.armorType === 'Accessory') {
        if (item.weaponType && canonSpec) return canUseWeapon(canonSpec, item.weaponType);
        return true;
      }
      return item.armorType === armorType;
    })
    .map(item => ({
      itemId:     String(item.itemId),
      name:       item.name,
      difficulty: item.difficulty ?? '',
      source:     item.sourceName ?? '',
      sourceType: item.sourceType ?? '',
    }))
    .sort((a, b) => {
      const da = DIFF_ORDER[a.difficulty] ?? 9;
      const db = DIFF_ORDER[b.difficulty] ?? 9;
      return da !== db ? da - db : a.name.localeCompare(b.name);
    });
}

const router = new Hono();
router.use('*', requireAuth);

// ── GET /api/bis ───────────────────────────────────────────────────────────────

router.get('/', async (c) => {
  const { teamSheetId, charId, charName, spec } = c.get('session').user;
  if (!teamSheetId) return c.json({ noTeam: true });

  try {
    const [submissions, itemDb, effectiveBis] = await Promise.all([
      getBisSubmissions(teamSheetId),
      getItemDb(),
      getEffectiveDefaultBis(),
    ]);

    const canonicalSpec = toCanonical(spec);
    const armorType     = getArmorType(canonicalSpec);

    const bySlot = Object.fromEntries(
      submissions
        .filter(s => (charId && s.charId ? s.charId === charId : s.charName.toLowerCase() === charName.toLowerCase()))
        .map(s => [s.slot, s])
    );

    const specRows      = effectiveBis.filter(d => d.spec === canonicalSpec);
    const specDefaults  = applyRaidBisInference(specRows, itemDb);
    const defaultBySlot = Object.fromEntries(specDefaults.map(d => [d.slot, d]));

    const slots = ALL_SLOTS.map(slot => {
      const sub = bySlot[slot] ?? null;
      const def = defaultBySlot[slot] ?? null;

      const lastApproved = sub?.lastApprovedTrueBis
        ? {
            trueBis:       sub.lastApprovedTrueBis,
            raidBis:       sub.lastApprovedRaidBis,
            trueBisItemId: sub.lastApprovedTrueBisItemId,
            raidBisItemId: sub.lastApprovedRaidBisItemId,
          }
        : null;

      return {
        slot,
        submission:  sub,
        lastApproved,
        specDefault: def ? {
          trueBis:       def.trueBis       ?? '',
          trueBisItemId: def.trueBisItemId ?? '',
          raidBis:       def.raidBis       ?? '',
          raidBisItemId: def.raidBisItemId ?? '',
        } : null,
        sentinels: {
          tier:     TIER_SLOTS.has(slot),
          catalyst: CATALYST_SLOTS.has(slot),
          crafted:  true,
        },
        overallOptions: itemOptionsForSlot(itemDb, slot, armorType, { canonSpec: canonicalSpec }),
        raidOptions:    itemOptionsForSlot(itemDb, slot, armorType, { raidOnly: true, canonSpec: canonicalSpec }),
      };
    });

    return c.json({ charName, spec, slots });
  } catch (err) {
    console.error('[BIS] GET error:', err);
    return c.json({ error: 'Failed to load BIS data' }, 500);
  }
});

// ── POST /api/bis ──────────────────────────────────────────────────────────────

router.post('/', async (c) => {
  const { updates } = await c.req.json();
  if (!Array.isArray(updates) || !updates.length) {
    return c.json({ error: 'updates[] is required' }, 400);
  }

  const { teamSheetId, charId, charName, spec } = c.get('session').user;
  if (!teamSheetId) return c.json({ error: 'No team configured' }, 400);
  if (!charName)    return c.json({ error: 'No character linked to this account' }, 400);

  const validSlots = new Set(ALL_SLOTS);

  const validUpdates = updates.filter(u =>
    validSlots.has(u.slot) && (u.clearPending || u.clearRejected || u.clearSlot || u.resetRaidBis || u.trueBis)
  );

  if (!validUpdates.length) {
    return c.json({ error: 'No valid updates provided (slot required, trueBis required)' }, 400);
  }

  try {
    let saved   = 0;
    let cleared = 0;

    for (const u of validUpdates.filter(u => u.clearRejected)) {
      await clearRejectedBisSubmission(teamSheetId, charId, u.slot, charName);
      cleared++;
    }
    for (const u of validUpdates.filter(u => u.clearPending)) {
      await clearPendingBisSubmission(teamSheetId, charId, u.slot, charName);
      cleared++;
    }
    for (const u of validUpdates.filter(u => u.clearSlot)) {
      await clearBisSubmission(teamSheetId, charId, u.slot, charName);
      cleared++;
    }
    for (const u of validUpdates.filter(u => u.resetRaidBis)) {
      await resetBisRaidBisField(teamSheetId, charId, u.slot, charName);
      cleared++;
    }

    const saveUpdates = validUpdates.filter(u => !u.clearPending && !u.clearRejected && !u.clearSlot && !u.resetRaidBis);
    if (saveUpdates.length) {
      await batchUpsertBisSubmissions(teamSheetId, saveUpdates.map(u => ({
        charId,
        charName,
        spec,
        slot:          u.slot,
        trueBis:       u.trueBis,
        trueBisItemId: u.trueBisItemId ?? '',
        raidBis:       u.raidBis       ?? '',
        raidBisItemId: u.raidBisItemId ?? '',
        rationale:     u.rationale     ?? '',
      })));
      saved = saveUpdates.length;
    }

    const parts = [];
    if (saved)   parts.push(`${saved} slot${saved   !== 1 ? 's' : ''} saved`);
    if (cleared) parts.push(`${cleared} slot${cleared !== 1 ? 's' : ''} cleared`);
    return c.json({ ok: true, saved, cleared, message: parts.join(', ') });
  } catch (err) {
    console.error('[BIS] POST error:', err);
    return c.json({ error: 'Failed to save BIS submissions' }, 500);
  }
});

export default router;
