/**
 * Council — Officer loot council page.
 *
 * Layout:
 *   Boss selector (row of buttons, filtered by selected instance)
 *   Item grid (chips for items from selected boss)
 *   Candidate table (shown when item selected) + Raid BIS / All toggle
 */

import { apiPath } from '../lib/api.js';
import { useState, useEffect, useCallback } from 'react';

// ── Item meta label ───────────────────────────────────────────────────────────

const ARMOR_TYPES = new Set(['Cloth', 'Leather', 'Mail', 'Plate']);

function itemMeta(item) {
  if (item.weaponType) return item.weaponType;
  if (ARMOR_TYPES.has(item.armorType)) return `${item.slot} · ${item.armorType}`;
  return item.slot;
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

function sortCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    // 1. Raid BIS match first
    if (b.raidBisMatch !== a.raidBisMatch) return b.raidBisMatch - a.raidBisMatch;
    // 2. Overall BIS match (true > 'crafted' > false)
    const aO = a.overallBisMatch === true ? 2 : a.overallBisMatch === 'crafted' ? 1 : 0;
    const bO = b.overallBisMatch === true ? 2 : b.overallBisMatch === 'crafted' ? 1 : 0;
    if (bO !== aO) return bO - aO;
    // 3. Fewest H/M BIS drops (needs loot more)
    const aBis = a.bisH + a.bisM;
    const bBis = b.bisH + b.bisM;
    return aBis - bBis;
  });
}

// ── Tier helpers ──────────────────────────────────────────────────────────────

const TIER_SLOT_SHORT      = { Head: 'He', Shoulders: 'Sh', Chest: 'Ch', Hands: 'Ha', Legs: 'Le' };
const TIER_SLOT_INITIAL    = { Head: 'H',  Shoulders: 'S',  Chest: 'C',  Hands: 'Ha', Legs: 'L'  };

const TRACK_COLOR = {
  Veteran:  '#4ecdc4',
  Champion: '#60a5fa',
  Hero:     '#c084fc',
  Mythic:   '#fbbf24',
};

function TierPips({ tierSlots, activeSlot }) {
  const owned = Object.keys(tierSlots ?? {}).length;
  return (
    <span className="council-tier-pips-owned" title={`${owned}/5 tier pieces`}>
      {Object.entries(TIER_SLOT_INITIAL).map(([slot, short]) => {
        const track   = tierSlots?.[slot];
        const isActive = slot === activeSlot;
        const classes = [
          'council-tier-pip',
          track    ? 'active'      : '',
          isActive ? 'active-slot' : '',
        ].filter(Boolean).join(' ');
        return (
          <span
            key={slot}
            className={classes}
            style={track ? { color: TRACK_COLOR[track] ?? '#aaa' } : { opacity: isActive ? 0.5 : 0.2 }}
            title={track ? `${slot}: ${track}` : slot}
          >{short}</span>
        );
      })}
    </span>
  );
}

// ── Curio candidate table ─────────────────────────────────────────────────────

function CurioCandidateRow({ c }) {
  return (
    <tr>
      <td className="council-col-char">
        {c.charName}{c.status === 'Bench' && <BenchDot />}
      </td>
      <td className="council-col-spec">{c.spec}</td>
      <td className="council-col-tier-slots">
        {Object.entries(TIER_SLOT_SHORT).map(([slot, short]) => (
          <span
            key={slot}
            className={`council-tier-pip${c.tierSlotsWanted.includes(slot) ? ' wanted' : ''}`}
            title={slot}
          >{short}</span>
        ))}
      </td>
      <td className="council-col-tier-slots">
        <TierPips tierSlots={c.tierSlots} />
      </td>
      <td className="council-col-stats">
        <span className="council-stat-bis">{c.bisH}/{c.bisM}</span>
      </td>
      <td className="council-col-stats">
        <span className="council-stat-nonbis">{c.nonBisH}/{c.nonBisM}</span>
      </td>
      <td className="council-col-stats" title="Account total across all characters">
        <span className="council-stat-bis">{c.acctBisH}/{c.acctBisM}</span>
      </td>
      <td className="council-col-stats" title="Account total across all characters">
        <span className="council-stat-nonbis">{c.acctNonBisH}/{c.acctNonBisM}</span>
      </td>
      <td className="council-col-num">{c.raidsAttended}</td>
    </tr>
  );
}

function CurioCandidateTable({ curioItemId }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    setLoading(true);
    fetch(apiPath('/api/council/curio-candidates'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setError('Failed to load curio candidates.'); setLoading(false); });
  }, []);

  useEffect(() => {
    if (data) window.$WowheadPower?.refreshLinks();
  }, [data]);

  if (loading) return <div className="loading">Loading curio candidates…</div>;
  if (error)   return <div className="error">{error}</div>;
  if (!data)   return null;

  const { candidates } = data;

  return (
    <div className="council-candidates">
      <div className="council-item-header">
        <a
          className="council-item-title"
          href={`https://www.wowhead.com/item=${curioItemId}`}
          target="_blank"
          rel="noreferrer"
        >Season Curio</a>
        <span className="council-item-subtitle">Tier Token · Any Class · Any Slot</span>
      </div>

      <span className="council-candidate-count" style={{ marginBottom: 12, display: 'block' }}>
        {candidates.length} eligible character{candidates.length !== 1 ? 's' : ''}
      </span>

      {candidates.length === 0 ? (
        <p className="empty">No active characters found.</p>
      ) : (
        <div className="council-table-wrap">
          <table className="council-table">
            <thead>
              <tr>
                <th className="council-col-char">Character</th>
                <th className="council-col-spec">Spec</th>
                <th className="council-col-tier-slots">Tier Needed</th>
                <th className="council-col-tier-slots">Tier Owned</th>
                <th className="council-col-stats">BIS H/M</th>
                <th className="council-col-stats">Non-BIS H/M</th>
                <th className="council-col-stats" title="Account total across all characters">Acct BIS H/M</th>
                <th className="council-col-stats" title="Account total across all characters">Acct Non-BIS H/M</th>
                <th className="council-col-num">Raids</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map(c => <CurioCandidateRow key={c.charName} c={c} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BossSelector({ bosses, selectedBoss, onSelect }) {
  if (!bosses.length) return null;
  return (
    <div className="council-selector-row">
      <span className="council-selector-label">Boss</span>
      <div className="council-instance-tabs">
        {bosses.map(b => (
          <button
            key={b.name}
            className={`council-instance-tab${selectedBoss === b.name ? ' active' : ''}`}
            onClick={() => onSelect(b.name)}
          >
            {b.name}
          </button>
        ))}
      </div>
    </div>
  );
}

const ITEM_GROUPS = [
  { label: 'Armor',       filter: item => ARMOR_TYPES.has(item.armorType) && !item.weaponType },
  { label: 'Accessories', filter: item => !item.isTierToken && item.armorType === 'Accessory' && !item.weaponType },
  { label: 'Weapons',     filter: item => !!item.weaponType },
];

function ItemGrid({ items, selectedItemId, onSelect }) {
  if (!items.length) return <p className="empty">No items for this boss.</p>;

  return (
    <div className="council-item-grid">
      {ITEM_GROUPS.map(group => {
        const groupItems = items.filter(group.filter);
        if (!groupItems.length) return null;
        return (
          <div key={group.label} className="council-item-group">
            <div className="council-item-group-label">{group.label}</div>
            {groupItems.map(item => (
              <button
                key={item.itemId}
                className={`council-item-chip${String(item.itemId) === String(selectedItemId) ? ' active' : ''}${item.isTierToken ? ' council-item-chip-tier' : ''}`}
                onClick={() => onSelect(item.itemId)}
              >
                <span className="council-item-name">{item.name}</span>
                <span className="council-item-meta">{itemMeta(item)}</span>
                {item.isTierToken && <span className="council-tier-star">✦</span>}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function BisIndicator({ match }) {
  if (match === true)      return <span className="council-bis-yes" title="BIS match">✓</span>;
  if (match === 'crafted') return <span className="council-bis-crafted" title="Crafted BIS">&lt;Crafted&gt;</span>;
  return <span className="council-bis-no">—</span>;
}

function BenchDot() {
  return <span className="council-bench-dot" title="Benched" />;
}

function CandidateRow({ c, isTierToken, itemSlot }) {
  return (
    <tr>
      <td className="council-col-char">
        {c.charName}{c.status === 'Bench' && <BenchDot />}
      </td>
      <td className="council-col-spec">{c.spec}</td>
      {isTierToken && (
        <td className="council-col-tier-slots">
          <TierPips tierSlots={c.tierSlots} activeSlot={itemSlot} />
        </td>
      )}
      <td className="council-col-stats">
        <span className="council-stat-bis">{c.bisH}/{c.bisM}</span>
      </td>
      <td className="council-col-stats">
        <span className="council-stat-nonbis">{c.nonBisH}/{c.nonBisM}</span>
      </td>
      <td className="council-col-stats" title="Account total across all characters">
        <span className="council-stat-bis">{c.acctBisH}/{c.acctBisM}</span>
      </td>
      <td className="council-col-stats" title="Account total across all characters">
        <span className="council-stat-nonbis">{c.acctNonBisH}/{c.acctNonBisM}</span>
      </td>
      <td className="council-col-num">{c.raidsAttended}</td>
      <td className="council-col-bis"><BisIndicator match={c.overallBisMatch} /></td>
      <td className="council-col-bis"><BisIndicator match={c.raidBisMatch} /></td>
    </tr>
  );
}

function CandidateTable({ itemId, showAll, onToggle }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!itemId) return;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(apiPath(`/api/council/candidates?itemId=${encodeURIComponent(itemId)}`), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setError('Failed to load candidates.'); setLoading(false); });
  }, [itemId]);

  useEffect(() => {
    if (data) window.$WowheadPower?.refreshLinks();
  }, [data]);

  if (loading) return <div className="loading">Loading candidates…</div>;
  if (error)   return <div className="error">{error}</div>;
  if (!data)   return null;

  const { item, candidates } = data;
  const filtered = showAll ? candidates : candidates.filter(c => c.raidBisMatch);
  const sorted   = sortCandidates(filtered);

  return (
    <div className="council-candidates">
      <div className="council-item-header">
        <a
          className="council-item-title"
          href={`https://www.wowhead.com/item=${item.itemId}`}
          target="_blank"
          rel="noreferrer"
        >{item.name}</a>
        <span className="council-item-subtitle">
          {itemMeta(item)}{item.difficulty ? ` · ${item.difficulty}` : ''}
        </span>
      </div>

      <div className="council-toggle-row">
        <button
          className={`council-toggle-btn${!showAll ? ' active' : ''}`}
          onClick={() => onToggle(false)}
        >
          Raid BIS only
        </button>
        <button
          className={`council-toggle-btn${showAll ? ' active' : ''}`}
          onClick={() => onToggle(true)}
        >
          Show all eligible
        </button>
        <span className="council-candidate-count">
          {sorted.length} candidate{sorted.length !== 1 ? 's' : ''}
        </span>
        <span className="council-legend">
          <span className="council-bench-dot" /> Benched
        </span>
      </div>

      {sorted.length === 0 ? (
        <p className="empty">
          {showAll
            ? 'No eligible active characters.'
            : <>No candidates with Raid BIS set.{' '}
                <button className="council-link-btn" onClick={() => onToggle(true)}>
                  Show all eligible
                </button>
              </>
          }
        </p>
      ) : (
        <div className="council-table-wrap">
          <table className="council-table">
            <thead>
              <tr>
                <th className="council-col-char">Character</th>
                <th className="council-col-spec">Spec</th>
                {item.isTierToken && <th className="council-col-tier-slots">Tier Owned</th>}
                <th className="council-col-stats" title="BIS drops (Heroic/Mythic)">BIS</th>
                <th className="council-col-stats" title="Non-BIS drops (Heroic/Mythic)">Non-BIS</th>
                <th className="council-col-stats" title="Account BIS drops (Heroic/Mythic)">Acct BIS</th>
                <th className="council-col-stats" title="Account Non-BIS drops (Heroic/Mythic)">Acct NB</th>
                <th className="council-col-num" title="Raids attended">Raids</th>
                <th className="council-col-bis">OvBIS</th>
                <th className="council-col-bis">RaidBIS</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(c => <CandidateRow key={c.charName} c={c} isTierToken={item.isTierToken} itemSlot={item.slot} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Council() {
  const [instances,        setInstances]        = useState([]);
  const [currentInstance,  setCurrentInstance]  = useState('');
  const [curioItemId,      setCurioItemId]      = useState('');
  const [loading,          setLoading]          = useState(true);
  const [error,            setError]            = useState(null);
  const [selectedBoss,     setSelectedBoss]     = useState(null);
  const [selectedItemId,   setSelectedItemId]   = useState(null);
  const [showAll,          setShowAll]          = useState(false);
  const [showCurio,        setShowCurio]        = useState(false);

  useEffect(() => {
    fetch(apiPath('/api/council/items'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => {
        setInstances(d.instances);
        setCurioItemId(d.curioItemId ?? '');
        const inst = d.instances.find(i => i.instance === d.currentInstance) ?? d.instances[0];
        setCurrentInstance(inst?.instance ?? '');
        if (inst?.bosses?.length) setSelectedBoss(inst.bosses[0].name);
        setLoading(false);
      })
      .catch(() => { setError('Failed to load item data.'); setLoading(false); });
  }, []);

  const handleBossSelect = useCallback((boss) => {
    setSelectedBoss(boss);
    setSelectedItemId(null);
    setShowAll(false);
    setShowCurio(false);
  }, []);

  const handleItemSelect = useCallback((itemId) => {
    setSelectedItemId(prev => String(prev) === String(itemId) ? null : itemId);
    setShowAll(false);
  }, []);

  const handleInstanceSelect = useCallback((instance) => {
    setCurrentInstance(instance);
    const inst = instances.find(i => i.instance === instance);
    const firstBoss = inst?.bosses[0]?.name ?? null;
    setSelectedBoss(firstBoss);
    setSelectedItemId(null);
    setShowAll(false);
    setShowCurio(false);
  }, [instances]);

  const handleCurioClick = useCallback(() => {
    setShowCurio(true);
    setSelectedItemId(null);
    setShowAll(false);
  }, []);

  if (loading) return <div className="loading">Loading loot data…</div>;
  if (error)   return <div className="error">{error}</div>;

  const currentInst = instances.find(i => i.instance === currentInstance);
  const bosses      = currentInst?.bosses ?? [];
  const bossItems   = bosses.find(b => b.name === selectedBoss)?.items ?? [];

  return (
    <div className="council-page">
      <h2 className="page-title">Loot Council</h2>

      <div className="council-top-row">
        {instances.length > 1 && (
          <div className="council-selector-row">
            <span className="council-selector-label">Raid</span>
            <div className="council-instance-tabs">
              {instances.map(inst => (
                <button
                  key={inst.instance}
                  className={`council-instance-tab${inst.instance === currentInstance && !showCurio ? ' active' : ''}`}
                  onClick={() => handleInstanceSelect(inst.instance)}
                >
                  {inst.instance}
                </button>
              ))}
            </div>
          </div>
        )}
        {curioItemId && (
          <button
            className={`council-curio-btn${showCurio ? ' active' : ''}`}
            onClick={handleCurioClick}
          >
            ✦ Curio
          </button>
        )}
      </div>

      {!showCurio ? (
        <>
          <div className="council-selector-row council-boss-selector-row">
            <BossSelector
              bosses={bosses}
              selectedBoss={selectedBoss}
              onSelect={handleBossSelect}
            />
          </div>

          <div className="council-split">
            <div className="card council-split-left">
              <ItemGrid
                items={bossItems}
                selectedItemId={selectedItemId}
                onSelect={handleItemSelect}
              />
            </div>

            <div className="council-split-right">
              {selectedItemId ? (
                <div className="card">
                  <CandidateTable
                    itemId={selectedItemId}
                    showAll={showAll}
                    onToggle={setShowAll}
                  />
                </div>
              ) : (
                <div className="council-split-empty">
                  <span>Select an item to see candidates</span>
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="card">
          <CurioCandidateTable curioItemId={curioItemId} />
        </div>
      )}
    </div>
  );
}
