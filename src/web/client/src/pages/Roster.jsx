import { apiPath } from '../lib/api.js';
import { refreshMe } from '../hooks/useMe.js';
import { useState, useEffect, Fragment } from 'react';
import ItemLink from '../components/ItemLink.jsx';

const ALL_SLOTS = [
  'Head', 'Neck', 'Shoulders', 'Back', 'Chest', 'Wrists',
  'Hands', 'Waist', 'Legs', 'Feet',
  'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2', 'Weapon', 'Off-Hand',
];

const SENTINELS        = new Set(['<Tier>', '<Catalyst>', '<Crafted>']);
const DIFFICULTY_ORDER = ['Mythic', 'Heroic', 'Normal'];

const TRACK_CLASS = {
  Crafted:  'track-crafted',
  Veteran:  'track-veteran',
  Champion: 'track-champion',
  Hero:     'track-hero',
  Mythic:   'track-mythic',
};
const TRACK_ORDER = { Crafted: -1, Veteran: 0, Champion: 1, Hero: 2, Mythic: 3 };
function bestTrack(...tracks) {
  return tracks.reduce((best, t) =>
    t && (TRACK_ORDER[t] ?? -2) > (TRACK_ORDER[best] ?? -2) ? t : best
  , '');
}
function TrackBadge({ track }) {
  if (!track) return null;
  return <span className={`track-badge ${TRACK_CLASS[track] ?? ''}`}>{track}</span>;
}

const SLOT_GROUPS = [
  { label: 'Tier',        slots: ['Head', 'Shoulders', 'Chest', 'Hands', 'Legs'] },
  { label: 'Other Armor', slots: ['Wrists', 'Waist', 'Feet'] },
  { label: 'Accessories', slots: ['Neck', 'Back', 'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2'] },
  { label: 'Weapons',     slots: ['Weapon', 'Off-Hand'] },
];

const CLASS_SPECS = {
  'Death Knight':  ['Blood DK', 'Frost DK', 'Unholy DK'],
  'Demon Hunter':  ['Havoc DH', 'Vengeance DH', 'Devourer DH'],
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

const CLASS_COLORS = {
  'Death Knight': '#C41E3A',
  'Demon Hunter': '#A330C9',
  'Druid':        '#FF7C0A',
  'Evoker':       '#33937F',
  'Hunter':       '#AAD372',
  'Mage':         '#3FC7EB',
  'Monk':         '#00FF98',
  'Paladin':      '#F48CBA',
  'Priest':       '#FFFFFF',
  'Rogue':        '#FFF468',
  'Shaman':       '#0070DD',
  'Warlock':      '#8788EE',
  'Warrior':      '#C69B3A',
};

// Strip the class suffix from spec strings, e.g. "Blood DK" → "Blood", "Balance Druid" → "Balance"
const shortSpec = (spec) => spec ? spec.replace(/ \S+$/, '') : spec;

const TANK_SPECS   = new Set(['Blood DK', 'Vengeance DH', 'Guardian Druid', 'Brewmaster Monk', 'Prot Paladin', 'Prot Warrior']);
const HEALER_SPECS = new Set(['Resto Druid', 'Preservation Evoker', 'Mistweaver Monk', 'Holy Paladin', 'Disc Priest', 'Holy Priest', 'Resto Shaman']);
const RANGED_SPECS = new Set([
  'Balance Druid', 'Devastation Evoker', 'Augmentation Evoker',
  'Devourer DH',
  'BM Hunter', 'MM Hunter',
  'Arcane Mage', 'Fire Mage', 'Frost Mage',
  'Shadow Priest', 'Ele Shaman',
  'Affliction Lock', 'Demo Lock', 'Destro Lock',
]);
function displayRole(role, spec) {
  if (role && role !== 'DPS') return role;
  if (TANK_SPECS.has(spec))   return 'Tank';
  if (HEALER_SPECS.has(spec)) return 'Healer';
  if (RANGED_SPECS.has(spec)) return 'Ranged DPS';
  return 'Melee DPS';
}

const ROLE_ORDER = { 'Tank': 0, 'Healer': 1, 'Melee DPS': 2, 'Ranged DPS': 3 };
function sortByRoleThenClassThenName(chars) {
  return [...chars].sort((a, b) => {
    const ra = ROLE_ORDER[displayRole(a.role, a.spec)] ?? 99;
    const rb = ROLE_ORDER[displayRole(b.role, b.spec)] ?? 99;
    if (ra !== rb) return ra - rb;
    const classCompare = (a.class ?? '').localeCompare(b.class ?? '');
    if (classCompare !== 0) return classCompare;
    return a.charName.localeCompare(b.charName);
  });
}

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

// ── WoW NA/Oceania realm list ─────────────────────────────────────────────────
// Source: warcraft.wiki.gg/wiki/Americas_region_realm_list_by_datacenter
const WOW_NA_SERVERS = [
  'Aegwynn', 'Aerie Peak', 'Agamaggan', 'Aggramar', 'Akama', 'Alexstrasza', 'Alleria',
  'Altar of Storms', 'Alterac Mountains', 'Aman\'Thul', 'Andorhal', 'Anetheron',
  'Anub\'arak', 'Anvilmar', 'Antonidas', 'Arathor', 'Area 52', 'Archimonde', 'Argent Dawn',
  'Arthas', 'Arygos', 'Auchindoun', 'Azgalor', 'Azjol-Nerub', 'Azralon', 'Azshara',
  'Azuremyst', 'Baelgun', 'Balnazzar', 'Barthilas', 'Black Dragonflight', 'Blackhand',
  'Blackrock', 'Blackwater Raiders', 'Blackwing Lair', 'Blade\'s Edge', 'Bladefist',
  'Bleeding Hollow', 'Blood Furnace', 'Bloodhoof', 'Bloodscalp', 'Bonechewer',
  'Borean Tundra', 'Boulderfist', 'Bronzebeard', 'Burning Blade', 'Burning Legion',
  'Caelestrasz', 'Cairne', 'Cenarius', 'Cenarion Circle', 'Cho\'gall', 'Chromaggus',
  'Coilfang', 'Crushridge', 'Daggerspine', 'Dalaran', 'Dalvengyr', 'Dark Iron',
  'Darkspear', 'Darrowmere', 'Dath\'Remar', 'Dawnbringer', 'Deathwing', 'Demon Soul',
  'Dentarg', 'Destromath', 'Dethecus', 'Detheroc', 'Doomhammer', 'Draenor',
  'Dragonblight', 'Dragonmaw', 'Drak\'Tharon', 'Drak\'thul', 'Draka', 'Drenden',
  'Dreadmaul', 'Dunemaul', 'Durotan', 'Duskwood', 'Earth\'en Ring', 'Echo Isles',
  'Eitrigg', 'Eldre\'Thalas', 'Elune', 'Emerald Dream', 'Eonar', 'Eredar', 'Executus',
  'Exodar', 'Farstriders', 'Feathermoon', 'Fenris', 'Firetree', 'Fizzcrank',
  'Frostmane', 'Frostmourne', 'Frostwolf', 'Galakrond', 'Gallywix', 'Garithos',
  'Garona', 'Garrosh', 'Ghostlands', 'Gilneas', 'Gnomeregan', 'Goldrinn', 'Gorefiend',
  'Gorgonnash', 'Greymane', 'Grizzly Hills', 'Gul\'dan', 'Gundrak', 'Gurubashi',
  'Hakkar', 'Haomarush', 'Hellscream', 'Hydraxis', 'Hyjal', 'Icecrown', 'Illidan',
  'Jaedenar', 'Jubei\'Thos', 'Kael\'thas', 'Kalecgos', 'Kargath', 'Kel\'Thuzad',
  'Khaz Modan', 'Khaz\'goroth', 'Khadgar', 'Kil\'jaeden', 'Kilrogg', 'Kirin Tor',
  'Korgath', 'Korialstrasz', 'Kul Tiras', 'Laughing Skull', 'Lethon', 'Lightbringer',
  'Lightning\'s Blade', 'Lightninghoof', 'Llane', 'Lothar', 'Madoran', 'Maelstrom',
  'Maiev', 'Mal\'Ganis', 'Malorne', 'Malygos', 'Malfurion', 'Mannoroth', 'Medivh',
  'Misha', 'Mok\'Nathal', 'Moon Guard', 'Moonrunner', 'Mug\'thol', 'Muradin',
  'Nagrand', 'Nathrezim', 'Nazgrel', 'Nazjatar', 'Nemesis', 'Nesingwary',
  'Ner\'zhul', 'Nordrassil', 'Norgannon', 'Onyxia', 'Perenolde', 'Proudmoore',
  'Quel\'Thalas', 'Quel\'dorei', 'Ragnaros', 'Ravencrest', 'Ravenholdt', 'Rexxar',
  'Rivendare', 'Runetotem', 'Saurfang', 'Sargeras', 'Scarlet Crusade',
  'Scilla', 'Sen\'jin', 'Sentinels', 'Shadow Council', 'Shadowmoon', 'Shadowsong',
  'Shandris', 'Shattered Halls', 'Shattered Hand', 'Shu\'halo', 'Silver Hand',
  'Silvermoon', 'Sisters of Elune', 'Skullcrusher', 'Skywall', 'Smolderthorn',
  'Spinebreaker', 'Spirestone', 'Staghelm', 'Steamwheedle Cartel', 'Stonemaul',
  'Stormrage', 'Stormreaver', 'Stormscale', 'Suramar', 'Tanaris', 'Terenas',
  'Terokkar', 'Thaurissan', 'The Forgotten Coast', 'The Scryers', 'The Underbog',
  'The Venture Co', 'Thorium Brotherhood', 'Thrall', 'Thunderhorn', 'Thunderlord',
  'Tichondrius', 'Tol Barad', 'Tortheldrin', 'Trollbane', 'Turalyon', 'Twisting Nether',
  'Uldum', 'Uldaman', 'Undermine', 'Ursin', 'Uther', 'Vashj', 'Vek\'nilash',
  'Velen', 'Warsong', 'Whisperwind', 'Wildhammer', 'Windrunner', 'Winterhoof',
  'Wyrmrest Accord', 'Ysera', 'Ysondre', 'Zangarmarsh', 'Zul\'jin', 'Zuluhed',
].sort();

// Single shared datalist node — all WowServerSelect instances reference the same list.
// Rendered once at the bottom of the page tree by RosterPage.
const SERVER_DATALIST_ID = 'wow-server-list';
function WowServerDatalist() {
  return (
    <datalist id={SERVER_DATALIST_ID}>
      {WOW_NA_SERVERS.map(s => <option key={s} value={s} />)}
    </datalist>
  );
}

/**
 * Server name input with datalist autocomplete from the WoW NA realm list.
 * Falls back gracefully to free text for unlisted realms.
 */
function WowServerSelect({ value, onChange, autoFocus = false, placeholder = 'e.g. Area 52', disabled = false }) {
  const [focused, setFocused] = useState(false);
  const [draft,   setDraft]   = useState('');

  // When focused: show draft (starts empty so the full dropdown appears immediately).
  // When blurred: show the parent-controlled value.
  // This means the user always sees all options on click without having to delete first.
  const handleFocus = () => { setDraft(''); setFocused(true); };
  const handleBlur  = () => { setFocused(false); };
  const handleChange = (e) => { setDraft(e.target.value); onChange(e.target.value); };

  return (
    <input
      className="roster-player-input"
      list={disabled ? undefined : SERVER_DATALIST_ID}
      placeholder={focused && value ? value : placeholder}
      value={focused ? draft : value}
      autoFocus={autoFocus}
      disabled={disabled}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onChange={handleChange}
      style={disabled ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
    />
  );
}

// ── Shared sub-components ──────────────────────────────────────────────────────

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

function BisTable({ bis, specDefaults, loot, wornBis = {} }) {
  const personalBySlot = Object.fromEntries(bis.map(b => [b.slot, b]));
  const defaultBySlot  = Object.fromEntries(specDefaults.map(d => [d.slot, d]));

  const rows = ALL_SLOTS.flatMap(slot => {
    const personal = personalBySlot[slot];
    const def      = defaultBySlot[slot];
    const src      = personal ?? def;
    if (!src) return [];

    const overall    = src.trueBis        ?? '';
    const overallId  = src.trueBisItemId  ?? '';
    const raid       = src.raidBis        ?? '';
    const raidId     = src.raidBisItemId  ?? '';
    // Show "Personal" badge only in the column where the personal value differs from default.
    const isPersonalOverall = !!personal && overall !== (def?.trueBis ?? '');
    const isPersonalRaid    = !!personal && raid    !== (def?.raidBis ?? '');

    const worn = wornBis[slot] ?? {};
    const effectiveRaidTrack = worn.raidBISTrack ||
      (raid && overall && raid === overall ? worn.overallBISTrack : '');
    const displayWorn = { ...worn, raidBISTrack: effectiveRaidTrack };
    const maxed    = worn.overallBISTrack === 'Mythic';
    const slotBest = bestTrack(worn.overallBISTrack, worn.raidBISTrack, worn.otherTrack);

    return [{ slot, overall, overallId, raid, raidId, isPersonalOverall, isPersonalRaid, worn: displayWorn, maxed, slotBest }];
  });

  if (!rows.length) return <p className="empty">No BIS data available for this spec.</p>;

  return (
    <table className="bis-table">
      <thead>
        <tr>
          <th>Slot</th>
          <th>Overall BIS</th>
          <th>Raid BIS</th>
          <th className="bis-col-best">Best</th>
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
              {groupRows.map(({ slot, overall, overallId, raid, raidId, isPersonalOverall, isPersonalRaid, worn, maxed, slotBest }) => (
                <tr key={slot} className={maxed ? 'bis-row-received' : ''}>
                  <td className="bis-slot">{slot}</td>
                  <td>
                    <ItemLink
                      name={overall || '—'}
                      itemId={overallId}
                      className={SENTINELS.has(overall) ? 'bis-sentinel' : undefined}
                    />
                    {isPersonalOverall && <span className="badge badge-personal">Personal</span>}
                    <TrackBadge track={worn.overallBISTrack} />
                  </td>
                  <td>
                    <ItemLink
                      name={raid || '—'}
                      itemId={raidId}
                      className={SENTINELS.has(raid) ? 'bis-sentinel' : 'text-muted'}
                    />
                    {isPersonalRaid && <span className="badge badge-personal">Personal</span>}
                    <TrackBadge track={worn.raidBISTrack} />
                  </td>
                  <td className="bis-col-best"><TrackBadge track={slotBest} /></td>
                </tr>
              ))}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Account loot widget ────────────────────────────────────────────────────────

function AccountWidget({ accountChars, accountLoot, currentChar }) {
  const AWARD_TYPES = [
    { type: 'BIS',      label: 'B',    cls: 'loot-badge-bis'     },
    { type: 'Non-BIS',  label: 'NB',   cls: 'loot-badge-nonbis'  },
    { type: 'Tertiary', label: 'T',    cls: 'loot-badge-tertiary' },
    { type: 'Offspec',  label: 'OS',   cls: 'loot-badge-offspec'  },
  ];

  const byChar = Object.fromEntries(
    accountChars.map(char => [char, accountLoot.filter(e => e.recipientChar === char)])
  );

  const activeDiffs = DIFFICULTY_ORDER.filter(d =>
    accountLoot.some(e => e.difficulty === d)
  );

  const renderBadges = (loot) => (
    <div className="account-badge-cell">
      {AWARD_TYPES.map(({ type, label, cls }) => {
        const count = loot.filter(e => e.upgradeType === type).length;
        if (!count) return null;
        return (
          <span key={type} className={`loot-summary-badge ${cls}`}>
            <span className="loot-summary-badge-count">{count}</span>
            <span className="loot-summary-badge-label">{label}</span>
          </span>
        );
      })}
      {!loot.length && <span className="text-muted">—</span>}
    </div>
  );

  return (
    <div className="account-widget">
      <div className="account-widget-title">Account · {accountChars.join(' · ')}</div>
      <table className="account-loot-table">
        <thead>
          <tr>
            <th>Character</th>
            {activeDiffs.map(d => <th key={d}>{d}</th>)}
          </tr>
        </thead>
        <tbody>
          {accountChars.map(char => (
            <tr key={char} className={char === currentChar ? 'account-row-current' : ''}>
              <td className="account-char-name">{char}</td>
              {activeDiffs.map(d => (
                <td key={d}>
                  {renderBadges(byChar[char].filter(e => e.difficulty === d))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="account-row-total">
            <td>Total</td>
            {activeDiffs.map(d => (
              <td key={d}>
                {renderBadges(accountLoot.filter(e => e.difficulty === d))}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Character detail panel ─────────────────────────────────────────────────────

function CharacterDetail({ charId, charName, onClose }) {
  const [data,         setData]         = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [activeSpec,   setActiveSpec]   = useState(null);
  const [specBusy,     setSpecBusy]     = useState(false);
  const [specMsg,      setSpecMsg]      = useState(null);
  const [showAddSpec,  setShowAddSpec]  = useState(false);
  const [addSpecValue, setAddSpecValue] = useState('');

  const reload = () => {
    setLoading(true);
    setError(null);
    fetch(apiPath(`/api/roster/${charId}`), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { setData(d); setActiveSpec(s => s ?? d.spec); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  };

  useEffect(() => { reload(); }, [charId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (data) window.$WowheadPower?.refreshLinks(); }, [data]);

  const handleSecondarySpecRemove = async (specToRemove) => {
    if (!data) return;
    setSpecBusy(true); setSpecMsg(null);
    const newList = (data.secondarySpecs ?? []).filter(s => s !== specToRemove);
    try {
      const res = await fetch(apiPath(`/api/roster/${charId}/secondary-specs`), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specs: newList }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.status);
      reload();
    } catch (err) { setSpecMsg(`Error: ${err.message}`); }
    finally { setSpecBusy(false); }
  };

  const handleSecondarySpecAdd = async () => {
    if (!data || !addSpecValue) return;
    setSpecBusy(true); setSpecMsg(null);
    const newList = [...new Set([...(data.secondarySpecs ?? []), addSpecValue])];
    try {
      const res = await fetch(apiPath(`/api/roster/${charId}/secondary-specs`), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specs: newList }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.status);
      setShowAddSpec(false); setAddSpecValue('');
      reload();
    } catch (err) { setSpecMsg(`Error: ${err.message}`); }
    finally { setSpecBusy(false); }
  };

  const handleSpecChange = async (approve) => {
    if (!data) return;
    setSpecBusy(true); setSpecMsg(null);
    try {
      const res = await fetch(apiPath(`/api/roster/${charId}/spec-change`), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.status);
      reload();
    } catch (err) { setSpecMsg(`Error: ${err.message}`); }
    finally { setSpecBusy(false); }
  };

  const allSpecs        = data ? [data.spec, ...(data.secondarySpecs ?? [])] : [];
  const addableSpecs    = data ? (CLASS_SPECS[data.class] ?? []).filter(s => !allSpecs.includes(s)) : [];
  const bisForSpec      = activeSpec && data?.bisBySpec ? (data.bisBySpec[activeSpec] ?? data.bis) : data?.bis;
  const defaultsForSpec = activeSpec && data?.defaultsBySpec ? (data.defaultsBySpec[activeSpec] ?? data.specDefaults) : data?.specDefaults;

  return (
    <div className="roster-detail">
      <div className="roster-detail-header">
        <div className="roster-detail-identity">
          {loading
            ? <span className="roster-detail-name">{charName}</span>
            : data && (
              <>
                <span className="roster-detail-name">{charName || data.charName}</span>
                <span className="roster-detail-spec">{data.spec} (primary)</span>
                {(data.secondarySpecs ?? []).map(s => (
                  <span key={s} className="roster-detail-spec roster-detail-spec-secondary">
                    {s}
                    <button className="spec-remove-btn" title="Remove secondary spec" disabled={specBusy}
                      onClick={() => handleSecondarySpecRemove(s)}>✕</button>
                  </span>
                ))}
                {addableSpecs.length > 0 && !showAddSpec && (
                  <button className="btn-secondary spec-add-btn" disabled={specBusy}
                    onClick={() => setShowAddSpec(true)}>+ Add Spec</button>
                )}
                {showAddSpec && (
                  <span className="spec-add-inline">
                    <select value={addSpecValue} onChange={e => setAddSpecValue(e.target.value)}>
                      <option value="">Select spec…</option>
                      {addableSpecs.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <button className="btn-primary" disabled={!addSpecValue || specBusy} onClick={handleSecondarySpecAdd}>Add</button>
                    <button className="btn-secondary" onClick={() => { setShowAddSpec(false); setAddSpecValue(''); }}>Cancel</button>
                  </span>
                )}
                <span className={`badge ${STATUS_BADGE[data.status] ?? ''}`}>{data.status}</span>
                {data.ownerNick && <span className="roster-detail-owner">@{data.ownerNick}</span>}
              </>
            )
          }
        </div>
        <button className="roster-detail-close" onClick={onClose} title="Close">✕</button>
      </div>

      {data?.pendingPrimarySpec && (
        <div className="spec-change-pending-banner">
          Spec change pending: → <strong>{data.pendingPrimarySpec}</strong>
          <button className="btn-approve btn-sm" disabled={specBusy} onClick={() => handleSpecChange(true)}>Approve</button>
          <button className="btn-reject  btn-sm" disabled={specBusy} onClick={() => handleSpecChange(false)}>Reject</button>
        </div>
      )}

      {specMsg && <div className="error" style={{margin:'4px 0'}}>{specMsg}</div>}

      {loading && <div className="loading">Loading…</div>}
      {error   && <div className="error">Failed to load character data.</div>}

      {data && (
        <>
          <section className="card">
            <h3 className="card-title">BIS Status</h3>
            {allSpecs.length > 1 && (
              <div className="spec-tabs" style={{marginBottom:12}}>
                {allSpecs.map(s => (
                  <button key={s}
                    className={`spec-tab${s === activeSpec ? ' spec-tab-active' : ''}`}
                    onClick={() => setActiveSpec(s)}>
                    {s}{s === data.spec ? ' ★' : ''}
                  </button>
                ))}
              </div>
            )}
            <BisTable bis={bisForSpec} specDefaults={defaultsForSpec} loot={data.loot} wornBis={(data.wornBisBySpec ?? {})[activeSpec] ?? {}} />
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

function AddCharForm({ roster, onSave, onCancel }) {
  const [charName,  setCharName]  = useState('');
  const [cls,       setCls]       = useState('');
  const [spec,      setSpec]      = useState('');
  const [status,    setStatus]    = useState('Active');
  const [ownerId,   setOwnerId]   = useState('');
  const [ownerNick, setOwnerNick] = useState('');
  const [nickAutoFilled, setNickAutoFilled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState(null);

  // Server conflict resolution state
  const [conflictData,    setConflictData]    = useState(null); // { existingCharId, existingCharName }
  const [newServer,       setNewServer]       = useState('');
  const [existingServer,  setExistingServer]  = useState('');

  const specs = cls ? (CLASS_SPECS[cls] ?? []) : [];

  const handleClassChange = (e) => {
    setCls(e.target.value);
    setSpec('');
  };

  const handleCharNameChange = (e) => {
    const val = e.target.value;
    setCharName(val);
    // Default ownerNick to charName only if it hasn't been manually set or auto-filled
    if (!nickAutoFilled && !ownerNick) setOwnerNick(val);
    else if (!nickAutoFilled && ownerNick === charName) setOwnerNick(val);
  };

  const handleOwnerIdChange = (e) => {
    const val = e.target.value;
    setOwnerId(val);
    // Auto-fill ownerNick from existing roster match
    const match = roster?.find(c => c.ownerId === val.trim());
    if (match?.ownerNick) {
      setOwnerNick(match.ownerNick);
      setNickAutoFilled(true);
    } else if (nickAutoFilled) {
      // Clear auto-fill if ID no longer matches
      setOwnerNick(charName || '');
      setNickAutoFilled(false);
    }
  };

  const handleOwnerNickChange = (e) => {
    setOwnerNick(e.target.value);
    setNickAutoFilled(false);
  };

  const doSubmit = async ({ server = '', resolveConflictCharId = '', resolveConflictServer = '' } = {}) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(apiPath('/api/roster'), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({
          charName: charName.trim(), class: cls, spec, status,
          ownerId:   ownerId.trim()   || '',
          ownerNick: ownerNick.trim() || '',
          server,
          resolveConflictCharId,
          resolveConflictServer,
        }),
      });
      const body = await res.json();
      if (res.status === 409 && body.conflict) {
        // Name collision — prompt for server names
        setConflictData({
          existingCharId:      body.existingCharId,
          existingCharName:    body.existingCharName,
          existingServerLocked: !!body.existingServer,
        });
        setNewServer('');
        setExistingServer(body.existingServer ?? '');
        setSaving(false);
        return;
      }
      if (!res.ok) throw new Error(body.error ?? res.status);
      onSave(body);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!charName.trim() || !cls || !spec) return;
    await doSubmit();
  };

  const handleResolveConflict = async () => {
    if (!newServer.trim() || !existingServer.trim()) return;
    await doSubmit({
      server:               newServer.trim(),
      resolveConflictCharId: conflictData.existingCharId,
      resolveConflictServer: existingServer.trim(),
    });
    setConflictData(null);
  };

  if (conflictData) {
    return (
      <div className="add-char-form card">
        <h3 className="card-title">Resolve Name Conflict</h3>
        <p className="modal-body" style={{ marginBottom: 12 }}>
          A character named <strong>{charName.trim()}</strong> already exists on this roster.
          Enter a server name for each to tell them apart.
        </p>
        <div className="add-char-fields" style={{ flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Server for existing <strong>{conflictData.existingCharName}</strong>
          </label>
          <WowServerSelect
            value={existingServer}
            onChange={setExistingServer}
            autoFocus={!conflictData.existingServerLocked}
            disabled={conflictData.existingServerLocked}
          />
          <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: 4 }}>
            Server for new <strong>{charName.trim()}</strong>
          </label>
          <WowServerSelect
            value={newServer}
            onChange={setNewServer}
            autoFocus={conflictData.existingServerLocked}
          />
        </div>
        {error && <div className="error" style={{ marginTop: '8px' }}>{error}</div>}
        <div className="add-char-actions">
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={saving || !newServer.trim() || !existingServer.trim()}
            onClick={handleResolveConflict}
          >
            {saving ? 'Saving…' : 'Resolve & Add'}
          </button>
          <button type="button" className="btn-sm" onClick={() => setConflictData(null)}>Back</button>
          <button type="button" className="btn-sm" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <form className="add-char-form card" onSubmit={handleSubmit}>
      <h3 className="card-title">Add Character</h3>
      <div className="add-char-fields">
        <input
          className="roster-player-input"
          placeholder="Character name"
          value={charName}
          autoFocus
          onChange={handleCharNameChange}
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
      <div className="add-char-fields" style={{ marginTop: 8 }}>
        <input
          className="roster-player-input"
          placeholder="Discord ID (optional)"
          value={ownerId}
          onChange={handleOwnerIdChange}
          onKeyDown={e => e.key === 'Escape' && onCancel()}
        />
        <input
          className="roster-player-input"
          placeholder="Player name (optional)"
          value={ownerNick}
          onChange={handleOwnerNickChange}
          onKeyDown={e => e.key === 'Escape' && onCancel()}
        />
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
  const [expandedGroups, setExpandedGroups] = useState(new Set(['Active']));
  const [toggling, setToggling]             = useState(null); // charName being status-toggled
  const [copiedChar, setCopiedChar]         = useState(null); // charName whose Discord ID was just copied
  const [editingOwnerChar, setEditingOwnerChar]     = useState(null); // charName whose player name is being edited
  const [editingOwnerCharId, setEditingOwnerCharId] = useState(null); // charId of the char being edited
  const [editOwnerValue, setEditOwnerValue]         = useState('');
  const [linkingOwnerChar, setLinkingOwnerChar]     = useState(null); // charName being linked to a Discord ID
  const [linkingOwnerCharId, setLinkingOwnerCharId] = useState(null); // charId being linked
  const [linkOwnerIdValue, setLinkOwnerIdValue]     = useState('');
  const [linkOwnerNickValue, setLinkOwnerNickValue] = useState('');
  const [deleteConfirmChar, setDeleteConfirmChar]   = useState(null); // charName pending delete confirmation
  const [deleteConfirmCharId, setDeleteConfirmCharId] = useState(null); // charId pending delete confirmation
  const [deleting, setDeleting]                   = useState(null); // charName being deleted
  const [renamingChar,   setRenamingChar]   = useState(null); // charName being renamed (display only)
  const [renamingCharId, setRenamingCharId] = useState(null); // charId being renamed (for API)
  const [renameValue,    setRenameValue]    = useState('');
  const [renameConflict, setRenameConflict]       = useState(null); // { charName, newName, existingCharId, existingCharName }
  const [renameConflictNewServer,      setRenameConflictNewServer]      = useState('');
  const [renameConflictExistingServer, setRenameConflictExistingServer] = useState('');
  const [renameServerValue, setRenameServerValue] = useState('');
  const [renameSaving, setRenameSaving]           = useState(false);
  const [renameError,  setRenameError]            = useState(null);

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

  const handleRowClick = (charId) => {
    setSelectedChar(prev => prev === charId ? null : charId);
  };

  const handleEditOwner = (e, char) => {
    e.stopPropagation();
    setEditingOwnerChar(char.charName);
    setEditingOwnerCharId(char.charId);
    setEditOwnerValue(char.ownerNick || '');
  };

  const handleSaveOwnerNick = async () => {
    if (!editingOwnerChar) return;
    const trimmed     = editOwnerValue.trim();
    const char        = roster.find(c => c.charId === editingOwnerCharId);
    const ownerId     = char?.ownerId;
    const originalNick = char?.ownerNick;
    setEditingOwnerChar(null);
    setEditingOwnerCharId(null);
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
    const charId   = linkingOwnerCharId;
    const ownerId  = linkOwnerIdValue.trim();
    const nick     = linkOwnerNickValue.trim();
    setLinkingOwnerChar(null);
    setLinkingOwnerCharId(null);
    if (!charName || !ownerId) return;

    // Optimistic update — match by charId so same-named chars aren't both updated
    setRoster(prev => prev.map(c =>
      c.charId === charId ? { ...c, ownerId, ownerNick: nick } : c
    ));

    try {
      const res = await fetch(apiPath(`/api/roster/${charId}/owner`), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ ownerId, ownerNick: nick }),
      });
      if (!res.ok) throw new Error(res.status);
    } catch {
      // Roll back
      setRoster(prev => prev.map(c =>
        c.charId === charId ? { ...c, ownerId: '', ownerNick: '' } : c
      ));
    }
  };

  const handleClearOwner = async (e, char) => {
    e.stopPropagation();
    const { ownerId, ownerNick, charId } = char;

    // Optimistic update — match by charId so same-named chars aren't both updated
    setRoster(prev => prev.map(c =>
      c.charId === charId ? { ...c, ownerId: '', ownerNick: '' } : c
    ));

    try {
      const res = await fetch(apiPath(`/api/roster/${char.charId}/owner`), {
        method:  'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(res.status);
    } catch {
      // Roll back
      setRoster(prev => prev.map(c =>
        c.charId === charId ? { ...c, ownerId, ownerNick } : c
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

  const handleSetStatus = async (e, char, newStatus) => {
    e.stopPropagation();
    setToggling(char.charName);

    // Optimistic update — match by charId so same-named chars aren't both updated
    setRoster(prev => prev.map(c =>
      c.charId === char.charId ? { ...c, status: newStatus } : c
    ));

    try {
      const res = await fetch(apiPath(`/api/roster/${char.charId}/status`), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error(res.status);
    } catch {
      // Roll back on failure
      setRoster(prev => prev.map(c =>
        c.charId === char.charId ? { ...c, status: char.status } : c
      ));
    } finally {
      setToggling(null);
    }
  };

  const doRename = async (charId, newName, { server = '', resolveConflictCharId = '', resolveConflictServer = '' } = {}) => {
    setRenameSaving(true);
    setRenameError(null);
    try {
      const res = await fetch(apiPath(`/api/roster/${charId}/rename`), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ newName, server, resolveConflictCharId, resolveConflictServer }),
      });
      const body = await res.json();
      if (res.status === 409 && body.conflict) {
        setRenameConflict({
          charId,
          newName,
          existingCharId:      body.existingCharId,
          existingCharName:    body.existingCharName,
          existingServerLocked: !!body.existingServer,
          targetServerLocked:   !!body.targetServer,
        });
        setRenameConflictNewServer(body.targetServer ?? '');
        setRenameConflictExistingServer(body.existingServer ?? '');
        setRenameSaving(false);
        setRenamingChar(null);
        setRenamingCharId(null);
        return;
      }
      if (!res.ok) {
        setRenameError(body.error ?? 'Rename failed');
        setRenameSaving(false);
        return;
      }
      // Update roster in state — charId is stable across rename
      setRoster(prev => prev.map(c =>
        c.charId === body.charId ? { ...c, charName: newName, server: server.trim() } : c
      ));
      // Refresh session user so dashboard tabs reflect the new name immediately
      refreshMe();
      setRenamingChar(null);
      setRenamingCharId(null);
      setRenameValue('');
      setRenameServerValue('');
    } catch {
      setRenameError('Rename failed');
      setRenameSaving(false);
    } finally {
      setRenameSaving(false);
    }
  };

  const handleStartRename = (e, char) => {
    e.stopPropagation();
    setRenamingChar(char.charName);
    setRenamingCharId(char.charId);
    setRenameValue(char.charName);
    setRenameServerValue(char.server ?? '');
    setRenameError(null);
  };

  const handleSaveRenameModal = async () => {
    const newName = renameValue.trim();
    if (!newName || !renamingCharId) { setRenamingChar(null); setRenamingCharId(null); return; }
    await doRename(renamingCharId, newName, { server: renameServerValue });
  };

  const handleResolveRenameConflict = async () => {
    if (!renameConflictNewServer.trim() || !renameConflictExistingServer.trim()) return;
    const { charId, newName, existingCharId } = renameConflict;
    setRenameConflict(null);
    await doRename(charId, newName, {
      server:               renameConflictNewServer.trim(),
      resolveConflictCharId: existingCharId,
      resolveConflictServer: renameConflictExistingServer.trim(),
    });
  };

  const handleDeleteChar = async (charName, charId) => {
    setDeleting(charName);
    try {
      const res = await fetch(apiPath(`/api/roster/${charId}`), {
        method:  'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(res.status);
      setRoster(prev => prev.filter(c => c.charId !== charId));
      if (selectedChar === charId) setSelectedChar(null);
    } catch {
      // leave roster unchanged on failure
    } finally {
      setDeleting(null);
      setDeleteConfirmChar(null);
      setDeleteConfirmCharId(null);
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
          roster={roster}
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

      {[
        { status: 'Active',   dot: 'dot-active',   label: 'Active',   chars: roster.filter(c => c.status === 'Active')   },
        { status: 'Bench',    dot: 'dot-bench',     label: 'Bench',    chars: roster.filter(c => c.status === 'Bench')    },
        { status: 'Inactive', dot: 'dot-inactive',  label: 'Inactive', chars: roster.filter(c => c.status === 'Inactive') },
      ].filter(g => g.chars.length > 0).map(group => {
        const isExpanded = expandedGroups.has(group.status);
        const toggle = () => setExpandedGroups(prev => {
          const next = new Set(prev);
          next.has(group.status) ? next.delete(group.status) : next.add(group.status);
          return next;
        });
        return (
          <section key={group.status} className="roster-group">
            <div className="roster-group-header" onClick={toggle}>
              <span className="roster-group-chevron">{isExpanded ? '▾' : '▸'}</span>
              <span className={`roster-count-dot ${group.dot}`} />
              <span className="roster-group-label">{group.label}</span>
              <span className="roster-group-count">{group.chars.length}</span>
            </div>
            {isExpanded && (
              <table className="roster-table">
                <thead>
                  <tr>
                    <th>Character</th>
                    <th>Class</th>
                    <th>Spec</th>
                    <th>Role</th>
                    <th>Player</th>
                    <th></th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortByRoleThenClassThenName(group.chars).flatMap((char, i, arr) => {
                    const role = displayRole(char.role, char.spec);
                    const prevRole = i > 0 ? displayRole(arr[i - 1].role, arr[i - 1].spec) : null;
                    const sep = i > 0 && role !== prevRole
                      ? [<tr key={`sep-${role}`} className="roster-role-sep"><td colSpan={7} /></tr>]
                      : [];
                    const row = (
              <tr
                key={char.charId}
                className={[
                  'roster-row',
                  selectedChar === char.charId ? 'roster-row-selected' : '',
                  char.status === 'Inactive'   ? 'roster-row-inactive' : '',
                  char.status === 'Bench'      ? 'roster-row-bench'    : '',
                ].filter(Boolean).join(' ')}
                onClick={() => handleRowClick(char.charId)}
              >
                <td className="roster-col-name" onClick={e => e.stopPropagation()}>
                  <span className="roster-char-name-cell">
                    <span
                      className="roster-char-name"
                      onClick={() => handleRowClick(char.charId)}
                      style={{ cursor: 'pointer' }}
                    >
                      {char.charName}
                      {char.server && <span className="roster-server-tag">{char.server}</span>}
                    </span>
                    <button
                      className="roster-edit-btn"
                      title="Rename / edit server"
                      onClick={e => handleStartRename(e, char)}
                    >✎</button>
                  </span>
                </td>
                <td style={{ color: CLASS_COLORS[char.class] ?? 'inherit', fontWeight: CLASS_COLORS[char.class] ? 500 : undefined }}>{char.class || '—'}</td>
                <td>{shortSpec(char.spec)}</td>
                <td className="text-muted">{displayRole(char.role, char.spec)}</td>
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
                          setLinkingOwnerCharId(char.charId);
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
                  {char.status === 'Active' && (
                    <>
                      <button
                        className="roster-status-btn roster-status-btn-bench"
                        onClick={e => handleSetStatus(e, char, 'Bench')}
                        disabled={toggling === char.charName}
                      >
                        {toggling === char.charName ? '…' : 'Bench'}
                      </button>
                      <button
                        className="roster-status-btn roster-status-btn-deactivate"
                        onClick={e => handleSetStatus(e, char, 'Inactive')}
                        disabled={toggling === char.charName}
                      >
                        Deactivate
                      </button>
                    </>
                  )}
                  {char.status === 'Bench' && (
                    <>
                      <button
                        className="roster-status-btn roster-status-btn-activate"
                        onClick={e => handleSetStatus(e, char, 'Active')}
                        disabled={toggling === char.charName}
                      >
                        {toggling === char.charName ? '…' : 'Promote'}
                      </button>
                      <button
                        className="roster-status-btn roster-status-btn-deactivate"
                        onClick={e => handleSetStatus(e, char, 'Inactive')}
                        disabled={toggling === char.charName}
                      >
                        Deactivate
                      </button>
                    </>
                  )}
                  {char.status === 'Inactive' && (
                    <>
                      <button
                        className="roster-status-btn roster-status-btn-activate"
                        onClick={e => handleSetStatus(e, char, 'Active')}
                        disabled={toggling === char.charName}
                      >
                        {toggling === char.charName ? '…' : 'Activate'}
                      </button>
                      <button
                        className="roster-status-btn roster-status-btn-bench"
                        onClick={e => handleSetStatus(e, char, 'Bench')}
                        disabled={toggling === char.charName}
                      >
                        Bench
                      </button>
                    </>
                  )}
                </td>
                <td className="roster-col-delete" onClick={e => e.stopPropagation()}>
                  <button
                    className="roster-delete-btn"
                    title="Delete character"
                    onClick={e => { e.stopPropagation(); setDeleteConfirmChar(char.charName); setDeleteConfirmCharId(char.charId); }}
                  >✕</button>
                </td>
              </tr>
                    );
                    return [...sep, row];
                  })}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      {selectedChar && (
        <CharacterDetail
          key={selectedChar}
          charId={selectedChar}
          charName={roster?.find(c => c.charId === selectedChar)?.charName ?? ''}
          onClose={() => setSelectedChar(null)}
        />
      )}

      {deleteConfirmChar && (
        <div className="modal-backdrop" onClick={() => { setDeleteConfirmChar(null); setDeleteConfirmCharId(null); }}>
          <div className="modal-dialog" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Delete Character</h3>
            <p className="modal-body">
              Permanently remove <strong>{deleteConfirmChar}</strong> from the roster?
              This cannot be undone. All BIS submissions and loot history for this
              character will remain in the sheet but the character will no longer
              appear in the app.
            </p>
            <div className="modal-actions">
              <button
                className="btn-danger"
                onClick={() => handleDeleteChar(deleteConfirmChar, deleteConfirmCharId)}
                disabled={deleting === deleteConfirmChar}
              >
                {deleting === deleteConfirmChar ? 'Deleting…' : 'Delete'}
              </button>
              <button className="btn-secondary" onClick={() => { setDeleteConfirmChar(null); setDeleteConfirmCharId(null); }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <WowServerDatalist />

      {renamingChar && (
        <div className="modal-backdrop" onClick={() => { setRenamingChar(null); setRenameError(null); }}>
          <div className="modal-dialog" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Edit Character</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0' }}>
              <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Character name</label>
              <input
                className="roster-player-input"
                value={renameValue}
                autoFocus
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter')  { e.preventDefault(); handleSaveRenameModal(); }
                  if (e.key === 'Escape') { setRenamingChar(null); setRenameError(null); }
                }}
                disabled={renameSaving}
              />
              <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: 4 }}>
                Server <span style={{ fontWeight: 400 }}>(optional — clear to remove)</span>
              </label>
              <WowServerSelect
                value={renameServerValue}
                onChange={setRenameServerValue}
              />
            </div>
            {renameError && <div className="error" style={{ marginBottom: 8 }}>{renameError}</div>}
            <div className="modal-actions">
              <button
                className="btn-primary"
                onClick={handleSaveRenameModal}
                disabled={renameSaving || !renameValue.trim()}
              >
                {renameSaving ? 'Saving…' : 'Save'}
              </button>
              <button className="btn-secondary" onClick={() => { setRenamingChar(null); setRenameError(null); }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {renameConflict && (
        <div className="modal-backdrop" onClick={() => setRenameConflict(null)}>
          <div className="modal-dialog" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Resolve Name Conflict</h3>
            <p className="modal-body">
              A character named <strong>{renameConflict.newName}</strong> already exists on this roster.
              Enter a server name for each to tell them apart.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0' }}>
              <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Server for existing <strong>{renameConflict.existingCharName}</strong>
              </label>
              <WowServerSelect
                value={renameConflictExistingServer}
                onChange={setRenameConflictExistingServer}
                autoFocus={!renameConflict.existingServerLocked}
                disabled={renameConflict.existingServerLocked}
              />
              <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: 4 }}>
                Server for <strong>{renameConflict.charName}</strong> (being renamed)
              </label>
              <WowServerSelect
                value={renameConflictNewServer}
                onChange={setRenameConflictNewServer}
                autoFocus={renameConflict.existingServerLocked && !renameConflict.targetServerLocked}
                disabled={renameConflict.targetServerLocked}
              />
            </div>
            {renameError && <div className="error" style={{ marginBottom: 8 }}>{renameError}</div>}
            <div className="modal-actions">
              <button
                className="btn-primary"
                onClick={handleResolveRenameConflict}
                disabled={renameSaving || !renameConflictNewServer.trim() || !renameConflictExistingServer.trim()}
              >
                {renameSaving ? 'Saving…' : 'Resolve & Rename'}
              </button>
              <button className="btn-secondary" onClick={() => setRenameConflict(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
