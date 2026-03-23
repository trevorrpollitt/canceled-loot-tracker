/**
 * simc.js — SimulationCraft export parser.
 *
 * Extracts equipped gear from a SimC profile string. Only slot lines are
 * parsed (e.g. `head=,id=208424,bonus_id=4800/6652,ilevel=636`). All other
 * lines (talents, spells, professions, etc.) are ignored.
 */

/** SimC slot name → canonical app slot name (matches BIS Submissions / Worn BIS). */
export const SIMC_SLOT_MAP = {
  head:      'Head',
  neck:      'Neck',
  shoulders: 'Shoulders',
  back:      'Back',
  chest:     'Chest',
  waist:     'Waist',
  legs:      'Legs',
  feet:      'Feet',
  wrists:    'Wrists',
  hands:     'Hands',
  finger1:   'Ring 1',
  finger2:   'Ring 2',
  trinket1:  'Trinket 1',
  trinket2:  'Trinket 2',
  main_hand: 'Weapon',
  off_hand:  'Off-Hand',
};

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
