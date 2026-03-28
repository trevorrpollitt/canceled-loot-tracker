import { useState, useEffect, Fragment } from 'react';
import ItemLink from '../components/ItemLink.jsx';
import { apiPath } from '../lib/api.js';

const DIFFICULTY_ORDER = ['Mythic', 'Heroic'];

const UPGRADE_BADGE = {
  'BIS':     { label: 'BIS',     cls: 'badge-bis'    },
  'Non-BIS': { label: 'Non-BIS', cls: 'badge-nonbis' },
};

// ── Difficulty breakdown cell ─────────────────────────────────────────────────

function DiffCounts({ counts }) {
  const parts = DIFFICULTY_ORDER
    .map(d => ({ d, n: counts[d] ?? 0 }))
    .filter(({ n }) => n > 0);
  if (!parts.length) return <span className="text-muted">—</span>;
  return (
    <span className="lh-diff-counts">
      {parts.map(({ d, n }) => (
        <span key={d} className={`lh-diff lh-diff-${d.toLowerCase()}`}>
          {n}{d[0]}
        </span>
      ))}
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
  const [expanded, setExpanded] = useState(new Set());

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

  return (
    <div className="loot-history-page">
      <div className="page-header">
        <h2 className="page-title">Loot History</h2>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="lh-table">
          <colgroup>
            <col style={{ width: '38%' }} />
            <col style={{ width: '22%' }} />
            <col style={{ width: '22%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '9%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Character</th>
              <th>BIS</th>
              <th>Non-BIS</th>
              <th className="lh-col-num">Raids</th>
              <th className="lh-col-num" title="Weighted loot per raid attended&#10;= (BIS-M + BIS-H×0.2 + (NonBIS-M + NonBIS-H×0.2)×0.333) ÷ raids">Loot/Raid ⓘ</th>
            </tr>
          </thead>
          <tbody>
            {players.flatMap(p => {
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
                  <td><DiffCounts counts={p.counts.BIS} /></td>
                  <td><DiffCounts counts={p.counts['Non-BIS']} /></td>
                  <td className="lh-col-num">{p.raidsAttended}</td>
                  <td className="lh-col-num"><strong>{p.lootPerRaid.toFixed(2)}</strong></td>
                </tr>,
                isOpen && (
                  <tr key={`${p.charId}-detail`} className="lh-detail-row">
                    <td colSpan={5} style={{ padding: 0 }}>
                      <PlayerLootDetail loot={p.loot} />
                    </td>
                  </tr>
                ),
              ].filter(Boolean);
            })}
            {players.length === 0 && (
              <tr><td colSpan={5} className="empty" style={{ textAlign: 'center', padding: 24 }}>No loot recorded this season.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
