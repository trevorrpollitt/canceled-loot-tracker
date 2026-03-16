import { apiPath } from '../lib/api.js';
import { useState, useEffect } from 'react';
import ItemLink from '../components/ItemLink.jsx';

const ALL_SLOTS = [
  'Head', 'Neck', 'Shoulders', 'Back', 'Chest', 'Wrists',
  'Hands', 'Waist', 'Legs', 'Feet',
  'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2', 'Weapon', 'Off-Hand',
];

const SENTINELS       = new Set(['<Tier>', '<Catalyst>', '<Crafted>']);
const DIFFICULTY_ORDER = ['Mythic', 'Heroic', 'Normal'];

const CLASS_SPECS = {
  'Death Knight':  ['Blood DK', 'Frost DK', 'Unholy DK'],
  'Demon Hunter':  ['Havoc DH', 'Vengeance DH'],
  'Druid':         ['Balance Druid', 'Feral Druid', 'Guardian Druid', 'Resto Druid'],
  'Evoker':        ['Devastation Evoker', 'Augmentation Evoker', 'Preservation Evoker'],
  'Hunter':        ['BM Hunter', 'MM Hunter', 'SV Hunter'],
  'Mage':          ['Arcane Mage', 'Fire Mage', 'Frost Mage'],
  'Monk':          ['Brewmaster Monk', 'Mistweaver Monk', 'Windwalker Monk'],
  'Paladin':       ['Holy Paladin', 'Prot Paladin', 'Ret Paladin'],
  'Priest':        ['Disc Priest', 'Holy Priest', 'Shadow Priest'],
  'Rogue':         ['Assassination Rogue', 'Outlaw Rogue', 'Subtlety Rogue'],
  'Shaman':        ['Ele Shaman', 'Enh Shaman', 'Resto Shaman'],
  'Warlock':       ['Affliction Lock', 'Demo Lock', 'Destro Lock'],
  'Warrior':       ['Arms Warrior', 'Fury Warrior', 'Prot Warrior'],
};

const UPGRADE_BADGE = {
  'BIS':      { label: 'BIS',      className: 'badge-bis'     },
  'Non-BIS':  { label: 'Non-BIS',  className: 'badge-nonbis'  },
  'Tertiary': { label: 'Tertiary', className: 'badge-tertiary' },
};

const STATUS_BADGE = {
  'Active':   'badge-status-active',
  'Bench':    'badge-status-bench',
  'Inactive': 'badge-status-inactive',
};

// ── Shared sub-components ──────────────────────────────────────────────────────

function LootSummary({ loot }) {
  const counted  = loot.filter(e => e.upgradeType !== 'Tertiary');
  const tertiary = loot.filter(e => e.upgradeType === 'Tertiary');

  const byDiff = Object.fromEntries(
    DIFFICULTY_ORDER.map(d => [d, counted.filter(e => e.difficulty === d)])
  );

  const anyData = DIFFICULTY_ORDER.some(d => byDiff[d].length > 0) || tertiary.length > 0;
  if (!anyData) return null;

  return (
    <div className="loot-summary">
      {DIFFICULTY_ORDER.map(d => byDiff[d].length > 0 && (
        <div key={d} className="summary-block">
          <span className="summary-label">{d[0]}</span>
          <span className="summary-bis">{byDiff[d].filter(e => e.upgradeType === 'BIS').length} BIS</span>
          <span className="summary-nonbis">{byDiff[d].filter(e => e.upgradeType === 'Non-BIS').length} Non-BIS</span>
        </div>
      ))}
      {tertiary.length > 0 && (
        <div className="summary-block">
          <span className="summary-label">Tertiary</span>
          <span className="summary-tertiary">{tertiary.length}</span>
        </div>
      )}
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

function BisTable({ bis, specDefaults, loot }) {
  const personalBySlot = Object.fromEntries(bis.map(b => [b.slot, b]));
  const defaultBySlot  = Object.fromEntries(specDefaults.map(d => [d.slot, d]));

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

    const overall    = src.trueBis        ?? '';
    const overallId  = src.trueBisItemId  ?? '';
    const raid       = src.raidBis        ?? '';
    const raidId     = src.raidBisItemId  ?? '';
    const isPersonal = !!personal;
    const received   = overall && !SENTINELS.has(overall) &&
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
        {rows.map(({ slot, overall, overallId, raid, raidId, isPersonal, received }) => (
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
      </tbody>
    </table>
  );
}

// ── Account loot widget ────────────────────────────────────────────────────────

function AccountWidget({ accountChars, accountLoot, currentChar }) {
  const rows = accountChars.map(char => {
    const charLoot  = accountLoot.filter(e => e.recipientChar === char);
    const counted   = charLoot.filter(e => e.upgradeType !== 'Tertiary');
    const tertiary  = charLoot.filter(e => e.upgradeType === 'Tertiary').length;
    const byDiff    = Object.fromEntries(
      DIFFICULTY_ORDER.map(d => [d, counted.filter(e => e.difficulty === d)])
    );
    return { char, byDiff, tertiary };
  });

  // Totals row
  const totalByDiff = Object.fromEntries(
    DIFFICULTY_ORDER.map(d => [d, accountLoot.filter(e => e.upgradeType !== 'Tertiary' && e.difficulty === d)])
  );
  const totalTertiary = accountLoot.filter(e => e.upgradeType === 'Tertiary').length;

  return (
    <div className="account-widget">
      <div className="account-widget-title">Account · {accountChars.join(' · ')}</div>
      <table className="account-loot-table">
        <thead>
          <tr>
            <th>Character</th>
            {DIFFICULTY_ORDER.map(d => <th key={d}>{d[0]}</th>)}
            <th>Tert</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ char, byDiff, tertiary }) => (
            <tr key={char} className={char === currentChar ? 'account-row-current' : ''}>
              <td className="account-char-name">{char}</td>
              {DIFFICULTY_ORDER.map(d => {
                const bis    = byDiff[d].filter(e => e.upgradeType === 'BIS').length;
                const nonbis = byDiff[d].filter(e => e.upgradeType === 'Non-BIS').length;
                return (
                  <td key={d} className="account-diff-cell">
                    {bis    > 0 && <span className="summary-bis">{bis}B</span>}
                    {nonbis > 0 && <span className="summary-nonbis">{nonbis}N</span>}
                    {bis === 0 && nonbis === 0 && <span className="text-muted">—</span>}
                  </td>
                );
              })}
              <td className="account-diff-cell">
                {tertiary > 0 ? <span className="summary-tertiary">{tertiary}</span> : <span className="text-muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="account-row-total">
            <td>Total</td>
            {DIFFICULTY_ORDER.map(d => {
              const bis    = totalByDiff[d].filter(e => e.upgradeType === 'BIS').length;
              const nonbis = totalByDiff[d].filter(e => e.upgradeType === 'Non-BIS').length;
              return (
                <td key={d} className="account-diff-cell">
                  {bis    > 0 && <span className="summary-bis">{bis}B</span>}
                  {nonbis > 0 && <span className="summary-nonbis">{nonbis}N</span>}
                  {bis === 0 && nonbis === 0 && <span className="text-muted">—</span>}
                </td>
              );
            })}
            <td className="account-diff-cell">
              {totalTertiary > 0 ? <span className="summary-tertiary">{totalTertiary}</span> : <span className="text-muted">—</span>}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Character detail panel ─────────────────────────────────────────────────────

function CharacterDetail({ charName, onClose }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);
    fetch(apiPath(`/api/roster/${encodeURIComponent(charName)}`), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  }, [charName]);

  useEffect(() => {
    if (data) window.$WowheadPower?.refreshLinks();
  }, [data]);

  return (
    <div className="roster-detail">
      <div className="roster-detail-header">
        <div className="roster-detail-identity">
          {loading
            ? <span className="roster-detail-name">{charName}</span>
            : data && (
              <>
                <span className="roster-detail-name">{data.charName}</span>
                <span className="roster-detail-spec">{data.spec}</span>
                <span className={`badge ${STATUS_BADGE[data.status] ?? ''}`}>{data.status}</span>
                {data.ownerNick && <span className="roster-detail-owner">@{data.ownerNick}</span>}
              </>
            )
          }
        </div>
        <button className="roster-detail-close" onClick={onClose} title="Close">✕</button>
      </div>

      {loading && <div className="loading">Loading…</div>}
      {error   && <div className="error">Failed to load character data.</div>}

      {data && (
        <>
          <section className="card">
            <h3 className="card-title">BIS Status</h3>
            <BisTable bis={data.bis} specDefaults={data.specDefaults} loot={data.loot} />
          </section>

          <section className="card">
            <h3 className="card-title">Loot History</h3>
            {data.accountChars?.length > 1 && (
              <AccountWidget
                accountChars={data.accountChars}
                accountLoot={data.accountLoot}
                currentChar={charName}
              />
            )}
            <LootSummary loot={data.loot} />
            <LootTable   loot={data.loot} />
          </section>
        </>
      )}
    </div>
  );
}

// ── Add character form ─────────────────────────────────────────────────────────

function AddCharForm({ onSave, onCancel }) {
  const [charName, setCharName] = useState('');
  const [cls, setCls]           = useState('');
  const [spec, setSpec]         = useState('');
  const [status, setStatus]     = useState('Active');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState(null);

  const specs = cls ? (CLASS_SPECS[cls] ?? []) : [];

  const handleClassChange = (e) => {
    setCls(e.target.value);
    setSpec('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!charName.trim() || !cls || !spec) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(apiPath('/api/roster'), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ charName: charName.trim(), class: cls, spec, status }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.status);
      onSave(body);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <form className="add-char-form card" onSubmit={handleSubmit}>
      <h3 className="card-title">Add Character</h3>
      <div className="add-char-fields">
        <input
          className="roster-player-input"
          placeholder="Character name"
          value={charName}
          autoFocus
          onChange={e => setCharName(e.target.value)}
          onKeyDown={e => e.key === 'Escape' && onCancel()}
        />
        <select className="add-char-select" value={cls} onChange={handleClassChange}>
          <option value="">Class…</option>
          {Object.keys(CLASS_SPECS).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="add-char-select" value={spec} onChange={e => setSpec(e.target.value)} disabled={!cls}>
          <option value="">Spec…</option>
          {specs.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="add-char-select" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="Active">Active</option>
          <option value="Bench">Bench</option>
          <option value="Inactive">Inactive</option>
        </select>
      </div>
      {error && <div className="error" style={{ marginTop: '8px' }}>{error}</div>}
      <div className="add-char-actions">
        <button type="submit" className="btn-primary btn-sm" disabled={saving || !charName.trim() || !cls || !spec}>
          {saving ? 'Adding…' : 'Add Character'}
        </button>
        <button type="button" className="btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ── Roster page ────────────────────────────────────────────────────────────────

export default function RosterPage() {
  const [roster, setRoster]                 = useState(null);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState(null);
  const [selectedChar, setSelectedChar]     = useState(null);
  const [showAddForm, setShowAddForm]       = useState(false);
  const [toggling, setToggling]             = useState(null); // charName being status-toggled
  const [copiedChar, setCopiedChar]         = useState(null); // charName whose Discord ID was just copied
  const [editingOwnerChar, setEditingOwnerChar] = useState(null); // charName whose player name is being edited
  const [editOwnerValue, setEditOwnerValue] = useState('');
  const [linkingOwnerChar, setLinkingOwnerChar] = useState(null); // charName being linked to a Discord ID
  const [linkOwnerIdValue, setLinkOwnerIdValue]   = useState('');
  const [linkOwnerNickValue, setLinkOwnerNickValue] = useState('');

  useEffect(() => {
    fetch(apiPath('/api/roster'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { setRoster(d); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  }, []);

  if (loading) return <div className="loading">Loading roster…</div>;
  if (error)   return <div className="error">Failed to load roster.</div>;

  const active   = roster.filter(c => c.status === 'Active').length;
  const bench    = roster.filter(c => c.status === 'Bench').length;
  const inactive = roster.filter(c => c.status === 'Inactive').length;

  const handleRowClick = (charName) => {
    setSelectedChar(prev => prev === charName ? null : charName);
  };

  const handleEditOwner = (e, char) => {
    e.stopPropagation();
    setEditingOwnerChar(char.charName);
    setEditOwnerValue(char.ownerNick || '');
  };

  const handleSaveOwnerNick = async () => {
    if (!editingOwnerChar) return;
    const trimmed     = editOwnerValue.trim();
    const char        = roster.find(c => c.charName === editingOwnerChar);
    const ownerId     = char?.ownerId;
    const originalNick = char?.ownerNick;
    setEditingOwnerChar(null);
    if (!trimmed || !ownerId || trimmed === originalNick) return;

    // Optimistic update — all chars sharing this ownerId
    setRoster(prev => prev.map(c =>
      c.ownerId === ownerId ? { ...c, ownerNick: trimmed } : c
    ));

    try {
      const res = await fetch(apiPath('/api/roster/owner-nick'), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ ownerId, ownerNick: trimmed }),
      });
      if (!res.ok) throw new Error(res.status);
    } catch {
      // Roll back
      setRoster(prev => prev.map(c =>
        c.ownerId === ownerId ? { ...c, ownerNick: originalNick } : c
      ));
    }
  };

  const handleSaveLinkOwner = async () => {
    const charName = linkingOwnerChar;
    const ownerId  = linkOwnerIdValue.trim();
    const nick     = linkOwnerNickValue.trim();
    setLinkingOwnerChar(null);
    if (!charName || !ownerId) return;

    // Optimistic update
    setRoster(prev => prev.map(c =>
      c.charName === charName ? { ...c, ownerId, ownerNick: nick } : c
    ));

    try {
      const res = await fetch(apiPath(`/api/roster/${encodeURIComponent(charName)}/owner`), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ ownerId, ownerNick: nick }),
      });
      if (!res.ok) throw new Error(res.status);
    } catch {
      // Roll back
      setRoster(prev => prev.map(c =>
        c.charName === charName ? { ...c, ownerId: '', ownerNick: '' } : c
      ));
    }
  };

  const handleClearOwner = async (e, char) => {
    e.stopPropagation();
    const { ownerId, ownerNick } = char;

    // Optimistic update
    setRoster(prev => prev.map(c =>
      c.charName === char.charName ? { ...c, ownerId: '', ownerNick: '' } : c
    ));

    try {
      const res = await fetch(apiPath(`/api/roster/${encodeURIComponent(char.charName)}/owner`), {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) throw new Error(res.status);
    } catch {
      // Roll back
      setRoster(prev => prev.map(c =>
        c.charName === char.charName ? { ...c, ownerId, ownerNick } : c
      ));
    }
  };

  const handleCopyDiscordId = (e, char) => {
    e.stopPropagation();
    navigator.clipboard.writeText(char.ownerId).then(() => {
      setCopiedChar(char.charName);
      setTimeout(() => setCopiedChar(prev => prev === char.charName ? null : prev), 1500);
    });
  };

  const handleToggleStatus = async (e, char) => {
    e.stopPropagation(); // don't also trigger row click / detail open
    const newStatus = char.status === 'Inactive' ? 'Active' : 'Inactive';
    setToggling(char.charName);

    // Optimistic update
    setRoster(prev => prev.map(c =>
      c.charName === char.charName ? { ...c, status: newStatus } : c
    ));

    try {
      const res = await fetch(apiPath(`/api/roster/${encodeURIComponent(char.charName)}/status`), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error(res.status);
    } catch {
      // Roll back on failure
      setRoster(prev => prev.map(c =>
        c.charName === char.charName ? { ...c, status: char.status } : c
      ));
    } finally {
      setToggling(null);
    }
  };

  return (
    <div className="roster-page">
      <div className="page-header">
        <h2 className="page-title">Roster</h2>
        <div className="roster-header-right">
          <div className="roster-counts">
            <span><span className="roster-count-dot dot-active" />Active {active}</span>
            <span><span className="roster-count-dot dot-bench"  />Bench {bench}</span>
            {inactive > 0 && (
              <span><span className="roster-count-dot dot-inactive" />Inactive {inactive}</span>
            )}
          </div>
          <button className="btn-primary btn-sm" onClick={() => setShowAddForm(f => !f)}>
            {showAddForm ? 'Cancel' : '+ Add Character'}
          </button>
        </div>
      </div>

      {showAddForm && (
        <AddCharForm
          onSave={newChar => {
            // Insert into sorted position: Active/Bench alpha first, Inactive alpha last
            setRoster(prev => {
              const next = [...prev, newChar];
              return next.sort((a, b) => {
                const ai = a.status === 'Inactive' ? 1 : 0;
                const bi = b.status === 'Inactive' ? 1 : 0;
                if (ai !== bi) return ai - bi;
                return a.charName.localeCompare(b.charName);
              });
            });
            setShowAddForm(false);
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      <section className="card">
        <table className="roster-table">
          <thead>
            <tr>
              <th>Character</th>
              <th>Spec</th>
              <th>Role</th>
              <th>Status</th>
              <th>Player</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {roster.map(char => (
              <tr
                key={char.charName}
                className={[
                  'roster-row',
                  selectedChar === char.charName ? 'roster-row-selected' : '',
                  char.status === 'Inactive'     ? 'roster-row-inactive' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => handleRowClick(char.charName)}
              >
                <td className="roster-col-name">{char.charName}</td>
                <td>{char.spec}</td>
                <td className="text-muted">{char.role || '—'}</td>
                <td>
                  <span className={`badge ${STATUS_BADGE[char.status] ?? ''}`}>
                    {char.status}
                  </span>
                </td>
                <td className="roster-col-player" onClick={e => e.stopPropagation()}>
                  {!char.ownerId ? (
                    // No Discord link — show warning icon / linking form
                    linkingOwnerChar === char.charName ? (
                      <div className="roster-link-form">
                        <input
                          className="roster-player-input"
                          placeholder="Discord ID"
                          value={linkOwnerIdValue}
                          autoFocus
                          onChange={e => {
                            const val = e.target.value;
                            setLinkOwnerIdValue(val);
                            const match = roster.find(c => c.ownerId === val.trim());
                            if (match?.ownerNick) setLinkOwnerNickValue(match.ownerNick);
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Enter')  { e.preventDefault(); handleSaveLinkOwner(); }
                            if (e.key === 'Escape') setLinkingOwnerChar(null);
                          }}
                        />
                        <input
                          className="roster-player-input"
                          placeholder="Player name (optional)"
                          value={linkOwnerNickValue}
                          onChange={e => setLinkOwnerNickValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter')  { e.preventDefault(); handleSaveLinkOwner(); }
                            if (e.key === 'Escape') setLinkingOwnerChar(null);
                          }}
                        />
                        <div className="roster-link-actions">
                          <button className="btn-primary btn-sm" onClick={handleSaveLinkOwner}>Save</button>
                          <button className="btn-sm" onClick={() => setLinkingOwnerChar(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="roster-unlinked-btn"
                        title="No Discord account linked — click to link"
                        onClick={e => {
                          e.stopPropagation();
                          setLinkingOwnerChar(char.charName);
                          setLinkOwnerIdValue('');
                          setLinkOwnerNickValue('');
                        }}
                      >
                        ⚠ Unlinked
                      </button>
                    )
                  ) : editingOwnerChar === char.charName ? (
                    <input
                      className="roster-player-input"
                      value={editOwnerValue}
                      autoFocus
                      onChange={e => setEditOwnerValue(e.target.value)}
                      onBlur={handleSaveOwnerNick}
                      onKeyDown={e => {
                        if (e.key === 'Enter')  { e.preventDefault(); handleSaveOwnerNick(); }
                        if (e.key === 'Escape') setEditingOwnerChar(null);
                      }}
                    />
                  ) : (
                    <span className="roster-player-value">
                      <span className="text-muted">{char.ownerNick || '—'}</span>
                      <button
                        className="roster-edit-btn"
                        onClick={e => handleEditOwner(e, char)}
                        title="Edit player name"
                      >✎</button>
                      <button
                        className={`roster-copy-btn ${copiedChar === char.charName ? 'roster-copy-btn-copied' : ''}`}
                        onClick={e => handleCopyDiscordId(e, char)}
                        title={copiedChar === char.charName ? 'Copied!' : `Copy Discord ID (${char.ownerId})`}
                      >{copiedChar === char.charName ? '✓' : '⎘'}</button>
                      <button
                        className="roster-clear-btn"
                        onClick={e => handleClearOwner(e, char)}
                        title="Unlink Discord account and clear player name"
                      >✕</button>
                    </span>
                  )}
                </td>
                <td className="roster-col-action">
                  {char.status !== 'Bench' && (
                    <button
                      className={`roster-status-btn ${char.status === 'Inactive' ? 'roster-status-btn-activate' : 'roster-status-btn-deactivate'}`}
                      onClick={e => handleToggleStatus(e, char)}
                      disabled={toggling === char.charName}
                      title={char.status === 'Inactive' ? 'Set Active' : 'Set Inactive'}
                    >
                      {toggling === char.charName
                        ? '…'
                        : char.status === 'Inactive' ? 'Activate' : 'Deactivate'
                      }
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {selectedChar && (
        <CharacterDetail
          key={selectedChar}
          charName={selectedChar}
          onClose={() => setSelectedChar(null)}
        />
      )}
    </div>
  );
}
