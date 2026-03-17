import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { useMe, refreshMe } from '../hooks/useMe.js';
import ItemLink from '../components/ItemLink.jsx';
import { apiPath } from '../lib/api.js';

const ALL_SLOTS = [
  'Head', 'Neck', 'Shoulders', 'Back', 'Chest', 'Wrists',
  'Hands', 'Waist', 'Legs', 'Feet',
  'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2', 'Weapon', 'Off-Hand',
];

const SENTINELS = new Set(['<Tier>', '<Catalyst>', '<Crafted>']);

const DIFFICULTY_ORDER = ['Mythic', 'Heroic', 'Normal'];

const UPGRADE_BADGE = {
  'BIS':      { label: 'BIS',      className: 'badge-bis'      },
  'Non-BIS':  { label: 'Non-BIS',  className: 'badge-nonbis'   },
  'Tertiary': { label: 'Tertiary', className: 'badge-tertiary'  },
  'Offspec':  { label: 'Offspec',  className: 'badge-offspec'   },
};

const SLOT_GROUPS = [
  { label: 'Tier',        slots: ['Head', 'Shoulders', 'Chest', 'Hands', 'Legs'] },
  { label: 'Other Armor', slots: ['Wrists', 'Waist', 'Feet'] },
  { label: 'Accessories', slots: ['Neck', 'Back', 'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2'] },
  { label: 'Weapons',     slots: ['Weapon', 'Off-Hand'] },
];

// ── Loot section ──────────────────────────────────────────────────────────────

function LootSummary({ loot }) {
  const byDiff = Object.fromEntries(
    DIFFICULTY_ORDER.map(d => [d, loot.filter(e => e.difficulty === d)])
  );

  const anyData = DIFFICULTY_ORDER.some(d => byDiff[d].length > 0);
  if (!anyData) return null;

  const AWARD_TYPES = [
    { type: 'BIS',      label: 'BIS',      cls: 'loot-badge-bis'      },
    { type: 'Non-BIS',  label: 'Non-BIS',  cls: 'loot-badge-nonbis'   },
    { type: 'Tertiary', label: 'Tertiary', cls: 'loot-badge-tertiary'  },
  ];

  return (
    <div className="loot-summary">
      {DIFFICULTY_ORDER.filter(d => byDiff[d].length > 0).map(d => (
        <div key={d} className="loot-summary-card">
          <div className="loot-summary-card-title">
            <span>{d}</span>
            <span className="loot-summary-card-total">Total: {byDiff[d].length}</span>
          </div>
          <div className="loot-summary-badges">
            {AWARD_TYPES.map(({ type, label, cls }) => {
              const count = byDiff[d].filter(e => e.upgradeType === type).length;
              if (!count) return null;
              return (
                <span key={type} className={`loot-summary-badge ${cls}`}>
                  {count} {label}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function LootTable({ loot }) {
  if (!loot.length) return <p className="empty">No loot recorded yet.</p>;

  return (
    <table className="loot-table">
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
          const badge = UPGRADE_BADGE[entry.upgradeType] ?? { label: entry.upgradeType, className: '' };
          return (
            <tr key={entry.id}>
              <td>{entry.date}</td>
              <td>{entry.boss}</td>
              <td><ItemLink name={entry.itemName} itemId={entry.itemId} /></td>
              <td>{entry.difficulty?.[0]}</td>
              <td><span className={`badge ${badge.className}`}>{badge.label}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── BIS section ───────────────────────────────────────────────────────────────

function BisTable({ bis, specDefaults, loot }) {
  // Personal approved submissions take priority over spec defaults
  const personalBySlot = Object.fromEntries(bis.map(b => [b.slot, b]));
  const defaultBySlot  = Object.fromEntries(specDefaults.map(d => [d.slot, d]));

  // Items the player has received that were marked BIS
  const receivedBis = new Set(
    loot
      .filter(e => e.upgradeType === 'BIS')
      .map(e => e.itemName.toLowerCase())
  );

  const rows = ALL_SLOTS.flatMap(slot => {
    const personal = personalBySlot[slot];
    const def      = defaultBySlot[slot];
    const src      = personal ?? def;
    if (!src) return [];

    const overall        = src.trueBis        ?? '';
    const overallId      = src.trueBisItemId  ?? '';
    const raid           = src.raidBis        ?? '';
    const raidId         = src.raidBisItemId  ?? '';
    const isPersonal     = !!personal;

    // A slot is "received" when the player has a BIS-tagged loot entry matching
    // the item name. Sentinel values (<Tier> etc.) can't be matched by name.
    const received = overall && !SENTINELS.has(overall) &&
                     receivedBis.has(overall.toLowerCase());

    return [{ slot, overall, overallId, raid, raidId, isPersonal, received }];
  });

  if (!rows.length) return <p className="empty">No BIS data available for this spec.</p>;

  return (
    <table className="bis-table">
      <thead>
        <tr>
          <th>Slot</th>
          <th>Overall BIS</th>
          <th>Raid BIS</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {SLOT_GROUPS.map(group => {
          const groupRows = rows.filter(r => group.slots.includes(r.slot));
          if (!groupRows.length) return null;
          return (
            <Fragment key={group.label}>
              <tr className="bis-group-header-row">
                <td colSpan={4} className="bis-group-header">{group.label}</td>
              </tr>
              {groupRows.map(({ slot, overall, overallId, raid, raidId, isPersonal, received }) => (
                <tr key={slot} className={received ? 'bis-row-received' : ''}>
                  <td className="bis-slot">{slot}</td>
                  <td>
                    <ItemLink
                      name={overall || '—'}
                      itemId={overallId}
                      className={SENTINELS.has(overall) ? 'bis-sentinel' : undefined}
                    />
                    {isPersonal && <span className="badge badge-personal">Personal</span>}
                  </td>
                  <td>
                    <ItemLink
                      name={raid || '—'}
                      itemId={raidId}
                      className={SENTINELS.has(raid) ? 'bis-sentinel' : 'text-muted'}
                    />
                  </td>
                  <td className="bis-check">
                    {received && <span className="bis-received-mark">✓</span>}
                  </td>
                </tr>
              ))}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Dashboard page ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { user } = useMe();
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError]         = useState(null);
  const initialSelectDone         = useRef(false);

  const loadDashboard = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(apiPath('/api/dashboard'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e); setLoading(false); });
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  // Re-process Wowhead tooltip links after data renders
  useEffect(() => {
    if (data) window.$WowheadPower?.refreshLinks();
  }, [data]);

  const handleSwitchChar = useCallback(async (charName) => {
    if (charName === user?.charName) return;
    setSwitching(true);
    try {
      const res = await fetch(apiPath('/api/me/active-char'), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ charName }),
      });
      if (!res.ok) throw new Error(res.status);
      await refreshMe();   // push updated user (charName, spec) to all consumers
      loadDashboard();     // reload dashboard data for the new character
    } catch {
      setError('Failed to switch character.');
    } finally {
      setSwitching(false);
    }
  }, [user?.charName, loadDashboard]);

  // On first load, auto-select the first character in sorted order
  useEffect(() => {
    if (initialSelectDone.current) return;
    const chars = user?.chars ?? [];
    if (!user || chars.length <= 1) return;
    initialSelectDone.current = true;
    const first = [...chars].sort((a, b) => {
      const ai = a.status === 'Inactive' ? 1 : 0;
      const bi = b.status === 'Inactive' ? 1 : 0;
      if (ai !== bi) return ai - bi;
      return a.charName.localeCompare(b.charName);
    })[0];
    if (first.charName !== user.charName) handleSwitchChar(first.charName);
  }, [user, handleSwitchChar]);

  if (loading) return <div className="loading">Loading dashboard…</div>;
  if (error)   return <div className="error">Failed to load dashboard.</div>;

  if (data?.noTeam) return (
    <div className="card">
      <p>Your Discord account isn't linked to any team roster yet. Ask an officer to add you.</p>
    </div>
  );

  const chars        = user?.chars ?? [];
  const multiChar    = chars.length > 1;
  const charBisStatus = data?.charBisStatus ?? {};

  // Active/Bench characters first (alphabetical), Inactive last (alphabetical)
  const sortedChars = [...chars].sort((a, b) => {
    const ai = a.status === 'Inactive' ? 1 : 0;
    const bi = b.status === 'Inactive' ? 1 : 0;
    if (ai !== bi) return ai - bi;
    return a.charName.localeCompare(b.charName);
  });

  return (
    <div className="dashboard">
      <div className="page-header">
        <h2 className="page-title">
          {user?.charName ?? user?.username}
          {user?.spec && <span className="spec-label"> — {user.spec}</span>}
        </h2>

        {multiChar && (
          <div className="char-switcher">
            {sortedChars.map(c => {
              const bisStatus = charBisStatus[c.charName] ?? {};
              const pending   = bisStatus.pending  ?? 0;
              const rejected  = bisStatus.rejected ?? 0;
              const inactive  = c.status === 'Inactive';
              return (
                <button
                  key={c.charName}
                  type="button"
                  className={[
                    'char-tab',
                    user.charName === c.charName ? 'char-tab-active'   : '',
                    inactive                     ? 'char-tab-inactive' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => handleSwitchChar(c.charName)}
                  disabled={switching}
                >
                  <span className="char-tab-name">{c.charName}</span>
                  <span className="char-tab-spec">{c.spec}</span>
                  {inactive && <span className="char-tab-status-label">Inactive</span>}
                  {(pending > 0 || rejected > 0) && (
                    <span className="char-tab-badges">
                      {pending  > 0 && (
                        <span className="char-tab-badge char-tab-badge-pending" title={`${pending} pending submission${pending !== 1 ? 's' : ''}`}>
                          ⏳ {pending}
                        </span>
                      )}
                      {rejected > 0 && (
                        <span className="char-tab-badge char-tab-badge-rejected" title={`${rejected} rejected submission${rejected !== 1 ? 's' : ''}`}>
                          ⚠ {rejected}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <section className="card">
        <div className="card-title-row">
          <h3 className="card-title">BIS Status</h3>
          <Link to="/bis" className="btn-primary btn-sm">Edit BIS</Link>
        </div>
        {(() => {
          const activeStatus = charBisStatus[data.charName] ?? {};
          const pending  = activeStatus.pending  ?? 0;
          const rejected = activeStatus.rejected ?? 0;
          return (pending > 0 || rejected > 0) ? (
            <div className="bis-notices">
              {pending > 0 && (
                <Link to="/bis" className="bis-notice bis-notice-pending">
                  <span className="bis-notice-icon">⏳</span>
                  <span>{pending} pending submission{pending !== 1 ? 's' : ''} awaiting officer review</span>
                </Link>
              )}
              {rejected > 0 && (
                <Link to="/bis" className="bis-notice bis-notice-rejected">
                  <span className="bis-notice-icon">⚠</span>
                  <span>{rejected} submission{rejected !== 1 ? 's' : ''} rejected — tap to review and resubmit</span>
                </Link>
              )}
            </div>
          ) : null;
        })()}
        <BisTable
          bis={data.bis}
          specDefaults={data.specDefaults}
          loot={data.loot}
        />
      </section>

      <section className="card">
        <h3 className="card-title">Loot History</h3>
        <LootSummary loot={data.loot} />
        <LootTable   loot={data.loot} />
      </section>
    </div>
  );
}
