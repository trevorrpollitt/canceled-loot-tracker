/**
 * backfill-bis-item-ids.js — Normalise true_bis_item_id and raid_bis_item_id
 * in the bis_submissions table.
 *
 * Background
 * ----------
 * The column is supposed to hold the Blizzard item_id (e.g. 249346).  Due to
 * inconsistent history it currently contains three different values:
 *
 *   • The item_db.id (D1 auto-increment PK, small integers 1–~300) — rows
 *     migrated from the old Google Sheets data.
 *   • The real Blizzard item_id (5–6 digit number, TEXT) — rows submitted via
 *     the web form after the initial migration.
 *   • NULL — rows that never had an item ID at all.
 *
 * This script normalises every row to one canonical format: the Blizzard
 * item_id TEXT value from item_db, looked up by matching item_db.item_id
 * (for rows that already have the right value) or item_db.id (for rows with
 * the old D1 PK).  Rows whose item name is not found in item_db are set to NULL.
 * Sentinel values (<Tier>, <Catalyst>, <Crafted>) and blank values are skipped.
 *
 * After this script runs, the column is safe to read directly:
 *   COALESCE(s.true_bis_item_id, '') AS true_bis_item_id
 *
 * Usage (local D1):
 *   node scripts/backfill-bis-item-ids.js [--dry-run]
 *
 * Usage (remote D1 via Wrangler — applies the generated SQL):
 *   node scripts/backfill-bis-item-ids.js --print-sql
 *   # then pipe output to: wrangler d1 execute canceled-loot-tracker --remote --command="..."
 *
 * Safe to re-run.  Already-correct rows are updated to the same value (no-op
 * at the DB level).
 */

import { openLocalDb } from './local-db.js';

const DRY_RUN   = process.argv.includes('--dry-run');
const PRINT_SQL = process.argv.includes('--print-sql');

const SENTINELS = new Set(['<Tier>', '<Catalyst>', '<Crafted>']);

// ── Main ───────────────────────────────────────────────────────────────────────

if (PRINT_SQL) {
  // Emit raw SQL for manual remote execution via wrangler
  console.log(`-- Normalise true_bis_item_id: set to Blizzard item_id from item_db name lookup`);
  console.log(`UPDATE bis_submissions`);
  console.log(`  SET true_bis_item_id = (`);
  console.log(`    SELECT item_id FROM item_db`);
  console.log(`    WHERE LOWER(name) = LOWER(bis_submissions.true_bis)`);
  console.log(`    LIMIT 1`);
  console.log(`  )`);
  console.log(`  WHERE true_bis NOT IN ('<Tier>','<Catalyst>','<Crafted>')`);
  console.log(`    AND true_bis IS NOT NULL AND true_bis != '';\n`);
  console.log(`-- Normalise raid_bis_item_id similarly`);
  console.log(`UPDATE bis_submissions`);
  console.log(`  SET raid_bis_item_id = (`);
  console.log(`    SELECT item_id FROM item_db`);
  console.log(`    WHERE LOWER(name) = LOWER(bis_submissions.raid_bis)`);
  console.log(`    LIMIT 1`);
  console.log(`  )`);
  console.log(`  WHERE raid_bis NOT IN ('<Tier>','<Catalyst>','<Crafted>')`);
  console.log(`    AND raid_bis IS NOT NULL AND raid_bis != '';`);
  process.exit(0);
}

if (DRY_RUN) console.log('*** DRY RUN — no writes will be made ***\n');

const db = openLocalDb();

// ── 1. Build item lookup maps ─────────────────────────────────────────────────

const itemDbRows = await db.prepare('SELECT id, item_id, name FROM item_db').all()
  .then(r => r.results);

// name.toLowerCase() → Blizzard item_id (TEXT, e.g. "249346")
const itemIdByName = new Map(
  itemDbRows.map(r => [r.name.toLowerCase(), String(r.item_id)])
);
// item_db.id (D1 PK) → Blizzard item_id
const itemIdByDbId = new Map(
  itemDbRows.map(r => [String(r.id), String(r.item_id)])
);

console.log(`item_db: ${itemDbRows.length} items loaded\n`);

// ── 2. Load all bis_submissions rows ─────────────────────────────────────────

const rows = await db.prepare(
  'SELECT id, true_bis, true_bis_item_id, raid_bis, raid_bis_item_id FROM bis_submissions'
).all().then(r => r.results);

console.log(`bis_submissions: ${rows.length} rows to inspect\n`);

// ── 3. Compute updates ───────────────────────────────────────────────────────

function resolveItemId(name, storedValue) {
  if (!name || SENTINELS.has(name)) return null;   // sentinel / blank → leave NULL

  // Is the stored value already the correct Blizzard item_id?
  const byName = itemIdByName.get(name.toLowerCase()) ?? null;
  return byName;  // NULL when item not in item_db
}

let trueUpdates = 0, raidUpdates = 0, notFound = new Set();

const updateStmt = db.prepare(
  'UPDATE bis_submissions SET true_bis_item_id = ?, raid_bis_item_id = ? WHERE id = ?'
);

for (const row of rows) {
  const newTrueId = resolveItemId(row.true_bis, row.true_bis_item_id);
  const newRaidId = resolveItemId(row.raid_bis, row.raid_bis_item_id);

  // Track items we couldn't resolve (not in item_db)
  if (row.true_bis && !SENTINELS.has(row.true_bis) && newTrueId === null)
    notFound.add(row.true_bis);
  if (row.raid_bis && !SENTINELS.has(row.raid_bis) && row.raid_bis !== '' && newRaidId === null)
    notFound.add(row.raid_bis);

  const trueChanged = String(row.true_bis_item_id ?? '') !== String(newTrueId ?? '');
  const raidChanged = String(row.raid_bis_item_id ?? '') !== String(newRaidId ?? '');

  if (!trueChanged && !raidChanged) continue;

  if (trueChanged) trueUpdates++;
  if (raidChanged) raidUpdates++;

  if (!DRY_RUN) {
    await updateStmt.bind(newTrueId, newRaidId, row.id).run();
  } else {
    if (trueChanged)
      console.log(`  [dry] id=${row.id} true_bis="${row.true_bis}": ${row.true_bis_item_id ?? 'NULL'} → ${newTrueId ?? 'NULL'}`);
    if (raidChanged)
      console.log(`  [dry] id=${row.id} raid_bis="${row.raid_bis}": ${row.raid_bis_item_id ?? 'NULL'} → ${newRaidId ?? 'NULL'}`);
  }
}

// ── 4. Summary ───────────────────────────────────────────────────────────────

console.log(`\n=== ${DRY_RUN ? 'Dry-run' : 'Migration'} complete ===`);
console.log(`  true_bis_item_id rows updated:  ${trueUpdates}`);
console.log(`  raid_bis_item_id rows updated:  ${raidUpdates}`);

if (notFound.size) {
  console.warn(`\n  ⚠  ${notFound.size} item name(s) not found in item_db (set to NULL):`);
  for (const name of [...notFound].sort()) {
    console.warn(`       • ${name}`);
  }
  console.warn(`\n  Run the Sync Loot Tables admin action if these items are missing from item_db.`);
}

if (!DRY_RUN) {
  console.log(`\nRun the same command with --remote SQL if you need to apply this to production:`);
  console.log(`  node scripts/backfill-bis-item-ids.js --print-sql`);
}
