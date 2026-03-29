import { useState, useEffect, Fragment } from 'react';
import ItemLink from '../components/ItemLink.jsx';
import { apiPath } from '../lib/api.js';

const DIFFICULTIES = ['Mythic', 'Heroic', 'Normal'];

const UPGRADE_BADGE = {
  'BIS':     { label: 'BIS',     cls: 'badge-bis'    },
  'Non-BIS': { label: 'Non-BIS', cls: 'badge-nonbis' },
};

// ── BIS / Non-BIS breakdown within one difficulty column ──────────────────────

function DiffColumn({ diff, counts }) {
  const bis    = counts.BIS?.[diff]       ?? 0;
  const nonBis = counts['Non-BIS']?.[diff] ?? 0;
  if (!bis && !nonBis) return <span className="text-muted">—</span>;
  return (
    <span className="lh-diff-col">
      {bis    > 0 && <span className="lh-diff-tag lh-diff-bis">{bis} BIS</span>}
      {nonBis > 0 && <span className="lh-diff-tag lh-diff-nonbis">{nonBis} Non-BIS</span>}
    </span>
  );
}

// ── Expanded loot detail for one player ──────────────────────────────────────

function PlayerLootDetail({ loot }) {
  if (!loot.length) return <p className="empty" style={{ margin: '10px 16px' }}>No loot recorded.</p>;
  return (
    <table className="loot-table lh-detail-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Boss</th>
          <th>Item</th>
          <th>Diff</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
        {loot.map(entry => {
          const badge = UPGRADE_BADGE[entry.upgradeType] ?? { label: entry.upgradeType, cls: '' };
          return (
            <tr key={entry.id}>
              <td>{entry.date}</td>
              <td>{entry.boss}</td>
              <td><ItemLink name={entry.itemName} /></td>
              <td>{entry.difficulty?.[0]}</td>
              <td><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Skipped rows diagnostic ───────────────────────────────────────────────────

const SKIP_SECTIONS = [
  { key: 'noRosterMatch',   label: 'No Roster Match',    desc: 'Pugs, deleted characters, or unresolvable CharId/name.' },
  { key: 'wrongDifficulty', label: 'Wrong Difficulty',   desc: 'Difficulty not in the tracked set (Normal / Heroic / Mythic). Select the correct value to fix.' },
  { key: 'tertiary',        label: 'Tertiary',           desc: 'Tertiary drops — excluded from loot score but still recorded.' },
];

const DIFF_OPTIONS = ['Normal', 'Heroic', 'Mythic'];

function SkippedTable({ rows, corrections, onCorrect }) {
  const editable = !!onCorrect;
  return (
    <table className="loot-table lh-detail-table" style={{ marginTop: 8 }}>
      <thead>
        <tr>
          <th>Date</th>
          <th>Recipient</th>
          <th>Item</th>
          <th>Diff</th>
          <th>Type</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(e => (
          <tr key={e.id}>
            <td>{e.date}</td>
            <td>{e.recipientChar}</td>
            <td><ItemLink name={e.itemName} /></td>
            <td>
              {editable ? (
                <select
                  className={`lh-diff-select${corrections[e.id] ? ' lh-diff-select-set' : ''}`}
                  value={corrections[e.id] ?? ''}
                  onChange={ev => onCorrect(e.id, ev.target.value)}
                >
                  <option value="">{e.difficulty || '—'}</option>
                  {DIFF_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              ) : (
                e.difficulty || '—'
              )}
            </td>
            <td>{e.upgradeType || '—'}</td>
            <td className="text-muted" style={{ fontSize: '0.82em' }}>{e.skipReason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SkippedSection({ skipped }) {
  const [open,    setOpen]    = useState(false);
  const [openSub, setOpenSub] = useState({});
  const [corrections, setCorrections] = useState({});
  const [saving,  setSaving]  = useState(false);
  const [saveErr, setSaveErr] = useState(null);

  const total = SKIP_SECTIONS.reduce((n, s) => n + (skipped[s.key]?.length ?? 0), 0);
  if (total === 0) return null;

  const pendingCount = Object.values(corrections).filter(Boolean).length;

  const handleCorrect = (id, difficulty) =>
    setCorrections(prev => ({ ...prev, [id]: difficulty }));

  const handleSave = async () => {
    const list = Object.entries(corrections)
      .filter(([, d]) => d)
      .map(([id, difficulty]) => ({ id, difficulty }));
    if (!list.length) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const r = await fetch(apiPath('/api/loot/entries'), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ corrections: list }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? r.status);
      window.location.reload();
    } catch (e) {
      setSaveErr(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="card lh-skipped-card">
      <div className="lh-skipped-header" onClick={() => setOpen(o => !o)}>
        <span className={`lh-chevron${open ? ' lh-chevron-open' : ''}`}>▶</span>
        <span>Skipped / Ignored Rows</span>
        <span className="lh-group-count">{total}</span>
        {pendingCount > 0 && (
          <button
            className="btn lh-save-corrections-btn"
            disabled={saving}
            onClick={e => { e.stopPropagation(); handleSave(); }}
          >
            {saving ? 'Saving…' : `Save ${pendingCount} correction${pendingCount !== 1 ? 's' : ''}`}
          </button>
        )}
        {saveErr && <span className="lh-save-err">{saveErr}</span>}
      </div>
      {open && (
        <div className="lh-skipped-body">
          {SKIP_SECTIONS.map(({ key, label, desc }) => {
            const rows = skipped[key] ?? [];
            if (!rows.length) return null;
            const subOpen = openSub[key] ?? false;
            const isEditable = key === 'wrongDifficulty';
            return (
              <div key={key} className="lh-skip-group">
                <div className="lh-skip-group-header" onClick={() => setOpenSub(p => ({ ...p, [key]: !p[key] }))}>
                  <span className={`lh-chevron${subOpen ? ' lh-chevron-open' : ''}`}>▶</span>
                  <strong>{label}</strong>
                  <span className="lh-group-count">{rows.length}</span>
                  <span className="text-muted lh-skip-desc">{desc}</span>
                </div>
                {subOpen && (
                  <SkippedTable
                    rows={rows}
                    corrections={isEditable ? corrections : undefined}
                    onCorrect={isEditable ? handleCorrect : undefined}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function LootHistory() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [expanded,       setExpanded]       = useState(new Set());
  const [expandedGroups, setExpandedGroups] = useState({ Active: true, Bench: false, Inactive: false });
  const [showDiff,       setShowDiff]       = useState({ Mythic: true, Heroic: true, Normal: true });

  useEffect(() => {
    fetch(apiPath('/api/loot/history'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e); setLoading(false); });
  }, []);

  if (loading) return <div className="loading">Loading loot history…</div>;
  if (error)   return <div className="error">Failed to load loot history.</div>;

  const toggle      = (charId) => setExpanded(prev => {
    const next = new Set(prev); next.has(charId) ? next.delete(charId) : next.add(charId); return next;
  });
  const toggleGroup = (label)  => setExpandedGroups(prev => ({ ...prev, [label]: !prev[label] }));

  const { players, heroicWeight = 0.2, normalWeight = 0, nonBisWeight = 0.333, skipped = {} } = data;

  const groups = ['Active', 'Bench', 'Inactive']
    .map(status => ({
      label:   status,
      players: players
        .filter(p => p.status === status)
        .sort((a, b) => b.lootPerRaid - a.lootPerRaid || a.charName.localeCompare(b.charName)),
    }))
    .filter(g => g.players.length > 0);

  return (
    <div className="loot-history-page">
      <div className="page-header">
        <h2 className="page-title">Loot History</h2>
        <span className="lh-filter-divider" />
        {DIFFICULTIES.map(d => (
          <label key={d} className={`lh-filter-check lh-filter-diff lh-col-${d.toLowerCase()}`}>
            <input type="checkbox" checked={showDiff[d]} onChange={e => setShowDiff(prev => ({ ...prev, [d]: e.target.checked }))} />
            {d}
          </label>
        ))}
      </div>

      {(() => {
        const visibleDiffs = DIFFICULTIES.filter(d => showDiff[d]);
        const colSpan = 3 + visibleDiffs.length; // char + visible diffs + raids + loot/raid
        return (
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="lh-table">
          <colgroup>
            <col />
            {visibleDiffs.map(d => <col key={d} />)}
            <col style={{ width: '5%' }} />
            <col style={{ width: '13%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Character</th>
              {visibleDiffs.map(d => (
                <th key={d} className={`lh-col-diff lh-col-${d.toLowerCase()}`}>{d}</th>
              ))}
              <th className="lh-col-num">Raids</th>
              <th className="lh-col-num" title={`Weighted loot per raid attended\n= (BIS-M + BIS-H×${heroicWeight}${normalWeight ? ` + BIS-N×${normalWeight}` : ''} + (NonBIS-M + NonBIS-H×${heroicWeight}${normalWeight ? ` + NonBIS-N×${normalWeight}` : ''})×${nonBisWeight}) ÷ raids`}>Loot/Raid ⓘ</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr><td colSpan={colSpan} className="empty" style={{ textAlign: 'center', padding: 24 }}>No loot recorded this season.</td></tr>
            )}
            {groups.flatMap(group => {
              const groupOpen = expandedGroups[group.label] ?? false;
              return [
              <tr key={`group-${group.label}`} className="lh-group-header-row" onClick={() => toggleGroup(group.label)}>
                <td colSpan={colSpan} className="lh-group-header">
                  <span className={`lh-chevron${groupOpen ? ' lh-chevron-open' : ''}`}>▶</span>
                  {group.label}
                  <span className="lh-group-count">{group.players.length}</span>
                </td>
              </tr>,
              ...(!groupOpen ? [] : group.players.flatMap(p => {
                const isOpen = expanded.has(p.charId);
                return [
                  <tr
                    key={p.charId}
                    className={`lh-row${isOpen ? ' lh-row-open' : ''}${p.status !== 'Active' ? ' lh-row-inactive' : ''}`}
                    onClick={() => toggle(p.charId)}
                  >
                    <td className="lh-cell-char">
                      <span className={`lh-chevron${isOpen ? ' lh-chevron-open' : ''}`}>▶</span>
                      <span className="lh-char-name">{p.charName}</span>
                      <span className="lh-spec text-muted">{p.spec}</span>
                    </td>
                    {visibleDiffs.map(d => (
                      <td key={d}><DiffColumn diff={d} counts={p.counts} /></td>
                    ))}
                    <td className="lh-col-num">{p.raidsAttended}</td>
                    <td className="lh-col-num"><strong>{p.lootPerRaid.toFixed(2)}</strong></td>
                  </tr>,
                  isOpen && (
                    <tr key={`${p.charId}-detail`} className="lh-detail-row">
                      <td colSpan={colSpan} style={{ padding: 0 }}>
                        <PlayerLootDetail loot={p.loot} />
                      </td>
                    </tr>
                  ),
                ].filter(Boolean);
              })),
            ];})}

          </tbody>
        </table>
      </div>
        );
      })()}

      <SkippedSection skipped={skipped} />
    </div>
  );
}
