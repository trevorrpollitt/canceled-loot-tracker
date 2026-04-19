/**
 * LootAudit — full loot log grouped by date for high-level auditing.
 * Rendered at the bottom of the Import Loot page.
 *
 * Per-entry edits (recipient, upgrade type, ignored) fire immediately
 * with optimistic updates and silent rollback on failure.
 */

import { apiPath } from '../lib/api.js';
import { useState, useEffect } from 'react';
import ItemLink from '../components/ItemLink.jsx';

const UPGRADE_TYPES = ['BIS', 'Non-BIS', 'Tertiary'];

export default function LootAudit() {
  const [entries,       setEntries]       = useState(null);
  const [rosterMembers, setRosterMembers] = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState(null);
  const [expanded,      setExpanded]      = useState(new Set()); // expanded date strings
  const [busy,          setBusy]          = useState({});        // id → true while saving

  useEffect(() => {
    fetch(apiPath('/api/loot/audit'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { setEntries(d.entries); setRosterMembers(d.rosterMembers); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  }, []);

  if (loading) return <div className="loading" style={{ marginTop: 32 }}>Loading loot log…</div>;
  if (error)   return <div className="error"   style={{ marginTop: 32 }}>Failed to load loot log.</div>;
  if (!entries?.length) return <p className="empty" style={{ marginTop: 32 }}>No loot entries recorded yet.</p>;

  // ── group by date, sorted desc ──────────────────────────────────────────────
  const dateMap = new Map();
  for (const e of entries) {
    if (!dateMap.has(e.date)) dateMap.set(e.date, []);
    dateMap.get(e.date).push(e);
  }
  const dates = [...dateMap.keys()].sort((a, b) => b.localeCompare(a));

  // ── helpers ─────────────────────────────────────────────────────────────────
  const toggleDate = (date) => setExpanded(prev => {
    const next = new Set(prev);
    next.has(date) ? next.delete(date) : next.add(date);
    return next;
  });

  const updateEntry = (id, changes) =>
    setEntries(prev => prev.map(e => e.id === id ? { ...e, ...changes } : e));

  const withBusy = (id, fn) => async (...args) => {
    setBusy(prev => ({ ...prev, [id]: true }));
    try { await fn(...args); }
    finally { setBusy(prev => ({ ...prev, [id]: false })); }
  };

  const handleReassign = (entry) => withBusy(entry.id, async (newCharId) => {
    const charId = Number(newCharId);
    const char   = rosterMembers.find(r => r.charId === charId);
    if (!char) return;
    const orig = { recipient_char_id: entry.recipient_char_id, recipient_name: entry.recipient_name, recipientName: entry.recipientName };
    updateEntry(entry.id, { recipient_char_id: charId, recipient_name: char.charName, recipientName: char.charName });
    const res = await fetch(apiPath('/api/loot/entries/reassign'), {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments: [{ id: entry.id, charId }] }),
    });
    if (!res.ok) updateEntry(entry.id, orig);
  });

  const handleUpgradeType = (entry) => withBusy(entry.id, async (newType) => {
    if (!newType || newType === (entry.upgradeType || entry.upgrade_type)) return;
    const orig = { upgradeType: entry.upgradeType, upgrade_type: entry.upgrade_type };
    updateEntry(entry.id, { upgradeType: newType, upgrade_type: newType });
    const res = await fetch(apiPath('/api/loot/entries/upgrade-type'), {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ corrections: [{ id: entry.id, upgradeType: newType }] }),
    });
    if (!res.ok) updateEntry(entry.id, orig);
  });

  const handleToggleIgnored = (entry) => withBusy(entry.id, async () => {
    const newIgnored = !entry.ignored;
    updateEntry(entry.id, { ignored: newIgnored });
    const res = await fetch(apiPath('/api/loot/ignored'), {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [entry.id], ignored: newIgnored }),
    });
    if (!res.ok) updateEntry(entry.id, { ignored: entry.ignored });
  });

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div className="loot-audit">
      <h2 className="section-title">Loot Audit</h2>
      <p className="loot-audit-desc">
        All imported loot entries grouped by date. Edit recipient or type inline; toggle Ignore to exclude an entry from loot scoring.
      </p>

      {dates.map(date => {
        const rows        = dateMap.get(date);
        const isOpen      = expanded.has(date);
        const ignoredCount = rows.filter(r => r.ignored).length;

        return (
          <div key={date} className="loot-audit-group">
            <div className="loot-audit-group-header" onClick={() => toggleDate(date)}>
              <span className={`lh-chevron${isOpen ? ' lh-chevron-open' : ''}`}>▶</span>
              <span className="loot-audit-date">{date}</span>
              <span className="lh-group-count">{rows.length}</span>
              {ignoredCount > 0 && (
                <span className="loot-audit-ignored-badge">{ignoredCount} ignored</span>
              )}
            </div>

            {isOpen && (
              <table className="loot-table loot-audit-table">
                <thead>
                  <tr>
                    <th>Boss</th>
                    <th>Item</th>
                    <th>Diff</th>
                    <th>Recipient</th>
                    <th>Type</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(entry => {
                    const isBusy     = !!busy[entry.id];
                    const upgradeType = entry.upgradeType || entry.upgrade_type || '';
                    const charId      = entry.recipient_char_id;
                    const charName    = entry.resolved_char_name || entry.recipientName || entry.recipient_name || '';
                    const inRoster    = charId && rosterMembers.some(r => r.charId === charId);

                    return (
                      <tr
                        key={entry.id}
                        className={`loot-audit-row${entry.ignored ? ' loot-audit-row-ignored' : ''}`}
                      >
                        <td className="loot-audit-boss">{entry.boss || '—'}</td>
                        <td><ItemLink name={entry.itemName || entry.item_name} /></td>
                        <td className="loot-audit-diff">{entry.difficulty?.[0] ?? '—'}</td>

                        {/* Recipient */}
                        <td>
                          <select
                            className="lh-diff-select loot-audit-select"
                            disabled={isBusy}
                            value={charId ?? ''}
                            onChange={e => handleReassign(entry)(e.target.value)}
                          >
                            {/* If current recipient is not in active/bench roster, keep them as an option */}
                            {charId && !inRoster && (
                              <option value={charId}>{charName || `#${charId}`}</option>
                            )}
                            {!charId && <option value="">— unlinked —</option>}
                            {rosterMembers.map(r => (
                              <option key={r.charId} value={r.charId}>{r.charName}</option>
                            ))}
                          </select>
                        </td>

                        {/* Upgrade type */}
                        <td>
                          <select
                            className="lh-diff-select loot-audit-select"
                            disabled={isBusy}
                            value={upgradeType}
                            onChange={e => handleUpgradeType(entry)(e.target.value)}
                          >
                            {UPGRADE_TYPES.map(t => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </td>

                        {/* Ignored toggle */}
                        <td className="lh-action-cell">
                          <button
                            className={entry.ignored ? 'lh-unignore-btn' : 'lh-ignore-btn'}
                            disabled={isBusy}
                            onClick={() => handleToggleIgnored(entry)()}
                          >
                            {isBusy ? '…' : (entry.ignored ? 'Unignore' : 'Ignore')}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}
