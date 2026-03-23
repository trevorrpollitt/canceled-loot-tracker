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
