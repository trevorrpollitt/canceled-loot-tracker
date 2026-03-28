/**
 * fix-recipe-upgrade-types.js — Backfill: set UpgradeType = Tertiary for
 * any Loot Log row whose item name is a crafting recipe.
 *
 * Recipes (Pattern:, Plans:, Recipe:, etc.) should never count toward loot
 * totals. Historical rows may have been imported as BIS or Non-BIS via RCLC
 * before this rule was added.
 *
 * Usage:
 *   # Dry run — shows what would change, writes nothing:
 *   node --env-file=.env scripts/fix-recipe-upgrade-types.js --dry-run
 *
 *   # All teams (reads team list from master sheet):
 *   node --env-file=.env scripts/fix-recipe-upgrade-types.js
 *
 *   # Single team sheet:
 *   node --env-file=.env scripts/fix-recipe-upgrade-types.js <teamSheetId>
 *
 * Safe to re-run — rows already set to Tertiary are skipped.
 */

import { readRange, batchWriteRanges } from '../src/lib/sheets.js';
import { isRecipeItem } from '../src/lib/rclc.js';

const DRY_RUN     = process.argv.includes('--dry-run');
const argSheetId  = process.argv.find(a => !a.startsWith('--') && a !== process.argv[1] && a !== process.argv[0]);
const masterSheetId = process.env.MASTER_SHEET_ID;

// ── Resolve team sheet IDs ─────────────────────────────────────────────────────

let teamSheetIds;

if (argSheetId) {
  teamSheetIds = [{ name: '', sheetId: argSheetId }];
} else if (masterSheetId) {
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
  console.error('Usage: node --env-file=.env scripts/fix-recipe-upgrade-types.js [--dry-run] [teamSheetId]');
  console.error('       MASTER_SHEET_ID env var must be set if no teamSheetId is provided.');
  process.exit(1);
}

if (DRY_RUN) console.log('*** DRY RUN — no changes will be written ***\n');

// ── Per-team fix ───────────────────────────────────────────────────────────────

// Loot Log schema: A=Id B=RaidId C=Date D=Boss E=ItemName F=Difficulty
//                  G=RecipientId H=RecipientChar I=UpgradeType J=Notes K=RecipientCharId

async function fixTeam(sheetId, teamName = '') {
  const label = teamName ? `${teamName} (${sheetId.slice(-6)})` : sheetId;
  console.log(`=== ${label} ===`);

  const rows = await readRange(sheetId, 'Loot Log!A2:I');

  const updates = [];

  for (let i = 0; i < rows.length; i++) {
    const r           = rows[i];
    const id          = String(r[0] ?? '').trim();
    const itemName    = String(r[4] ?? '').trim(); // col E
    const upgradeType = String(r[8] ?? '').trim(); // col I

    if (!id || !itemName) continue;
    if (!isRecipeItem(itemName)) continue;
    if (upgradeType === 'Tertiary') continue; // already correct

    const rowNum = i + 2;
    console.log(`  row ${rowNum}: "${itemName}" — ${upgradeType || '(blank)'} → Tertiary`);
    updates.push({ range: `Loot Log!I${rowNum}`, values: [['Tertiary']] });
  }

  if (!updates.length) {
    console.log('  Nothing to update.\n');
    return 0;
  }

  console.log(`  ${updates.length} row(s) to update${DRY_RUN ? ' (dry run — skipping write)' : ''}…`);

  if (!DRY_RUN) {
    // Write in chunks of 50 to stay well within rate limits
    for (let i = 0; i < updates.length; i += 50) {
      await batchWriteRanges(sheetId, updates.slice(i, i + 50));
    }
    console.log(`  ✓ Done.\n`);
  } else {
    console.log();
  }

  return updates.length;
}

// ── Run ────────────────────────────────────────────────────────────────────────

let total = 0;

for (const { name, sheetId } of teamSheetIds) {
  total += await fixTeam(sheetId, name);
}

if (teamSheetIds.length > 1) {
  console.log(`=== All teams done — ${total} row(s) ${DRY_RUN ? 'would be' : ''} updated ===`);
} else {
  console.log(`=== Done — ${total} row(s) ${DRY_RUN ? 'would be' : ''} updated ===`);
}
