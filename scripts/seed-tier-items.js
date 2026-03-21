/**
 * seed-tier-items.js — Populate the master sheet Tier Items tab
 * (A=Class  B=Slot  C=ItemId) from the Blizzard API.
 *
 * Each WoW class has its own item set for the current tier.
 * Pass the set IDs as a comma-separated argument — one per class.
 * You can find set IDs on Wowhead: https://www.wowhead.com/item-sets
 * (search for the tier set name, e.g. "Razorscale Dominion").
 *
 * Usage:
 *   node --env-file=.env scripts/seed-tier-items.js <setId1,setId2,...>
 *
 * Example (TWW Season 2 — Liberation of Undermine):
 *   node --env-file=.env scripts/seed-tier-items.js 1738,1739,1740,1741,1742,1743,1744,1745,1746,1747,1748,1749,1750
 *
 * Dry-run (prints rows, does not write to sheet):
 *   node --env-file=.env scripts/seed-tier-items.js <setIds> --dry-run
 *
 * The script detects each item's class from the Blizzard
 * item API `requirements.playable_classes` field.
 * If that field is absent, it prints a warning and skips the item
 * (this should not happen for current-season tier gear).
 */

import { getItemSet, getItemDetails, pLimit } from './blizzard.js';
import { setTierItems } from '../src/lib/sheets.js';

// ── Slot mapping (Blizzard inventory_type → our slot label) ──────────────────
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
  const args    = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const setArg  = args.find(a => !a.startsWith('--'));

  if (!setArg) {
    console.error('Usage: node --env-file=.env scripts/seed-tier-items.js <setId1,setId2,...> [--dry-run]');
    process.exit(1);
  }

  const setIds = setArg.split(',').map(s => Number(s.trim())).filter(Boolean);
  if (!setIds.length) {
    console.error('No valid set IDs provided.');
    process.exit(1);
  }

  console.log(`\nProcessing ${setIds.length} item set(s)${dryRun ? ' [DRY RUN]' : ''}…\n`);

  const allRows = [];

  for (const setId of setIds) {
    console.log(`── Set ${setId}`);
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

    // Fetch full details for each item in parallel (capped concurrency)
    const detailed = await pLimit(
      items.map(item => async () => {
        const id = item.id ?? item.item?.id;
        try {
          const details = await getItemDetails(id);
          return details;
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
        // Not a tier equip slot — skip (e.g. weapons accidentally in a set)
        console.log(`  [${details.id}] ${details.name} — skipping (invType=${invType})`);
        continue;
      }

      // Class from requirements.playable_classes (array of { name, id })
      const playableClasses = details.requirements?.playable_classes?.links ?? [];
      if (!playableClasses.length) {
        console.warn(`  ⚠ [${details.id}] ${details.name} — no playable_classes found, skipping`);
        continue;
      }

      for (const cls of playableClasses) {
        const className = cls.name?.trim();
        if (!className) continue;
        console.log(`  ✓ [${details.id}] ${details.name} → ${className} / ${slot}`);
        allRows.push({ class: className, slot, itemId: details.id });
      }
    }

    console.log();
  }

  if (!allRows.length) {
    console.error('No rows produced — nothing to write.');
    process.exit(1);
  }

  // Validate: every class should have exactly 5 tier slots
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

  console.log(`\n  Total rows: ${allRows.length} across ${Object.keys(byClass).length} class(es)`);
  if (warnings) console.warn(`  ${warnings} class(es) have incomplete tier slot coverage — check set IDs`);

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
