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
import { createPortal } from 'react-dom';
import { useMe } from '../hooks/useMe.js';

// ── Item meta label ───────────────────────────────────────────────────────────

const ARMOR_TYPES = new Set(['Cloth', 'Leather', 'Mail', 'Plate']);

function itemMeta(item) {
  if (item.weaponType) return item.weaponType;
  if (ARMOR_TYPES.has(item.armorType)) return `${item.slot} · ${item.armorType}`;
  return item.slot;
}

// ── Scoring & tags ────────────────────────────────────────────────────────────

const TRACK_RANK       = { '': 0, Veteran: 1, Champion: 2, Hero: 3, Mythic: 4, Crafted: 5 };
const TRACK_BY_RANK    = ['', 'Veteran', 'Champion', 'Hero', 'Mythic', 'Crafted'];
const DIFFICULTY_TO_TRACK = { Normal: 'Champion', Heroic: 'Hero', Mythic: 'Mythic' };

const TIER_DIST_SCORES = {
  'four-first':  [1, 2, 3, 4, 0],
  'two-first':   [2, 4, 1, 3, 0],
  'bonus-first': [2, 3, 1, 4, 0],
  'even':        [4, 3, 2, 1, 0],
};

function getRelevantTrack(c) {
  const worn = c.wornBis ?? {};
  if (c.overallBisMatch) return worn.overallBISTrack ?? '';
  if (c.raidBisMatch)    return worn.raidBISTrack    ?? '';
  return worn.otherTrack ?? '';
}

function scoreCandidates(candidates, selectedDifficulty, tierDistPriority, heroicWeight, normalWeight, nonBisWeight, itemSlot) {
  const maxAttendance  = Math.max(...candidates.map(c => c.raidsAttended ?? 0), 1);
  const itemTrackRank  = TRACK_RANK[DIFFICULTY_TO_TRACK[selectedDifficulty] ?? 'Hero'];
  const tierScores     = TIER_DIST_SCORES[tierDistPriority] ?? TIER_DIST_SCORES['bonus-first'];

  return [...candidates].map(c => {
    const isTierToken  = c.tierSlots !== undefined;
    const tierCount    = isTierToken ? Object.keys(c.tierSlots).length : 0;
    // No tier dist benefit if the character already owns tier for this specific slot
    const alreadyHasSlot = isTierToken && itemSlot && c.tierSlots[itemSlot] !== undefined;
    const tierDistPts  = isTierToken && !alreadyHasSlot ? (tierScores[Math.min(tierCount, 4)] ?? 0) : 0;

    const wornS = c.wornBis ?? {};

    // For paired slots (Ring, Trinket), minOverallBISTrack is the STRICT MIN of overallBISTrack
    // across both slots. If it's >= itemTrackRank, every paired slot is already covered by the
    // character's Overall BIS item — a Raid BIS match for one slot is meaningless (Anzhem case).
    const minOvBISTrack = wornS.minOverallBISTrack ?? wornS.overallBISTrack ?? '';
    const slotAlreadySatisfied = c.overallBisMatch !== true
      && (TRACK_RANK[minOvBISTrack] ?? 0) >= itemTrackRank;

    const bisMatchPoints = c.overallBisMatch === true      ? 4
      : c.overallBisMatch === 'catalyst'                   ? 3
      : (c.raidBisMatch && !slotAlreadySatisfied)          ? 2
      : 0;

    // Use per-match-slot tracks here too — the aggregate from the other paired slot would
    // incorrectly inflate relevantTrackRank (e.g. Narestrasz has Hero in Trinket 2 but
    // the dropping item goes into Trinket 1 which may have nothing).
    const relevantTrackRank = Math.max(
      TRACK_RANK[wornS.ovMatchWornTrack   ?? wornS.overallBISTrack ?? ''] ?? 0,
      TRACK_RANK[wornS.raidMatchWornTrack ?? wornS.raidBISTrack    ?? ''] ?? 0,
      TRACK_RANK[wornS.otherTrack ?? ''] ?? 0,
    );
    const trackDelta = itemTrackRank - relevantTrackRank;

    const baseScore = tierDistPts * 10_000_000 + bisMatchPoints * 1_000_000 + trackDelta * 10_000;

    const A           = 0.5 + 0.5 * ((c.raidsAttended ?? 0) / maxAttendance);
    const weightedLoot = (c.acctBisM ?? 0)
      + (c.acctBisH    ?? 0) * heroicWeight
      + (c.acctBisN    ?? 0) * normalWeight
      + ((c.acctNonBisM ?? 0) + (c.acctNonBisH ?? 0) * heroicWeight + (c.acctNonBisN ?? 0) * normalWeight) * nonBisWeight;
    const lootPerRaid = weightedLoot / Math.max(c.raidsAttended ?? 1, 1);
    const L           = 1 / (1 + lootPerRaid);

    // Sink to bottom if: strict downgrade OR already owns their BIS item at or above this track
    // OR all paired slots are already covered by Overall BIS (slotAlreadySatisfied).
    // Uses aggregate wornBis (max across paired slots) — overallBISTrack is '' when they have
    // never worn the BIS item, so a non-BIS Hero item (otherTrack) does NOT trigger this
    // (Culveron case). Only fires when they have specifically worn their BIS at this track.
    // Use per-match-slot worn tracks (minimum across the specific slot(s) where the match was
    // found) rather than the aggregate MAX across all paired slots. This prevents the aggregate
    // raidBISTrack from Trinket 2 (a different item) from triggering a penalty on a Trinket 1
    // match (Simlock case), and correctly handles "has it in slot 1 but needs slot 2" (Narestrasz).
    // If overallBisMatch is set (true or 'catalyst'), only check overallBIS — raidBIS is irrelevant.
    const hasOverallMatch = c.overallBisMatch === true || c.overallBisMatch === 'catalyst';
    const alreadyOwnsBis =
      (hasOverallMatch  && (TRACK_RANK[wornS.ovMatchWornTrack   ?? ''] ?? 0) >= itemTrackRank) ||
      (!hasOverallMatch && c.raidBisMatch && (TRACK_RANK[wornS.raidMatchWornTrack ?? ''] ?? 0) >= itemTrackRank) ||
      slotAlreadySatisfied;
    const finalScore = (trackDelta < 0 && relevantTrackRank > 0) || alreadyOwnsBis
      ? -1_000_000_000
      : Math.round(baseScore * A * L * 1000);
    return {
      ...c,
      _score: finalScore,
      _tierCount: tierCount,
      _breakdown: {
        tierDistPts, bisMatchPoints, trackDelta,
        baseScore, A, L,
        lootPerRaid: Math.round(lootPerRaid * 100) / 100,
        finalScore, alreadyOwnsBis, slotAlreadySatisfied,
      },
    };
  }).sort((a, b) => b._score - a._score);
}

function scoreCurioCandidates(candidates, tierDistPriority, heroicWeight, normalWeight, nonBisWeight) {
  const maxAttendance = Math.max(...candidates.map(c => c.raidsAttended ?? 0), 1);
  const tierScores    = TIER_DIST_SCORES[tierDistPriority] ?? TIER_DIST_SCORES['bonus-first'];

  return [...candidates].map(c => {
    const tierCount  = Object.keys(c.tierSlots ?? {}).length;
    const tierDistPts = tierScores[Math.min(tierCount, 4)] ?? 0;

    const bisMatchPoints = c.overallBisMatch === true      ? 4
      : c.overallBisMatch === 'catalyst'                   ? 3
      : c.raidBisMatch                                     ? 2
      : 0;

    const baseScore = tierDistPts * 10_000_000 + bisMatchPoints * 1_000_000;

    const A           = 0.5 + 0.5 * ((c.raidsAttended ?? 0) / maxAttendance);
    const weightedLoot = (c.acctBisM ?? 0)
      + (c.acctBisH    ?? 0) * heroicWeight
      + (c.acctBisN    ?? 0) * normalWeight
      + ((c.acctNonBisM ?? 0) + (c.acctNonBisH ?? 0) * heroicWeight + (c.acctNonBisN ?? 0) * normalWeight) * nonBisWeight;
    const lootPerRaid = weightedLoot / Math.max(c.raidsAttended ?? 1, 1);
    const L           = 1 / (1 + lootPerRaid);

    const finalScore = Math.round(baseScore * A * L * 1000);
    return {
      ...c,
      _score:     finalScore,
      _tierCount: tierCount,
      _breakdown: { tierDistPts, bisMatchPoints, baseScore, A, L, lootPerRaid: Math.round(lootPerRaid * 100) / 100, finalScore },
    };
  }).sort((a, b) => b._score - a._score);
}

function getCurioTags(c) {
  const tags = [];
  tags.push(`Has ${c._tierCount} tier`);
  if (c.overallBisMatch === true)           tags.push('Overall BIS');
  else if (c.overallBisMatch === 'catalyst') tags.push('Catalyst');
  else if (c.raidBisMatch)                  tags.push('Raid BIS');
  else if (c.overallBisMatch === 'crafted')  tags.push('Crafted BIS');
  const wanted = c.tierSlotsWanted?.length ?? 0;
  if (wanted > 0) tags.push(`Wants ${wanted} slot${wanted !== 1 ? 's' : ''}`);
  return tags.slice(0, 3);
}

function getPriorityTags(c, selectedDifficulty) {
  const tags        = [];
  const isTierToken = c.tierSlots !== undefined;
  if (isTierToken) tags.push(`Has ${c._tierCount} tier`);

  if (c.overallBisMatch === true)          tags.push('Overall BIS');
  else if (c.overallBisMatch === 'catalyst') tags.push('Catalyst');
  else if (c.raidBisMatch)                 tags.push('Raid BIS');
  else if (c.overallBisMatch === 'crafted') tags.push('Crafted BIS');

  const itemTrackRank  = TRACK_RANK[DIFFICULTY_TO_TRACK[selectedDifficulty] ?? 'Hero'];
  const worn           = c.wornBis ?? {};
  // Use per-match-slot tracks (not aggregate) so the tag reflects the slot where this item
  // would actually go — not a different paired slot that happens to have a higher worn track.
  const currentBestRank = Math.max(
    TRACK_RANK[worn.ovMatchWornTrack   ?? worn.overallBISTrack ?? ''] ?? 0,
    TRACK_RANK[worn.raidMatchWornTrack ?? worn.raidBISTrack    ?? ''] ?? 0,
    TRACK_RANK[worn.otherTrack         ?? ''] ?? 0,
    1, // no data → assume Veteran baseline
  );
  const currentBestTrack = TRACK_BY_RANK[currentBestRank] ?? '';
  const trackDelta       = itemTrackRank - currentBestRank;
  if (trackDelta > 0)        tags.push(`+${trackDelta} track`);
  else if (currentBestTrack) tags.push(`Has ${currentBestTrack}`);

  return tags.slice(0, 3);
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

const TRACK_LETTER = { Crafted: 'Cr', Veteran: 'V', Champion: 'C', Hero: 'H', Mythic: 'M' };
const TRACK_CSS    = {
  Crafted:  'track-crafted',
  Veteran:  'track-veteran',
  Champion: 'track-champion',
  Hero:     'track-hero',
  Mythic:   'track-mythic',
};

function MiniTrackBadge({ track }) {
  if (!track || !TRACK_LETTER[track]) return null;
  return (
    <span className={`track-badge-mini ${TRACK_CSS[track]}`} title={track}>
      {TRACK_LETTER[track]}
    </span>
  );
}

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

function CurioCandidateRow({ c, tags, isOfficer }) {
  const [tooltipPos, setTooltipPos] = useState(null);
  return (
    <tr>
      <td className="council-col-char">
        <div
          className="council-char-cell"
          onMouseEnter={e => {
            if (!isOfficer) return;
            const r = e.currentTarget.getBoundingClientRect();
            const isBottomHalf = r.top > window.innerHeight / 2;
            setTooltipPos({ top: isBottomHalf ? r.top : r.bottom + 4, left: r.left, anchorBottom: isBottomHalf });
          }}
          onMouseLeave={() => setTooltipPos(null)}
        >
          <span>{c.charName}{c.status === 'Bench' && <BenchDot />}</span>
          {tags?.length > 0 && (
            <div className="council-priority-tags">
              {tags.map(t => (
                <span key={t} className={`council-ptag ptag-${t.toLowerCase().replace(/[+\s]+/g, '-').replace(/[^a-z0-9-]/g, '')}`}>{t}</span>
              ))}
            </div>
          )}
          {tooltipPos && c._breakdown && (
            <ScoreTooltip b={c._breakdown} isTierToken pos={tooltipPos} />
          )}
        </div>
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

function CurioCandidateTable({ curioItemId, tierDistributionPriority, heroicWeight, normalWeight, nonBisWeight }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const { user } = useMe();
  const isOfficer = !!user?.isOfficer;

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

  const scored = scoreCurioCandidates(data.candidates, tierDistributionPriority, heroicWeight, normalWeight, nonBisWeight);
  const candidates = scored;

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
              {candidates.map(c => <CurioCandidateRow key={c.charName} c={c} tags={getCurioTags(c)} isOfficer={isOfficer} />)}
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

function BisIndicator({ match, track }) {
  const badge = <MiniTrackBadge track={track} />;
  if (match === true)       return <span className="council-bis-yes" title="BIS match">✓{badge}</span>;
  if (match === 'crafted')  return <span className="council-bis-crafted" title="Crafted BIS">&lt;Crafted&gt;{badge}</span>;
  if (match === 'catalyst') return <span className="council-bis-catalyst" title="Catalyst BIS">&lt;Catalyst&gt;{badge}</span>;
  return <span className="council-bis-no">—{badge}</span>;
}

function BenchDot() {
  return <span className="council-bench-dot" title="Benched" />;
}

function ScoreTooltip({ b, isTierToken, pos }) {
  // pos.anchorBottom: tooltip grows upward from pos.top via translateY
  const style = {
    left: pos.left,
    top:  pos.top,
    transform: pos.anchorBottom ? 'translateY(calc(-100% - 4px))' : undefined,
  };
  return createPortal(
    <div className="council-score-tooltip" style={style}>
      <div className="cst-title">Score breakdown</div>
      {isTierToken && (
        <div className="cst-row"><span>Tier dist</span><span>{b.tierDistPts} × 10M = {(b.tierDistPts * 10_000_000).toLocaleString()}</span></div>
      )}
      {b.bisMatchPoints !== undefined && (
        <div className="cst-row"><span>BIS match</span><span>{b.bisMatchPoints} × 1M = {(b.bisMatchPoints * 1_000_000).toLocaleString()}</span></div>
      )}
      {b.trackDelta !== undefined && (
        <div className="cst-row"><span>Track delta</span><span>{b.trackDelta} × 10K = {(b.trackDelta * 10_000).toLocaleString()}</span></div>
      )}
      <div className="cst-row cst-sub"><span>Base score</span><span>{b.baseScore.toLocaleString()}</span></div>
      <div className="cst-divider" />
      <div className="cst-row"><span>Attendance</span><span>× {b.A.toFixed(2)}</span></div>
      <div className="cst-row"><span>Loot density</span><span>× {b.L.toFixed(3)} ({b.lootPerRaid.toFixed(2)}/raid)</span></div>
      {b.slotAlreadySatisfied && (
        <div className="cst-row cst-penalty"><span>Slots covered by Overall BIS</span><span>→ penalised</span></div>
      )}
      {b.alreadyOwnsBis && !b.slotAlreadySatisfied && (
        <div className="cst-row cst-penalty"><span>Already owns BIS</span><span>→ penalised</span></div>
      )}
      <div className="cst-row cst-final"><span>Final</span><span>{b.finalScore.toLocaleString()}</span></div>
    </div>,
    document.body
  );
}

function CandidateRow({ c, isTierToken, itemSlot, tags, isOfficer }) {
  const worn = c.wornBis ?? {};
  const [expanded,    setExpanded]    = useState(false);
  const [tooltipPos,  setTooltipPos]  = useState(null);
  const hasSecondary = c.secondarySpecCandidates?.length > 0;

  return (
    <>
      <tr className={expanded ? 'council-row-expanded-parent' : ''}>
        <td className="council-col-char">
          {hasSecondary && (
            <button
              className={`council-expand-btn${expanded ? ' expanded' : ''}`}
              onClick={() => setExpanded(e => !e)}
              title={expanded ? 'Collapse secondary specs' : 'Expand secondary specs'}
            >▶</button>
          )}
          <div
            className="council-char-cell"
            onMouseEnter={e => {
              if (!isOfficer) return;
              const r = e.currentTarget.getBoundingClientRect();
              const isBottomHalf = r.top > window.innerHeight / 2;
              setTooltipPos({
                top:          isBottomHalf ? r.top : r.bottom + 4,
                left:         r.left,
                anchorBottom: isBottomHalf,
              });
            }}
            onMouseLeave={() => setTooltipPos(null)}
          >
            <span>{c.charName}{c.status === 'Bench' && <BenchDot />}</span>
            {tags?.length > 0 && (
              <div className="council-priority-tags">
                {tags.map(t => (
                  <span
                    key={t}
                    className={`council-ptag ptag-${t.toLowerCase().replace(/[+\s]+/g, '-').replace(/[^a-z0-9-]/g, '')}`}
                  >{t}</span>
                ))}
              </div>
            )}
            {tooltipPos && c._breakdown && (
              <ScoreTooltip b={c._breakdown} isTierToken={isTierToken} pos={tooltipPos} />
            )}
          </div>
        </td>
        <td className="council-col-spec">{c.spec}</td>
        {isTierToken && (
          <td className="council-col-tier-slots">
            <TierPips tierSlots={c.tierSlots} activeSlot={itemSlot} />
          </td>
        )}
        <td className="council-col-stats"><span className="council-stat-bis">{c.bisH}/{c.bisM}</span></td>
        <td className="council-col-stats"><span className="council-stat-nonbis">{c.nonBisH}/{c.nonBisM}</span></td>
        <td className="council-col-stats" title="Account total"><span className="council-stat-bis">{c.acctBisH}/{c.acctBisM}</span></td>
        <td className="council-col-stats" title="Account total"><span className="council-stat-nonbis">{c.acctNonBisH}/{c.acctNonBisM}</span></td>
        <td className="council-col-num">{c.raidsAttended}</td>
        <td className="council-col-bis"><BisIndicator match={c.overallBisMatch} track={worn.ovMatchWornTrack ?? worn.overallBISTrack} /></td>
        <td className="council-col-bis"><BisIndicator match={c.raidBisMatch} track={worn.raidMatchWornTrack ?? worn.raidBISTrack} /></td>
        <td className="council-col-bis"><MiniTrackBadge track={worn.otherTrack} /></td>
      </tr>
      {expanded && c.secondarySpecCandidates?.map(sc => {
        const scWorn = sc.wornBis ?? {};
        return (
          <tr key={sc.spec} className="council-row-secondary">
            <td className="council-col-char council-secondary-indent">↳ {sc.spec}</td>
            <td className="council-col-spec" />
            {isTierToken && <td className="council-col-tier-slots" />}
            <td className="council-col-stats" colSpan={4} />
            <td className="council-col-num" />
            <td className="council-col-bis"><BisIndicator match={sc.overallBisMatch} track={scWorn.overallBISTrack} /></td>
            <td className="council-col-bis"><BisIndicator match={sc.raidBisMatch} track={scWorn.raidBISTrack} /></td>
            <td className="council-col-bis"><MiniTrackBadge track={scWorn.otherTrack} /></td>
          </tr>
        );
      })}
    </>
  );
}

function CandidateTable({ itemId, showAll, onToggle, selectedDifficulty, tierDistributionPriority, heroicWeight, normalWeight, nonBisWeight }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const { user } = useMe();
  const isOfficer = !!user?.isOfficer;

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
  const sorted   = scoreCandidates(filtered, selectedDifficulty, tierDistributionPriority, heroicWeight, normalWeight, nonBisWeight, item.slot);

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
          {itemMeta(item)}{selectedDifficulty ? ` · ${selectedDifficulty}` : ''}
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
                <th className="council-col-bis" title="Overall BIS match + worn track">OvBIS</th>
                <th className="council-col-bis" title="Raid BIS match + worn track">RaidBIS</th>
                <th className="council-col-bis" title="Best non-BIS track worn in this slot">Other</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(c => <CandidateRow key={c.charName} c={c} isTierToken={item.isTierToken} itemSlot={item.slot} tags={getPriorityTags(c, selectedDifficulty)} isOfficer={isOfficer} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Council() {
  const [instances,              setInstances]              = useState([]);
  const [currentInstance,        setCurrentInstance]        = useState('');
  const [curioItemId,            setCurioItemId]            = useState('');
  const [selectedDifficulty,     setSelectedDifficulty]     = useState('Mythic');
  const [tierDistributionPriority, setTierDistributionPriority] = useState('bonus-first');
  const [heroicWeight,           setHeroicWeight]           = useState(0.2);
  const [normalWeight,           setNormalWeight]           = useState(0);
  const [nonBisWeight,           setNonBisWeight]           = useState(0.333);
  const [loading,                setLoading]                = useState(true);
  const [error,                  setError]                  = useState(null);
  const [selectedBoss,           setSelectedBoss]           = useState(null);
  const [selectedItemId,         setSelectedItemId]         = useState(null);
  const [showAll,                setShowAll]                = useState(false);
  const [showCurio,              setShowCurio]              = useState(false);

  useEffect(() => {
    fetch(apiPath('/api/council/items'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => {
        setInstances(d.instances);
        setCurioItemId(d.curioItemId ?? '');
        setSelectedDifficulty(d.currentDifficulty || 'Mythic');
        setTierDistributionPriority(d.tierDistributionPriority || 'bonus-first');
        setHeroicWeight(typeof d.heroicWeight === 'number' ? d.heroicWeight : 0.2);
        setNormalWeight(typeof d.normalWeight === 'number' ? d.normalWeight : 0);
        setNonBisWeight(typeof d.nonBisWeight === 'number' ? d.nonBisWeight : 0.333);
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
        <div className="council-selector-row">
          <span className="council-selector-label">Difficulty</span>
          <div className="council-instance-tabs">
            {['Normal', 'Heroic', 'Mythic'].map(diff => (
              <button
                key={diff}
                className={`council-instance-tab${selectedDifficulty === diff ? ' active' : ''}`}
                onClick={() => setSelectedDifficulty(diff)}
              >{diff}</button>
            ))}
          </div>
        </div>
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
                    selectedDifficulty={selectedDifficulty}
                    tierDistributionPriority={tierDistributionPriority}
                    heroicWeight={heroicWeight}
                    normalWeight={normalWeight}
                    nonBisWeight={nonBisWeight}
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
          <CurioCandidateTable
            curioItemId={curioItemId}
            tierDistributionPriority={tierDistributionPriority}
            heroicWeight={heroicWeight}
            normalWeight={normalWeight}
            nonBisWeight={nonBisWeight}
          />
        </div>
      )}
    </div>
  );
}
