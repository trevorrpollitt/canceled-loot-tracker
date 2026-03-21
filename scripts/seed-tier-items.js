/**
 * seed-tier-items.js — Populate the master sheet Tier Items tab
 * (A=Class  B=Slot  C=ItemId) from the Blizzard API.
 *
 * Each WoW class has its own item set for the current tier. Blizzard does not
 * expose class restrictions as a field on the item — the class binding is
 * implicit through which set the item belongs to. So you must supply the
 * class name alongside each set ID as "setId:ClassName" pairs.
 *
 * Usage:
 *   node --env-file=.env scripts/seed-tier-items.js "setId:Class Name" "setId:Class Name" ... [--dry-run]
 *
 * TWW Season 2 — Liberation of Undermine (copy-paste ready):
 *   node --env-file=.env scripts/seed-tier-items.js \
 *     "1867:Death Knight" \
 *     "1868:Demon Hunter" \
 *     "1869:Druid" \
 *     "1870:Evoker" \
 *     "1871:Hunter" \
 *     "1872:Mage" \
 *     "1873:Monk" \
 *     "1874:Paladin" \
 *     "1875:Priest" \
 *     "1876:Rogue" \
 *     "1877:Shaman" \
 *     "1878:Warlock" \
 *     "1879:Warrior"
 *
 * Add --dry-run to print rows without writing to the sheet.
 *
 * To find set IDs for a future tier: https://www.wowhead.com/item-sets
 * (search for the set name, e.g. "Cauldron Champion's Encore")
 */

import { getItemSet, getItemDetails, pLimit } from './blizzard.js';
import { setTierItems } from '../src/lib/sheets.js';

// ── Slot mapping (Blizzard inventory_type.type → our slot label) ──────────────
const SLOT_MAP = {
  HEAD:     'Head',
  SHOULDER: 'Shoulders',
  CHEST:    'Chest',
  ROBE:     'Chest',
  HAND:     'Hands',
  LEGS:     'Legs',
};

const TIER_SLOTS = new Set(Object.values(SLOT_MAP));

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const pairs  = args.filter(a => !a.startsWith('--'));

  if (!pairs.length) {
    console.error([
      'Usage: node --env-file=.env scripts/seed-tier-items.js "setId:Class Name" ... [--dry-run]',
      '',
      'Example:',
      '  node --env-file=.env scripts/seed-tier-items.js \\',
      '    "1867:Death Knight" "1868:Demon Hunter" "1869:Druid" \\',
      '    "1870:Evoker" "1871:Hunter" "1872:Mage" "1873:Monk" \\',
      '    "1874:Paladin" "1875:Priest" "1876:Rogue" "1877:Shaman" \\',
      '    "1878:Warlock" "1879:Warrior"',
    ].join('\n'));
    process.exit(1);
  }

  // Parse "setId:Class Name" pairs
  const sets = [];
  for (const pair of pairs) {
    const colon = pair.indexOf(':');
    if (colon === -1) {
      console.error(`Invalid argument "${pair}" — expected format "setId:Class Name"`);
      process.exit(1);
    }
    const setId     = Number(pair.slice(0, colon).trim());
    const className = pair.slice(colon + 1).trim();
    if (!setId || !className) {
      console.error(`Invalid argument "${pair}" — set ID must be numeric and class name must be non-empty`);
      process.exit(1);
    }
    sets.push({ setId, className });
  }

  console.log(`\nProcessing ${sets.length} item set(s)${dryRun ? ' [DRY RUN]' : ''}…\n`);

  const allRows = [];

  for (const { setId, className } of sets) {
    console.log(`── Set ${setId} → ${className}`);
    let setData;
    try {
      setData = await getItemSet(setId);
    } catch (err) {
      console.warn(`  ⚠ Failed to fetch set ${setId}: ${err.message}`);
      continue;
    }

    console.log(`  Name: ${setData.name}`);
    const items = setData.items ?? [];
    console.log(`  Items: ${items.length}`);

    // Fetch full details for each item in parallel
    const detailed = await pLimit(
      items.map(item => async () => {
        const id = item.id ?? item.item?.id;
        try {
          return await getItemDetails(id);
        } catch (err) {
          console.warn(`  ⚠ Item ${id}: ${err.message}`);
          return null;
        }
      }),
      5,
    );

    for (const details of detailed.filter(Boolean)) {
      const invType = details.inventory_type?.type;
      const slot    = SLOT_MAP[invType];

      if (!slot) {
        console.log(`  [${details.id}] ${details.name} — skipping (invType=${invType ?? 'unknown'})`);
        continue;
      }

      console.log(`  ✓ [${details.id}] ${details.name} → ${slot}`);
      allRows.push({ class: className, slot, itemId: details.id });
    }

    console.log();
  }

  if (!allRows.length) {
    console.error('No rows produced — nothing to write. Check that the set IDs are correct.');
    process.exit(1);
  }

  // Validate: every class should have exactly the 5 tier slots
  const byClass = {};
  for (const row of allRows) {
    if (!byClass[row.class]) byClass[row.class] = [];
    byClass[row.class].push(row.slot);
  }

  console.log('── Summary');
  let warnings = 0;
  for (const [cls, slots] of Object.entries(byClass).sort()) {
    const missing = [...TIER_SLOTS].filter(s => !slots.includes(s));
    const flag    = missing.length ? ` ⚠ missing: ${missing.join(', ')}` : ' ✓';
    console.log(`  ${cls.padEnd(20)} ${slots.length} slot(s)${flag}`);
    if (missing.length) warnings++;
  }

  console.log(`\n  Total rows : ${allRows.length}`);
  console.log(`  Classes    : ${Object.keys(byClass).length}`);
  if (warnings) console.warn(`  ⚠ ${warnings} class(es) with incomplete tier slot coverage — check set IDs`);

  if (dryRun) {
    console.log('\n[DRY RUN] Skipping sheet write.');
    return;
  }

  console.log('\nWriting to master sheet Tier Items tab…');
  await setTierItems(allRows);
  console.log(`Done — ${allRows.length} rows written.`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
