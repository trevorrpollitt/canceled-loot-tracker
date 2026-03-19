/**
 * migrate-char-ids.js — One-time migration to add stable character UUIDs
 * to existing sheet data.
 *
 * What this script does (non-destructive — only writes to new/empty cells):
 *
 *   1. Roster (col H) — generates a UUID for every row that doesn't have one.
 *      Existing cols A–G are untouched.
 *
 *   2. BIS Submissions (col N) — looks up each row's charName (col B) in the
 *      Roster to find its charId, then writes it to col N.
 *      Rows already having a charId in col N are skipped.
 *
 *   3. Loot Log (col K) — looks up each row's recipientChar (col H) in the
 *      Roster to find its charId, then writes it to col K.
 *      Rows already having a charId in col K are skipped.
 *
 * Usage:
 *   # Migrate all teams (reads team list from master sheet):
 *   node --env-file=.env scripts/migrate-char-ids.js
 *
 *   # Migrate a single team sheet:
 *   node --env-file=.env scripts/migrate-char-ids.js <teamSheetId>
 *
 * Safe to re-run — skips already-migrated rows.
 */

import { randomUUID } from 'node:crypto';
import { readRange, batchWriteRanges } from '../src/lib/sheets.js';

// ── Resolve team sheet IDs ─────────────────────────────────────────────────────

const masterSheetId = process.env.MASTER_SHEET_ID;
const argSheetId    = process.argv[2];

let teamSheetIds;

if (argSheetId) {
  // Single team passed explicitly — no name available
  teamSheetIds = [{ name: '', sheetId: argSheetId }];
} else if (masterSheetId) {
  // Read all teams from master sheet Teams tab (A=TeamName, B=SheetId)
  console.log(`Reading team list from master sheet ${masterSheetId.slice(-6)}…`);
  const teamRows = await readRange(masterSheetId, 'Teams!A2:B');
  teamSheetIds = teamRows
    .map(r => ({ name: String(r[0] ?? '').trim(), sheetId: String(r[1] ?? '').trim() }))
    .filter(t => t.sheetId);
  if (!teamSheetIds.length) {
    console.error('No teams found in master sheet Teams tab.');
    process.exit(1);
  }
  console.log(`Found ${teamSheetIds.length} team(s): ${teamSheetIds.map(t => t.name).join(', ')}\n`);
} else {
  console.error('Usage: node --env-file=.env scripts/migrate-char-ids.js [teamSheetId]');
  console.error('       MASTER_SHEET_ID env var must be set if no teamSheetId is provided.');
  process.exit(1);
}

// ── Helper: batch write in chunks to avoid hitting the API limits ──────────────

async function batchWriteChunked(sheetId, updates, label, chunkSize = 50) {
  if (!updates.length) { console.log(`  ${label}: nothing to write`); return; }
  console.log(`  ${label}: writing ${updates.length} cells in chunks of ${chunkSize}…`);
  for (let i = 0; i < updates.length; i += chunkSize) {
    await batchWriteRanges(sheetId, updates.slice(i, i + chunkSize));
    process.stdout.write(`    chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(updates.length / chunkSize)} done\r`);
  }
  console.log(`  ${label}: ✓ ${updates.length} cells written                    `);
}

// ── Per-team migration ─────────────────────────────────────────────────────────

async function migrateTeam(sheetId, teamName = '') {
  const label = teamName ? `${teamName} (${sheetId.slice(-6)})` : sheetId;
  console.log(`=== Migrating char IDs for ${label} ===\n`);

  // ── Step 1: Roster — generate charId for every row missing one ──────────────

  console.log('Step 1: Roster — generating charIds for un-migrated rows…');

  // Schema (new): A=CharName B=Class C=Spec D=Role E=Status F=OwnerId G=OwnerNick H=CharId
  const rosterRows   = await readRange(sheetId, 'Roster!A2:H');
  const charIdByName = new Map();  // charName.toLowerCase() → charId
  const rosterUpdates = [];

  for (let i = 0; i < rosterRows.length; i++) {
    const r        = rosterRows[i];
    const charName = String(r[0] ?? '').trim();
    const status   = String(r[4] ?? '').trim().toLowerCase();
    const existing = String(r[7] ?? '').trim(); // col H

    if (!charName || status === 'deleted') continue;

    if (existing) {
      // Already has a charId — just record it for downstream steps
      charIdByName.set(charName.toLowerCase(), existing);
      continue;
    }

    const charId = randomUUID();
    charIdByName.set(charName.toLowerCase(), charId);
    rosterUpdates.push({ range: `Roster!H${i + 2}`, values: [[charId]] });
  }

  await batchWriteChunked(sheetId, rosterUpdates, 'Roster!H (charId)');
  console.log(`  Roster: ${charIdByName.size} characters mapped (${rosterUpdates.length} new IDs generated)\n`);

  // ── Step 2: BIS Submissions — fill col N from charName lookup ───────────────

  console.log('Step 2: BIS Submissions — writing charId to col N…');

  // Schema (new): A=Id B=CharName C=Spec D=Slot … M=RaidBISItemId N=CharId
  const bisRows    = await readRange(sheetId, 'BIS Submissions!A2:N');
  const bisUpdates  = [];
  const bisMissing  = new Set(); // charNames that couldn't be linked

  for (let i = 0; i < bisRows.length; i++) {
    const r        = bisRows[i];
    const id       = String(r[0]  ?? '').trim();
    const charName = String(r[1]  ?? '').trim();
    const existing = String(r[13] ?? '').trim(); // col N

    if (!id || !charName || existing) continue;  // blank row or already migrated

    const charId = charIdByName.get(charName.toLowerCase());
    if (!charId) {
      bisMissing.add(charName);
      continue;
    }

    bisUpdates.push({ range: `BIS Submissions!N${i + 2}`, values: [[charId]] });
  }

  await batchWriteChunked(sheetId, bisUpdates, 'BIS Submissions!N (charId)');
  if (bisMissing.size) console.warn(`  ⚠  ${bisMissing.size} BIS rows could not be linked (char not in roster): ${[...bisMissing].sort().join(', ')}`);
  console.log();

  // ── Step 3: Loot Log — fill col K from recipientChar lookup ─────────────────

  console.log('Step 3: Loot Log — writing recipientCharId to col K…');

  // Schema (new): A=Id … H=RecipientChar … J=Notes K=RecipientCharId
  const lootRows    = await readRange(sheetId, 'Loot Log!A2:K');
  const lootUpdates  = [];
  const lootMissing  = new Set(); // charNames that couldn't be linked

  for (let i = 0; i < lootRows.length; i++) {
    const r             = lootRows[i];
    const id            = String(r[0]  ?? '').trim();
    const recipientChar = String(r[7]  ?? '').trim(); // col H
    const existing      = String(r[10] ?? '').trim(); // col K

    if (!id || !recipientChar || existing) continue;

    const charId = charIdByName.get(recipientChar.toLowerCase());
    if (!charId) {
      lootMissing.add(recipientChar);
      continue;
    }

    lootUpdates.push({ range: `Loot Log!K${i + 2}`, values: [[charId]] });
  }

  await batchWriteChunked(sheetId, lootUpdates, 'Loot Log!K (recipientCharId)');
  if (lootMissing.size) console.warn(`  ⚠  ${lootMissing.size} loot rows could not be linked (char not in roster): ${[...lootMissing].sort().join(', ')}`);
  console.log();

  // ── Summary ─────────────────────────────────────────────────────────────────

  console.log(`--- ${teamName || sheetId.slice(-6)} complete ---`);
  console.log(`  Roster charIds written:     ${rosterUpdates.length}`);
  console.log(`  BIS charIds written:        ${bisUpdates.length}`);
  console.log(`  Loot log charIds written:   ${lootUpdates.length}`);

  const allMissing = new Set([...bisMissing, ...lootMissing]);
  if (allMissing.size) {
    console.warn(`\n  ⚠  The following character name(s) appear in linked data but have no matching`);
    console.warn(`     active roster entry. These rows will fall back to name-based joins until`);
    console.warn(`     you resolve the discrepancy and re-run the script:`);
    for (const name of [...allMissing].sort()) {
      const inBis  = bisMissing.has(name)  ? 'BIS'      : '';
      const inLoot = lootMissing.has(name) ? 'Loot Log' : '';
      const sources = [inBis, inLoot].filter(Boolean).join(', ');
      console.warn(`       • ${name}  (${sources})`);
    }
  }
  console.log();

  return { rosterUpdates: rosterUpdates.length, bisUpdates: bisUpdates.length, lootUpdates: lootUpdates.length, bisMissing: allMissing.size, lootMissing: lootMissing.size };
}

// ── Run ────────────────────────────────────────────────────────────────────────

let totalRoster = 0, totalBis = 0, totalLoot = 0;

for (const { name, sheetId } of teamSheetIds) {
  const result = await migrateTeam(sheetId, name);
  totalRoster += result.rosterUpdates;
  totalBis    += result.bisUpdates;
  totalLoot   += result.lootUpdates;
}

if (teamSheetIds.length > 1) {
  console.log('=== All teams migrated ===');
  console.log(`  Total roster charIds written:     ${totalRoster}`);
  console.log(`  Total BIS charIds written:        ${totalBis}`);
  console.log(`  Total loot log charIds written:   ${totalLoot}`);
} else {
  console.log('=== Migration complete ===');
}
