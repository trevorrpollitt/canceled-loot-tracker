/**
 * admin.js — Officer-only admin routes.
 *
 * GET  /api/admin/default-bis
 * POST /api/admin/default-bis
 * POST /api/admin/spec-bis-source
 * GET  /api/admin/specs
 * GET  /api/admin/bis-review
 * POST /api/admin/bis-review/approve
 * POST /api/admin/bis-review/reject
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getDefaultBis, getDefaultBisOverrides, getItemDb, getSpecBisConfig, setSpecBisSource,
  applyRaidBisInference, updateDefaultBisOverrides, getBisSubmissions,
  approveBisSubmission, rejectBisSubmission, getConfig, clearWornBis,
  invalidateWornBisSlots, getRoster,
} from '../../../lib/sheets.js';
import { toCanonical, CLASS_SPECS, getArmorType, canUseWeapon, canDualWield, canHaveOffHand } from '../../../lib/specs.js';
import { getAllTeams } from '../../../lib/teams.js';
import { runWclSyncForTeam, runWclSyncWornBisOnly } from '../../../lib/wcl-sync.js';

const TIER_SLOTS     = new Set(['Head', 'Shoulders', 'Chest', 'Hands', 'Legs']);
const CATALYST_SLOTS = new Set(['Neck', 'Back', 'Wrists', 'Waist', 'Feet']);
const DIFF_ORDER     = { Mythic: 0, Heroic: 1, Normal: 2 };

function itemOptionsForSlot(itemDb, slot, armorType, canonSpec = '', raidOnly = true) {
  let dbSlot = slot.replace(/ [12]$/, '');
  if (dbSlot === 'Off-Hand' && canonSpec && canDualWield(canonSpec)) dbSlot = 'Weapon';
  return itemDb
    .filter(item => {
      if (raidOnly && item.sourceType !== 'Raid') return false;
      if (item.slot !== dbSlot)       return false;
      if (item.isTierToken)           return false;
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

// Routes that edit guild-wide Default BIS (master sheet) require global officer role.
// All other admin routes require only the per-team officer role.
const requireGlobalOfficer = async (c, next) => {
  if (!c.get('session').user?.isGlobalOfficer) return c.json({ error: 'Global officers only' }, 403);
  await next();
};
const requireOfficer = async (c, next) => {
  if (!c.get('session').user?.isOfficer) return c.json({ error: 'Officers only' }, 403);
  await next();
};

// ── GET /api/admin/default-bis ─────────────────────────────────────────────────

router.get('/default-bis', requireGlobalOfficer, async (c) => {
  const spec            = c.req.query('spec');
  const requestedSource = c.req.query('source');
  if (!spec) return c.json({ error: 'spec is required' }, 400);

  const { teamSheetId } = c.get('session').user;
  if (!teamSheetId) return c.json({ error: 'No team sheet configured' }, 400);

  try {
    const [allRows, overrideRows, itemDb, specConfig] = await Promise.all([
      getDefaultBis(), getDefaultBisOverrides(), getItemDb(), getSpecBisConfig(),
    ]);

    const canonicalSpec    = toCanonical(spec);
    const specRows         = allRows.filter(r => r.spec === canonicalSpec);
    const availableSources = [...new Set(specRows.map(r => r.source).filter(Boolean))];
    const preferredSource  = specConfig.get(canonicalSpec) ?? availableSources[0] ?? '';
    const displaySource    = (requestedSource && availableSources.includes(requestedSource))
      ? requestedSource : preferredSource;

    // Seed rows for this source (unchanged guide data — used for ★ indicator)
    const seedRows = specRows.filter(r => r.source === displaySource);

    // Merge officer overrides on top of seed rows before inference
    const rows = seedRows.map(r => {
      const ovr = overrideRows.find(
        o => o.spec === canonicalSpec && o.slot === r.slot && o.source === r.source
      );
      return ovr ? {
        ...r,
        trueBis:       ovr.trueBis       || r.trueBis,
        trueBisItemId: ovr.trueBisItemId || r.trueBisItemId,
        raidBis:       ovr.raidBis       || r.raidBis,
        raidBisItemId: ovr.raidBisItemId || r.raidBisItemId,
      } : r;
    });

    const withInference = applyRaidBisInference(rows, itemDb);
    const armorType     = getArmorType(canonicalSpec);

    const withOptions = withInference.map(row => {
      const seed = seedRows.find(s => s.slot === row.slot);
      return {
        ...row,
        trueBisSeed:    seed?.trueBis  ?? '',
        raidBisSeed:    seed?.raidBis  ?? '',
        options:        itemOptionsForSlot(itemDb, row.slot, armorType, canonicalSpec, true),
        overallOptions: itemOptionsForSlot(itemDb, row.slot, armorType, canonicalSpec, false),
        hasTier:        TIER_SLOTS.has(row.slot),
        hasCatalyst:    CATALYST_SLOTS.has(row.slot),
      };
    });

    // For dual-wield specs whose default BIS was seeded from a 2H guide, the
    // Off-Hand slot may be absent. Inject a synthetic editable row so officers
    // can set the Raid BIS without needing to re-seed.
    if (canHaveOffHand(canonicalSpec) && !withOptions.some(r => r.slot === 'Off-Hand')) {
      withOptions.push({
        slot: 'Off-Hand', source: displaySource,
        trueBis: '', trueBisItemId: '', raidBis: '', raidBisItemId: '',
        trueBisSeed: '', raidBisSeed: '',
        raidBisAuto: false,
        options:        itemOptionsForSlot(itemDb, 'Off-Hand', armorType, canonicalSpec, true),
        overallOptions: itemOptionsForSlot(itemDb, 'Off-Hand', armorType, canonicalSpec, false),
        hasTier: false, hasCatalyst: false,
      });
    }

    return c.json({ spec, source: displaySource, availableSources, preferredSource, rows: withOptions });
  } catch (err) {
    console.error('[ADMIN] default-bis GET error:', err);
    return c.json({ error: 'Failed to load default BIS' }, 500);
  }
});

// ── POST /api/admin/default-bis ────────────────────────────────────────────────

router.post('/default-bis', requireGlobalOfficer, async (c) => {
  const { spec, source, updates } = await c.req.json();
  if (!spec || !source || !Array.isArray(updates)) {
    return c.json({ error: 'spec, source, and updates[] are required' }, 400);
  }
  const { teamSheetId } = c.get('session').user;
  if (!teamSheetId) return c.json({ error: 'No team sheet configured' }, 400);
  try {
    const canonicalSpec = toCanonical(spec);
    const writes = updates.map(u => ({
      spec: canonicalSpec, source,
      slot:          u.slot,
      raidBis:       u.raidBis,       raidBisItemId: u.raidBisItemId,
      trueBis:       u.trueBis,       trueBisItemId: u.trueBisItemId,
    }));
    await updateDefaultBisOverrides(writes);

    // Invalidate worn BIS for all characters whose effective BIS for these slots came
    // from spec defaults (i.e. they have no personal approved submission for the slot).
    // Must cover all teams since default BIS is global.
    const changedSlots = new Set(writes.map(w => w.slot));
    const allTeams     = getAllTeams();
    await Promise.all(allTeams.map(async team => {
      const [roster, subs] = await Promise.all([
        getRoster(team.sheetId),
        getBisSubmissions(team.sheetId),
      ]);
      // Build set of charId+slot pairs that have a personal approved submission
      const personalApproved = new Set(
        subs
          .filter(s => s.status === 'Approved' && s.charId && changedSlots.has(s.slot))
          .map(s => `${s.charId}:${s.slot}`),
      );
      const targets = [];
      for (const char of roster) {
        if (!char.charId) continue;
        if (toCanonical(char.spec) !== canonicalSpec) continue;
        for (const slot of changedSlots) {
          if (!personalApproved.has(`${char.charId}:${slot}`)) {
            targets.push({ charId: char.charId, slot });
          }
        }
      }
      if (targets.length) await invalidateWornBisSlots(team.sheetId, targets);
    }));

    return c.json({ ok: true, updated: writes.length });
  } catch (err) {
    console.error('[ADMIN] default-bis POST error:', err);
    return c.json({ error: 'Failed to save Raid BIS' }, 500);
  }
});

// ── POST /api/admin/spec-bis-source ────────────────────────────────────────────

router.post('/spec-bis-source', requireGlobalOfficer, async (c) => {
  const { spec, source } = await c.req.json();
  if (!spec || !source) return c.json({ error: 'spec and source are required' }, 400);
  const { teamSheetId } = c.get('session').user;
  if (!teamSheetId) return c.json({ error: 'No team sheet configured' }, 400);
  try {
    const canonicalSpec = toCanonical(spec);
    await setSpecBisSource(canonicalSpec, source);
    return c.json({ ok: true, spec: canonicalSpec, source });
  } catch (err) {
    console.error('[ADMIN] spec-bis-source POST error:', err);
    return c.json({ error: 'Failed to save preferred source' }, 500);
  }
});

// ── GET /api/admin/specs ───────────────────────────────────────────────────────

router.get('/specs', requireGlobalOfficer, (c) => c.json(CLASS_SPECS));

// ── GET /api/admin/bis-review ──────────────────────────────────────────────────

router.get('/bis-review', requireOfficer, async (c) => {
  const { teamSheetId } = c.get('session').user;
  if (!teamSheetId) return c.json({ error: 'No team sheet configured' }, 400);
  try {
    const [allSubmissions, itemDb, allDefaults, specConfig] = await Promise.all([
      getBisSubmissions(teamSheetId), getItemDb(), getDefaultBis(), getSpecBisConfig(),
    ]);

    const itemByName = new Map(itemDb.map(i => [i.name.toLowerCase(), i]));
    const resolveSource = (name) => {
      if (!name) return null;
      const item = itemByName.get(name.toLowerCase());
      if (!item) return null;
      return { itemId: String(item.itemId ?? ''), difficulty: item.difficulty ?? '', sourceType: item.sourceType ?? '', sourceName: item.sourceName ?? '' };
    };

    const specDefaultByKey = new Map();
    for (const canonSpec of [...new Set(allDefaults.map(r => toCanonical(r.spec)))]) {
      const specRows  = allDefaults.filter(r => toCanonical(r.spec) === canonSpec);
      const sources   = [...new Set(specRows.map(r => r.source).filter(Boolean))];
      const preferred = specConfig.get(canonSpec);
      const source    = (preferred && sources.includes(preferred)) ? preferred : (sources[0] ?? '');
      for (const row of applyRaidBisInference(specRows.filter(r => r.source === source), itemDb)) {
        if (!row.trueBis) continue;
        specDefaultByKey.set(canonSpec + '::' + row.slot, { trueBis: row.trueBis ?? '', raidBis: row.raidBis ?? '', source });
      }
    }

    const approvedByKey = new Map();
    for (const s of allSubmissions) {
      if (s.status !== 'Approved') continue;
      approvedByKey.set(s.charName + '::' + s.slot, { trueBis: s.trueBis ?? '', raidBis: s.raidBis ?? '' });
    }

    const resolveCurrent = (charName, spec, slot) => {
      const approved = approvedByKey.get(charName + '::' + slot);
      if (approved) return { ...approved, isDefault: false, defaultSource: null };
      const def = specDefaultByKey.get(toCanonical(spec) + '::' + slot);
      if (def)      return { ...def,      isDefault: true,  defaultSource: def.source ?? null };
      return null;
    };

    const pending  = allSubmissions.filter(s => s.status === 'Pending');
    const groupMap = new Map();
    for (const s of pending) {
      if (!groupMap.has(s.charName)) groupMap.set(s.charName, { charName: s.charName, spec: s.spec, submissions: [] });
      const current = resolveCurrent(s.charName, s.spec, s.slot);
      groupMap.get(s.charName).submissions.push({
        id: s.id, slot: s.slot,
        current: current ? {
          trueBis: current.trueBis, trueBisSource: resolveSource(current.trueBis),
          raidBis: current.raidBis, raidBisSource: resolveSource(current.raidBis),
          isDefault: current.isDefault, defaultSource: current.defaultSource,
        } : null,
        trueBis: s.trueBis, trueBisSource: resolveSource(s.trueBis),
        raidBis: s.raidBis, raidBisSource: resolveSource(s.raidBis),
        rationale: s.rationale, submittedAt: s.submittedAt,
      });
    }
    return c.json({ pending: pending.length, groups: [...groupMap.values()] });
  } catch (err) {
    console.error('[ADMIN] bis-review GET error:', err);
    return c.json({ error: 'Failed to load BIS review queue' }, 500);
  }
});

// ── POST /api/admin/bis-review/approve ─────────────────────────────────────────

router.post('/bis-review/approve', requireOfficer, async (c) => {
  const { id } = await c.req.json();
  if (!id) return c.json({ error: 'id is required' }, 400);
  const { teamSheetId, charName: officerChar, username } = c.get('session').user;
  if (!teamSheetId) return c.json({ error: 'No team sheet configured' }, 400);
  try {
    // Look up the submission before approving so we can invalidate worn BIS for this slot
    const subs = await getBisSubmissions(teamSheetId);
    const sub  = subs.find(s => s.id === id);

    await approveBisSubmission(teamSheetId, id, officerChar ?? username ?? 'Officer');

    // Invalidate worn BIS for this character+slot — the BIS definition has changed
    if (sub?.charId && sub?.slot) {
      await invalidateWornBisSlots(teamSheetId, [{ charId: sub.charId, slot: sub.slot }]);
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] bis-review approve error:', err);
    return c.json({ error: 'Failed to approve submission' }, 500);
  }
});

// ── POST /api/admin/bis-review/reject ──────────────────────────────────────────

router.post('/bis-review/reject', requireOfficer, async (c) => {
  const { id, officerNote = '' } = await c.req.json();
  if (!id) return c.json({ error: 'id is required' }, 400);
  const { teamSheetId, charName: officerChar, username } = c.get('session').user;
  if (!teamSheetId) return c.json({ error: 'No team sheet configured' }, 400);
  try {
    await rejectBisSubmission(teamSheetId, id, officerChar ?? username ?? 'Officer', officerNote);
    return c.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] bis-review reject error:', err);
    return c.json({ error: 'Failed to reject submission' }, 500);
  }
});

// ── WCL sync (manual trigger) ─────────────────────────────────────────────────

router.get('/wcl-status', requireOfficer, async (c) => {
  const { teamSheetId } = c.get('session').user;
  try {
    const config = await getConfig(teamSheetId);
    const lastCheck = Number(config.wcl_last_check) || null;
    return c.json({ lastCheck });
  } catch (err) {
    return c.json({ error: 'Failed to load status' }, 500);
  }
});

router.post('/wcl-sync', requireOfficer, async (c) => {
  const { teamSheetId } = c.get('session').user;
  const team = getAllTeams().find(t => t.sheetId === teamSheetId);
  if (!team) return c.json({ error: 'Team not found' }, 404);
  try {
    await runWclSyncForTeam(team);
    return c.json({ ok: true });
  } catch (err) {
    console.error('[admin] WCL sync error:', err);
    return c.json({ error: err.message ?? 'Sync failed' }, 500);
  }
});

router.post('/wcl-sync-worn-bis', requireOfficer, async (c) => {
  const { teamSheetId } = c.get('session').user;
  const team = getAllTeams().find(t => t.sheetId === teamSheetId);
  if (!team) return c.json({ error: 'Team not found' }, 404);
  try {
    await runWclSyncWornBisOnly(team);
    return c.json({ ok: true });
  } catch (err) {
    console.error('[admin] WCL worn BIS resync error:', err);
    return c.json({ error: err.message ?? 'Sync failed' }, 500);
  }
});

// ── DELETE /api/admin/worn-bis ─────────────────────────────────────────────────

router.delete('/worn-bis', requireOfficer, async (c) => {
  const { teamSheetId } = c.get('session').user;
  if (!teamSheetId) return c.json({ error: 'No team sheet configured' }, 400);
  try {
    await clearWornBis(teamSheetId);
    return c.json({ ok: true });
  } catch (err) {
    console.error('[admin] worn-bis reset error:', err);
    return c.json({ error: err.message ?? 'Reset failed' }, 500);
  }
});

export default router;
