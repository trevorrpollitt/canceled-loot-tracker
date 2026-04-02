/**
 * bis-match.js — BIS item matching logic shared between the council route, WCL sync, and SimC import.
 *
 * `item` must have the shape returned by getItemDb:
 *   { itemId, name, slot, armorType, isTierToken }
 */

/**
 * Paired slots — for rings and trinkets, an item in either physical slot can
 * satisfy either BIS entry (e.g. Ring 2 BIS worn in Ring 1 slot still counts).
 */
export const PAIRED_BIS_SLOTS = {
  'Ring 1':    ['Ring 1', 'Ring 2'],
  'Ring 2':    ['Ring 1', 'Ring 2'],
  'Trinket 1': ['Trinket 1', 'Trinket 2'],
  'Trinket 2': ['Trinket 1', 'Trinket 2'],
};

/**
 * Returns true if `item` satisfies the given BIS value for a character with
 * the given armor type equipping the given slot.
 *
 * @param {string} bisValue     — TrueBIS or RaidBIS field value (item name, ID, or sentinel)
 * @param {string} bisItemId    — TrueBISItemId or RaidBISItemId (may be empty)
 * @param {object} item         — Item DB row { itemId, name, slot, armorType, isTierToken }
 * @param {string} charArmorType — e.g. 'Cloth', 'Leather', 'Mail', 'Plate'
 * @param {string} slot         — BIS submission slot (e.g. 'Ring 1', 'Head')
 */
export function matchesBis(bisValue, bisItemId, item, charArmorType, slot) {
  if (!bisValue) return false;
  if (bisValue === '<Crafted>') return false;
  if (bisValue === '<Tier>')    return item.isTierToken === true;
  if (bisValue === '<Catalyst>') {
    const normalizedSlot = slot.replace(/ [12]$/, '');
    return item.slot === normalizedSlot &&
      (item.armorType === charArmorType || item.armorType === 'Accessory');
  }
  if (bisItemId && String(bisItemId) === String(item.itemId)) return true;
  return item.name.toLowerCase() === bisValue.toLowerCase();
}

/**
 * Given a default-BIS row with raidBis unset, attempt to infer it from trueBis.
 * Returns null if raidBis is already set (leave it alone).
 * Returns { raidBis, raidBisItemId, auto } otherwise.
 *
 * @param {object} row              — default_bis / effective_default_bis row
 * @param {Map}    itemDbByName     — item_db rows keyed by name.toLowerCase()
 */
export function inferRaidBis(row, itemDbByName) {
  // Accept both snake_case (D1) and camelCase (legacy) field names
  const raidBis       = row.raid_bis        ?? row.raidBis       ?? '';
  const trueBis       = row.true_bis        ?? row.trueBis       ?? '';
  const trueBisItemId = row.true_bis_item_id ?? row.trueBisItemId ?? '';

  if (raidBis) return null;

  if (trueBis === '<Tier>' || trueBis === '<Catalyst>') {
    return { raidBis: trueBis, raidBisItemId: trueBis, auto: true };
  }

  if (trueBis === '<Crafted>' || !trueBis) {
    return { raidBis: '', raidBisItemId: '', auto: false };
  }

  const dbItem = itemDbByName.get(trueBis.toLowerCase());
  const sourceType = dbItem?.source_type ?? dbItem?.sourceType;
  if (sourceType === 'Raid') {
    const id = String(trueBisItemId || dbItem.item_id || dbItem.itemId || '');
    return { raidBis: trueBis, raidBisItemId: id, auto: true };
  }

  return { raidBis: '', raidBisItemId: '', auto: false };
}

/**
 * Apply inferRaidBis to every row in an effective-default-BIS result set.
 * Returns rows normalised to camelCase regardless of input field naming.
 *
 * @param {object[]} rows   — from getEffectiveDefaultBis
 * @param {object[]} itemDb — from getItemDb
 * @returns {object[]}
 */
export function applyRaidBisInference(rows, itemDb) {
  const byName = new Map(itemDb.map(i => [i.name.toLowerCase(), i]));
  return rows.map(row => {
    // Normalise internally — supports both D1 snake_case and legacy camelCase input
    const base = {
      spec:          row.spec,
      slot:          row.slot,
      trueBis:       row.true_bis         ?? row.trueBis        ?? '',
      trueBisItemId: row.true_bis_item_id  ?? row.trueBisItemId  ?? '',
      raidBis:       row.raid_bis         ?? row.raidBis        ?? '',
      raidBisItemId: row.raid_bis_item_id  ?? row.raidBisItemId  ?? '',
    };

    const inferred = inferRaidBis(base, byName);
    const raidBis       = inferred === null ? base.raidBis       : inferred.raidBis;
    const raidBisItemId = inferred === null ? base.raidBisItemId : inferred.raidBisItemId;
    const raidBisAuto   = inferred === null
      ? (() => { const h = inferRaidBis({ ...base, raidBis: '' }, byName); return h?.auto === true && h.raidBis === base.raidBis; })()
      : inferred.auto;

    // Return both camelCase (for client-facing routes) AND snake_case (for legacy
    // callers such as admin.js that read row.true_bis / row.raid_bis directly).
    return {
      ...row,              // preserve all original D1 fields (e.g. source, source_type)
      // camelCase
      spec:          base.spec,
      slot:          base.slot,
      trueBis:       base.trueBis,
      trueBisItemId: base.trueBisItemId,
      raidBis,
      raidBisItemId,
      raidBisAuto,
      // snake_case aliases
      true_bis:          base.trueBis,
      true_bis_item_id:  base.trueBisItemId,
      raid_bis:          raidBis,
      raid_bis_item_id:  raidBisItemId,
    };
  });
}
