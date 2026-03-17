/**
 * AdminBisReview — Officer page for approving / rejecting player BIS submissions.
 *
 * Shows all Pending submissions grouped by player. Each slot card has:
 *   Overall BIS  + source badge
 *   Raid BIS     + source badge  (or "— not set")
 *   Rationale    (if present)
 *   [ Approve ]  [ Reject ]
 *
 * Clicking Reject expands an inline note field before confirming.
 * After approve/reject the card is removed optimistically.
 */

import { apiPath } from '../lib/api.js';
import { useState, useEffect, useCallback } from 'react';

const SENTINELS = new Set(['<Tier>', '<Catalyst>', '<Crafted>']);

// ── Source badge ──────────────────────────────────────────────────────────────

function SourceBadge({ value, source }) {
  if (!value || SENTINELS.has(value)) return null;
  if (!source) return null;

  const { difficulty, sourceType } = source;
  const label = sourceType === 'Mythic+' ? 'Mythic+' : `${difficulty} ${sourceType}`.trim();
  const cls   = sourceType === 'Mythic+' ? 'mplus'
              : difficulty === 'Mythic'  ? 'mythic'
              : difficulty === 'Heroic'  ? 'heroic'
              : 'normal';

  return <span className={`review-source-badge review-source-${cls}`}>{label}</span>;
}

// ── Item name — plain text for sentinels, Wowhead tooltip link for real items ─

function ItemName({ name, source, muted = false }) {
  if (!name) return <span className="text-muted">—</span>;

  if (SENTINELS.has(name)) {
    return <span className="review-sentinel">{name}</span>;
  }

  const itemId = source?.itemId;
  if (itemId) {
    return (
      <a
        href={`https://www.wowhead.com/item=${itemId}`}
        data-wowhead={`item=${itemId}`}
        target="_blank"
        rel="noopener noreferrer"
        className={muted ? 'review-item-link review-item-link-muted' : 'review-item-link'}
      >
        {name}
      </a>
    );
  }

  return <span className={muted ? 'text-muted' : ''}>{name}</span>;
}

// ── Single submission card ────────────────────────────────────────────────────

function SubmissionCard({ sub, onApprove, onReject }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote]           = useState('');
  const [saving, setSaving]       = useState(false);
  const [err, setErr]             = useState(null);

  // Per-field change detection: null current means first-ever submission (always "changed")
  const trueBisChanged  = !sub.current || sub.trueBis !== sub.current.trueBis;
  const raidBisChanged  = !sub.current || sub.raidBis !== sub.current.raidBis;

  const handleApprove = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onApprove(sub.id);
    } catch {
      setErr('Failed to approve.');
      setSaving(false);
    }
  };

  const handleReject = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onReject(sub.id, note);
    } catch {
      setErr('Failed to reject.');
      setSaving(false);
    }
  };

  return (
    <div className="review-card">
      <div className="review-card-header">
        <span className="review-slot">{sub.slot}</span>
        {sub.submittedAt && (
          <span className="review-submitted-at">{sub.submittedAt}</span>
        )}
      </div>

      {/* ── Current vs Requested comparison table ─────────────────────────── */}
      <div className="review-compare">
        {/* Column headers */}
        <div className="review-compare-header" />
        <div className="review-compare-header">Overall BIS</div>
        <div className="review-compare-header">Raid BIS</div>

        {/* Current row */}
        <div className="review-row-label">
          Current
          {sub.current?.isDefault && (
            <span className="review-default-tag">
              {sub.current.defaultSource ?? 'spec default'}
            </span>
          )}
        </div>
        <div className="review-compare-cell">
          {sub.current ? (
            <>
              <ItemName name={sub.current.trueBis} source={sub.current.trueBisSource} muted />
              <SourceBadge value={sub.current.trueBis} source={sub.current.trueBisSource} />
            </>
          ) : <span className="text-muted">—</span>}
        </div>
        <div className="review-compare-cell">
          {sub.current?.raidBis ? (
            <>
              <ItemName name={sub.current.raidBis} source={sub.current.raidBisSource} muted />
              <SourceBadge value={sub.current.raidBis} source={sub.current.raidBisSource} />
            </>
          ) : <span className="text-muted">— not set</span>}
        </div>

        {/* Arrow row */}
        <div className="review-arrow-row" />
        <div className="review-arrow-cell">
          {trueBisChanged
            ? <span className="review-arrow-changed">⬇</span>
            : <span className="review-arrow-same">—</span>}
        </div>
        <div className="review-arrow-cell">
          {raidBisChanged
            ? <span className="review-arrow-changed">⬇</span>
            : <span className="review-arrow-same">—</span>}
        </div>

        {/* Requested row */}
        <div className="review-row-label review-row-label-request">Requested</div>
        <div className="review-compare-cell review-compare-cell-request">
          {trueBisChanged ? (
            <>
              <ItemName name={sub.trueBis} source={sub.trueBisSource} />
              <SourceBadge value={sub.trueBis} source={sub.trueBisSource} />
            </>
          ) : (
            <span className="review-no-change">No change</span>
          )}
        </div>
        <div className="review-compare-cell review-compare-cell-request">
          {!raidBisChanged ? (
            <span className="review-no-change">No change</span>
          ) : sub.raidBis ? (
            <>
              <ItemName name={sub.raidBis} source={sub.raidBisSource} />
              <SourceBadge value={sub.raidBis} source={sub.raidBisSource} />
            </>
          ) : (
            <span className="text-muted">— not set</span>
          )}
        </div>
      </div>

      {sub.rationale && (
        <div className="review-rationale-row">
          <span className="review-rationale-label">Rationale</span>
          <span className="review-rationale">"{sub.rationale}"</span>
        </div>
      )}

      <div className="review-actions">
        {err && <span className="review-action-err">{err}</span>}

        {!rejecting ? (
          <>
            <button
              className="btn-primary btn-sm"
              onClick={handleApprove}
              disabled={saving}
            >
              {saving ? '…' : 'Approve'}
            </button>
            <button
              className="btn-secondary btn-sm review-btn-reject"
              onClick={() => setRejecting(true)}
              disabled={saving}
            >
              Reject
            </button>
          </>
        ) : (
          <div className="review-reject-expand">
            <input
              type="text"
              className="review-note-input"
              placeholder="Officer note (optional)…"
              value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleReject(); if (e.key === 'Escape') { setRejecting(false); setNote(''); } }}
              autoFocus
            />
            <button
              className="btn-secondary btn-sm review-btn-reject-confirm"
              onClick={handleReject}
              disabled={saving}
            >
              {saving ? '…' : 'Confirm Reject'}
            </button>
            <button
              className="btn-secondary btn-sm"
              onClick={() => { setRejecting(false); setNote(''); }}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Player group ──────────────────────────────────────────────────────────────

function PlayerGroup({ group, isExpanded, onToggle, onApprove, onReject }) {
  return (
    <section className="review-group">
      <div className="review-group-header review-group-header-clickable" onClick={onToggle}>
        <span className="review-group-chevron">{isExpanded ? '▾' : '▸'}</span>
        <span className="review-group-name">{group.charName}</span>
        <span className="review-group-spec">{group.spec}</span>
        <span className="review-group-count">
          {group.submissions.length} pending
        </span>
      </div>
      {isExpanded && (
        <div className="review-group-cards">
          {group.submissions.map(sub => (
            <SubmissionCard
              key={sub.id}
              sub={sub}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminBisReview() {
  const [groups,       setGroups]       = useState([]);
  const [pending,      setPending]      = useState(0);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [expandedChar, setExpandedChar] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(apiPath('/api/admin/bis-review'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { setGroups(d.groups); setPending(d.pending); setLoading(false); })
      .catch(() => { setError('Failed to load BIS review queue.'); setLoading(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  // Re-register Wowhead tooltips whenever the visible submission list changes
  useEffect(() => {
    if (!loading) window.$WowheadPower?.refreshLinks();
  }, [loading, groups]);

  // Optimistically remove a submission from the list after action
  const removeSubmission = (id) => {
    setGroups(prev =>
      prev
        .map(g => ({ ...g, submissions: g.submissions.filter(s => s.id !== id) }))
        .filter(g => g.submissions.length > 0)
    );
    setPending(p => Math.max(0, p - 1));
  };

  const handleApprove = async (id) => {
    const res = await fetch(apiPath('/api/admin/bis-review/approve'), {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error(res.status);
    removeSubmission(id);
  };

  const handleReject = async (id, officerNote) => {
    const res = await fetch(apiPath('/api/admin/bis-review/reject'), {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ id, officerNote }),
    });
    if (!res.ok) throw new Error(res.status);
    removeSubmission(id);
  };

  if (loading) return <div className="loading">Loading BIS review queue…</div>;
  if (error)   return <div className="error">{error}</div>;

  return (
    <div className="review-page">
      <div className="page-header">
        <h2 className="page-title">
          BIS Review
          {pending > 0 && (
            <span className="review-pending-count">{pending} pending</span>
          )}
        </h2>
      </div>

      {groups.length === 0 ? (
        <div className="card">
          <p className="empty">No pending BIS submissions. All caught up!</p>
        </div>
      ) : (
        groups.map(group => (
          <PlayerGroup
            key={group.charName}
            group={group}
            isExpanded={expandedChar === group.charName}
            onToggle={() => setExpandedChar(prev => prev === group.charName ? null : group.charName)}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        ))
      )}
    </div>
  );
}
