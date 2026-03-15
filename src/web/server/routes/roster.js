/**
 * roster.js — Officer roster routes.
 *
 * GET /api/roster
 *   Returns all characters on the team roster, sorted Active/Bench first
 *   then Inactive, alphabetically within each group.
 *
 * GET /api/roster/:charName
 *   Returns a single character's approved BIS list, spec defaults, and
 *   full loot history — the same data the dashboard shows for that player.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getRoster, getLootLog, getBisSubmissions,
  getEffectiveDefaultBis, getItemDb, applyRaidBisInference,
  setRosterStatus, setOwnerNick, setRosterOwner, addRosterChar,
} from '../../../lib/sheets.js';
import { toCanonical, CLASS_SPECS } from '../../../lib/specs.js';

// Derive tank/healer/DPS role from sheet spec name
const TANK_SPECS   = new Set(['Blood DK', 'Vengeance DH', 'Guardian Druid', 'Brewmaster Monk', 'Prot Paladin', 'Prot Warrior']);
const HEALER_SPECS = new Set(['Resto Druid', 'Preservation Evoker', 'Mistweaver Monk', 'Holy Paladin', 'Disc Priest', 'Holy Priest', 'Resto Shaman']);
function specToRole(spec) {
  if (TANK_SPECS.has(spec))   return 'Tank';
  if (HEALER_SPECS.has(spec)) return 'Healer';
  return 'DPS';
}

const router = Router();
router.use(requireAuth);

// Officer-only
router.use((req, res, next) => {
  if (!req.session.user?.isOfficer) return res.status(403).json({ error: 'Officer only' });
  next();
});

// ── GET /api/roster ────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const { teamSheetId } = req.session.user;
  if (!teamSheetId) return res.json([]);

  try {
    const roster = await getRoster(teamSheetId);

    // Active/Bench first, Inactive last; alphabetical within each group
    const sorted = [...roster].sort((a, b) => {
      const ai = a.status === 'Inactive' ? 1 : 0;
      const bi = b.status === 'Inactive' ? 1 : 0;
      if (ai !== bi) return ai - bi;
      return a.charName.localeCompare(b.charName);
    });

    res.json(sorted);
  } catch (err) {
    console.error('[ROSTER] Error:', err);
    res.status(500).json({ error: 'Failed to load roster' });
  }
});

// ── POST /api/roster ──────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { teamSheetId } = req.session.user;
  const { charName, class: cls, spec, status = 'Active' } = req.body;

  if (!charName?.trim()) return res.status(400).json({ error: 'charName is required' });
  if (!cls?.trim())      return res.status(400).json({ error: 'class is required' });
  if (!spec?.trim())     return res.status(400).json({ error: 'spec is required' });
  if (!CLASS_SPECS[cls]?.includes(spec)) {
    return res.status(400).json({ error: 'Invalid class/spec combination' });
  }
  if (!['Active', 'Bench', 'Inactive'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const roster = await getRoster(teamSheetId);
    if (roster.some(r => r.charName === charName.trim())) {
      return res.status(409).json({ error: 'Character already exists on this roster' });
    }

    const role = specToRole(spec.trim());
    await addRosterChar(teamSheetId, charName.trim(), cls.trim(), spec.trim(), role, status);
    res.json({ charName: charName.trim(), class: cls.trim(), spec: spec.trim(), role, status, ownerId: '', ownerNick: '' });
  } catch (err) {
    console.error('[ROSTER] Add character error:', err);
    res.status(500).json({ error: 'Failed to add character' });
  }
});

// ── GET /api/roster/:charName ──────────────────────────────────────────────────

router.get('/:charName', async (req, res) => {
  const { teamSheetId } = req.session.user;
  const { charName }    = req.params;

  if (!teamSheetId) return res.status(404).json({ error: 'No team' });

  try {
    const [roster, lootLog, bisSubmissions, effectiveBis, itemDb] = await Promise.all([
      getRoster(teamSheetId),
      getLootLog(teamSheetId),
      getBisSubmissions(teamSheetId),
      getEffectiveDefaultBis(teamSheetId),
      getItemDb(teamSheetId),
    ]);

    const rosterChar = roster.find(r => r.charName === charName);
    if (!rosterChar) return res.status(404).json({ error: 'Character not found' });

    // Item name → itemId lookup (case-insensitive)
    const itemIdByName = new Map();
    for (const item of itemDb) {
      if (item.name) itemIdByName.set(item.name.toLowerCase(), item.itemId);
    }

    // All characters on the same Discord account
    const accountCharNames = rosterChar.ownerId
      ? roster.filter(r => r.ownerId === rosterChar.ownerId).map(r => r.charName)
      : [charName];

    // Loot history for this character, newest first
    const loot = lootLog
      .filter(e => e.recipientChar === charName)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(e => ({
        ...e,
        itemId: itemIdByName.get((e.itemName ?? '').toLowerCase()) ?? '',
      }));

    // Loot history for the whole account (all chars), newest first
    const accountLoot = accountCharNames.length > 1
      ? lootLog
          .filter(e => accountCharNames.includes(e.recipientChar))
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .map(e => ({
            ...e,
            itemId: itemIdByName.get((e.itemName ?? '').toLowerCase()) ?? '',
          }))
      : [];

    // Approved personal BIS submissions
    const approvedBis = bisSubmissions.filter(
      s => s.charName === charName && s.status === 'Approved'
    );

    // Spec defaults (fall back for slots without a personal submission)
    const canonicalSpec = toCanonical(rosterChar.spec);
    const specRows      = effectiveBis.filter(d => d.spec === canonicalSpec);
    const specDefaults  = applyRaidBisInference(specRows, itemDb);

    res.json({
      charName:  rosterChar.charName,
      class:     rosterChar.class,
      spec:      rosterChar.spec,
      role:      rosterChar.role,
      status:    rosterChar.status,
      ownerNick: rosterChar.ownerNick,
      bis:          approvedBis,
      specDefaults,
      loot,
      accountChars: accountCharNames,
      accountLoot,
    });
  } catch (err) {
    console.error('[ROSTER] Character detail error:', err);
    res.status(500).json({ error: 'Failed to load character data' });
  }
});

// ── POST /api/roster/owner-nick ────────────────────────────────────────────────

router.post('/owner-nick', async (req, res) => {
  const { teamSheetId } = req.session.user;
  const { ownerId, ownerNick } = req.body;

  if (!ownerId)   return res.status(400).json({ error: 'ownerId is required' });
  if (!ownerNick?.trim()) return res.status(400).json({ error: 'ownerNick is required' });

  try {
    await setOwnerNick(teamSheetId, ownerId, ownerNick.trim());
    res.json({ ok: true, ownerId, ownerNick: ownerNick.trim() });
  } catch (err) {
    console.error('[ROSTER] Owner nick update error:', err);
    res.status(500).json({ error: 'Failed to update player name' });
  }
});

// ── POST /api/roster/:charName/owner ──────────────────────────────────────────

router.post('/:charName/owner', async (req, res) => {
  const { teamSheetId } = req.session.user;
  const { charName }    = req.params;
  const { ownerId, ownerNick = '' } = req.body;

  if (!ownerId?.trim()) return res.status(400).json({ error: 'ownerId is required' });

  try {
    await setRosterOwner(teamSheetId, charName, ownerId.trim(), ownerNick.trim());
    res.json({ ok: true, charName, ownerId: ownerId.trim(), ownerNick: ownerNick.trim() });
  } catch (err) {
    console.error('[ROSTER] Set owner error:', err);
    res.status(500).json({ error: 'Failed to link Discord account' });
  }
});

// ── DELETE /api/roster/:charName/owner ────────────────────────────────────────

router.delete('/:charName/owner', async (req, res) => {
  const { teamSheetId } = req.session.user;
  const { charName }    = req.params;

  try {
    await setRosterOwner(teamSheetId, charName, '', '');
    res.json({ ok: true, charName });
  } catch (err) {
    console.error('[ROSTER] Clear owner error:', err);
    res.status(500).json({ error: 'Failed to clear Discord account' });
  }
});

// ── POST /api/roster/:charName/status ─────────────────────────────────────────

router.post('/:charName/status', async (req, res) => {
  const { teamSheetId } = req.session.user;
  const { charName }    = req.params;
  const { status }      = req.body;

  if (!['Active', 'Inactive'].includes(status)) {
    return res.status(400).json({ error: 'status must be Active or Inactive' });
  }

  try {
    await setRosterStatus(teamSheetId, charName, status);
    res.json({ ok: true, charName, status });
  } catch (err) {
    console.error('[ROSTER] Status update error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

export default router;
