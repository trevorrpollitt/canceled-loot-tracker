/**
 * admin.js — Officer-only admin routes.
 *
 * GET  /api/admin/default-bis?spec=<canonical>[&source=<source>]
 *   Returns BIS rows for a spec, optionally filtered to a specific source.
 *   Also returns availableSources[] and preferredSource so the UI can render
 *   the source selector. When source is omitted, uses the preferred source.
 *
 * POST /api/admin/default-bis
 *   Body: { spec, source, updates: [{ slot, raidBis, raidBisItemId }] }
 *   Writes officer-supplied Raid BIS values to the Default BIS sheet.
 *
 * POST /api/admin/spec-bis-source
 *   Body: { spec, source }
 *   Sets the preferred BIS source for a spec in the Spec BIS Config tab.
 *
 * GET  /api/admin/bis-review
 *   Returns all Pending BIS submissions across all players, grouped by
 *   character. Each submission includes resolved item-source metadata.
 *
 * POST /api/admin/bis-review/approve
 *   Body: { id }  — approves the submission and writes LastApproved snapshot.
 *
 * POST /api/admin/bis-review/reject
 *   Body: { id, officerNote? }  — rejects with optional note.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getDefaultBis,
  getItemDb,
  getSpecBisConfig,
  setSpecBisSource,
  applyRaidBisInference,
  updateDefaultBisRaidBis,
  getBisSubmissions,
  approveBisSubmission,
  rejectBisSubmission,
} from '../../../lib/sheets.js';
import { toCanonical, CLASS_SPECS, getArmorType, canUseWeapon } from '../../../lib/specs.js';

const TIER_SLOTS     = new Set(['Head', 'Shoulders', 'Chest', 'Hands', 'Legs']);
const CATALYST_SLOTS = new Set(['Neck', 'Back', 'Wrists', 'Waist', 'Feet']);
const DIFF_ORDER     = { Mythic: 0, Heroic: 1, Normal: 2 };

/**
 * Build a sorted list of raid items valid for a given slot + armor type.
 * Tier tokens (IsTierToken=TRUE) are excluded — they're represented by <Tier>.
 */
function itemOptionsForSlot(itemDb, slot, armorType, canonSpec = '') {
  // Ring 1/Ring 2 → Ring, Trinket 1/Trinket 2 → Trinket
  const dbSlot = slot.replace(/ [12]$/, '');

  return itemDb
    .filter(item => {
      if (item.sourceType !== 'Raid') return false;
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
    }))
    .sort((a, b) => {
      const da = DIFF_ORDER[a.difficulty] ?? 9;
      const db = DIFF_ORDER[b.difficulty] ?? 9;
      return da !== db ? da - db : a.name.localeCompare(b.name);
    });
}

const router = Router();

// All admin routes require authentication + officer role
router.use(requireAuth);
router.use((req, res, next) => {
  if (!req.session.user.isOfficer) return res.status(403).json({ error: 'Officers only' });
  next();
});

// ── GET /api/admin/default-bis ─────────────────────────────────────────────────

router.get('/default-bis', async (req, res) => {
  const { spec, source: requestedSource } = req.query;
  if (!spec) return res.status(400).json({ error: 'spec is required' });

  const { teamSheetId } = req.session.user;
  if (!teamSheetId) return res.status(400).json({ error: 'No team sheet configured' });

  try {
    const [allRows, itemDb, specConfig] = await Promise.all([
      getDefaultBis(teamSheetId),
      getItemDb(teamSheetId),
      getSpecBisConfig(teamSheetId),
    ]);

    const canonicalSpec = toCanonical(spec);
    const specRows      = allRows.filter(r => r.spec === canonicalSpec);

    // All sources available for this spec, preserving insertion order
    const availableSources = [...new Set(specRows.map(r => r.source).filter(Boolean))];

    // Preferred source: from config → first available → ''
    const preferredSource = specConfig.get(canonicalSpec) ?? availableSources[0] ?? '';

    // Which source to display: caller can override, otherwise use preferred
    const displaySource = (requestedSource && availableSources.includes(requestedSource))
      ? requestedSource
      : preferredSource;

    const rows          = specRows.filter(r => r.source === displaySource);
    const withInference = applyRaidBisInference(rows, itemDb);
    const armorType     = getArmorType(canonicalSpec);

    // Attach item options to editable (non-auto) rows
    const withOptions = withInference.map(row => {
      if (row.raidBisAuto) return { ...row, options: [], hasTier: false, hasCatalyst: false };
      return {
        ...row,
        options:     itemOptionsForSlot(itemDb, row.slot, armorType, canonicalSpec),
        hasTier:     TIER_SLOTS.has(row.slot),
        hasCatalyst: CATALYST_SLOTS.has(row.slot),
      };
    });

    res.json({ spec, source: displaySource, availableSources, preferredSource, rows: withOptions });
  } catch (err) {
    console.error('[ADMIN] default-bis GET error:', err);
    res.status(500).json({ error: 'Failed to load default BIS' });
  }
});

// ── POST /api/admin/default-bis ────────────────────────────────────────────────

router.post('/default-bis', async (req, res) => {
  const { spec, source, updates } = req.body;
  if (!spec || !source || !Array.isArray(updates)) {
    return res.status(400).json({ error: 'spec, source, and updates[] are required' });
  }

  const { teamSheetId } = req.session.user;
  if (!teamSheetId) return res.status(400).json({ error: 'No team sheet configured' });

  try {
    const canonicalSpec = toCanonical(spec);
    const writes = updates.map(u => ({
      spec: canonicalSpec,
      source,
      slot:          u.slot,
      raidBis:       u.raidBis       ?? '',
      raidBisItemId: u.raidBisItemId ?? '',
    }));

    await updateDefaultBisRaidBis(teamSheetId, writes);
    res.json({ ok: true, updated: writes.length });
  } catch (err) {
    console.error('[ADMIN] default-bis POST error:', err);
    res.status(500).json({ error: 'Failed to save Raid BIS' });
  }
});

// ── POST /api/admin/spec-bis-source ────────────────────────────────────────────

router.post('/spec-bis-source', async (req, res) => {
  const { spec, source } = req.body;
  if (!spec || !source) {
    return res.status(400).json({ error: 'spec and source are required' });
  }

  const { teamSheetId } = req.session.user;
  if (!teamSheetId) return res.status(400).json({ error: 'No team sheet configured' });

  try {
    const canonicalSpec = toCanonical(spec);
    await setSpecBisSource(teamSheetId, canonicalSpec, source);
    res.json({ ok: true, spec: canonicalSpec, source });
  } catch (err) {
    console.error('[ADMIN] spec-bis-source POST error:', err);
    res.status(500).json({ error: 'Failed to save preferred source' });
  }
});

// ── GET /api/admin/specs ───────────────────────────────────────────────────────
// Returns the full spec list grouped by class, for populating the spec selector.

router.get('/specs', (_req, res) => {
  res.json(CLASS_SPECS);
});

// ── GET /api/admin/bis-review ──────────────────────────────────────────────────

router.get('/bis-review', async (req, res) => {
  const { teamSheetId } = req.session.user;
  if (!teamSheetId) return res.status(400).json({ error: 'No team sheet configured' });

  try {
    const [allSubmissions, itemDb, allDefaults, specConfig] = await Promise.all([
      getBisSubmissions(teamSheetId),
      getItemDb(teamSheetId),
      getDefaultBis(teamSheetId),
      getSpecBisConfig(teamSheetId),
    ]);

    // ── Item DB index ──────────────────────────────────────────────────────────
    const itemByName = new Map(itemDb.map(i => [i.name.toLowerCase(), i]));

    const resolveSource = (name) => {
      if (!name) return null;
      const item = itemByName.get(name.toLowerCase());
      if (!item) return null;
      return {
        itemId:     String(item.itemId ?? ''),
        difficulty: item.difficulty ?? '',
        sourceType: item.sourceType ?? '',
        sourceName: item.sourceName ?? '',
      };
    };

    // ── Spec default map: "canonicalSpec::slot" → { trueBis, raidBis } ──────────
    // Keys are always canonical so they match lookups using toCanonical(s.spec).
    // Mirror the same source-selection logic used in GET /api/admin/default-bis:
    // preferred source → first available source → skip (no defaults for spec).
    const specDefaultByKey = new Map();
    const specsWithDefaults = [...new Set(allDefaults.map(r => toCanonical(r.spec)))];
    for (const canonSpec of specsWithDefaults) {
      const specRows   = allDefaults.filter(r => toCanonical(r.spec) === canonSpec);
      const sources    = [...new Set(specRows.map(r => r.source).filter(Boolean))];
      const preferred  = specConfig.get(canonSpec);
      const source     = (preferred && sources.includes(preferred)) ? preferred : (sources[0] ?? '');
      const rows       = specRows.filter(r => r.source === source);
      const withInfer  = applyRaidBisInference(rows, itemDb);
      for (const row of withInfer) {
        // Only store if there's actually a value — empty defaults aren't useful
        if (!row.trueBis) continue;
        specDefaultByKey.set(`${canonSpec}::${row.slot}`, {
          trueBis: row.trueBis ?? '',
          raidBis: row.raidBis ?? '',
          source,
        });
      }
    }

    // ── Most-recent Approved submission per char+slot ──────────────────────────
    // Submissions are in sheet order; later rows overwrite earlier for the same key.
    const approvedByKey = new Map();
    for (const s of allSubmissions) {
      if (s.status !== 'Approved') continue;
      approvedByKey.set(`${s.charName}::${s.slot}`, {
        trueBis: s.trueBis ?? '',
        raidBis: s.raidBis ?? '',
      });
    }

    // ── Build current-value for a slot ────────────────────────────────────────
    // spec is canonicalized so it matches the specDefaultByKey keys regardless
    // of how the Roster sheet stored the spec on the original submission.
    const resolveCurrent = (charName, spec, slot) => {
      const approved = approvedByKey.get(`${charName}::${slot}`);
      if (approved) return { ...approved, isDefault: false, defaultSource: null };
      const def = specDefaultByKey.get(`${toCanonical(spec)}::${slot}`);
      if (def)      return { ...def,      isDefault: true,  defaultSource: def.source ?? null };
      return null;
    };

    // ── Filter + group Pending ─────────────────────────────────────────────────
    const pending  = allSubmissions.filter(s => s.status === 'Pending');
    const groupMap = new Map();

    for (const s of pending) {
      if (!groupMap.has(s.charName)) {
        groupMap.set(s.charName, { charName: s.charName, spec: s.spec, submissions: [] });
      }

      const current = resolveCurrent(s.charName, s.spec, s.slot);

      groupMap.get(s.charName).submissions.push({
        id:             s.id,
        slot:           s.slot,
        // ── current (what's active now) ──────────────────────────────────────
        current: current ? {
          trueBis:       current.trueBis,
          trueBisSource: resolveSource(current.trueBis),
          raidBis:       current.raidBis,
          raidBisSource: resolveSource(current.raidBis),
          isDefault:     current.isDefault,
          defaultSource: current.defaultSource,
        } : null,
        // ── requested (what the player wants) ───────────────────────────────
        trueBis:        s.trueBis,
        trueBisSource:  resolveSource(s.trueBis),
        raidBis:        s.raidBis,
        raidBisSource:  resolveSource(s.raidBis),
        rationale:      s.rationale,
        submittedAt:    s.submittedAt,
      });
    }

    res.json({ pending: pending.length, groups: [...groupMap.values()] });
  } catch (err) {
    console.error('[ADMIN] bis-review GET error:', err);
    res.status(500).json({ error: 'Failed to load BIS review queue' });
  }
});

// ── POST /api/admin/bis-review/approve ─────────────────────────────────────────

router.post('/bis-review/approve', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });

  const { teamSheetId, charName: officerChar, username } = req.session.user;
  if (!teamSheetId) return res.status(400).json({ error: 'No team sheet configured' });

  const reviewerName = officerChar ?? username ?? 'Officer';

  try {
    await approveBisSubmission(teamSheetId, id, reviewerName);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] bis-review approve error:', err);
    res.status(500).json({ error: 'Failed to approve submission' });
  }
});

// ── POST /api/admin/bis-review/reject ──────────────────────────────────────────

router.post('/bis-review/reject', async (req, res) => {
  const { id, officerNote = '' } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });

  const { teamSheetId, charName: officerChar, username } = req.session.user;
  if (!teamSheetId) return res.status(400).json({ error: 'No team sheet configured' });

  const reviewerName = officerChar ?? username ?? 'Officer';

  try {
    await rejectBisSubmission(teamSheetId, id, reviewerName, officerNote);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] bis-review reject error:', err);
    res.status(500).json({ error: 'Failed to reject submission' });
  }
});

export default router;
