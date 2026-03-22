/**
 * specs.js — Spec name conversion between sheet abbreviations and canonical names.
 *
 * The Google Sheet uses abbreviated display names (e.g. "Blood DK", "BM Hunter").
 * The Default BIS tab and seed scripts use full canonical names
 * (e.g. "Blood Death Knight", "Beast Mastery Hunter").
 *
 * Use toCanonical() when reading a spec from the Roster and querying Default BIS.
 * Use toSheet() when writing back to the Roster or displaying in Discord embeds.
 */

// sheet display name → canonical BIS name
const SHEET_TO_CANONICAL = {
  // Death Knight
  'Blood DK':             'Blood Death Knight',
  'Frost DK':             'Frost Death Knight',
  'Unholy DK':            'Unholy Death Knight',
  // Demon Hunter
  'Havoc DH':             'Havoc Demon Hunter',
  'Vengeance DH':         'Vengeance Demon Hunter',
  'Devourer DH':          'Devourer Demon Hunter',
  // Druid (Balance/Feral/Guardian are already full names in the sheet)
  'Balance Druid':        'Balance Druid',
  'Feral Druid':          'Feral Druid',
  'Guardian Druid':       'Guardian Druid',
  'Resto Druid':          'Restoration Druid',
  // Evoker
  'Devastation Evoker':   'Devastation Evoker',
  'Augmentation Evoker':  'Augmentation Evoker',
  'Preservation Evoker':  'Preservation Evoker',
  // Hunter
  'BM Hunter':            'Beast Mastery Hunter',
  'MM Hunter':            'Marksmanship Hunter',
  'SV Hunter':            'Survival Hunter',
  // Mage
  'Arcane Mage':          'Arcane Mage',
  'Fire Mage':            'Fire Mage',
  'Frost Mage':           'Frost Mage',
  // Monk
  'Brewmaster Monk':      'Brewmaster Monk',
  'Mistweaver Monk':      'Mistweaver Monk',
  'Windwalker Monk':      'Windwalker Monk',
  // Paladin
  'Holy Paladin':         'Holy Paladin',
  'Prot Paladin':         'Protection Paladin',
  'Ret Paladin':          'Retribution Paladin',
  // Priest
  'Disc Priest':          'Discipline Priest',
  'Holy Priest':          'Holy Priest',
  'Shadow Priest':        'Shadow Priest',
  // Rogue
  'Assassination Rogue':  'Assassination Rogue',
  'Outlaw Rogue':         'Outlaw Rogue',
  'Subtlety Rogue':       'Subtlety Rogue',
  // Shaman
  'Ele Shaman':           'Elemental Shaman',
  'Enh Shaman':           'Enhancement Shaman',
  'Resto Shaman':         'Restoration Shaman',
  // Warlock
  'Affliction Lock':      'Affliction Warlock',
  'Demo Lock':            'Demonology Warlock',
  'Destro Lock':          'Destruction Warlock',
  // Warrior
  'Arms Warrior':         'Arms Warrior',
  'Fury Warrior':         'Fury Warrior',
  'Prot Warrior':         'Protection Warrior',
};

// Reverse map: canonical → sheet display name
const CANONICAL_TO_SHEET = Object.fromEntries(
  Object.entries(SHEET_TO_CANONICAL).map(([sheet, canon]) => [canon, sheet])
);

// Case-insensitive fallback map for toCanonical()
const SHEET_TO_CANONICAL_LOWER = Object.fromEntries(
  Object.entries(SHEET_TO_CANONICAL).map(([k, v]) => [k.toLowerCase(), v])
);

/**
 * Convert a sheet spec name to the canonical name used in Default BIS.
 * Case-insensitive: "blood dk" and "Blood DK" both resolve correctly.
 * Returns the input unchanged if no mapping exists (safe fallback).
 */
export function toCanonical(sheetSpec) {
  if (!sheetSpec) return sheetSpec;
  return SHEET_TO_CANONICAL[sheetSpec]
    ?? SHEET_TO_CANONICAL_LOWER[sheetSpec.toLowerCase()]
    ?? sheetSpec;
}

/**
 * Convert a canonical spec name back to the sheet display name.
 * Returns the input unchanged if no mapping exists (safe fallback).
 */
export function toSheet(canonicalSpec) {
  return CANONICAL_TO_SHEET[canonicalSpec] ?? canonicalSpec;
}

/**
 * Returns a structured spec summary for a roster entry.
 * Works whether or not the character has secondary specs.
 *
 * @param {object} rosterEntry  Row from getRoster()
 * @returns {{ primary: string, secondary: string[], pending: string|null, all: string[] }}
 */
export function getCharSpecs(rosterEntry) {
  const primary   = rosterEntry.spec ?? '';
  const secondary = rosterEntry.secondarySpecs ?? [];
  const pending   = rosterEntry.pendingPrimarySpec || null;
  return { primary, secondary, pending, all: [primary, ...secondary].filter(Boolean) };
}

/**
 * Map from WoW spec ID (as returned in WCL CombatantInfo event.specID) to the
 * sheet display name used throughout this app. Used by wcl-sync to record Worn
 * BIS data under the correct spec when a character plays a non-primary spec.
 * Update each expansion/patch if Blizzard adds or renumbers specs.
 */
export const WOW_SPEC_ID_TO_NAME = {
  // Death Knight
  250: 'Blood DK',    251: 'Frost DK',    252: 'Unholy DK',
  // Demon Hunter
  577: 'Havoc DH',   581: 'Vengeance DH',
  // Druid
  102: 'Balance Druid', 103: 'Feral Druid', 104: 'Guardian Druid', 105: 'Resto Druid',
  // Evoker
  1467: 'Devastation Evoker', 1468: 'Preservation Evoker', 1473: 'Augmentation Evoker',
  // Hunter
  253: 'BM Hunter',  254: 'MM Hunter',   255: 'SV Hunter',
  // Mage
  62: 'Arcane Mage', 63: 'Fire Mage',    64: 'Frost Mage',
  // Monk
  268: 'Brewmaster Monk', 270: 'Mistweaver Monk', 269: 'Windwalker Monk',
  // Paladin
  65: 'Holy Paladin', 66: 'Prot Paladin', 70: 'Ret Paladin',
  // Priest
  256: 'Disc Priest', 257: 'Holy Priest', 258: 'Shadow Priest',
  // Rogue
  259: 'Assassination Rogue', 260: 'Outlaw Rogue', 261: 'Subtlety Rogue',
  // Shaman
  262: 'Ele Shaman', 263: 'Enh Shaman',  264: 'Resto Shaman',
  // Warlock
  265: 'Affliction Lock', 266: 'Demo Lock', 267: 'Destro Lock',
  // Warrior
  71: 'Arms Warrior', 72: 'Fury Warrior', 73: 'Prot Warrior',
};

/** All sheet spec names, grouped by class. */
export const CLASS_SPECS = {
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

/** Flat list of all sheet spec names. */
export const ALL_SPECS = Object.values(CLASS_SPECS).flat();

/** Armor type for each class. */
const ARMOR_TYPE_BY_CLASS = {
  'Mage':         'Cloth',   'Priest':    'Cloth',   'Warlock':      'Cloth',
  'Druid':        'Leather', 'Demon Hunter': 'Leather', 'Monk':      'Leather', 'Rogue': 'Leather',
  'Evoker':       'Mail',    'Hunter':    'Mail',     'Shaman':       'Mail',
  'Death Knight': 'Plate',   'Paladin':   'Plate',    'Warrior':      'Plate',
};

/**
 * Returns the armor type for a canonical spec name (e.g. "Elemental Shaman" → "Mail").
 * Returns null if the class cannot be determined.
 */
export function getArmorType(canonicalSpec) {
  for (const [cls, type] of Object.entries(ARMOR_TYPE_BY_CLASS)) {
    if (canonicalSpec.endsWith(cls)) return type;
  }
  return null;
}

/**
 * Weapon types (item_subclass.name from Blizzard API) each class can equip.
 * "Miscellaneous" = held-in-off-hand items (grimoires, orbs, tomes).
 */
const WEAPON_PROFICIENCY_BY_CLASS = {
  'Death Knight':  new Set(['Axe', 'Two-Handed Axe', 'Mace', 'Two-Handed Mace', 'Sword', 'Two-Handed Sword', 'Polearm']),
  'Demon Hunter':  new Set(['Warglaives', 'Sword', 'Axe', 'Fist Weapon']),
  'Druid':         new Set(['Mace', 'Two-Handed Mace', 'Staff', 'Polearm', 'Dagger', 'Fist Weapon', 'Miscellaneous']),
  'Evoker':        new Set(['Axe', 'Mace', 'Sword', 'Dagger', 'Fist Weapon', 'Miscellaneous']),
  'Hunter':        new Set(['Axe', 'Two-Handed Axe', 'Bow', 'Crossbow', 'Gun', 'Polearm', 'Staff', 'Sword', 'Two-Handed Sword', 'Dagger', 'Fist Weapon']),
  'Mage':          new Set(['Sword', 'Dagger', 'Wand', 'Staff', 'Miscellaneous']),
  'Monk':          new Set(['Axe', 'Mace', 'Sword', 'Polearm', 'Staff', 'Fist Weapon']),
  'Paladin':       new Set(['Axe', 'Two-Handed Axe', 'Mace', 'Two-Handed Mace', 'Sword', 'Two-Handed Sword', 'Polearm', 'Shield', 'Miscellaneous']),
  'Priest':        new Set(['Dagger', 'Mace', 'Staff', 'Wand', 'Miscellaneous']),
  'Rogue':         new Set(['Axe', 'Mace', 'Sword', 'Dagger', 'Fist Weapon']),
  'Shaman':        new Set(['Axe', 'Two-Handed Axe', 'Mace', 'Two-Handed Mace', 'Dagger', 'Fist Weapon', 'Staff', 'Shield', 'Miscellaneous']),
  'Warlock':       new Set(['Sword', 'Dagger', 'Wand', 'Staff', 'Miscellaneous']),
  'Warrior':       new Set(['Axe', 'Two-Handed Axe', 'Mace', 'Two-Handed Mace', 'Sword', 'Two-Handed Sword', 'Polearm', 'Dagger', 'Fist Weapon', 'Staff', 'Shield']),
};

/**
 * Specs whose off-hand slot holds a weapon (dual wield), not a shield/frill.
 * For these specs, Off-Hand BIS options come from slot='Weapon' items.
 */
const DUAL_WIELD_SPECS = new Set([
  'Havoc Demon Hunter', 'Vengeance Demon Hunter', 'Devourer Demon Hunter',
  'Assassination Rogue', 'Outlaw Rogue', 'Subtlety Rogue',
  'Enhancement Shaman',
  'Windwalker Monk', 'Brewmaster Monk',
  'Frost Death Knight',
  'Fury Warrior',
  'Survival Hunter'
]);

/**
 * Returns true if the canonical spec dual wields (off-hand slot holds a weapon).
 */
export function canDualWield(canonicalSpec) {
  return DUAL_WIELD_SPECS.has(canonicalSpec);
}

/**
 * Returns true if the canonical spec can equip an off-hand item — either a
 * dual-wield weapon or a held-in-off-hand / shield. Used to decide whether to
 * show an editable Off-Hand row in the default BIS editor for specs that may
 * be seeded with a 2H weapon (e.g. Staff on a caster, 2H on Frost DK).
 */
export function canHaveOffHand(canonicalSpec) {
  if (canDualWield(canonicalSpec)) return true;
  for (const [cls, weapons] of Object.entries(WEAPON_PROFICIENCY_BY_CLASS)) {
    if (canonicalSpec.endsWith(cls)) return weapons.has('Miscellaneous') || weapons.has('Shield');
  }
  return false;
}

/**
 * Returns true if the canonical spec can equip the given weapon type.
 * If weaponType is empty (not yet populated), returns true (no restriction).
 */
export function canUseWeapon(canonicalSpec, weaponType) {
  if (!weaponType) return true;
  for (const [cls, weapons] of Object.entries(WEAPON_PROFICIENCY_BY_CLASS)) {
    if (canonicalSpec.endsWith(cls)) return weapons.has(weaponType);
  }
  return true; // unknown class — no restriction
}
