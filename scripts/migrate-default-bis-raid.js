/**
 * migrate-default-bis-raid.js — Backfill raid_bis from the master Sheets
 * Default BIS tab into the D1 default_bis table.
 *
 * The seed-default-bis.js script populates true_bis from web guides but
 * intentionally leaves raid_bis blank. Officers filled in raid_bis via the
 * old Sheets-backed admin UI. This script exports those values and writes
 * UPDATE statements so the D1 table matches.
 *
 * Usage:
 *   node --env-file=.env scripts/migrate-default-bis-raid.js [--dry-run]
 *
 * Flags:
 *   --dry-run    Print the SQL without executing it
 *   --remote     Apply to the remote D1 database (default: local)
 *
 * The script executes the SQL via `wrangler d1 execute` automatically.
 * Rows where raid_bis is already populated in D1 are updated (not skipped)
 * so a re-run is idempotent.
 */

import { execSync }   from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir }     from 'node:os';
import { join }       from 'node:path';
import { getDefaultBis } from '../src/lib/sheets.js';

const isDryRun = process.argv.includes('--dry-run');
const isRemote = process.argv.includes('--remote');

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Escape a string value for a SQL literal (single-quote doubling). */
function sqlStr(v) {
  return `'${String(v ?? '').replace(/'/g, "''")}'`;
}

// ── Main ───────────────────────────────────────────────────────────────────────

console.log('Reading Default BIS from Sheets…');
const rows = await getDefaultBis();

const toUpdate = rows.filter(r => r.raidBis && r.spec && r.slot && r.source);
console.log(`Found ${toUpdate.length} rows with raid_bis set (out of ${rows.length} total).`);

if (!toUpdate.length) {
  console.log('Nothing to migrate.');
  process.exit(0);
}

// Generate one UPDATE statement per row.
// raid_bis_item_id is left NULL — the item name alone is sufficient for matching,
// and a proper FK lookup would require joining item_db which varies per environment.
const statements = toUpdate.map(r =>
  `UPDATE default_bis SET raid_bis = ${sqlStr(r.raidBis)} WHERE spec = ${sqlStr(r.spec)} AND slot = ${sqlStr(r.slot)} AND source = ${sqlStr(r.source)};`
);

if (isDryRun) {
  console.log('\n-- DRY RUN — SQL that would be executed:\n');
  statements.forEach(s => console.log(s));
  process.exit(0);
}

// Write to a temp SQL file and execute via wrangler.
const tmpFile = join(tmpdir(), `raid-bis-migration-${Date.now()}.sql`);
writeFileSync(tmpFile, statements.join('\n') + '\n');

const remoteFlag = isRemote ? '--remote' : '--local';
const cmd = `npx wrangler d1 execute canceled-loot-tracker ${remoteFlag} --file "${tmpFile}"`;

console.log(`\nExecuting via wrangler (${isRemote ? 'remote' : 'local'})…`);
console.log(`SQL file: ${tmpFile}`);

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log(`\n✓ Migrated ${toUpdate.length} raid_bis values.`);
} finally {
  try { unlinkSync(tmpFile); } catch { /* ignore */ }
}
