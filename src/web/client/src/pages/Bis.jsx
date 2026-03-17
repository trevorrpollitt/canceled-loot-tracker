/**
 * Bis — Raider BIS submission page.
 *
 * Each slot row shows:
 *   Overall BIS  — best item from any source (Raid, Mythic+, crafted sentinels)
 *   Raid BIS     — best raid-obtainable item only (optional)
 *   Rationale    — free-text justification
 *
 * Display priority per field: user edit → saved submission → spec default
 *
 * Per-field indicators:
 *   ★  (teal)   — value matches the spec default for this slot
 *   ●  (amber)  — field has unsaved changes (dirty)
 *
 * Sentinel availability:
 *   Tier slots   (Head, Shoulders, Chest, Hands, Legs): <Tier>
 *   Non-tier arm (Neck, Back, Wrists, Waist, Feet):     <Catalyst>
 *   Accessory    (Ring, Trinket, Weapon, Off-Hand):      neither
 *   <Crafted> only applies to Overall BIS.
 */

import { useState, useEffect, useCallback, Fragment } from 'react';
import { useMe } from '../hooks/useMe.js';
import ItemSelect from '../components/ItemSelect.jsx';
import { apiPath } from '../lib/api.js';

const SENTINELS = new Set(['<Tier>', '<Catalyst>', '<Crafted>']);

const STATUS_BADGE = {
  Pending:  { label: 'Pending',  cls: 'badge-pending'  },
  Approved: { label: 'Approved', cls: 'badge-approved' },
  Rejected: { label: 'Rejected', cls: 'badge-rejected' },
};

const SLOT_GROUPS = [
  { label: 'Tier',    slots: ['Head', 'Shoulders', 'Chest', 'Hands', 'Legs'] },
  { label: 'Other Armor',   slots: ['Wrists', 'Waist', 'Feet'] },
  { label: 'Accessories', slots: ['Back', 'Neck', 'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2'] },
  { label: 'Weapons', slots: ['Weapon', 'Off-Hand'] },
];

function overallSentinels({ tier, catalyst, crafted }) {
  return [
    ...(tier     ? [{ value: '<Tier>',     label: '<Tier>'     }] : []),
    ...(catalyst ? [{ value: '<Catalyst>', label: '<Catalyst>' }] : []),
    ...(crafted  ? [{ value: '<Crafted>',  label: '<Crafted>'  }] : []),
  ];
}

function raidSentinels({ tier, catalyst }) {
  return [
    ...(tier     ? [{ value: '<Tier>',     label: '<Tier>'     }] : []),
    ...(catalyst ? [{ value: '<Catalyst>', label: '<Catalyst>' }] : []),
  ];
}

function isRaidBisCompatible(value, raidOptions) {
  if (!value || value === '<Crafted>') return false;
  if (SENTINELS.has(value)) return true;
  return raidOptions.some(o => o.name === value);
}

// ── Field indicator ─────────────────────────────────────────────────────────────
// Shows ★ when the displayed value matches the spec default,
// and ● when the user has an unsaved change for that specific field.

function FieldIndicator({ isDefault, isDirty }) {
  return (
    <span className="bis-field-indicators">
      {isDefault && <span className="bis-indicator-default" title="Matches spec default">★</span>}
      {isDirty   && <span className="bis-indicator-dirty"   title="Unsaved change">●</span>}
    </span>
  );
}

// ── Slot row ────────────────────────────────────────────────────────────────────

function SlotRow({ slotData, edit, onEdit, onAcknowledge, onResubmit, onReset }) {
  const { slot, submission, lastApproved, specDefault, sentinels, overallOptions, raidOptions } = slotData;

  // Display priority: edit → saved submission → spec default → ''
  // Raid BIS uses || so that an empty saved raidBis (post-reset) falls through to
  // the spec default, keeping it dynamically linked after a reset.
  const trueBis        = edit?.trueBis        ?? submission?.trueBis        ?? specDefault?.trueBis        ?? '';
  const trueBisItemId  = edit?.trueBisItemId  ?? submission?.trueBisItemId  ?? specDefault?.trueBisItemId  ?? '';
  const raidBis        = edit?.raidBis        ?? (submission?.raidBis        || specDefault?.raidBis)       ?? '';
  const raidBisItemId  = edit?.raidBisItemId  ?? submission?.raidBisItemId  ?? specDefault?.raidBisItemId  ?? '';
  const rationale      = edit?.rationale      ?? submission?.rationale      ?? '';

  const status      = submission?.status      ?? null;
  const officerNote = submission?.officerNote ?? '';
  const badge       = status ? STATUS_BADGE[status] : null;

  // Approved/pending values shown as badges inside the dropdown.
  // Approved: the last-approved snapshot (cols N–Q) while Pending, or the
  //           current submission when it is itself Approved.
  // Pending:  the current Pending submission values.
  const approvedTrueBis = status === 'Approved'
    ? (submission?.trueBis ?? '')
    : (lastApproved?.trueBis ?? '');
  const approvedRaidBis = status === 'Approved'
    ? (submission?.raidBis ?? '')
    : (lastApproved?.raidBis ?? '');
  const pendingTrueBis  = status === 'Pending' ? (submission?.trueBis ?? '') : '';
  const pendingRaidBis  = status === 'Pending' ? (submission?.raidBis ?? '') : '';

  // Per-field dirty: the user's edit differs from the pre-edit display baseline
  // (submission value → spec default → '').
  const baselineTrueBis   = submission?.trueBis   ?? specDefault?.trueBis   ?? '';
  const baselineRaidBis   = submission?.raidBis   ?? specDefault?.raidBis   ?? '';
  const baselineRationale = submission?.rationale ?? '';

  const trueBisDirty   = edit !== undefined && edit.trueBis   !== baselineTrueBis;
  const raidBisDirty   = edit !== undefined && edit.raidBis   !== baselineRaidBis;
  const rationaleDirty = edit !== undefined && edit.rationale !== baselineRationale;

  // Per-field default match
  const trueBisIsDefault  = !!specDefault?.trueBis  && trueBis  === specDefault.trueBis;
  const raidBisIsDefault  = !!specDefault?.raidBis  && raidBis  === specDefault.raidBis;

  const canCopyToRaid = isRaidBisCompatible(trueBis, raidOptions);

  // Rejection callout state
  const [resubmitting, setResubmitting] = useState(false);
  const [resubmitNote, setResubmitNote] = useState('');
  const [busy, setBusy]                 = useState(false);
  const [actionErr, setActionErr]       = useState(null);

  const handleAcknowledge = async () => {
    setBusy(true);
    setActionErr(null);
    try {
      await onAcknowledge();
    } catch {
      setActionErr('Failed. Please try again.');
      setBusy(false);
    }
  };

  const handleResubmitSubmit = async () => {
    setBusy(true);
    setActionErr(null);
    try {
      await onResubmit(resubmitNote);
    } catch {
      setActionErr('Failed to resubmit. Please try again.');
      setBusy(false);
    }
  };

  const handleSameAsOverall = () => {
    if (!canCopyToRaid) return;
    const match = raidOptions.find(o => o.name === trueBis);
    onEdit(slot, {
      trueBis, trueBisItemId,
      raidBis:       trueBis,
      raidBisItemId: match?.itemId ?? (SENTINELS.has(trueBis) ? trueBis : ''),
      rationale,
    });
  };

  return (
    <>
      <tr className="bis-slot-row">
        <td className="bis-slot">
          {slot}
          {badge && <span className={`badge ${badge.cls} badge-sm`}>{badge.label}</span>}
        </td>

        {/* Overall BIS */}
        <td className="bis-form-cell">
          <div className="bis-field-wrap">
            <ItemSelect
              value={trueBis}
              options={overallOptions}
              sentinels={overallSentinels(sentinels)}
              empty={!trueBis}
              placeholder="— Select Overall BIS —"
              defaultValue={specDefault?.trueBis ?? ''}
              approvedValue={approvedTrueBis}
              pendingValue={pendingTrueBis}
              onChange={(name, itemId) => onEdit(slot, { trueBis: name, trueBisItemId: itemId, raidBis, raidBisItemId, rationale })}
            />
            <FieldIndicator isDefault={trueBisIsDefault} isDirty={trueBisDirty} />
            {submission && (
              <button
                type="button"
                className="bis-reset-field-btn"
                title="Reset to spec default"
                onClick={() => onReset(slot, 'trueBis')}
              >↺</button>
            )}
          </div>
        </td>

        {/* → copy button */}
        <td className="bis-copy-cell">
          <button
            type="button"
            className="bis-copy-btn"
            title={canCopyToRaid ? 'Same as Overall BIS' : 'Overall BIS is not a raid item'}
            disabled={!canCopyToRaid}
            onClick={handleSameAsOverall}
          >
            →
          </button>
        </td>

        {/* Raid BIS */}
        <td className="bis-form-cell">
          <div className="bis-field-wrap">
            <ItemSelect  
              value={raidBis}
              options={raidOptions}
              sentinels={raidSentinels(sentinels)}
              placeholder="— None —"
              defaultValue={specDefault?.raidBis ?? ''}
              approvedValue={approvedRaidBis}
              pendingValue={pendingRaidBis}
              onChange={(name, itemId) => onEdit(slot, { trueBis, trueBisItemId, raidBis: name, raidBisItemId: itemId, rationale })}
            />
            <FieldIndicator isDefault={raidBisIsDefault} isDirty={raidBisDirty} />
            {submission?.raidBis && (
              <button
                type="button"
                className="bis-reset-field-btn"
                title="Reset Raid BIS to spec default"
                onClick={() => onReset(slot, 'raidBis')}
              >↺</button>
            )}
          </div>
        </td>

        {/* Rationale */}
        <td className="bis-rationale-cell">
          <div className="bis-field-wrap">
            <input
              type="text"
              className="bis-rationale-input"
              placeholder="Optional rationale…"
              value={rationale}
              onChange={e => onEdit(slot, { trueBis, trueBisItemId, raidBis, raidBisItemId, rationale: e.target.value })}
            />
            <FieldIndicator isDefault={false} isDirty={rationaleDirty} />
          </div>
        </td>
      </tr>

      {status === 'Rejected' && (
        <tr className="bis-rejection-row">
          <td />
          <td colSpan={4}>
            <div className="bis-rejection-callout">
              <div className="bis-rejection-header">
                <span className="bis-rejection-label">❌ Request rejected</span>
                {officerNote
                  ? <span className="bis-rejection-note">{officerNote}</span>
                  : <span className="bis-rejection-no-note">No officer note provided.</span>
                }
              </div>

              {!resubmitting ? (
                <div className="bis-rejection-actions">
                  <button
                    className="btn-secondary btn-sm"
                    onClick={handleAcknowledge}
                    disabled={busy}
                  >
                    {busy ? '…' : 'Acknowledge'}
                  </button>
                  <button
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      setResubmitNote(submission?.rationale ?? '');
                      setActionErr(null);
                      setResubmitting(true);
                    }}
                    disabled={busy}
                  >
                    Resubmit with justification
                  </button>
                  {actionErr && <span className="bis-rejection-err">{actionErr}</span>}
                </div>
              ) : (
                <div className="bis-resubmit-expand">
                  <textarea
                    className="bis-resubmit-input"
                    placeholder="Add justification for your request…"
                    value={resubmitNote}
                    onChange={e => setResubmitNote(e.target.value)}
                    autoFocus
                    rows={2}
                  />
                  <div className="bis-resubmit-buttons">
                    <button
                      className="btn-primary btn-sm"
                      onClick={handleResubmitSubmit}
                      disabled={busy || !resubmitNote.trim()}
                    >
                      {busy ? '…' : 'Submit'}
                    </button>
                    <button
                      className="btn-secondary btn-sm"
                      onClick={() => { setResubmitting(false); setActionErr(null); }}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                    {actionErr && <span className="bis-rejection-err">{actionErr}</span>}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────────

export default function Bis() {
  const { user } = useMe();
  const [slots, setSlots]     = useState([]);
  const [edits, setEdits]     = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [error, setError]     = useState(null);

  const loadBis = useCallback(() => {
    setLoading(true);
    setError(null);
    setSaveMsg(null);
    fetch(apiPath('/api/bis'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => {
        setSlots(data.slots ?? []);
        setEdits({});
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load BIS data.');
        setLoading(false);
      });
  }, []);

  useEffect(() => { loadBis(); }, [loadBis]);
  useEffect(() => { if (slots.length) window.$WowheadPower?.refreshLinks(); }, [slots]);

  const handleEdit = useCallback((slot, values) => {
    const slotData     = slots.find(s => s.slot === slot);
    const submission   = slotData?.submission;
    const specDefault  = slotData?.specDefault;
    const lastApproved = slotData?.lastApproved;

    // Clean: values match the saved submission exactly → no pending save needed
    const isClean = submission
      ? values.trueBis    === (submission.trueBis    ?? '')
        && values.raidBis  === (submission.raidBis   ?? '')
        && values.rationale === (submission.rationale ?? '')
      : !values.trueBis && !values.raidBis && !values.rationale;

    // Revert: slot is Pending and the player has dialled back to the last accepted
    // state (lastApproved snapshot if it exists, spec default otherwise).
    // Saving a revert clears the pending row instead of re-submitting it.
    const acceptedBaseline = submission?.status === 'Pending'
      ? (lastApproved ?? specDefault ?? null)
      : null;
    const isRevert = !isClean && acceptedBaseline !== null
      && values.trueBis === (acceptedBaseline.trueBis ?? '')
      && values.raidBis === (acceptedBaseline.raidBis ?? '');

    setEdits(prev => {
      const next = { ...prev };
      if (isClean) {
        delete next[slot];
      } else {
        next[slot] = isRevert ? { ...values, clearPending: true } : values;
      }
      return next;
    });
    setSaveMsg(null);
  }, [slots]);

  const handleSave = async () => {
    const dirtySlots = Object.keys(edits);
    if (!dirtySlots.length) return;

    // clearPending doesn't need trueBis; regular updates do
    const updates = dirtySlots
      .map(slot => ({ slot, ...edits[slot] }))
      .filter(u => u.clearPending || u.trueBis);

    if (!updates.length) {
      setSaveMsg('Overall BIS is required for each slot before saving.');
      return;
    }

    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(apiPath('/api/bis'), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ updates }),
      });
      if (!res.ok) throw new Error(res.status);
      const { saved, cleared, message } = await res.json();
      const parts = [];
      if (saved)   parts.push(`${saved} slot${saved !== 1 ? 's' : ''} saved. Pending officer review.`);
      if (cleared) parts.push(`${cleared} slot${cleared !== 1 ? 's' : ''} reset to spec default.`);
      setSaveMsg(parts.join(' ') || message || 'Done.');
      loadBis();
    } catch {
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── Single-slot immediate actions (acknowledge / resubmit) ─────────────────

  const handleAcknowledge = useCallback(async (slot) => {
    const res = await fetch(apiPath('/api/bis'), {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ updates: [{ slot, clearRejected: true }] }),
    });
    if (!res.ok) throw new Error(res.status);
    loadBis();
  }, [loadBis]);

  // Immediate resets — no approval needed (removing an override, not adding one).
  // Overall BIS reset: deletes the whole submission row.
  // Raid BIS reset:    blanks only the raidBis cells, status untouched.
  const handleReset = useCallback(async (slot, field) => {
    const action = field === 'trueBis' ? { clearSlot: true } : { resetRaidBis: true };
    const res = await fetch(apiPath('/api/bis'), {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ updates: [{ slot, ...action }] }),
    });
    if (!res.ok) throw new Error(res.status);
    loadBis();
  }, [loadBis]);

  const handleResubmit = useCallback(async (slot, rationale) => {
    const slotData = slots.find(s => s.slot === slot);
    const sub      = slotData?.submission;
    if (!sub?.trueBis) throw new Error('No submission data');

    const res = await fetch(apiPath('/api/bis'), {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ updates: [{
        slot,
        trueBis:       sub.trueBis,
        trueBisItemId: sub.trueBisItemId ?? '',
        raidBis:       sub.raidBis       ?? '',
        raidBisItemId: sub.raidBisItemId ?? '',
        rationale,
      }] }),
    });
    if (!res.ok) throw new Error(res.status);
    loadBis();
  }, [slots, loadBis]);

  const dirtyCount = Object.keys(edits).length;

  if (loading) return <div className="loading">Loading BIS list…</div>;
  if (error)   return <div className="error">{error}</div>;

  return (
    <div className="bis-page">
      <div className="page-header">
        <h2 className="page-title">
          My BIS List
          {user?.charName && <span className="spec-label"> — {user.charName}</span>}
          {user?.spec     && <span className="spec-label"> ({user.spec})</span>}
        </h2>
        <p className="page-sub">
          Set your best-in-slot items for each slot. Overall BIS is the absolute
          best regardless of source. Raid BIS is the best item from the current
          raid tier only. Submissions go to officers for review.
        </p>
      </div>

      <div className="admin-save-bar">
        <span className="bis-legend-trigger">
          ⓘ Legend
          <span className="bis-legend-tooltip">
            <span><span className="bis-indicator-default">★</span> = spec default</span>
            <span><span className="item-select-badge-approved">✓</span> = approved</span>
            <span><span className="item-select-badge-pending">●</span> = pending</span>
            <span><span className="bis-indicator-dirty">●</span> = unsaved change</span>
          </span>
        </span>
        {saveMsg && <span className="save-msg">{saveMsg}</span>}
        <a className="btn-secondary" href={apiPath('/')}>Cancel</a>
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || dirtyCount === 0}
        >
          {saving ? 'Saving…' : `Save Changes${dirtyCount > 0 ? ` (${dirtyCount})` : ''}`}
        </button>
      </div>

      <div className="card">
        <table className="bis-table bis-form-table">
          <thead>
            <tr>
              <th className="bis-slot-col">Slot</th>
              <th>Overall BIS</th>
              <th />
              <th>Raid BIS <span className="text-muted">(optional)</span></th>
              <th>Rationale</th>
            </tr>
          </thead>
          <tbody>
            {SLOT_GROUPS.map(group => {
              const groupSlots = slots.filter(s => group.slots.includes(s.slot));
              if (!groupSlots.length) return null;
              return (
                <Fragment key={group.label}>
                  <tr className="bis-group-header-row">
                    <td colSpan={5} className="bis-group-header">{group.label}</td>
                  </tr>
                  {groupSlots.map(slotData => (
                    <SlotRow
                      key={slotData.slot}
                      slotData={slotData}
                      edit={edits[slotData.slot]}
                      onEdit={handleEdit}
                      onAcknowledge={() => handleAcknowledge(slotData.slot)}
                      onResubmit={(note) => handleResubmit(slotData.slot, note)}
                    />
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
