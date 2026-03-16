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

function TierTag() {
  return <span className="council-tier-tag">Tier</span>;
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

// ── Curio candidate table ─────────────────────────────────────────────────────

const TIER_SLOT_SHORT = { Head: 'He', Shoulders: 'Sh', Chest: 'Ch', Hands: 'Ha', Legs: 'Le' };

function CurioCandidateRow({ c }) {
  return (
    <tr>
      <td className="council-col-char">{c.charName}</td>
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
                <th className="council-col-tier-slots">Tier Slots Needed</th>
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
    <div className="council-boss-row">
      {bosses.map(b => (
        <button
          key={b.name}
          className={`council-boss-btn${selectedBoss === b.name ? ' active' : ''}`}
          onClick={() => onSelect(b.name)}
        >
          {b.name}
        </button>
      ))}
    </div>
  );
}

function ItemGrid({ items, selectedItemId, onSelect }) {
  if (!items.length) return <p className="empty">No items for this boss.</p>;
  return (
    <div className="council-item-grid">
      {items.map(item => (
        <button
          key={item.itemId}
          className={`council-item-chip${String(item.itemId) === String(selectedItemId) ? ' active' : ''}`}
          onClick={() => onSelect(item.itemId)}
        >
          <span className="council-item-name">
            {item.name}{item.isTierToken && <TierTag />}
          </span>
          <span className="council-item-meta">{itemMeta(item)}</span>
        </button>
      ))}
    </div>
  );
}

function BisIndicator({ match }) {
  if (match === true)      return <span className="council-bis-yes" title="BIS match">✓</span>;
  if (match === 'crafted') return <span className="council-bis-crafted" title="Crafted BIS">&lt;Crafted&gt;</span>;
  return <span className="council-bis-no">—</span>;
}

function CandidateRow({ c }) {
  return (
    <tr>
      <td className="council-col-char">{c.charName}</td>
      <td className="council-col-spec">{c.spec}</td>
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
        >{item.name}{item.isTierToken && <TierTag />}</a>
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
                <th className="council-col-stats">BIS H/M</th>
                <th className="council-col-stats">Non-BIS H/M</th>
                <th className="council-col-stats" title="Account total across all characters">Acct BIS H/M</th>
                <th className="council-col-stats" title="Account total across all characters">Acct Non-BIS H/M</th>
                <th className="council-col-num">Raids</th>
                <th className="council-col-bis">Overall BIS</th>
                <th className="council-col-bis">Raid BIS</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(c => <CandidateRow key={c.charName} c={c} />)}
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
          <div className="card">
            <BossSelector
              bosses={bosses}
              selectedBoss={selectedBoss}
              onSelect={handleBossSelect}
            />
            <div className="council-boss-divider" />
            <ItemGrid
              items={bossItems}
              selectedItemId={selectedItemId}
              onSelect={handleItemSelect}
            />
          </div>

          {selectedItemId && (
            <div className="card">
              <CandidateTable
                itemId={selectedItemId}
                showAll={showAll}
                onToggle={setShowAll}
              />
            </div>
          )}
        </>
      ) : (
        <div className="card">
          <CurioCandidateTable curioItemId={curioItemId} />
        </div>
      )}
    </div>
  );
}
