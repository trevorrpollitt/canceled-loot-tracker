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

// ── Page ─────────────────────────────────────────────────────────────────────

export default function LootHistory() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [expanded,     setExpanded]     = useState(new Set());
  const [showInactive, setShowInactive] = useState(false);
  const [showBench,    setShowBench]    = useState(true);
  const [showDiff,     setShowDiff]     = useState({ Mythic: true, Heroic: true, Normal: true });

  useEffect(() => {
    fetch(apiPath('/api/loot/history'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e); setLoading(false); });
  }, []);

  if (loading) return <div className="loading">Loading loot history…</div>;
  if (error)   return <div className="error">Failed to load loot history.</div>;

  const toggle = (charId) => setExpanded(prev => {
    const next = new Set(prev);
    next.has(charId) ? next.delete(charId) : next.add(charId);
    return next;
  });

  const { players } = data;

  const visible = players.filter(p => {
    if (p.status === 'Inactive' && !showInactive) return false;
    if (p.status === 'Bench'    && !showBench)    return false;
    return true;
  });

  return (
    <div className="loot-history-page">
      <div className="page-header">
        <h2 className="page-title">Loot History</h2>
        <label className="lh-filter-check">
          <input type="checkbox" checked={showBench} onChange={e => setShowBench(e.target.checked)} />
          Bench
        </label>
        <label className="lh-filter-check">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Inactive
        </label>
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
            <col style={{ width: '6%' }} />
            <col style={{ width: '6%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Character</th>
              {visibleDiffs.map(d => (
                <th key={d} className={`lh-col-diff lh-col-${d.toLowerCase()}`}>{d}</th>
              ))}
              <th className="lh-col-num">Raids</th>
              <th className="lh-col-num" title="Weighted loot per raid attended&#10;= (BIS-M + BIS-H×0.2 + (NonBIS-M + NonBIS-H×0.2)×0.333) ÷ raids">Loot/Raid ⓘ</th>
            </tr>
          </thead>
          <tbody>
            {visible.flatMap(p => {
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
                    {p.status !== 'Active' && (
                      <span className="badge badge-status lh-status-badge">{p.status}</span>
                    )}
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
            })}
            {visible.length === 0 && (
              <tr><td colSpan={colSpan} className="empty" style={{ textAlign: 'center', padding: 24 }}>No loot recorded this season.</td></tr>
            )}
          </tbody>
        </table>
      </div>
        );
      })()}
    </div>
  );
}
