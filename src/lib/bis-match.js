/**
 * bis-match.js — BIS item matching logic shared between the council route and WCL sync.
 *
 * `item` must have the shape returned by getItemDb:
 *   { itemId, name, slot, armorType, isTierToken }
 */

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
