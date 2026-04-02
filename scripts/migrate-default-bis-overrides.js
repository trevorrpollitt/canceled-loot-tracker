/**
 * migrate-default-bis-overrides.js — Backfill default_bis_overrides from
 * the master Sheets "Default BIS Overrides" tab.
 *
 * The full migrate-sheets-to-d1.js script populates this table during a
 * complete re-migration. Use this script when you want to pull the overrides
 * incrementally without wiping the rest of the database.
 *
 * Usage:
 *   node --env-file=.env scripts/migrate-default-bis-overrides.js [--dry-run]
 *
 * Flags:
 *   --dry-run    Print the SQL without executing it
 *   --remote     Apply to the remote D1 database (default: local)
 *
 * The script executes via `wrangler d1 execute` automatically.
 * All rows are upserted so re-runs are safe and idempotent.
 */

import { execSync }           from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir }             from 'node:os';
import { join }               from 'node:path';
import { getDefaultBisOverrides } from '../src/lib/sheets.js';

const isDryRun = process.argv.includes('--dry-run');
const isRemote = process.argv.includes('--remote');

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Escape a value as a SQL string literal. */
const s = v => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;

/** Emit a subquery to resolve item_db integer PK from Blizzard item_id string. */
const itemRef = id => id ? `(SELECT id FROM item_db WHERE item_id=${s(id)})` : 'NULL';

// ── Main ───────────────────────────────────────────────────────────────────────

console.log('Reading Default BIS Overrides from Sheets…');
const rows = await getDefaultBisOverrides();

console.log(`Found ${rows.length} override rows.`);

if (!rows.length) {
  console.log('Nothing to migrate.');
  process.exit(0);
}

// Generate one UPSERT per row.
const statements = rows.map(r =>
  `INSERT INTO default_bis_overrides (spec, slot, source, true_bis, true_bis_item_id, raid_bis, raid_bis_item_id)` +
  ` VALUES (${s(r.spec)}, ${s(r.slot)}, ${s(r.source ?? '')}, ${s(r.trueBis ?? '')}, ${itemRef(r.trueBisItemId)}, ${s(r.raidBis ?? '')}, ${itemRef(r.raidBisItemId)})` +
  ` ON CONFLICT(spec, slot, source) DO UPDATE SET` +
  `   true_bis = excluded.true_bis,` +
  `   true_bis_item_id = excluded.true_bis_item_id,` +
  `   raid_bis = excluded.raid_bis,` +
  `   raid_bis_item_id = excluded.raid_bis_item_id;`
);

if (isDryRun) {
  console.log('\n-- DRY RUN — SQL that would be executed:\n');
  statements.forEach(s => console.log(s));
  process.exit(0);
}

// Write to a temp SQL file and execute via wrangler.
const tmpFile = join(tmpdir(), `bis-overrides-migration-${Date.now()}.sql`);
writeFileSync(tmpFile, statements.join('\n') + '\n');

const remoteFlag = isRemote ? '--remote' : '--local';
const cmd = `npx wrangler d1 execute canceled-loot-tracker ${remoteFlag} --file "${tmpFile}"`;

console.log(`\nExecuting via wrangler (${isRemote ? 'remote' : 'local'})…`);
console.log(`SQL file: ${tmpFile}`);

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log(`\n✓ Migrated ${rows.length} default BIS override rows.`);
} finally {
  try { unlinkSync(tmpFile); } catch { /* ignore */ }
}
