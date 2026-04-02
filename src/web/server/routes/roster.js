/**
 * roster.js — Officer roster routes.
 *
 * GET    /api/roster
 * POST   /api/roster
 * GET    /api/roster/:charId
 * POST   /api/roster/owner-nick
 * POST   /api/roster/:charId/owner
 * DELETE /api/roster/:charId/owner
 * POST   /api/roster/:charId/status
 * POST   /api/roster/:charId/rename
 * DELETE /api/roster/:charId
 * POST   /api/roster/:charId/secondary-specs
 * POST   /api/roster/:charId/spec-change
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getRoster, getLootLog, getBisSubmissions,
  getEffectiveDefaultBis, getItemDb,
  getWornBis,
  setRosterStatus, setOwnerNick, setRosterOwner, addRosterChar, deleteRosterChar,
  renameRosterChar, setRosterServer, setSecondarySpecs,
  approvePrimarySpecChange, rejectPrimarySpecChange,
} from '../../../lib/db.js';
import { applyRaidBisInference } from '../../../lib/bis-match.js';
import { toCanonical, CLASS_SPECS, getCharSpecs } from '../../../lib/specs.js';

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

/** Normalise a raw D1 bis_submissions row to camelCase for the client. */
function normalizeBisSub(s) {
  return {
    slot:          s.slot,
    spec:          s.spec         ?? '',
    status:        s.status       ?? '',
    trueBis:       s.true_bis     ?? '',
    trueBisItemId: s.true_bis_item_id ?? '',
    raidBis:       s.raid_bis     ?? '',
    raidBisItemId: s.raid_bis_item_id ?? '',
    rationale:     s.rationale    ?? '',
    officerNote:   s.officer_note ?? '',
  };
}

/**
 * If the renamed character belongs to the currently logged-in user, update their
 * session's chars array and active charName so the dashboard tabs stay in sync
 * without requiring a re-login.
 */
function patchSessionAfterRename(c, charId, newName) {
  const session = c.get('session');
  if (!session?.user) return;
  session.user.chars = (session.user.chars ?? []).map(ch =>
    ch.charId === charId ? { ...ch, charName: newName } : ch
  );
  if (session.user.charId === charId) {
    session.user.charName = newName;
  }
}

const router = new Hono();
router.use('*', requireAuth);
router.use('*', async (c, next) => {
  if (!c.get('session').user?.isOfficer) return c.json({ error: 'Officer only' }, 403);
  await next();
});

router.get('/', async (c) => {
  const { teamId } = c.get('session').user;
  if (!teamId) return c.json([]);
  const db = c.env.DB;
  try {
    const roster = await getRoster(db, teamId);
    const sorted = [...roster]
      .sort((a, b) => {
        const ai = a.status === 'Inactive' ? 1 : 0;
        const bi = b.status === 'Inactive' ? 1 : 0;
        if (ai !== bi) return ai - bi;
        return a.char_name.localeCompare(b.char_name);
      })
      .map(r => ({
        charId:    r.id,
        charName:  r.char_name,
        class:     r.class,
        spec:      r.spec,
        role:      r.role,
        status:    r.status,
        ownerId:   r.owner_id   ?? '',
        ownerNick: r.owner_nick ?? '',
        server:    r.server     ?? '',
      }));
    return c.json(sorted);
  } catch (err) {
    console.error('[ROSTER] Error:', err);
    return c.json({ error: 'Failed to load roster' }, 500);
  }
});

router.post('/', async (c) => {
  const { teamId } = c.get('session').user;
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

  const db = c.env.DB;
  try {
    const roster   = await getRoster(db, teamId);
    const existing = roster.find(r => r.char_name.toLowerCase() === charName.trim().toLowerCase());

    if (existing) {
      const incomingServer = server.trim();
      const existingServer = (existing.server ?? '').trim();
      const alreadyDisambiguated =
        incomingServer && existingServer &&
        incomingServer.toLowerCase() !== existingServer.toLowerCase();

      if (alreadyDisambiguated) {
        // Both chars have distinct servers — no resolution dialog needed, fall through to add
      } else if (resolveConflictCharId && incomingServer) {
        await setRosterServer(db, Number(resolveConflictCharId), resolveConflictServer.trim());
      } else {
        return c.json({
          conflict:         true,
          existingCharId:   existing.id,
          existingCharName: existing.char_name,
          existingServer:   existing.server ?? '',
        }, 409);
      }
    }

    const role   = specToRole(spec.trim());
    const newId  = await addRosterChar(db, teamId, {
      charName: charName.trim(), cls: cls.trim(), spec: spec.trim(),
      role, status, server: server.trim(),
    });
    if (ownerId.trim()) {
      await setRosterOwner(db, newId, ownerId.trim(), ownerNick.trim());
    }
    return c.json({ charId: newId, charName: charName.trim(), class: cls.trim(), spec: spec.trim(), role, status, ownerId: ownerId.trim(), ownerNick: ownerNick.trim(), server: server.trim() });
  } catch (err) {
    console.error('[ROSTER] Add character error:', err);
    return c.json({ error: 'Failed to add character' }, 500);
  }
});

router.get('/owner-nick', async (c) => c.json({ error: 'Use POST' }, 405));

router.post('/owner-nick', async (c) => {
  const { teamId } = c.get('session').user;
  const { ownerId, ownerNick } = await c.req.json();
  if (!ownerId)           return c.json({ error: 'ownerId is required' }, 400);
  if (!ownerNick?.trim()) return c.json({ error: 'ownerNick is required' }, 400);
  const db = c.env.DB;
  try {
    await setOwnerNick(db, teamId, ownerId, ownerNick.trim());
    return c.json({ ok: true, ownerId, ownerNick: ownerNick.trim() });
  } catch (err) {
    console.error('[ROSTER] Owner nick update error:', err);
    return c.json({ error: 'Failed to update player name' }, 500);
  }
});

router.get('/:charId', async (c) => {
  const { teamId } = c.get('session').user;
  const charId     = Number(c.req.param('charId'));
  if (!teamId || !charId) return c.json({ error: 'No team' }, 404);
  const db = c.env.DB;
  try {
    const [roster, lootLog, bisSubmissions, wornBisMap, effectiveBis, itemDb] = await Promise.all([
      getRoster(db, teamId), getLootLog(db, teamId), getBisSubmissions(db, teamId),
      getWornBis(db, teamId), getEffectiveDefaultBis(db), getItemDb(db),
    ]);
    const rosterChar = roster.find(r => r.id === charId);
    if (!rosterChar) return c.json({ error: 'Character not found' }, 404);

    const itemIdByName = new Map();
    for (const item of itemDb) if (item.name) itemIdByName.set(item.name.toLowerCase(), item.item_id);

    const accountCharIds = rosterChar.owner_id
      ? roster.filter(r => r.owner_id === rosterChar.owner_id).map(r => r.id)
      : [rosterChar.id];
    const accountCharNames = rosterChar.owner_id
      ? roster.filter(r => r.owner_id === rosterChar.owner_id).map(r => r.char_name)
      : [rosterChar.char_name];

    const loot = lootLog
      .filter(e => e.recipient_char_id === rosterChar.id)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(e => ({ ...e, itemId: itemIdByName.get((e.item_name ?? '').toLowerCase()) ?? '' }));

    const accountLoot = accountCharIds.length > 1
      ? lootLog
          .filter(e => accountCharIds.includes(e.recipient_char_id))
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .map(e => ({ ...e, itemId: itemIdByName.get((e.item_name ?? '').toLowerCase()) ?? '' }))
      : [];

    const charSpecs = getCharSpecs(rosterChar);

    // All approved BIS for this character, normalised to camelCase for the client
    const charApprovedBis = bisSubmissions
      .filter(s => s.status === 'Approved' && s.char_id === rosterChar.id)
      .map(normalizeBisSub);

    const bisBySpec      = {};
    const defaultsBySpec = {};
    for (const spec of charSpecs.all) {
      const canonSpec = toCanonical(spec);
      const specRows  = effectiveBis.filter(d => d.spec === canonSpec);
      defaultsBySpec[spec] = applyRaidBisInference(specRows, itemDb); // already camelCase
      bisBySpec[spec] = charApprovedBis.filter(s =>
        s.spec ? s.spec.toLowerCase() === spec.toLowerCase() : spec === charSpecs.primary
      );
    }

    const approvedBis  = bisBySpec[charSpecs.primary] ?? [];
    const specDefaults = defaultsBySpec[charSpecs.primary] ?? [];

    const wornBisBySpec = {};
    for (const [key, row] of wornBisMap) {
      if (row.char_id !== rosterChar.id) continue;
      if (!wornBisBySpec[row.spec]) wornBisBySpec[row.spec] = {};
      wornBisBySpec[row.spec][row.slot] = {
        overallBISTrack: row.overall_bis_track ?? '',
        raidBISTrack:    row.raid_bis_track    ?? '',
        otherTrack:      row.other_track       ?? '',
      };
    }

    return c.json({
      charName: rosterChar.char_name, charId: rosterChar.id,
      class: rosterChar.class, spec: rosterChar.spec,
      role: rosterChar.role, status: rosterChar.status, ownerNick: rosterChar.owner_nick,
      secondarySpecs:     charSpecs.secondary,
      pendingPrimarySpec: charSpecs.pending,
      bis: approvedBis, specDefaults,
      bisBySpec, defaultsBySpec,
      loot, accountChars: accountCharNames, accountLoot, wornBisBySpec,
    });
  } catch (err) {
    console.error('[ROSTER] Character detail error:', err);
    return c.json({ error: 'Failed to load character data' }, 500);
  }
});

router.post('/:charId/owner', async (c) => {
  const { teamId }  = c.get('session').user;
  const charId      = Number(c.req.param('charId'));
  const { ownerId, ownerNick = '' } = await c.req.json();
  if (!ownerId?.trim()) return c.json({ error: 'ownerId is required' }, 400);
  const db = c.env.DB;
  try {
    const roster = await getRoster(db, teamId);
    const target = roster.find(r => r.id === charId);
    if (!target) return c.json({ error: 'Character not found' }, 404);
    await setRosterOwner(db, target.id, ownerId.trim(), ownerNick.trim());
    return c.json({ ok: true, charName: target.char_name, ownerId: ownerId.trim(), ownerNick: ownerNick.trim() });
  } catch (err) {
    console.error('[ROSTER] Set owner error:', err);
    return c.json({ error: 'Failed to link Discord account' }, 500);
  }
});

router.delete('/:charId/owner', async (c) => {
  const { teamId } = c.get('session').user;
  const charId     = Number(c.req.param('charId'));
  const db = c.env.DB;
  try {
    const roster = await getRoster(db, teamId);
    const target = roster.find(r => r.id === charId);
    if (!target) return c.json({ error: 'Character not found' }, 404);
    await setRosterOwner(db, target.id, '', '');
    return c.json({ ok: true, charName: target.char_name });
  } catch (err) {
    console.error('[ROSTER] Clear owner error:', err);
    return c.json({ error: 'Failed to clear Discord account' }, 500);
  }
});

router.post('/:charId/status', async (c) => {
  const { teamId } = c.get('session').user;
  const charId     = Number(c.req.param('charId'));
  const { status } = await c.req.json();
  if (!['Active', 'Bench', 'Inactive'].includes(status)) return c.json({ error: 'status must be Active, Bench, or Inactive' }, 400);
  const db = c.env.DB;
  try {
    const roster = await getRoster(db, teamId);
    const target = roster.find(r => r.id === charId);
    if (!target) return c.json({ error: 'Character not found' }, 404);
    await setRosterStatus(db, target.id, status);
    return c.json({ ok: true, charName: target.char_name, status });
  } catch (err) {
    console.error('[ROSTER] Status update error:', err);
    return c.json({ error: 'Failed to update status' }, 500);
  }
});

router.post('/:charId/rename', async (c) => {
  const { teamId } = c.get('session').user;
  const charId     = Number(c.req.param('charId'));
  const {
    newName,
    server = '',
    resolveConflictCharId = '', resolveConflictServer = '',
  } = await c.req.json();
  if (!newName?.trim()) return c.json({ error: 'newName is required' }, 400);
  const db = c.env.DB;
  try {
    const roster   = await getRoster(db, teamId);
    const target   = roster.find(r => r.id === charId);
    if (!target) return c.json({ error: 'Character not found' }, 404);
    const conflict = roster.find(r => r.char_name.toLowerCase() === newName.trim().toLowerCase() && r.id !== target.id);
    if (conflict) {
      const incomingServer = server.trim();
      const conflictServer = (conflict.server ?? '').trim();
      const alreadyDisambiguated =
        incomingServer && conflictServer &&
        incomingServer.toLowerCase() !== conflictServer.toLowerCase();

      if (alreadyDisambiguated) {
        // Both chars have distinct servers — no resolution dialog needed, fall through
      } else if (resolveConflictCharId && incomingServer) {
        await setRosterServer(db, Number(resolveConflictCharId), resolveConflictServer.trim());
        await setRosterServer(db, target.id, incomingServer);
        await renameRosterChar(db, target.id, newName.trim());
        patchSessionAfterRename(c, target.id, newName.trim());
        return c.json({ ok: true, charId: target.id, oldName: target.char_name, newName: newName.trim(), server: incomingServer });
      } else {
        return c.json({
          conflict:         true,
          existingCharId:   conflict.id,
          existingCharName: conflict.char_name,
          existingServer:   conflict.server  ?? '',
          targetServer:     target.server    ?? '',
        }, 409);
      }
    }
    await renameRosterChar(db, target.id, newName.trim());
    await setRosterServer(db, target.id, server.trim());
    patchSessionAfterRename(c, target.id, newName.trim());
    return c.json({ ok: true, charId: target.id, oldName: target.char_name, newName: newName.trim(), server: server.trim() });
  } catch (err) {
    console.error('[ROSTER] Rename error:', err);
    return c.json({ error: 'Failed to rename character' }, 500);
  }
});

router.delete('/:charId', async (c) => {
  const { teamId } = c.get('session').user;
  const charId     = Number(c.req.param('charId'));
  const db = c.env.DB;
  try {
    const roster = await getRoster(db, teamId);
    const target = roster.find(r => r.id === charId);
    if (!target) return c.json({ error: 'Character not found' }, 404);
    await deleteRosterChar(db, target.id);
    return c.json({ ok: true, charName: target.char_name });
  } catch (err) {
    console.error('[ROSTER] Delete error:', err);
    return c.json({ error: 'Failed to delete character' }, 500);
  }
});

router.post('/:charId/secondary-specs', async (c) => {
  const { teamId } = c.get('session').user;
  const charId     = Number(c.req.param('charId'));
  const { specs = [] } = await c.req.json();
  if (!Array.isArray(specs)) return c.json({ error: 'specs must be an array' }, 400);

  const db = c.env.DB;
  try {
    const roster     = await getRoster(db, teamId);
    const rosterChar = roster.find(r => r.id === charId);
    if (!rosterChar) return c.json({ error: 'Character not found' }, 404);

    const classSpecs = CLASS_SPECS[rosterChar.class] ?? [];
    for (const s of specs) {
      if (!classSpecs.includes(s))
        return c.json({ error: `"${s}" is not a valid spec for class "${rosterChar.class}"` }, 400);
      if (s === rosterChar.spec)
        return c.json({ error: `"${s}" is already the primary spec — cannot be secondary` }, 400);
    }

    await setSecondarySpecs(db, rosterChar.id, specs);
    return c.json({ ok: true, charName: rosterChar.char_name, secondarySpecs: specs });
  } catch (err) {
    console.error('[ROSTER] Secondary specs error:', err);
    return c.json({ error: 'Failed to update secondary specs' }, 500);
  }
});

router.post('/:charId/spec-change', async (c) => {
  const charId     = Number(c.req.param('charId'));
  const { approve } = await c.req.json();
  if (!charId)               return c.json({ error: 'charId is required' }, 400);
  if (approve === undefined) return c.json({ error: 'approve (bool) is required' }, 400);
  const db = c.env.DB;
  try {
    if (approve) {
      await approvePrimarySpecChange(db, charId);
      return c.json({ ok: true });
    } else {
      await rejectPrimarySpecChange(db, charId);
      return c.json({ ok: true });
    }
  } catch (err) {
    console.error('[ROSTER] Spec change error:', err);
    return c.json({ error: 'Failed to process spec change' }, 500);
  }
});

export default router;
