/**
 * bis.js — Raider BIS submission routes.
 *
 * GET  /api/bis
 *   Returns the logged-in player's current BIS submissions for all 16 slots,
 *   plus item selector options and valid sentinels per slot.
 *
 * POST /api/bis
 *   Body: { updates: [{ slot, trueBis, trueBisItemId, raidBis, raidBisItemId, rationale,
 *                       clearPending? }] }
 *   For normal updates: upserts the slot submission (status → Pending).
 *   For clearPending updates: reverts the slot to the last accepted state
 *     (last-approved snapshot if it exists, or deletes the row entirely).
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getBisSubmissions, getItemDb, getEffectiveDefaultBis, applyRaidBisInference,
  batchUpsertBisSubmissions, clearPendingBisSubmission, clearRejectedBisSubmission,
} from '../../../lib/sheets.js';
import { toCanonical, getArmorType, canUseWeapon } from '../../../lib/specs.js';

const ALL_SLOTS = [
  'Head', 'Neck', 'Shoulders', 'Back', 'Chest', 'Wrists',
  'Hands', 'Waist', 'Legs', 'Feet',
  'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2', 'Weapon', 'Off-Hand',
];

const TIER_SLOTS     = new Set(['Head', 'Shoulders', 'Chest', 'Hands', 'Legs']);
const CATALYST_SLOTS = new Set(['Neck', 'Back', 'Wrists', 'Waist', 'Feet']);
const DIFF_ORDER     = { Mythic: 0, Heroic: 1, Normal: 2, 'Mythic+': 3 };

/**
 * Build a sorted item list for a given slot + armor type.
 * raidOnly=true restricts to SourceType=Raid (for the Raid BIS selector).
 */
function itemOptionsForSlot(itemDb, slot, armorType, { raidOnly = false, canonSpec = '' } = {}) {
  const dbSlot = slot.replace(/ [12]$/, ''); // Ring 1/2 → Ring, Trinket 1/2 → Trinket
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

const router = Router();
router.use(requireAuth);

// ── GET /api/bis ───────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const { teamSheetId, charName, spec } = req.session.user;
  if (!teamSheetId) return res.json({ noTeam: true });

  try {
    const [submissions, itemDb, effectiveBis] = await Promise.all([
      getBisSubmissions(teamSheetId),
      getItemDb(teamSheetId),
      getEffectiveDefaultBis(teamSheetId),
    ]);

    const canonicalSpec = toCanonical(spec);
    const armorType     = getArmorType(canonicalSpec);

    // Index personal submissions by slot
    const bySlot = Object.fromEntries(
      submissions.filter(s => s.charName === charName).map(s => [s.slot, s])
    );

    // Spec defaults with Raid BIS inference applied
    const specRows      = effectiveBis.filter(d => d.spec === canonicalSpec);
    const specDefaults  = applyRaidBisInference(specRows, itemDb);
    const defaultBySlot = Object.fromEntries(specDefaults.map(d => [d.slot, d]));

    const slots = ALL_SLOTS.map(slot => {
      const sub = bySlot[slot] ?? null;
      const def = defaultBySlot[slot] ?? null;

      // Last-approved snapshot — only meaningful when submission is Pending.
      // Written to cols N–Q when an officer approves; cleared when restored.
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
          crafted:  true,    // <Crafted> is always valid for Overall BIS
        },
        overallOptions: itemOptionsForSlot(itemDb, slot, armorType, { canonSpec: canonicalSpec }),
        raidOptions:    itemOptionsForSlot(itemDb, slot, armorType, { raidOnly: true, canonSpec: canonicalSpec }),
      };
    });

    res.json({ charName, spec, slots });
  } catch (err) {
    console.error('[BIS] GET error:', err);
    res.status(500).json({ error: 'Failed to load BIS data' });
  }
});

// ── POST /api/bis ──────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates) || !updates.length) {
    return res.status(400).json({ error: 'updates[] is required' });
  }

  const { teamSheetId, charName, spec } = req.session.user;
  if (!teamSheetId) return res.status(400).json({ error: 'No team configured' });
  if (!charName)    return res.status(400).json({ error: 'No character linked to this account' });

  const validSlots = new Set(ALL_SLOTS);

  // clearPending / clearRejected need only a valid slot; regular updates also need trueBis
  const validUpdates = updates.filter(u =>
    validSlots.has(u.slot) && (u.clearPending || u.clearRejected || u.trueBis)
  );

  if (!validUpdates.length) {
    return res.status(400).json({ error: 'No valid updates provided (slot required, trueBis required)' });
  }

  try {
    let saved   = 0;
    let cleared = 0;

    // Clear operations are rare (0–1 per save) — keep sequential
    for (const u of validUpdates.filter(u => u.clearRejected)) {
      await clearRejectedBisSubmission(teamSheetId, charName, u.slot);
      cleared++;
    }
    for (const u of validUpdates.filter(u => u.clearPending)) {
      await clearPendingBisSubmission(teamSheetId, charName, u.slot);
      cleared++;
    }

    // All normal saves in a single round-trip: 1 read + 1 batchUpdate + 1 append
    const saveUpdates = validUpdates.filter(u => !u.clearPending && !u.clearRejected);
    if (saveUpdates.length) {
      await batchUpsertBisSubmissions(teamSheetId, saveUpdates.map(u => ({
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
    if (cleared) parts.push(`${cleared} pending submission${cleared !== 1 ? 's' : ''} cleared`);
    res.json({ ok: true, saved, cleared, message: parts.join(', ') });
  } catch (err) {
    console.error('[BIS] POST error:', err);
    res.status(500).json({ error: 'Failed to save BIS submissions' });
  }
});

export default router;
