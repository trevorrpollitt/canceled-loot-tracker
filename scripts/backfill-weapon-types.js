/**
 * backfill-weapon-types.js — Fills the WeaponType column (J) in the Item DB
 * for all Weapon / Off-Hand items using the Blizzard Game Data API.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-weapon-types.js [sheetId]
 *
 * sheetId defaults to TEAM_MYTHIC_SHEET_ID from .env.
 * Pass --overwrite to refresh weapon types even for rows that already have one.
 *
 * Safe to re-run — by default only updates rows where WeaponType is blank.
 */

import { getItemDetails, pLimit } from './blizzard.js';
import { readRange, writeRange }  from '../src/lib/sheets.js';

const sheetId   = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'))
               ?? process.env.TEAM_MYTHIC_SHEET_ID;
const overwrite = process.argv.includes('--overwrite');

if (!sheetId) {
  console.error('Usage: node --env-file=.env scripts/backfill-weapon-types.js [sheetId]');
  console.error('       (or set TEAM_MYTHIC_SHEET_ID in .env)');
  process.exit(1);
}

const WEAPON_SLOTS = new Set(['Weapon', 'Off-Hand']);

try {
  console.log(`Sheet: ${sheetId}\n`);

  // Read all Item DB rows (A=ItemId … I=IsTierToken, J=WeaponType)
  const rows = await readRange(sheetId, 'Item DB!A2:J');
  if (!rows.length) {
    console.log('Item DB is empty.');
    process.exit(0);
  }

  // Ensure column J has a header
  await writeRange(sheetId, 'Item DB!J1', [['WeaponType']]);

  // Collect weapon rows that need a weapon type
  const toUpdate = [];
  for (let i = 0; i < rows.length; i++) {
    const slot       = rows[i][2] ?? '';
    const existingWt = rows[i][9] ?? '';
    if (WEAPON_SLOTS.has(slot) && (overwrite || !existingWt)) {
      toUpdate.push({ rowIdx: i, itemId: rows[i][0], name: rows[i][1] ?? '' });
    }
  }

  if (!toUpdate.length) {
    console.log('All weapons already have a WeaponType. Use --overwrite to refresh.');
    process.exit(0);
  }

  console.log(`Fetching weapon types for ${toUpdate.length} item(s)…\n`);

  // Fetch item_subclass.name from Blizzard API (5 concurrent)
  const tasks = toUpdate.map(({ rowIdx, itemId, name }) => async () => {
    try {
      const details    = await getItemDetails(itemId);
      const weaponType = details.item_subclass?.name ?? '';
      console.log(`  [${itemId}] ${name.padEnd(40)} → ${weaponType || '(unknown)'}`);
      return { rowIdx, weaponType };
    } catch (err) {
      console.warn(`  ⚠ [${itemId}] ${name}: ${err.message}`);
      return { rowIdx, weaponType: '' };
    }
  });

  const results = await pLimit(tasks, 5);

  // Build full column J array — preserve existing values for non-weapon rows
  const jCol = rows.map((r, i) => {
    const update = results.find(u => u.rowIdx === i);
    return [update ? update.weaponType : (r[9] ?? '')];
  });

  await writeRange(sheetId, `Item DB!J2:J${rows.length + 1}`, jCol);

  const written = results.filter(r => r.weaponType).length;
  console.log(`\n✓ Done. ${written} weapon type(s) written to column J.`);
} catch (err) {
  console.error('\n❌', err.message);
  process.exit(1);
}
