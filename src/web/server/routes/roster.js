/**
 * roster.js — Officer roster routes.
 *
 * GET    /api/roster
 * POST   /api/roster
 * GET    /api/roster/:charName
 * POST   /api/roster/owner-nick
 * POST   /api/roster/:charName/owner
 * DELETE /api/roster/:charName/owner
 * POST   /api/roster/:charName/status
 * DELETE /api/roster/:charName
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getRoster, getLootLog, getBisSubmissions,
  getEffectiveDefaultBis, getItemDb, applyRaidBisInference,
  setRosterStatus, setOwnerNick, setRosterOwner, addRosterChar, deleteRosterChar,
} from '../../../lib/sheets.js';
import { toCanonical, CLASS_SPECS } from '../../../lib/specs.js';

const TANK_SPECS   = new Set(['Blood DK', 'Vengeance DH', 'Guardian Druid', 'Brewmaster Monk', 'Prot Paladin', 'Prot Warrior']);
const HEALER_SPECS = new Set(['Resto Druid', 'Preservation Evoker', 'Mistweaver Monk', 'Holy Paladin', 'Disc Priest', 'Holy Priest', 'Resto Shaman']);
const RANGED_SPECS = new Set([
  'Balance Druid', 'Devastation Evoker', 'Augmentation Evoker',
  'Devourer DH',
  'BM Hunter', 'MM Hunter',
  'Arcane Mage', 'Fire Mage', 'Frost Mage',
  'Shadow Priest',
  'Ele Shaman',
  'Affliction Lock', 'Demo Lock', 'Destro Lock',
]);
function specToRole(spec) {
  if (TANK_SPECS.has(spec))   return 'Tank';
  if (HEALER_SPECS.has(spec)) return 'Healer';
  if (RANGED_SPECS.has(spec)) return 'Ranged DPS';
  return 'Melee DPS';
}

const router = new Hono();
router.use('*', requireAuth);
router.use('*', async (c, next) => {
  if (!c.get('session').user?.isOfficer) return c.json({ error: 'Officer only' }, 403);
  await next();
});

router.get('/', async (c) => {
  const { teamSheetId } = c.get('session').user;
  if (!teamSheetId) return c.json([]);
  try {
    const roster = await getRoster(teamSheetId);
    const sorted = [...roster].sort((a, b) => {
      const ai = a.status === 'Inactive' ? 1 : 0;
      const bi = b.status === 'Inactive' ? 1 : 0;
      if (ai !== bi) return ai - bi;
      return a.charName.localeCompare(b.charName);
    });
    return c.json(sorted);
  } catch (err) {
    console.error('[ROSTER] Error:', err);
    return c.json({ error: 'Failed to load roster' }, 500);
  }
});

router.post('/', async (c) => {
  const { teamSheetId } = c.get('session').user;
  const { charName, class: cls, spec, status = 'Active', ownerId = '', ownerNick = '' } = await c.req.json();

  if (!charName?.trim()) return c.json({ error: 'charName is required' }, 400);
  if (!cls?.trim())      return c.json({ error: 'class is required' }, 400);
  if (!spec?.trim())     return c.json({ error: 'spec is required' }, 400);
  if (!CLASS_SPECS[cls]?.includes(spec)) return c.json({ error: 'Invalid class/spec combination' }, 400);
  if (!['Active', 'Bench', 'Inactive'].includes(status)) return c.json({ error: 'Invalid status' }, 400);

  try {
    const roster = await getRoster(teamSheetId);
    if (roster.some(r => r.charName.toLowerCase() === charName.trim().toLowerCase())) {
      return c.json({ error: 'Character already exists on this roster' }, 409);
    }
    const role            = specToRole(spec.trim());
    const resolvedOwnerId = ownerId.trim();
    const resolvedNick    = ownerNick.trim();
    await addRosterChar(teamSheetId, charName.trim(), cls.trim(), spec.trim(), role, status);
    if (resolvedOwnerId) {
      await setRosterOwner(teamSheetId, charName.trim(), resolvedOwnerId, resolvedNick);
    }
    return c.json({ charName: charName.trim(), class: cls.trim(), spec: spec.trim(), role, status, ownerId: resolvedOwnerId, ownerNick: resolvedNick });
  } catch (err) {
    console.error('[ROSTER] Add character error:', err);
    return c.json({ error: 'Failed to add character' }, 500);
  }
});

router.get('/owner-nick', async (c) => c.json({ error: 'Use POST' }, 405));

router.post('/owner-nick', async (c) => {
  const { teamSheetId } = c.get('session').user;
  const { ownerId, ownerNick } = await c.req.json();
  if (!ownerId)             return c.json({ error: 'ownerId is required' }, 400);
  if (!ownerNick?.trim())   return c.json({ error: 'ownerNick is required' }, 400);
  try {
    await setOwnerNick(teamSheetId, ownerId, ownerNick.trim());
    return c.json({ ok: true, ownerId, ownerNick: ownerNick.trim() });
  } catch (err) {
    console.error('[ROSTER] Owner nick update error:', err);
    return c.json({ error: 'Failed to update player name' }, 500);
  }
});

router.get('/:charName', async (c) => {
  const { teamSheetId } = c.get('session').user;
  const charName        = c.req.param('charName');
  if (!teamSheetId) return c.json({ error: 'No team' }, 404);
  try {
    const [roster, lootLog, bisSubmissions, effectiveBis, itemDb] = await Promise.all([
      getRoster(teamSheetId), getLootLog(teamSheetId), getBisSubmissions(teamSheetId),
      getEffectiveDefaultBis(), getItemDb(),
    ]);
    const rosterChar = roster.find(r => r.charName.toLowerCase() === charName.toLowerCase());
    if (!rosterChar) return c.json({ error: 'Character not found' }, 404);

    const itemIdByName = new Map();
    for (const item of itemDb) if (item.name) itemIdByName.set(item.name.toLowerCase(), item.itemId);

    const accountCharNames = rosterChar.ownerId
      ? roster.filter(r => r.ownerId === rosterChar.ownerId).map(r => r.charName)
      : [charName];

    const loot = lootLog
      .filter(e => (e.recipientChar ?? '').toLowerCase() === charName.toLowerCase())
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(e => ({ ...e, itemId: itemIdByName.get((e.itemName ?? '').toLowerCase()) ?? '' }));

    const accountLoot = accountCharNames.length > 1
      ? lootLog
          .filter(e => accountCharNames.includes(e.recipientChar))
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .map(e => ({ ...e, itemId: itemIdByName.get((e.itemName ?? '').toLowerCase()) ?? '' }))
      : [];

    const approvedBis   = bisSubmissions.filter(s => s.charName.toLowerCase() === charName.toLowerCase() && s.status === 'Approved');
    const canonicalSpec = toCanonical(rosterChar.spec);
    const specRows      = effectiveBis.filter(d => d.spec === canonicalSpec);
    const specDefaults  = applyRaidBisInference(specRows, itemDb);

    return c.json({
      charName: rosterChar.charName, class: rosterChar.class, spec: rosterChar.spec,
      role: rosterChar.role, status: rosterChar.status, ownerNick: rosterChar.ownerNick,
      bis: approvedBis, specDefaults, loot, accountChars: accountCharNames, accountLoot,
    });
  } catch (err) {
    console.error('[ROSTER] Character detail error:', err);
    return c.json({ error: 'Failed to load character data' }, 500);
  }
});

router.post('/:charName/owner', async (c) => {
  const { teamSheetId } = c.get('session').user;
  const charName        = c.req.param('charName');
  const { ownerId, ownerNick = '' } = await c.req.json();
  if (!ownerId?.trim()) return c.json({ error: 'ownerId is required' }, 400);
  try {
    await setRosterOwner(teamSheetId, charName, ownerId.trim(), ownerNick.trim());
    return c.json({ ok: true, charName, ownerId: ownerId.trim(), ownerNick: ownerNick.trim() });
  } catch (err) {
    console.error('[ROSTER] Set owner error:', err);
    return c.json({ error: 'Failed to link Discord account' }, 500);
  }
});

router.delete('/:charName/owner', async (c) => {
  const { teamSheetId } = c.get('session').user;
  const charName        = c.req.param('charName');
  try {
    await setRosterOwner(teamSheetId, charName, '', '');
    return c.json({ ok: true, charName });
  } catch (err) {
    console.error('[ROSTER] Clear owner error:', err);
    return c.json({ error: 'Failed to clear Discord account' }, 500);
  }
});

router.post('/:charName/status', async (c) => {
  const { teamSheetId } = c.get('session').user;
  const charName        = c.req.param('charName');
  const { status }      = await c.req.json();
  if (!['Active', 'Bench', 'Inactive'].includes(status)) return c.json({ error: 'status must be Active, Bench, or Inactive' }, 400);
  try {
    await setRosterStatus(teamSheetId, charName, status);
    return c.json({ ok: true, charName, status });
  } catch (err) {
    console.error('[ROSTER] Status update error:', err);
    return c.json({ error: 'Failed to update status' }, 500);
  }
});

router.delete('/:charName', async (c) => {
  const { teamSheetId } = c.get('session').user;
  const charName        = c.req.param('charName');
  try {
    await deleteRosterChar(teamSheetId, charName);
    return c.json({ ok: true, charName });
  } catch (err) {
    console.error('[ROSTER] Delete error:', err);
    return c.json({ error: 'Failed to delete character' }, 500);
  }
});

export default router;
