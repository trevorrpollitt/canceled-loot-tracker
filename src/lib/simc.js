/**
 * simc.js — SimulationCraft export parser.
 *
 * Extracts equipped gear from a SimC profile string. Only slot lines are
 * parsed (e.g. `head=,id=208424,bonus_id=4800/6652,ilevel=636`). All other
 * lines (talents, spells, professions, etc.) are ignored.
 */

/** SimC slot name → canonical app slot name (matches BIS Submissions / Worn BIS).
 *  Both singular and plural forms are accepted by SimC; the addon typically exports
 *  singular (shoulder, wrist, hand) so all variants are mapped here. */
export const SIMC_SLOT_MAP = {
  head:       'Head',
  neck:       'Neck',
  shoulder:   'Shoulders',
  shoulders:  'Shoulders',
  back:       'Back',
  chest:      'Chest',
  waist:      'Waist',
  legs:       'Legs',
  feet:       'Feet',
  wrist:      'Wrists',
  wrists:     'Wrists',
  hand:       'Hands',
  hands:      'Hands',
  finger1:    'Ring 1',
  ring1:      'Ring 1',
  finger2:    'Ring 2',
  ring2:      'Ring 2',
  trinket1:   'Trinket 1',
  trinket2:   'Trinket 2',
  main_hand:  'Weapon',
  off_hand:   'Off-Hand',
};

/** SimC class key → app class name */
const SIMC_CLASS_MAP = {
  deathknight: 'Death Knight',
  demonhunter: 'Demon Hunter',
  druid:       'Druid',
  evoker:      'Evoker',
  hunter:      'Hunter',
  mage:        'Mage',
  monk:        'Monk',
  paladin:     'Paladin',
  priest:      'Priest',
  rogue:       'Rogue',
  shaman:      'Shaman',
  warlock:     'Warlock',
  warrior:     'Warrior',
};

/**
 * SimC class key + spec slug → canonical app spec name.
 * Keyed as `${simcClass}/${specSlug}` to disambiguate shared slugs like
 * frost (DK vs Mage), restoration (Druid vs Shaman), holy/protection.
 */
const SIMC_SPEC_MAP = {
  // Death Knight
  'deathknight/blood':          'Blood Death Knight',
  'deathknight/frost':          'Frost Death Knight',
  'deathknight/unholy':         'Unholy Death Knight',
  // Demon Hunter
  'demonhunter/havoc':          'Havoc Demon Hunter',
  'demonhunter/vengeance':      'Vengeance Demon Hunter',
  // Druid
  'druid/balance':              'Balance Druid',
  'druid/feral':                'Feral Druid',
  'druid/guardian':             'Guardian Druid',
  'druid/restoration':          'Restoration Druid',
  // Evoker
  'evoker/devastation':         'Devastation Evoker',
  'evoker/preservation':        'Preservation Evoker',
  'evoker/augmentation':        'Augmentation Evoker',
  // Hunter
  'hunter/beast_mastery':       'Beast Mastery Hunter',
  'hunter/marksmanship':        'Marksmanship Hunter',
  'hunter/survival':            'Survival Hunter',
  // Mage
  'mage/arcane':                'Arcane Mage',
  'mage/fire':                  'Fire Mage',
  'mage/frost':                 'Frost Mage',
  // Monk
  'monk/brewmaster':            'Brewmaster Monk',
  'monk/mistweaver':            'Mistweaver Monk',
  'monk/windwalker':            'Windwalker Monk',
  // Paladin
  'paladin/holy':               'Holy Paladin',
  'paladin/protection':         'Protection Paladin',
  'paladin/retribution':        'Retribution Paladin',
  // Priest
  'priest/discipline':          'Discipline Priest',
  'priest/holy':                'Holy Priest',
  'priest/shadow':              'Shadow Priest',
  // Rogue
  'rogue/assassination':        'Assassination Rogue',
  'rogue/outlaw':               'Outlaw Rogue',
  'rogue/subtlety':             'Subtlety Rogue',
  // Shaman
  'shaman/elemental':           'Elemental Shaman',
  'shaman/enhancement':         'Enhancement Shaman',
  'shaman/restoration':         'Restoration Shaman',
  // Warlock
  'warlock/affliction':         'Affliction Warlock',
  'warlock/demonology':         'Demonology Warlock',
  'warlock/destruction':        'Destruction Warlock',
  // Warrior
  'warrior/arms':               'Arms Warrior',
  'warrior/fury':               'Fury Warrior',
  'warrior/protection':         'Protection Warrior',
};

/**
 * Parse the header of a SimC profile string, extracting character name,
 * class, and spec for validation purposes.
 *
 * @param {string} text  Raw SimC export text.
 * @returns {{ charName: string, charClass: string, spec: string } | null}
 *   Returns null if the header cannot be identified (e.g. gear-only paste).
 *   `spec` is the canonical app spec name (e.g. "Arms Warrior"), or empty
 *   string if the spec line is missing or unrecognised.
 */
export function parseSimcHeader(text) {
  let charName  = null;
  let simcClass = null;
  let specSlug  = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;

    const key = line.slice(0, eqIdx).toLowerCase();
    const val = line.slice(eqIdx + 1).trim();

    if (SIMC_CLASS_MAP[key] && charName === null) {
      // e.g.  warrior="Morthrak"
      simcClass = key;
      charName  = val.replace(/^"(.*)"$/, '$1').split('-')[0]; // strip server suffix
    } else if (key === 'spec' && specSlug === null) {
      specSlug = val.toLowerCase();
    }

    if (charName !== null && specSlug !== null) break;
  }

  if (!charName || !simcClass) return null;

  const specKey    = `${simcClass}/${specSlug ?? ''}`;
  const charClass  = SIMC_CLASS_MAP[simcClass];
  const spec       = SIMC_SPEC_MAP[specKey] ?? '';

  return { charName, charClass, spec };
}

/**
 * Parse a SimC profile string, returning an array of equipped gear items.
 *
 * @param {string} text  Raw SimC export text (full profile or just the gear block).
 * @returns {{ slot: string, itemId: number, bonusIds: number[] }[]}
 *          One entry per equipped item. Unknown / empty slots are omitted.
 */
export function parseSimcGear(text) {
  const gear = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Each gear line: slotName=,id=XXXXX,key=val,...
    // We only care about lines whose left-hand side is a known slot name.
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;

    const slotRaw = line.slice(0, eqIdx).toLowerCase();
    const slot    = SIMC_SLOT_MAP[slotRaw];
    if (!slot) continue;

    // Parse key=value pairs from everything after the first '='
    const rest = line.slice(eqIdx + 1);
    const kvs  = {};
    for (const part of rest.split(',')) {
      const kIdx = part.indexOf('=');
      if (kIdx < 0) continue;
      kvs[part.slice(0, kIdx).trim()] = part.slice(kIdx + 1).trim();
    }

    const itemId = Number(kvs.id);
    if (!itemId) continue; // empty slot or non-item line

    const bonusIds = (kvs.bonus_id ?? '')
      .split('/')
      .map(Number)
      .filter(Boolean);

    gear.push({ slot, itemId, bonusIds });
  }

  return gear;
}
