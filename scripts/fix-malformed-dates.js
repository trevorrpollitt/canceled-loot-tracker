/**
 * fix-malformed-dates.js — Backfill: correct loot log rows whose date column
 * was stored in the malformed "20DD-YYYY-MM" pattern instead of "YYYY-MM-DD".
 *
 * The bug caused dates like 2026-03-17 to be stored as 2017-2026-03
 * (the day with a "20" prefix was placed first, followed by year then month).
 *
 * Detection:  /^20\d{2}-20\d{2}-\d{2}$/  e.g. "2017-2026-03"
 * Repair:     take segments [dd, yyyy, mm] → "${yyyy}-${mm}-${dd.slice(2)}"
 *
 * Usage:
 *   # Dry run — shows what would change, writes nothing:
 *   node --env-file=.env scripts/fix-malformed-dates.js --dry-run
 *
 *   # All teams (reads team list from master sheet):
 *   node --env-file=.env scripts/fix-malformed-dates.js
 *
 *   # Single team sheet:
 *   node --env-file=.env scripts/fix-malformed-dates.js <teamSheetId>
 *
 * Safe to re-run — already-correct rows are skipped.
 */

import { readRange, batchWriteRanges } from '../src/lib/sheets.js';

const DRY_RUN      = process.argv.includes('--dry-run');
const argSheetId   = process.argv.find(a => !a.startsWith('--') && a !== process.argv[1] && a !== process.argv[0]);
const masterSheetId = process.env.MASTER_SHEET_ID;

// ── Malformed date detection & repair ─────────────────────────────────────────

// Matches "20DD-YYYY-MM" e.g. "2017-2026-03"
const MALFORMED = /^(20\d{2})-(20\d{2})-(\d{2})$/;

function repairDate(val) {
  const m = String(val ?? '').match(MALFORMED);
  if (!m) return null;                       // not malformed — nothing to do
  const [, ddPart, yyyy, mm] = m;
  const dd = ddPart.slice(2);                // "2017" → "17"
  return `${yyyy}-${mm}-${dd}`;             // "2026-03-17"
}

// ── Process one team sheet ────────────────────────────────────────────────────

async function fixSheet(sheetId, teamName) {
  const label = teamName ? `${teamName} (${sheetId.slice(-6)})` : sheetId.slice(-6);
  console.log(`\n── ${label} ──`);

  const rows = await readRange(sheetId, 'Loot Log!A2:K');
  if (!rows.length) { console.log('  No rows.'); return; }

  const writes = [];   // { range, value }
  let fixed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const id     = String(row[0] ?? '').trim();
    const date   = String(row[2] ?? '').trim();
    if (!id) continue;

    const corrected = repairDate(date);
    if (!corrected) continue;

    const sheetRow = i + 2;   // 1-indexed, +1 for header
    console.log(`  Row ${sheetRow}: "${date}" → "${corrected}"  (${row[4] ?? '?'})`);
    writes.push({ range: `Loot Log!C${sheetRow}`, values: [[corrected]] });
    fixed++;
  }

  if (!fixed) { console.log('  No malformed dates found.'); return; }

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would fix ${fixed} row(s) — no changes written.`);
    return;
  }

  await batchWriteRanges(sheetId, writes);
  console.log(`  Fixed ${fixed} row(s).`);
}

// ── Resolve team sheet IDs ────────────────────────────────────────────────────

let teams;

if (argSheetId) {
  teams = [{ name: '', sheetId: argSheetId }];
} else if (masterSheetId) {
  console.log(`Reading team list from master sheet ${masterSheetId.slice(-6)}…`);
  const teamRows = await readRange(masterSheetId, 'Teams!A2:B');
  teams = teamRows
    .map(r => ({ name: String(r[0] ?? '').trim(), sheetId: String(r[1] ?? '').trim() }))
    .filter(t => t.sheetId);
} else {
  console.error('Provide a teamSheetId argument or set MASTER_SHEET_ID in .env');
  process.exit(1);
}

if (DRY_RUN) console.log('\n[DRY RUN MODE — no changes will be written]\n');

for (const { name, sheetId } of teams) {
  await fixSheet(sheetId, name);
}

console.log('\nDone.');
