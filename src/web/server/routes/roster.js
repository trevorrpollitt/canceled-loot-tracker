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
  renameRosterChar, setRosterServer,
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
  const {
    charName, class: cls, spec, status = 'Active', ownerId = '', ownerNick = '',
    server = '',
    resolveConflictCharId = '', resolveConflictServer = '',
  } = await c.req.json();

  if (!charName?.trim()) return c.json({ error: 'charName is required' }, 400);
  if (!cls?.trim())      return c.json({ error: 'class is required' }, 400);
  if (!spec?.trim())     return c.json({ error: 'spec is required' }, 400);
  if (!CLASS_SPECS[cls]?.includes(spec)) return c.json({ error: 'Invalid class/spec combination' }, 400);
  if (!['Active', 'Bench', 'Inactive'].includes(status)) return c.json({ error: 'Invalid status' }, 400);

  try {
    const roster   = await getRoster(teamSheetId);
    const existing = roster.find(r => r.charName.toLowerCase() === charName.trim().toLowerCase());

    if (existing) {
      const incomingServer = server.trim();
      const existingServer = (existing.server ?? '').trim();
      const alreadyDisambiguated =
        incomingServer && existingServer &&
        incomingServer.toLowerCase() !== existingServer.toLowerCase();

      if (alreadyDisambiguated) {
        // Both chars have distinct servers — no resolution dialog needed, fall through to add
      } else if (resolveConflictCharId && incomingServer) {
        // Explicit conflict resolution: set server on existing char, then add new char below
        await setRosterServer(teamSheetId, resolveConflictCharId, resolveConflictServer.trim());
      } else {
        // First attempt at this name — return structured conflict so the UI can ask for servers
        return c.json({
          conflict:          true,
          existingCharId:    existing.charId,
          existingCharName:  existing.charName,
          existingServer:    existing.server ?? '',
        }, 409);
      }
    }

    const role            = specToRole(spec.trim());
    const resolvedOwnerId = ownerId.trim();
    const resolvedNick    = ownerNick.trim();
    const charId          = await addRosterChar(teamSheetId, charName.trim(), cls.trim(), spec.trim(), role, status, server.trim());
    if (resolvedOwnerId) {
      await setRosterOwner(teamSheetId, charName.trim(), resolvedOwnerId, resolvedNick);
    }
    return c.json({ charName: charName.trim(), class: cls.trim(), spec: spec.trim(), role, status, ownerId: resolvedOwnerId, ownerNick: resolvedNick, charId, server: server.trim() });
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
      .filter(e => rosterChar.charId && e.recipientCharId
        ? e.recipientCharId === rosterChar.charId
        : (e.recipientChar ?? '').toLowerCase() === charName.toLowerCase())
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(e => ({ ...e, itemId: itemIdByName.get((e.itemName ?? '').toLowerCase()) ?? '' }));

    const accountLoot = accountCharNames.length > 1
      ? lootLog
          .filter(e => accountCharNames.includes(e.recipientChar))
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .map(e => ({ ...e, itemId: itemIdByName.get((e.itemName ?? '').toLowerCase()) ?? '' }))
      : [];

    const approvedBis   = bisSubmissions.filter(s =>
      s.status === 'Approved' &&
      (rosterChar.charId && s.charId ? s.charId === rosterChar.charId : s.charName.toLowerCase() === charName.toLowerCase())
    );
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
  const { ownerId, ownerNick = '', charId = null } = await c.req.json();
  if (!ownerId?.trim()) return c.json({ error: 'ownerId is required' }, 400);
  try {
    await setRosterOwner(teamSheetId, charName, ownerId.trim(), ownerNick.trim(), charId);
    return c.json({ ok: true, charName, ownerId: ownerId.trim(), ownerNick: ownerNick.trim() });
  } catch (err) {
    console.error('[ROSTER] Set owner error:', err);
    return c.json({ error: 'Failed to link Discord account' }, 500);
  }
});

router.delete('/:charName/owner', async (c) => {
  const { teamSheetId } = c.get('session').user;
  const charName        = c.req.param('charName');
  const body            = await c.req.json().catch(() => ({}));
  const charId          = body?.charId ?? null;
  try {
    await setRosterOwner(teamSheetId, charName, '', '', charId);
    return c.json({ ok: true, charName });
  } catch (err) {
    console.error('[ROSTER] Clear owner error:', err);
    return c.json({ error: 'Failed to clear Discord account' }, 500);
  }
});

router.post('/:charName/status', async (c) => {
  const { teamSheetId }       = c.get('session').user;
  const charName              = c.req.param('charName');
  const { status, charId = null } = await c.req.json();
  if (!['Active', 'Bench', 'Inactive'].includes(status)) return c.json({ error: 'status must be Active, Bench, or Inactive' }, 400);
  try {
    await setRosterStatus(teamSheetId, charName, status, charId);
    return c.json({ ok: true, charName, status });
  } catch (err) {
    console.error('[ROSTER] Status update error:', err);
    return c.json({ error: 'Failed to update status' }, 500);
  }
});

router.post('/:charName/rename', async (c) => {
  const { teamSheetId } = c.get('session').user;
  const charName        = c.req.param('charName');
  const {
    newName,
    server = '',
    resolveConflictCharId = '', resolveConflictServer = '',
  } = await c.req.json();
  if (!newName?.trim()) return c.json({ error: 'newName is required' }, 400);
  try {
    const roster  = await getRoster(teamSheetId);
    const target  = roster.find(r => r.charName.toLowerCase() === charName.toLowerCase());
    if (!target) return c.json({ error: 'Character not found' }, 404);
    if (!target.charId) return c.json({ error: 'Character has no charId — run the migration script first' }, 409);
    const conflict = roster.find(r => r.charName.toLowerCase() === newName.trim().toLowerCase() && r.charId !== target.charId);
    if (conflict) {
      const incomingServer = server.trim();
      const conflictServer = (conflict.server ?? '').trim();
      const alreadyDisambiguated =
        incomingServer && conflictServer &&
        incomingServer.toLowerCase() !== conflictServer.toLowerCase();

      if (alreadyDisambiguated) {
        // Both chars have distinct servers — no resolution dialog needed, fall through
      } else if (resolveConflictCharId && incomingServer) {
        // Explicit conflict resolution: set server on existing char + renamed char, then rename
        await setRosterServer(teamSheetId, resolveConflictCharId, resolveConflictServer.trim());
        await setRosterServer(teamSheetId, target.charId, incomingServer);
        await renameRosterChar(teamSheetId, target.charId, newName.trim());
        return c.json({ ok: true, charId: target.charId, oldName: charName, newName: newName.trim(), server: incomingServer });
      } else {
        // First attempt — return structured conflict so the UI can ask for servers
        return c.json({
          conflict:         true,
          existingCharId:   conflict.charId,
          existingCharName: conflict.charName,
          existingServer:   conflict.server  ?? '',
          targetServer:     target.server    ?? '',
        }, 409);
      }
    }
    await renameRosterChar(teamSheetId, target.charId, newName.trim());
    await setRosterServer(teamSheetId, target.charId, server.trim());
    return c.json({ ok: true, charId: target.charId, oldName: charName, newName: newName.trim(), server: server.trim() });
  } catch (err) {
    console.error('[ROSTER] Rename error:', err);
    return c.json({ error: 'Failed to rename character' }, 500);
  }
});

router.delete('/:charName', async (c) => {
  const { teamSheetId } = c.get('session').user;
  const charName        = c.req.param('charName');
  const body            = await c.req.json().catch(() => ({}));
  const charId          = body?.charId ?? null;
  try {
    await deleteRosterChar(teamSheetId, charName, charId);
    return c.json({ ok: true, charName });
  } catch (err) {
    console.error('[ROSTER] Delete error:', err);
    return c.json({ error: 'Failed to delete character' }, 500);
  }
});

export default router;
