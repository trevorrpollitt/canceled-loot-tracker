/**
 * test-worn-bis.js — Dry-run worn BIS extraction for a single character + report.
 *
 * Fetches CombatantInfo from the most recent fight in a WCL report, runs the
 * worn BIS matching logic, and prints what would be written to the Worn BIS sheet.
 * Nothing is written.
 *
 * Usage:
 *   node --env-file=.env scripts/test-worn-bis.js --report <code> --char <name>
 *   node --env-file=.env scripts/test-worn-bis.js --report <code> --char <name> --team <name>
 *
 * Options:
 *   --report <code>   WCL report code (required)
 *   --char   <name>   Character name to inspect (required)
 *   --team   <name>   Restrict search to this team (optional; searches all teams if omitted)
 *   --all             Show all slots, including those with no BIS match (OtherTrack only)
 */

import { getGlobalConfig, getConfig, getTeamRegistry, getRoster, getBisSubmissions, getEffectiveDefaultBis, getItemDb, getTierItems } from '../src/lib/sheets.js';
import { getReportFights, getCombatantInfo } from '../src/lib/wcl.js';
import { matchesBis } from '../src/lib/bis-match.js';
import { getArmorType, toCanonical } from '../src/lib/specs.js';

// ── Args ───────────────────────────────────────────────────────────────────────

const args        = process.argv.slice(2);
const get         = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const filterReport = get('--report');
const filterChar   = get('--char')?.toLowerCase();
const filterTeam   = get('--team')?.toLowerCase();
const showAll      = args.includes('--all');

if (!filterReport || !filterChar) {
  console.error('Usage: node --env-file=.env scripts/test-worn-bis.js --report <code> --char <name> [--team <name>] [--all]');
  process.exit(1);
}

// ── Helpers (must match wcl-sync.js) ──────────────────────────────────────────

function findTierPieces(gear, tierItemMap, trackRanges) {
  const pieces = [];
  for (const item of gear ?? []) {
    const slot = tierItemMap.get(Number(item.id));
    if (slot == null) continue;
    let track = 'Unknown';
    for (const bonusId of item.bonusIDs ?? []) {
      const row = trackRanges.find(r => bonusId >= r.bonusId && bonusId <= r.bonusId + 7);
      if (row) { track = row.track; break; }
    }
    pieces.push({ slot, track });
  }
  return pieces;
}

// ── Constants (must match wcl-sync.js) ────────────────────────────────────────

const WCL_SLOT_MAP = {
  0:  'Head',      1:  'Neck',       2:  'Shoulders',
  4:  'Chest',     5:  'Waist',      6:  'Legs',       7:  'Feet',
  8:  'Wrists',    9:  'Hands',      10: 'Ring 1',     11: 'Ring 2',
  12: 'Trinket 1', 13: 'Trinket 2',  14: 'Back',       15: 'Weapon',
  16: 'Off-Hand',
};

const PAIRED_BIS_SLOTS = {
  'Ring 1':    ['Ring 1', 'Ring 2'],
  'Ring 2':    ['Ring 1', 'Ring 2'],
  'Trinket 1': ['Trinket 1', 'Trinket 2'],
  'Trinket 2': ['Trinket 1', 'Trinket 2'],
};

const TRACK_NAMES = ['Veteran', 'Champion', 'Hero', 'Mythic'];
const TRACK_ORDER = { Crafted: -1, Veteran: 0, Champion: 1, Hero: 2, Mythic: 3 };

function buildTrackRanges(veteranStartId) {
  if (!veteranStartId) return [];
  return TRACK_NAMES.map((track, i) => ({ bonusId: veteranStartId + i * 8, track }));
}

function getItemTrack(bonusIDs, trackRanges) {
  for (const bonusId of bonusIDs ?? []) {
    const row = trackRanges.find(r => bonusId >= r.bonusId && bonusId <= r.bonusId + 7);
    if (row) return row.track;
  }
  return 'Unknown';
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function pass(msg)    { console.log(`  ✓ ${msg}`); }
function fail(msg)    { console.log(`  ✗ ${msg}`); }
function info(msg)    { console.log(`    ${msg}`); }
function section(msg) { console.log(`\n── ${msg}`); }

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Worn BIS Dry Run — report: ${filterReport}  char: ${filterChar}\n`);

  // ── Step 1: Global config ──────────────────────────────────────────────────
  section('Step 1: Global config + WCL credentials');
  const globalConfig      = await getGlobalConfig();
  const { wcl_client_id, wcl_veteran_bonus_id, wcl_crafted_bonus_ids } = globalConfig;
  const wcl_client_secret = process.env.WCL_CLIENT_SECRET;
  const trackRanges       = buildTrackRanges(Number(wcl_veteran_bonus_id) || 0);
  const craftedBonusIds   = new Set(
    String(wcl_crafted_bonus_ids ?? '').split('|').map(Number).filter(Boolean)
  );

  wcl_client_id     ? pass(`wcl_client_id: ${wcl_client_id}`)                    : fail('wcl_client_id not set');
  wcl_client_secret ? pass('WCL_CLIENT_SECRET: (set)')                            : fail('WCL_CLIENT_SECRET not set in env');
  wcl_veteran_bonus_id
    ? pass(`wcl_veteran_bonus_id: ${wcl_veteran_bonus_id}  →  ${trackRanges.map(r => `${r.track} ${r.bonusId}–${r.bonusId+7}`).join(', ')}`)
    : fail('wcl_veteran_bonus_id not set — all tracks will show Unknown');
  craftedBonusIds.size
    ? pass(`wcl_crafted_bonus_ids: [${[...craftedBonusIds].join(', ')}]`)
    : info('wcl_crafted_bonus_ids not set — crafted items will not be detected');

  if (!wcl_client_id || !wcl_client_secret) process.exit(1);

  // ── Step 2: Find character across teams ───────────────────────────────────
  section(`Step 2: Find "${filterChar}" in roster`);
  const registry = await getTeamRegistry();
  const teams    = registry.filter(t => !filterTeam || t.name.toLowerCase() === filterTeam);

  let foundChar = null;
  let foundTeam = null;
  let bisLookup = new Map(); // slot → { trueBis, trueBisItemId, raidBis, raidBisItemId }

  for (const team of teams) {
    const roster = await getRoster(team.sheetId);
    const char   = roster.find(c => c.charName.toLowerCase() === filterChar);
    if (!char) continue;

    foundChar = char;
    foundTeam = team;

    pass(`Found: ${char.charName} (${char.spec}) on team "${team.name}"`);
    info(`charId: ${char.charId || '(none — not migrated)'}`);
    info(`class:  ${char.class ?? '?'}  →  armorType: ${getArmorType(char.class) ?? '?'}`);

    // Build effective BIS: spec defaults → overridden by personal approved submissions
    const [allSubs, effectiveDefaultBis] = await Promise.all([
      getBisSubmissions(team.sheetId),
      getEffectiveDefaultBis(),
    ]);

    // Seed from spec defaults
    const specDefaults = effectiveDefaultBis.filter(r => r.spec === toCanonical(char.spec));
    for (const row of specDefaults) {
      bisLookup.set(row.slot, { trueBis: row.trueBis, trueBisItemId: row.trueBisItemId, raidBis: row.raidBis, raidBisItemId: row.raidBisItemId });
    }

    // Override with personal approved submissions
    const approvedSubs = allSubs.filter(s => s.status === 'Approved');
    const byCharId     = char.charId ? approvedSubs.filter(s => s.charId === char.charId) : [];
    const byCharName   = approvedSubs.filter(s => s.charName.toLowerCase() === filterChar);
    const personalSubs = byCharId.length ? byCharId : byCharName;
    for (const s of personalSubs) {
      bisLookup.set(s.slot, { trueBis: s.trueBis, trueBisItemId: s.trueBisItemId, raidBis: s.raidBis, raidBisItemId: s.raidBisItemId });
    }

    pass(`BIS lookup: ${bisLookup.size} slot(s) — ${specDefaults.length} from spec defaults, ${personalSubs.length} personal submission(s) (${personalSubs.length ? (byCharId.length ? 'charId match' : 'charName fallback') : 'none'})`);
    for (const [slot, b] of bisLookup) {
      const isPersonal = personalSubs.some(s => s.slot === slot);
      info(`  ${slot.padEnd(12)}  Overall: ${(b.trueBis || '—').padEnd(35)}  Raid: ${(b.raidBis || '—').padEnd(35)}  [${isPersonal ? 'personal' : 'default'}]`);
    }
    break;
  }

  if (!foundChar) {
    fail(`Character "${filterChar}" not found in any team roster`);
    process.exit(1);
  }

  // ── Step 3: Load Item DB + Tier Items ─────────────────────────────────────
  section('Step 3: Load Item DB + Tier Items');
  const [itemDbRows, tierItemRows] = await Promise.all([getItemDb(), getTierItems()]);
  const itemDbMap  = new Map();
  for (const row of itemDbRows) itemDbMap.set(Number(row.itemId), row);
  pass(`${itemDbMap.size} item(s) loaded`);

  const tierItemMap = new Map(); // itemId → slot, for this character's class (resolved after actor found)
  const tierItemsByClass = new Map();
  for (const { class: cls, slot, itemId } of tierItemRows) {
    if (!tierItemsByClass.has(cls)) tierItemsByClass.set(cls, new Map());
    tierItemsByClass.get(cls).set(Number(itemId), slot);
  }
  pass(`${tierItemRows.length} tier item row(s) loaded`);

  // ── Step 4: Fetch report fights ────────────────────────────────────────────
  section(`Step 4: Fetch report ${filterReport}`);
  let reportData;
  try {
    reportData = await getReportFights(filterReport, wcl_client_id, wcl_client_secret);
    pass(`${reportData.fights?.length ?? 0} fight(s) in report`);
  } catch (err) {
    fail(`Failed: ${err.message}`);
    process.exit(1);
  }

  const { fights = [], masterData = {} } = reportData;
  const actors = masterData.actors ?? [];

  if (!fights.length) {
    fail('No fights in report');
    process.exit(1);
  }

  // Pick the most recent completed fight (same logic as wcl-sync.js)
  const completedFights  = fights.filter(f => !f.inProgress);
  const fightForSnapshot = (completedFights.length ? completedFights : fights)
    .reduce((a, b) => b.id > a.id ? b : a);
  info(`Using fight ${fightForSnapshot.id}: "${fightForSnapshot.name ?? '?'}" (${fightForSnapshot.kill ? 'kill' : 'wipe'})`);

  // ── Step 5: CombatantInfo ──────────────────────────────────────────────────
  section(`Step 5: Fetch CombatantInfo from fight ${fightForSnapshot.id}`);
  let combatantEvents;
  try {
    combatantEvents = await getCombatantInfo(filterReport, fightForSnapshot.id, wcl_client_id, wcl_client_secret);
    pass(`${combatantEvents.length} combatant event(s)`);
  } catch (err) {
    fail(`Failed: ${err.message}`);
    process.exit(1);
  }

  // Find this character's event
  const charActor = actors.find(a => a.name.toLowerCase() === filterChar);
  if (!charActor) {
    fail(`Actor "${filterChar}" not found in masterData.actors`);
    info(`Actors present: ${actors.filter(a => a.type === 'Player').map(a => a.name).join(', ')}`);
    process.exit(1);
  }
  pass(`Actor found: id=${charActor.id}  class=${charActor.subType ?? '?'}  server=${charActor.server ?? '(none)'}`);

  const charEvent = combatantEvents.find(e => e.sourceID === charActor.id);
  if (!charEvent) {
    fail(`No CombatantInfo event for actor ${charActor.id} in fight ${fightForSnapshot.id}`);
    process.exit(1);
  }
  pass(`CombatantInfo event found — ${charEvent.gear?.length ?? 0} gear slot(s) in array`);

  // ── Step 6: BIS lookup contents + matching diagnostics ────────────────────
  section('Step 6: BIS lookup vs gear (matching diagnostics)');

  const armorType  = getArmorType(charActor.subType);
  const charId     = foundChar.charId;
  const charName   = foundChar.charName;

  info(`armorType resolved from class "${charActor.subType}": ${armorType ?? '(null — class not recognised)'}`);
  console.log('');

  if (!bisLookup.size) {
    fail('bisLookup is empty — no defaults found for spec and no personal submissions');
  } else {
    // For each gear slot that has a BIS submission, show what we have vs what we're wearing
    for (const [slotIdx, slotName] of Object.entries(WCL_SLOT_MAP)) {
      const bisSlots = PAIRED_BIS_SLOTS[slotName] ?? [slotName];
      for (const bisSlot of bisSlots) {
        const charBis = bisLookup.get(bisSlot);
        if (!charBis) continue;

        const gearItem  = (charEvent.gear ?? [])[Number(slotIdx)];
        const dbEntry   = gearItem?.id ? itemDbMap.get(Number(gearItem.id)) : null;
        const itemShape = gearItem?.id ? {
          itemId:      String(gearItem.id),
          name:        dbEntry?.name ?? '',
          slot:        dbEntry?.slot ?? '',
          armorType:   dbEntry?.armorType ?? '',
          isTierToken: dbEntry?.isTierToken ?? false,
        } : null;

        const rawTrackDiag  = itemShape ? getItemTrack((charEvent.gear ?? [])[Number(slotIdx)]?.bonusIDs, trackRanges) : 'Unknown';
        const isCraftedDiag = rawTrackDiag === 'Unknown' &&
          ((charEvent.gear ?? [])[Number(slotIdx)]?.bonusIDs ?? []).some(id => craftedBonusIds.has(id));
        const matchesOverall = itemShape
          ? ((isCraftedDiag && charBis.trueBis === '<Crafted>') || charBis.trueBis === '<Catalyst>' || matchesBis(charBis.trueBis, charBis.trueBisItemId, itemShape, armorType, bisSlot))
          : false;
        const matchesRaid    = itemShape
          ? ((isCraftedDiag && charBis.raidBis === '<Crafted>') || charBis.raidBis === '<Catalyst>' || matchesBis(charBis.raidBis, charBis.raidBisItemId, itemShape, armorType, bisSlot))
          : false;

        const worn = gearItem?.id
          ? `id:${gearItem.id} "${dbEntry?.name ?? '(not in DB)'}"  track:${getItemTrack(gearItem.bonusIDs, trackRanges)}`
          : '(nothing equipped)';

        const bisOverall = charBis.trueBis ? `"${charBis.trueBis}" (id:${charBis.trueBisItemId || 'none'})` : '—';
        const bisRaid    = charBis.raidBis  ? `"${charBis.raidBis}" (id:${charBis.raidBisItemId || 'none'})`  : '—';

        const matchLabel = matchesOverall ? '✓ Overall' : matchesRaid ? '✓ Raid' : '✗ no match';

        console.log(`  [${bisSlot}]`);
        console.log(`      BIS Overall : ${bisOverall}`);
        console.log(`      BIS Raid    : ${bisRaid}`);
        console.log(`      Worn (${slotName.padEnd(10)}): ${worn}`);
        if (itemShape) {
          console.log(`      Item DB     : slot="${itemShape.slot}"  armorType="${itemShape.armorType}"  isTierToken=${itemShape.isTierToken}`);
          // Show raw char codes for name comparison if names look identical
          if (charBis.trueBis && itemShape.name && charBis.trueBis.toLowerCase() !== itemShape.name.toLowerCase()) {
            const bisChars  = [...charBis.trueBis].map(c => c.charCodeAt(0).toString(16)).join(' ');
            const nameChars = [...itemShape.name].map(c => c.charCodeAt(0).toString(16)).join(' ');
            console.log(`      ⚠ Name mismatch (possible encoding diff):`);
            console.log(`        BIS  hex: ${bisChars}`);
            console.log(`        DB   hex: ${nameChars}`);
          }
        }
        console.log(`      Result      : ${matchLabel}`);
        console.log('');
      }
    }
  }

  // ── Step 6b: Worn BIS extraction ──────────────────────────────────────────
  section('Step 6b: Worn BIS extraction');

  // Rows keyed by bisSlot
  const result = new Map(); // bisSlot → { overallBISTrack, raidBISTrack, otherTrack, itemId, itemName, track }

  let unknownSkipped = 0;
  let craftedDetected = 0;

  for (const [slotIdx, slotName] of Object.entries(WCL_SLOT_MAP)) {
    const gearItem = (charEvent.gear ?? [])[Number(slotIdx)];
    if (!gearItem || !gearItem.id || gearItem.id === 0) continue;

    const rawTrack       = getItemTrack(gearItem.bonusIDs, trackRanges);
    const matchedCraftedId = rawTrack === 'Unknown'
      ? (gearItem.bonusIDs ?? []).find(id => craftedBonusIds.has(id))
      : undefined;
    const isCrafted      = matchedCraftedId !== undefined;

    if (rawTrack === 'Unknown') {
      if (isCrafted) {
        craftedDetected++;
        info(`  [crafted] slot ${slotName.padEnd(10)} item ${gearItem.id} — matched bonus ID ${matchedCraftedId}  (all bonusIDs: [${(gearItem.bonusIDs ?? []).join(', ')}])`);
      } else {
        unknownSkipped++;
        info(`  [unknown] slot ${slotName.padEnd(10)} item ${gearItem.id} — no match in craftedBonusIds=[${[...craftedBonusIds].join(', ') || 'empty'}]  bonusIDs: [${(gearItem.bonusIDs ?? []).join(', ')}]`);
        continue;
      }
    }

    const track   = isCrafted ? 'Crafted' : rawTrack;
    const dbEntry = itemDbMap.get(Number(gearItem.id));
    const itemShape = {
      itemId:      String(gearItem.id),
      name:        dbEntry?.name ?? '',
      slot:        dbEntry?.slot ?? '',
      armorType:   dbEntry?.armorType ?? '',
      isTierToken: dbEntry?.isTierToken ?? false,
    };

    const bisSlots = PAIRED_BIS_SLOTS[slotName] ?? [slotName];
    let matchedAnyBis = false;

    for (const bisSlot of bisSlots) {
      const charBis = bisLookup.get(bisSlot);
      if (!charBis) continue;

      const matchesOverall = (isCrafted && charBis.trueBis === '<Crafted>') ||
        charBis.trueBis === '<Catalyst>' ||
        matchesBis(charBis.trueBis, charBis.trueBisItemId, itemShape, armorType, bisSlot);
      const matchesRaid    = (isCrafted && charBis.raidBis === '<Crafted>') ||
        charBis.raidBis === '<Catalyst>' ||
        matchesBis(charBis.raidBis, charBis.raidBisItemId, itemShape, armorType, bisSlot);
      if (!matchesOverall && !matchesRaid) continue;

      matchedAnyBis = true;
      const recordTrack = isCrafted ? 'Crafted' : track;
      const prev = result.get(bisSlot) ?? { overallBISTrack: '', raidBISTrack: '', otherTrack: '', items: [] };
      result.set(bisSlot, {
        ...prev,
        overallBISTrack: matchesOverall ? (TRACK_ORDER[prev.overallBISTrack] >= TRACK_ORDER[recordTrack] ? prev.overallBISTrack : recordTrack) : prev.overallBISTrack,
        raidBISTrack:    matchesRaid    ? (TRACK_ORDER[prev.raidBISTrack]    >= TRACK_ORDER[recordTrack] ? prev.raidBISTrack    : recordTrack) : prev.raidBISTrack,
        items: [...prev.items, { slotName, itemId: gearItem.id, name: dbEntry?.name ?? `id:${gearItem.id}`, track: recordTrack, matchesOverall, matchesRaid }],
      });
    }

    if (!matchedAnyBis) {
      const prev = result.get(slotName) ?? { overallBISTrack: '', raidBISTrack: '', otherTrack: '', items: [] };
      const otherVal = isCrafted ? 'Crafted' : track;
      const newOtherTrack = (TRACK_ORDER[prev.otherTrack] ?? -2) >= (TRACK_ORDER[otherVal] ?? -2)
        ? prev.otherTrack : otherVal;
      result.set(slotName, {
        ...prev,
        otherTrack: newOtherTrack,
        items: [...prev.items, { slotName, itemId: gearItem.id, name: dbEntry?.name ?? `id:${gearItem.id}`, track: otherVal, matchesOverall: false, matchesRaid: false }],
      });
    }
  }

  if (unknownSkipped || craftedDetected) {
    console.log('');
    info(`Unknown-track items: ${craftedDetected} detected as Crafted, ${unknownSkipped} skipped (no match in craftedBonusIds)`);
  }

  // ── Step 6c: Tier piece post-processing ───────────────────────────────────
  // extractWornBis can't detect <Tier> BIS matches — it doesn't have tierItemsByClass.
  // Re-use findTierPieces on the same gear to fill those slots in.
  section('Step 6c: Tier piece detection');
  const charTierItemMap = tierItemsByClass.get(charActor.subType) ?? new Map();
  const tierPieces = findTierPieces(charEvent.gear, charTierItemMap, trackRanges);
  if (tierPieces.length) {
    pass(`${tierPieces.length} tier piece(s) detected: ${tierPieces.map(p => `${p.slot}:${p.track}`).join(', ')}`);
  } else {
    info('No tier pieces detected');
  }

  for (const { slot, track } of tierPieces) {
    if (track === 'Unknown') continue;
    const charBis = bisLookup.get(slot);
    if (!charBis) continue;
    const matchesOverall = charBis.trueBis === '<Tier>';
    const matchesRaid    = charBis.raidBis  === '<Tier>';
    if (!matchesOverall && !matchesRaid) continue;

    const charIdKey = foundChar.charId || `name:${foundChar.charName.toLowerCase()}`;
    const key  = `${charIdKey}:${slot}`;
    const prev = result.get(slot) ?? { overallBISTrack: '', raidBISTrack: '', otherTrack: '', items: [] };
    result.set(slot, {
      ...prev,
      overallBISTrack: matchesOverall ? (TRACK_ORDER[prev.overallBISTrack] >= TRACK_ORDER[track] ? prev.overallBISTrack : track) : prev.overallBISTrack,
      raidBISTrack:    matchesRaid    ? (TRACK_ORDER[prev.raidBISTrack]    >= TRACK_ORDER[track] ? prev.raidBISTrack    : track) : prev.raidBISTrack,
      items: [...prev.items, { slotName: slot, itemId: null, name: `(tier piece — ${slot})`, track, matchesOverall, matchesRaid }],
    });
    info(`  ${slot}: ${track} — ${matchesOverall ? 'Overall BIS' : ''}${matchesRaid ? ' Raid BIS' : ''}`);
  }

  // ── Step 7: Print results ──────────────────────────────────────────────────
  section('Step 7: Worn BIS rows that would be written');
  console.log('');

  const colW = [12, 16, 16, 12, 50];
  const header = ['Slot'.padEnd(colW[0]), 'OverallBISTrack'.padEnd(colW[1]), 'RaidBISTrack'.padEnd(colW[2]), 'OtherTrack'.padEnd(colW[3]), 'Item(s) worn'];
  console.log('  ' + header.join('  '));
  console.log('  ' + '─'.repeat(colW.reduce((a, b) => a + b, 0) + colW.length * 2));

  const allBisSlots = [
    'Head', 'Neck', 'Shoulders', 'Back', 'Chest', 'Wrists', 'Hands', 'Waist', 'Legs', 'Feet',
    'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2', 'Weapon', 'Off-Hand',
  ];

  let writeCount = 0;
  for (const slot of allBisSlots) {
    const row = result.get(slot);
    if (!row) continue;
    if (!showAll && !row.overallBISTrack && !row.raidBISTrack && !row.otherTrack) continue;

    const itemSummary = row.items
      .map(i => {
        const tags = [];
        if (i.matchesOverall) tags.push('Overall');
        if (i.matchesRaid)    tags.push('Raid');
        const label = tags.length ? `[${tags.join('+')}]` : '[Other]';
        return `${i.name || `id:${i.itemId}`} (${i.track}) ${label}`;
      })
      .join(', ');

    console.log('  ' + [
      slot.padEnd(colW[0]),
      (row.overallBISTrack || '—').padEnd(colW[1]),
      (row.raidBISTrack    || '—').padEnd(colW[2]),
      (row.otherTrack      || '—').padEnd(colW[3]),
      itemSummary,
    ].join('  '));
    writeCount++;
  }

  if (!writeCount) {
    info('No rows would be written (no items with recognised tracks matched BIS or were found).');
    info('Try --all to show all slots including Other-only and Unknown-track items.');
  }

  // ── Step 8: Raw gear dump (for verifying slot indices) ────────────────────
  section('Step 8: Raw gear array (verify slot indices)');
  const gear = charEvent.gear ?? [];
  console.log('');
  console.log(`  ${'Idx'.padEnd(5)}  ${'SlotName'.padEnd(12)}  ${'ItemId'.padEnd(10)}  ${'Track'.padEnd(10)}  Name`);
  console.log(`  ${'─'.repeat(70)}`);
  for (let i = 0; i < gear.length; i++) {
    const item     = gear[i];
    const slotName = WCL_SLOT_MAP[i] ?? '(skip)';
    if (!item?.id || item.id === 0) {
      if (WCL_SLOT_MAP[i]) console.log(`  ${String(i).padEnd(5)}  ${slotName.padEnd(12)}  ${'(empty)'.padEnd(10)}`);
      continue;
    }
    const track    = getItemTrack(item.bonusIDs, trackRanges);
    const dbEntry  = itemDbMap.get(Number(item.id));
    const name     = dbEntry?.name ?? '(not in Item DB)';
    const extra    = track === 'Unknown' ? `  bonusIDs: [${(item.bonusIDs ?? []).join(', ')}]` : '';
    console.log(`  ${String(i).padEnd(5)}  ${slotName.padEnd(12)}  ${String(item.id).padEnd(10)}  ${track.padEnd(10)}  ${name}${extra}`);
  }

  console.log('\n\nDry run complete — nothing was written.');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
