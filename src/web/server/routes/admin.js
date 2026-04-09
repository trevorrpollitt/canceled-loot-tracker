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
  updateDefaultBisOverrides, getBisSubmissions,
  approveBisSubmission, rejectBisSubmission, getTeamConfig, setTeamConfigValue, clearWornBis,
  invalidateWornBisSlots, getRoster, approvePrimarySpecChange, rejectPrimarySpecChange,
  getEffectiveDefaultBis, getAllTeams, getGlobalConfig, setGlobalConfigValue,
  getRclcResponseMapRows, setRclcResponseMap,
} from '../../../lib/db.js';
import { applyRaidBisInference } from '../../../lib/bis-match.js';
import { toCanonical, CLASS_SPECS, getArmorType, canUseWeapon, canDualWield, canHaveOffHand, getCharSpecs } from '../../../lib/specs.js';
import { runWclSyncForTeam, runWclSyncWornBisOnly } from '../../../lib/wcl-sync.js';
import {
  getTeamRegistry      as sheetsGetTeamRegistry,
  getGlobalConfig      as sheetsGetGlobalConfig,
  getItemDb            as sheetsGetItemDb,
  getDefaultBis        as sheetsGetDefaultBis,
  getDefaultBisOverrides as sheetsGetDefaultBisOverrides,
  getSpecBisConfig     as sheetsGetSpecBisConfig,
  getTierItems         as sheetsGetTierItems,
  getRoster            as sheetsGetRoster,
  getLootLog           as sheetsGetLootLog,
  getBisSubmissions    as sheetsGetBisSubmissions,
  getRaids             as sheetsGetRaids,
  getRaidEncounters    as sheetsGetRaidEncounters,
  getTierSnapshot      as sheetsGetTierSnapshot,
  getWornBis           as sheetsGetWornBis,
  getRclcResponseMap   as sheetsGetRclcResponseMap,
  getConfig            as sheetsGetConfig,
} from '../../../lib/sheets.js';

/** Execute D1 prepared statements in chunks to stay under the 100-statement batch limit. */
async function batchInsert(db, stmts, chunkSize = 80) {
  for (let i = 0; i < stmts.length; i += chunkSize) {
    await db.batch(stmts.slice(i, i + chunkSize));
  }
}

const TIER_SLOTS     = new Set(['Head', 'Shoulders', 'Chest', 'Hands', 'Legs']);
const CATALYST_SLOTS = new Set(['Neck', 'Back', 'Wrists', 'Waist', 'Feet']);
const DIFF_ORDER     = { Mythic: 0, Heroic: 1, Normal: 2 };

function itemOptionsForSlot(itemDb, slot, armorType, canonSpec = '', raidOnly = true) {
  let dbSlot = slot.replace(/ [12]$/, '');
  if (dbSlot === 'Off-Hand' && canonSpec && canDualWield(canonSpec)) dbSlot = 'Weapon';
  return itemDb
    .filter(item => {
      if (raidOnly && item.source_type !== 'Raid') return false;
      if (item.slot !== dbSlot)     return false;
      if (item.is_tier_token)       return false;
      if (item.armor_type === 'Accessory') {
        if (item.weapon_type && canonSpec) return canUseWeapon(canonSpec, item.weapon_type);
        return true;
      }
      return item.armor_type === armorType;
    })
    .map(item => ({
      itemId:     String(item.item_id),
      name:       item.name,
      difficulty: item.difficulty ?? '',
      source:     item.source_name ?? '',
      sourceType: item.source_type ?? '',
    }))
    .sort((a, b) => {
      const da = DIFF_ORDER[a.difficulty] ?? 9;
      const db = DIFF_ORDER[b.difficulty] ?? 9;
      return da !== db ? da - db : a.name.localeCompare(b.name);
    });
}

const router = new Hono();

router.use('*', requireAuth);

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

  const db = c.env.DB;

  try {
    const [allRows, overrideRows, itemDb, specConfig] = await Promise.all([
      getDefaultBis(db), getDefaultBisOverrides(db), getItemDb(db), getSpecBisConfig(db),
    ]);

    const canonicalSpec    = toCanonical(spec);
    const specRows         = allRows.filter(r => r.spec === canonicalSpec);
    const availableSources = [...new Set(specRows.map(r => r.source).filter(Boolean))];
    const preferredSource  = specConfig.get(canonicalSpec) ?? availableSources[0] ?? '';
    const displaySource    = (requestedSource && availableSources.includes(requestedSource))
      ? requestedSource : preferredSource;

    const seedRows = specRows.filter(r => r.source === displaySource);

    const rows = seedRows.map(r => {
      const ovr = overrideRows.find(
        o => o.spec === canonicalSpec && o.slot === r.slot && o.source === r.source
      );
      return ovr ? {
        ...r,
        true_bis:          ovr.true_bis          || r.true_bis,
        true_bis_item_id:  ovr.true_bis_item_id  || r.true_bis_item_id,
        raid_bis:          ovr.raid_bis          || r.raid_bis,
        raid_bis_item_id:  ovr.raid_bis_item_id  || r.raid_bis_item_id,
      } : r;
    });

    const withInference = applyRaidBisInference(rows, itemDb);
    const armorType     = getArmorType(canonicalSpec);

    const withOptions = withInference.map(row => {
      const seed = seedRows.find(s => s.slot === row.slot);
      return {
        ...row,
        trueBisSeed:    seed?.true_bis  ?? '',
        raidBisSeed:    seed?.raid_bis  ?? '',
        options:        itemOptionsForSlot(itemDb, row.slot, armorType, canonicalSpec, true),
        overallOptions: itemOptionsForSlot(itemDb, row.slot, armorType, canonicalSpec, false),
        hasTier:        TIER_SLOTS.has(row.slot),
        hasCatalyst:    CATALYST_SLOTS.has(row.slot),
      };
    });

    if (canHaveOffHand(canonicalSpec) && !withOptions.some(r => r.slot === 'Off-Hand')) {
      withOptions.push({
        slot: 'Off-Hand', source: displaySource,
        true_bis: '', true_bis_item_id: '', raid_bis: '', raid_bis_item_id: '',
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
  const db = c.env.DB;
  try {
    const canonicalSpec = toCanonical(spec);
    const writes = updates.map(u => ({
      spec: canonicalSpec, source,
      slot:          u.slot,
      raidBis:       u.raidBis,       raidBisItemId: u.raidBisItemId,
      trueBis:       u.trueBis,       trueBisItemId: u.trueBisItemId,
    }));
    await updateDefaultBisOverrides(db, writes);

    // Invalidate worn BIS across all teams for chars using spec defaults for these slots
    const changedSlots = new Set(writes.map(w => w.slot));
    const allTeams     = await getAllTeams(db);
    await Promise.all(allTeams.map(async team => {
      const [roster, subs] = await Promise.all([
        getRoster(db, team.id),
        getBisSubmissions(db, team.id),
      ]);
      const personalApproved = new Set(
        subs
          .filter(s => s.status === 'Approved' && s.char_id && changedSlots.has(s.slot))
          .map(s => `${s.char_id}:${s.slot}`),
      );
      const targets = [];
      for (const char of roster) {
        if (toCanonical(char.spec) !== canonicalSpec) continue;
        for (const slot of changedSlots) {
          if (!personalApproved.has(`${char.id}:${slot}`)) {
            targets.push({ charId: char.id, slot });
          }
        }
      }
      if (targets.length) await invalidateWornBisSlots(db, team.id, targets);
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
  const db = c.env.DB;
  try {
    const canonicalSpec = toCanonical(spec);
    await setSpecBisSource(db, canonicalSpec, source);
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
  const { teamId } = c.get('session').user;
  if (!teamId) return c.json({ error: 'No team configured' }, 400);
  const db = c.env.DB;
  try {
    const [allSubmissions, itemDb, effectiveDefaults, roster] = await Promise.all([
      getBisSubmissions(db, teamId), getItemDb(db), getEffectiveDefaultBis(db), getRoster(db, teamId),
    ]);

    const itemByName = new Map(itemDb.map(i => [i.name.toLowerCase(), i]));
    const resolveSource = (name) => {
      if (!name) return null;
      const item = itemByName.get(name.toLowerCase());
      if (!item) return null;
      return { itemId: String(item.item_id ?? ''), difficulty: item.difficulty ?? '', sourceType: item.source_type ?? '', sourceName: item.source_name ?? '' };
    };

    const specDefaultByKey = new Map();
    for (const row of applyRaidBisInference(effectiveDefaults, itemDb)) {
      if (!row.true_bis) continue;
      const canonSpec = toCanonical(row.spec);
      specDefaultByKey.set(canonSpec + '::' + row.slot, { trueBis: row.true_bis ?? '', raidBis: row.raid_bis ?? '', source: row.source ?? '' });
    }

    const approvedByKey = new Map();
    for (const s of allSubmissions) {
      if (s.status !== 'Approved') continue;
      approvedByKey.set(s.char_name + '::' + (s.spec ?? '') + '::' + s.slot, { trueBis: s.true_bis ?? '', raidBis: s.raid_bis ?? '' });
    }

    const resolveCurrent = (charName, spec, slot) => {
      const approved = approvedByKey.get(charName + '::' + (spec ?? '') + '::' + slot);
      if (approved) return { ...approved, isDefault: false, defaultSource: null };
      const def = specDefaultByKey.get(toCanonical(spec) + '::' + slot);
      if (def)      return { ...def,      isDefault: true,  defaultSource: def.source ?? null };
      return null;
    };

    const pending  = allSubmissions.filter(s => s.status === 'Pending');
    const groupMap = new Map();
    for (const s of pending) {
      if (!groupMap.has(s.char_name)) groupMap.set(s.char_name, { charName: s.char_name, spec: s.spec, submissions: [] });
      const current = resolveCurrent(s.char_name, s.spec, s.slot);
      groupMap.get(s.char_name).submissions.push({
        id: s.id, slot: s.slot,
        current: current ? {
          trueBis: current.trueBis, trueBisSource: resolveSource(current.trueBis),
          raidBis: current.raidBis, raidBisSource: resolveSource(current.raidBis),
          isDefault: current.isDefault, defaultSource: current.defaultSource,
        } : null,
        trueBis: s.true_bis, trueBisSource: resolveSource(s.true_bis),
        raidBis: s.raid_bis, raidBisSource: resolveSource(s.raid_bis),
        rationale: s.rationale, submittedAt: s.submitted_at,
      });
    }

    const specChangeRequests = roster
      .filter(r => r.pending_primary_spec)
      .map(r => ({
        charName:     r.char_name,
        charId:       r.id,
        currentSpec:  r.spec,
        requestedSpec: r.pending_primary_spec,
      }));

    return c.json({ pending: pending.length, groups: [...groupMap.values()], specChangeRequests });
  } catch (err) {
    console.error('[ADMIN] bis-review GET error:', err);
    return c.json({ error: 'Failed to load BIS review queue' }, 500);
  }
});

// ── POST /api/admin/bis-review/approve ─────────────────────────────────────────

router.post('/bis-review/approve', requireOfficer, async (c) => {
  const { id } = await c.req.json();
  if (!id) return c.json({ error: 'id is required' }, 400);
  const { teamId, charName: officerChar, username } = c.get('session').user;
  if (!teamId) return c.json({ error: 'No team configured' }, 400);
  const db = c.env.DB;
  try {
    const subs = await getBisSubmissions(db, teamId);
    const sub  = subs.find(s => s.id === id);

    await approveBisSubmission(db, id, officerChar ?? username ?? 'Officer');

    if (sub?.char_id && sub?.slot) {
      await invalidateWornBisSlots(db, teamId, [{ charId: sub.char_id, slot: sub.slot }]);
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
  const { teamId, charName: officerChar, username } = c.get('session').user;
  if (!teamId) return c.json({ error: 'No team configured' }, 400);
  const db = c.env.DB;
  try {
    await rejectBisSubmission(db, id, officerChar ?? username ?? 'Officer', officerNote);
    return c.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] bis-review reject error:', err);
    return c.json({ error: 'Failed to reject submission' }, 500);
  }
});

// ── POST /api/admin/bis-review/spec-change ─────────────────────────────────────

router.post('/bis-review/spec-change', requireOfficer, async (c) => {
  const { charId, approve } = await c.req.json();
  if (!charId)           return c.json({ error: 'charId is required' }, 400);
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
    console.error('[ADMIN] bis-review spec-change error:', err);
    return c.json({ error: 'Failed to process spec change' }, 500);
  }
});

// ── WCL sync (manual trigger) ─────────────────────────────────────────────────
// NOTE: wcl-sync.js has not yet been migrated to D1. These routes will work once
// wcl-sync.js is updated to accept a db parameter.

router.get('/wcl-status', requireOfficer, async (c) => {
  const { teamId } = c.get('session').user;
  const db = c.env.DB;
  try {
    const config = await getTeamConfig(db, teamId);
    const lastCheck = Number(config.wcl_last_check) || null;
    return c.json({ lastCheck });
  } catch (err) {
    return c.json({ error: 'Failed to load status' }, 500);
  }
});

router.post('/wcl-sync', requireOfficer, async (c) => {
  const { teamId } = c.get('session').user;
  const db = c.env.DB;
  const allTeams = await getAllTeams(db);
  const team = allTeams.find(t => t.id === teamId);
  if (!team) return c.json({ error: 'Team not found' }, 404);
  try {
    await runWclSyncForTeam(db, team);
    return c.json({ ok: true });
  } catch (err) {
    console.error('[admin] WCL sync error:', err);
    return c.json({ error: err.message ?? 'Sync failed' }, 500);
  }
});

router.post('/wcl-sync-worn-bis', requireOfficer, async (c) => {
  const { teamId } = c.get('session').user;
  const db = c.env.DB;
  const allTeams = await getAllTeams(db);
  const team = allTeams.find(t => t.id === teamId);
  if (!team) return c.json({ error: 'Team not found' }, 404);
  try {
    await runWclSyncWornBisOnly(db, team);
    return c.json({ ok: true });
  } catch (err) {
    console.error('[admin] WCL worn BIS resync error:', err);
    return c.json({ error: err.message ?? 'Sync failed' }, 500);
  }
});

// ── Team Config ───────────────────────────────────────────────────────────────

router.get('/team-config', requireOfficer, async (c) => {
  const { teamId } = c.get('session').user;
  if (!teamId) return c.json({ error: 'No team configured' }, 400);
  const db = c.env.DB;
  try {
    const config = await getTeamConfig(db, teamId);
    return c.json({ config });
  } catch (err) {
    return c.json({ error: err.message ?? 'Failed to load config' }, 500);
  }
});

router.post('/team-config', requireOfficer, async (c) => {
  const { teamId } = c.get('session').user;
  if (!teamId) return c.json({ error: 'No team configured' }, 400);
  const db = c.env.DB;
  const { key, value } = await c.req.json();
  if (!key) return c.json({ error: 'key is required' }, 400);
  try {
    await setTeamConfigValue(db, teamId, key, value ?? '');
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err.message ?? 'Failed to save config' }, 500);
  }
});

// ── RCLC Response Map ─────────────────────────────────────────────────────────

router.get('/rclc-map', requireOfficer, async (c) => {
  const { teamId } = c.get('session').user;
  if (!teamId) return c.json({ error: 'No team configured' }, 400);
  const db = c.env.DB;
  try {
    const entries = await getRclcResponseMapRows(db, teamId);
    return c.json({ entries });
  } catch (err) {
    return c.json({ error: err.message ?? 'Failed to load RCLC map' }, 500);
  }
});

router.post('/rclc-map', requireOfficer, async (c) => {
  const { teamId } = c.get('session').user;
  if (!teamId) return c.json({ error: 'No team configured' }, 400);
  const db = c.env.DB;
  const { entries } = await c.req.json();
  if (!Array.isArray(entries)) return c.json({ error: 'entries must be an array' }, 400);
  try {
    await setRclcResponseMap(db, teamId, entries);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err.message ?? 'Failed to save RCLC map' }, 500);
  }
});

// ── Global Config ─────────────────────────────────────────────────────────────

router.get('/global-config', requireGlobalOfficer, async (c) => {
  const db = c.env.DB;
  try {
    const config = await getGlobalConfig(db);
    return c.json({ config });
  } catch (err) {
    return c.json({ error: err.message ?? 'Failed to load global config' }, 500);
  }
});

router.post('/global-config', requireGlobalOfficer, async (c) => {
  const db = c.env.DB;
  const { key, value } = await c.req.json();
  if (!key) return c.json({ error: 'key is required' }, 400);
  try {
    await setGlobalConfigValue(db, key, value ?? '');
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err.message ?? 'Failed to save global config' }, 500);
  }
});

// ── POST /api/admin/migrate-from-sheets ───────────────────────────────────────

router.post('/migrate-from-sheets', requireGlobalOfficer, async (c) => {
  const db    = c.env.DB;
  const stats = {};

  try {
    // 1. Read all guild-wide Sheets data in parallel
    const [teams, globalCfg, itemDbRaw, defaultBisRaw, bisOverrides, specBisCfg, tierItems] =
      await Promise.all([
        sheetsGetTeamRegistry(),
        sheetsGetGlobalConfig(),
        sheetsGetItemDb(),
        sheetsGetDefaultBis(),
        sheetsGetDefaultBisOverrides(),
        sheetsGetSpecBisConfig(),
        sheetsGetTierItems(),
      ]);

    // Deduplicate item DB (mirrors script behaviour)
    const itemDb = [];
    { const seen = new Set();
      for (const item of itemDbRaw) {
        if (!seen.has(item.itemId)) { seen.add(item.itemId); itemDb.push(item); }
      }
    }

    // Deduplicate default BIS (spec|slot|source)
    const defaultBis = [];
    { const seen = new Set();
      for (const row of defaultBisRaw) {
        const key = `${row.spec}|${row.slot}|${row.source}`;
        if (!seen.has(key)) { seen.add(key); defaultBis.push(row); }
      }
    }

    // 2. Clear all tables in FK-safe order, preserving sentinel rows (id=0)
    const CLEAR_ORDER = [
      'worn_bis', 'tier_snapshot', 'raid_encounters', 'raid_attendees', 'raids',
      'bis_submissions', 'loot_log', 'rclc_response_map', 'roster', 'team_config',
      'transfers', 'tier_items', 'spec_bis_config', 'default_bis_overrides', 'default_bis',
      'item_db', 'global_config', 'teams',
    ];
    await db.batch(CLEAR_ORDER.map(tbl =>
      db.prepare(
        (tbl === 'teams' || tbl === 'roster')
          ? `DELETE FROM ${tbl} WHERE id > 0`
          : `DELETE FROM ${tbl}`
      )
    ));

    // 3. Insert guild-wide data

    if (teams.length > 0) {
      await batchInsert(db, teams.map(t =>
        db.prepare('INSERT INTO teams (name) VALUES (?)').bind(t.name)
      ));
    }

    // Resolve team IDs for subsequent FK binds
    const teamRows     = await db.prepare('SELECT id, name FROM teams WHERE id > 0').all();
    const teamIdByName = new Map(teamRows.results.map(r => [r.name, r.id]));

    const gcEntries = Object.entries(globalCfg);
    if (gcEntries.length > 0) {
      await batchInsert(db, gcEntries.map(([k, v]) =>
        db.prepare('INSERT INTO global_config (key, value) VALUES (?, ?)').bind(k, String(v ?? ''))
      ));
    }

    if (itemDb.length > 0) {
      const boolVal = v => (v === true || String(v).toUpperCase() === 'TRUE') ? 1 : 0;
      await batchInsert(db, itemDb.map(item =>
        db.prepare(
          'INSERT INTO item_db (item_id, name, slot, source_type, source_name, instance, difficulty, armor_type, is_tier_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          String(item.itemId), item.name, item.slot, item.sourceType,
          item.sourceName ?? '', item.instance ?? '', item.difficulty ?? '',
          item.armorType, boolVal(item.isTierToken),
        )
      ));
    }
    stats.itemDb = itemDb.length;

    // Resolve item PKs for default_bis FK columns
    const itemRows  = await db.prepare('SELECT id, item_id FROM item_db').all();
    const itemIdMap = new Map(itemRows.results.map(r => [String(r.item_id), r.id]));
    const resolveItemId = id => (id ? (itemIdMap.get(String(id)) ?? null) : null);

    if (defaultBis.length > 0) {
      await batchInsert(db, defaultBis.map(row =>
        db.prepare(
          'INSERT INTO default_bis (spec, slot, true_bis, true_bis_item_id, raid_bis, raid_bis_item_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          row.spec, row.slot,
          row.trueBis ?? '', resolveItemId(row.trueBisItemId),
          row.raidBis ?? '', resolveItemId(row.raidBisItemId),
          row.source ?? '',
        )
      ));
    }
    stats.defaultBis = defaultBis.length;

    if (bisOverrides.length > 0) {
      await batchInsert(db, bisOverrides.map(row =>
        db.prepare(
          'INSERT OR REPLACE INTO default_bis_overrides (spec, slot, source, true_bis, true_bis_item_id, raid_bis, raid_bis_item_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          row.spec, row.slot, row.source ?? '',
          row.trueBis ?? '', row.trueBisItemId ?? null,
          row.raidBis ?? '', row.raidBisItemId ?? null,
        )
      ));
    }

    const specBisEntries = [...specBisCfg];
    if (specBisEntries.length > 0) {
      await batchInsert(db, specBisEntries.map(([spec, source]) =>
        db.prepare('INSERT INTO spec_bis_config (spec, source) VALUES (?, ?)').bind(spec, source)
      ));
    }

    if (tierItems.length > 0) {
      await batchInsert(db, tierItems.map(item =>
        db.prepare('INSERT OR REPLACE INTO tier_items (class, slot, item_id) VALUES (?, ?, ?)').bind(item.class, item.slot, String(item.itemId))
      ));
    }

    // 4. Per-team data
    for (const team of teams) {
      const teamId = teamIdByName.get(team.name);
      if (!teamId) continue;

      const [config, roster, lootLog, bisSubs, raids, raidEncounters,
             tierSnapshotRaw, wornBisMap, rclcMap] = await Promise.all([
        sheetsGetConfig(team.sheetId),
        sheetsGetRoster(team.sheetId),
        sheetsGetLootLog(team.sheetId),
        sheetsGetBisSubmissions(team.sheetId),
        sheetsGetRaids(team.sheetId),
        sheetsGetRaidEncounters(team.sheetId),
        sheetsGetTierSnapshot(team.sheetId),
        sheetsGetWornBis(team.sheetId),
        sheetsGetRclcResponseMap(team.sheetId),
      ]);

      const rosterCharIds = new Set(roster.map(r => r.charId).filter(Boolean));
      const tierSnapshot  = tierSnapshotRaw.filter(s => rosterCharIds.has(s.charId));

      // Team config
      const cfgEntries = Object.entries(config);
      if (cfgEntries.length > 0) {
        await batchInsert(db, cfgEntries.map(([k, v]) =>
          db.prepare('INSERT INTO team_config (team_id, key, value) VALUES (?, ?, ?)').bind(teamId, k, String(v ?? ''))
        ));
      }

      // Roster — must be inserted before anything that references roster(id)
      if (roster.length > 0) {
        await batchInsert(db, roster.map(char =>
          db.prepare(
            'INSERT INTO roster (team_id, char_name, class, spec, role, status, owner_id, owner_nick, server, legacy_char_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            teamId, char.charName, char.class, char.spec, char.role ?? '',
            char.status ?? 'Active', char.ownerId ?? '', char.ownerNick ?? '',
            char.server ?? '', char.charId ?? null,
          )
        ));
      }

      // Resolve roster PKs
      const rosterRows      = await db.prepare('SELECT id, legacy_char_id, char_name FROM roster WHERE team_id = ?').bind(teamId).all();
      const charIdByLegacy  = new Map(rosterRows.results.filter(r => r.legacy_char_id).map(r => [r.legacy_char_id, r.id]));
      const charIdByName    = new Map(rosterRows.results.map(r => [r.char_name, r.id]));
      const resolveCharId   = (charId, charName) =>
        (charId && charIdByLegacy.get(charId)) || charIdByName.get(charName) || null;

      // Raids
      if (raids.length > 0) {
        await batchInsert(db, raids.map(raid =>
          db.prepare('INSERT INTO raids (raid_id, team_id, date, instance, difficulty) VALUES (?, ?, ?, ?, ?)')
            .bind(raid.raidId, teamId, raid.date, raid.instance, raid.difficulty)
        ));
      }

      // Resolve raid PKs
      const raidRows    = await db.prepare('SELECT id, raid_id FROM raids WHERE team_id = ?').bind(teamId).all();
      const raidIdByCode = new Map(raidRows.results.map(r => [r.raid_id, r.id]));

      // Raid attendees
      const attendeeStmts = [];
      for (const raid of raids) {
        const raidDbId = raidIdByCode.get(raid.raidId);
        if (!raidDbId) continue;
        for (const userId of (raid.attendeeIds ?? [])) {
          attendeeStmts.push(
            db.prepare('INSERT OR IGNORE INTO raid_attendees (raid_id, user_id) VALUES (?, ?)').bind(raidDbId, userId)
          );
        }
      }
      if (attendeeStmts.length > 0) await batchInsert(db, attendeeStmts);

      // Raid encounters
      const boolVal = v => (v === true || String(v).toUpperCase() === 'TRUE') ? 1 : 0;
      const encStmts = raidEncounters.flatMap(enc => {
        const raidDbId = raidIdByCode.get(enc.raidId);
        if (!raidDbId) return [];
        return [db.prepare(
          'INSERT OR IGNORE INTO raid_encounters (raid_id, encounter_id, boss_name, pulls, killed, best_pct) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(raidDbId, enc.encounterId, enc.bossName, enc.pulls ?? 0, boolVal(enc.killed), enc.bestPct ?? 0)];
      });
      if (encStmts.length > 0) await batchInsert(db, encStmts);

      // Loot log
      if (lootLog.length > 0) {
        await batchInsert(db, lootLog.map(entry =>
          db.prepare(
            'INSERT INTO loot_log (team_id, date, boss, item_name, difficulty, recipient_id, recipient_name, recipient_char_id, upgrade_type, notes, ignored) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            teamId, entry.date, entry.boss, entry.itemName, entry.difficulty ?? '',
            entry.recipientId ?? '', entry.recipientChar ?? '',
            resolveCharId(entry.recipientCharId, entry.recipientChar),
            entry.upgradeType ?? '', entry.notes ?? '',
            boolVal(entry.ignored),
          )
        ));
      }

      // BIS submissions
      if (bisSubs.length > 0) {
        await batchInsert(db, bisSubs.map(sub =>
          db.prepare(
            'INSERT OR IGNORE INTO bis_submissions (team_id, char_id, char_name, spec, slot, true_bis, raid_bis, rationale, status, submitted_at, reviewed_by, officer_note, true_bis_item_id, raid_bis_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            teamId, resolveCharId(sub.charId, sub.charName), sub.charName,
            sub.spec, sub.slot,
            sub.trueBis ?? '', sub.raidBis ?? '', sub.rationale ?? '',
            sub.status ?? 'Pending', sub.submittedAt ?? '', sub.reviewedBy ?? '', sub.officerNote ?? '',
            sub.trueBisItemId ?? null, sub.raidBisItemId ?? null,
          )
        ));
      }

      // RCLC response map
      const rclcStmts = [];
      for (const [button, { internalType, counted }] of rclcMap) {
        rclcStmts.push(
          db.prepare('INSERT INTO rclc_response_map (team_id, rclc_button, internal_type, counted_in_totals) VALUES (?, ?, ?, ?)')
            .bind(teamId, button, internalType, counted ? 1 : 0)
        );
      }
      if (rclcStmts.length > 0) await batchInsert(db, rclcStmts);

      // Tier snapshot
      const tsStmts = tierSnapshot.flatMap(snap => {
        const charDbId = resolveCharId(snap.charId, snap.charName);
        if (!charDbId) return [];
        const raidDbId = snap.raidId ? (raidIdByCode.get(snap.raidId) ?? null) : null;
        return [db.prepare(
          'INSERT OR REPLACE INTO tier_snapshot (char_id, raid_id, tier_count, tier_detail, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(charDbId, raidDbId, snap.tierCount ?? 0, snap.tierDetail ?? '', snap.updatedAt ?? '')];
      });
      if (tsStmts.length > 0) await batchInsert(db, tsStmts);

      // Worn BIS
      const wornBisStmts = [];
      for (const entry of wornBisMap.values()) {
        if (!rosterCharIds.has(entry.charId)) continue;
        const charDbId = resolveCharId(entry.charId, entry.charName);
        if (!charDbId) continue;
        wornBisStmts.push(
          db.prepare(
            'INSERT OR REPLACE INTO worn_bis (char_id, slot, spec, overall_bis_track, raid_bis_track, other_track, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            charDbId, entry.slot, entry.spec ?? '',
            entry.overallBISTrack ?? '', entry.raidBISTrack ?? '', entry.otherTrack ?? '',
            entry.updatedAt ?? '',
          )
        );
      }
      if (wornBisStmts.length > 0) await batchInsert(db, wornBisStmts);

      stats[team.name] = {
        roster: roster.length, loot: lootLog.length,
        bis: bisSubs.length, raids: raids.length,
      };
    }

    return c.json({ ok: true, stats });
  } catch (err) {
    console.error('[admin] migrate-from-sheets error:', err);
    return c.json({ error: err.message ?? 'Migration failed' }, 500);
  }
});

// ── DELETE /api/admin/worn-bis ─────────────────────────────────────────────────

router.delete('/worn-bis', requireOfficer, async (c) => {
  const { teamId } = c.get('session').user;
  if (!teamId) return c.json({ error: 'No team configured' }, 400);
  const db = c.env.DB;
  try {
    await clearWornBis(db, teamId);
    return c.json({ ok: true });
  } catch (err) {
    console.error('[admin] worn-bis reset error:', err);
    return c.json({ error: err.message ?? 'Reset failed' }, 500);
  }
});

export default router;
