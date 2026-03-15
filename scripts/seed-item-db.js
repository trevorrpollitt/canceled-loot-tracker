/**
 * seed-item-db.js — Populates the Item DB tab of a team's Google Sheet
 * with items from the Blizzard Game Data API.
 *
 * Usage:
 *   # List all journal instances to find the right ID:
 *   node --env-file=.env scripts/seed-item-db.js list
 *
 *   # Seed raid items from a specific instance:
 *   node --env-file=.env scripts/seed-item-db.js raid <instanceId> <sheetId> [difficulty]
 *
 *   # Seed M+ dungeon items from a specific instance:
 *   node --env-file=.env scripts/seed-item-db.js dungeon <instanceId> <sheetId>
 *
 * difficulty defaults to MYTHIC for raids, MYTHIC_KEYSTONE for dungeons.
 *
 * Examples:
 *   node --env-file=.env scripts/seed-item-db.js list
 *   node --env-file=.env scripts/seed-item-db.js raid 1273 1JeNNRz...
 */

import { listInstances, fetchRaidItems, getInstance, getItemDetails, pLimit } from './blizzard.js';

// Blizzard category.type values for journal instances
const DUNGEON_CATEGORY_TYPES = new Set(['DUNGEON', 'MYTHIC_PLUS_DUNGEON']);
import { fetchWowheadItems, extractItemIdsFromPage, fetchS1MplusGuide } from './wowhead.js';
import { writeItemDb, getConfig }                               from '../src/lib/sheets.js';

// ── Slot mapping ──────────────────────────────────────────────────────────────

const INVENTORY_SLOT = {
  HEAD:        'Head',
  NECK:        'Neck',
  SHOULDER:    'Shoulders',
  CHEST:       'Chest',
  ROBE:        'Chest',       // cloth chest pieces
  WAIST:       'Waist',
  LEGS:        'Legs',
  FEET:        'Feet',
  WRIST:       'Wrists',
  HAND:        'Hands',
  FINGER:      'Ring',
  TRINKET:     'Trinket',
  BACK:        'Back',
  CLOAK:       'Back',        // some back items use this type
  WEAPON:      'Weapon',
  RANGED:      'Weapon',
  RANGEDRIGHT: 'Weapon',      // wands / off-hand ranged
  TWO_HAND:    'Weapon',
  TWOHWEAPON:  'Weapon',      // alternate two-hand type string
  MAIN_HAND:   'Weapon',
  SHIELD:      'Off-Hand',
  OFF_HAND:    'Off-Hand',
  HOLDABLE:    'Off-Hand',    // held-in-off-hand (tomes, relics, etc.)
};

// ── Tier token detection ───────────────────────────────────────────────────────
//
// Midnight uses two NON_EQUIP tier token families:
//
//   Nullcore  — Head/Shoulders/Hands/Legs
//     Format:  <ArmorPrefix> <SlotWord> Nullcore
//     Example: Voidforged Fanatical Nullcore  (Plate, Head)
//
//   Riftbloom — Chest only
//     Format:  <ArmorPrefix> Riftbloom
//     Example: Alnforged Riftbloom  (Plate, Chest)
//
// Armor type is inferred from the suffix of the first word (shared convention):
//   *forged → Plate   *cast → Mail   *cured → Leather   *woven → Cloth
//
// Nullcore slot word (second word):
//   Fanatical → Head   Unraveled → Shoulders   Hungering → Hands   Corrupted → Legs
//
// Legacy expansions used Conqueror/Protector/Vanquisher tokens — also supported.

// Maps the trailing suffix of the first word to an armor type.
// Handles any prefix (Void*, Aln*, future variants) automatically.
const ARMOR_WORD_SUFFIX = {
  forged: 'Plate',
  cast:   'Mail',
  cured:  'Leather',
  woven:  'Cloth',
};

function armorTypeFromWord(word) {
  const lower = word.toLowerCase();
  for (const [suffix, type] of Object.entries(ARMOR_WORD_SUFFIX)) {
    if (lower.endsWith(suffix)) return type;
  }
  return null;
}

// Second word of a Nullcore token → slot
const NULLCORE_SLOT_WORD = {
  Fanatical: 'Head',
  Unraveled: 'Shoulders',
  Hungering: 'Hands',
  Corrupted: 'Legs',
};

// Legacy: Conqueror/Protector/Vanquisher tokens
const LEGACY_TOKEN_SUFFIXES = new Set(['Conqueror', 'Protector', 'Vanquisher']);
const LEGACY_SLOT_KEYWORDS  = [
  ['Head',      ['Helm', 'Helmet', 'Hood', 'Crown', 'Circlet', 'Cap', 'Headpiece']],
  ['Shoulders', ['Mantle', 'Spaulders', 'Pauldrons', 'Shoulderguards', 'Shoulderpads', 'Epaulets']],
  ['Chest',     ['Chestplate', 'Chestguard', 'Tunic', 'Robes', 'Robe', 'Vest', 'Hauberk', 'Breastplate', 'Jerkin', 'Coat']],
  ['Hands',     ['Gloves', 'Gauntlets', 'Handguards', 'Grips', 'Mitts']],
  ['Legs',      ['Leggings', 'Legplates', 'Breeches', 'Trousers', 'Greaves', 'Kilt']],
];

function isNullcore(name)   { return name.endsWith('Nullcore'); }
function isRiftbloom(name)  { return name.endsWith('Riftbloom'); }
function isLegacyToken(name) {
  return name.split(/\s+/).some(w => LEGACY_TOKEN_SUFFIXES.has(w.replace(/[''\u2019]s$/i, '')));
}

function looksLikeTierToken(name) {
  return isNullcore(name) || isRiftbloom(name) || isLegacyToken(name);
}

/**
 * Returns { slot, armorType } for a tier token, or null if unrecognised.
 */
function inferTierToken(name) {
  const words = name.split(/\s+/);

  if (isNullcore(name)) {
    const armorType = armorTypeFromWord(words[0]);
    const slot      = NULLCORE_SLOT_WORD[words[1]] ?? null;
    if (!slot) {
      console.log(`  ⚠ Nullcore with unknown slot keyword "${words[1]}" — add to NULLCORE_SLOT_WORD: ${name}`);
      return null;
    }
    return { slot, armorType: armorType ?? 'Tier Token' };
  }

  if (isRiftbloom(name)) {
    const armorType = armorTypeFromWord(words[0]);
    if (!armorType) {
      console.log(`  ⚠ Riftbloom with unknown armor prefix "${words[0]}" — add suffix to ARMOR_WORD_SUFFIX: ${name}`);
      return null;
    }
    return { slot: 'Chest', armorType };
  }

  // Legacy Conqueror/Protector/Vanquisher
  for (const [slot, keywords] of LEGACY_SLOT_KEYWORDS) {
    if (keywords.some(kw => name.includes(kw))) return { slot, armorType: 'Tier Token' };
  }
  return null;
}

const ARMOR_SUBCLASS = {
  1: 'Cloth',
  2: 'Leather',
  3: 'Mail',
  4: 'Plate',
};

const ACCESSORY_SLOTS = new Set(['Neck', 'Back', 'Ring', 'Trinket', 'Weapon', 'Off-Hand']);

const TIER_SLOTS = new Set(['Head', 'Shoulders', 'Chest', 'Hands', 'Legs']);

const DIFFICULTY_LABEL = {
  MYTHIC:           'Mythic',
  HEROIC:           'Heroic',
  NORMAL:           'Normal',
  LOOKING_FOR_RAID: 'LFR',
  MYTHIC_KEYSTONE:  'Mythic+',
};

// ── Item mapping ──────────────────────────────────────────────────────────────

function mapItem({ details, encounterName, instanceName, difficulty }) {
  const invTypeId = details.inventory_type?.type;
  let slot        = INVENTORY_SLOT[invTypeId];

  // NON_EQUIP: only keep if it looks like a tier token
  if (!slot && invTypeId === 'NON_EQUIP') {
    if (looksLikeTierToken(details.name)) {
      const tier = inferTierToken(details.name);
      if (tier) {
        console.log(`  [${details.id}] ${details.name} → tier token (${tier.slot} / ${tier.armorType})`);
        return {
          itemId:      String(details.id),
          name:        details.name,
          slot:        tier.slot,
          sourceType:  difficulty === 'MYTHIC_KEYSTONE' ? 'Mythic+' : 'Raid',
          sourceName:  encounterName,
          instance:    instanceName,
          difficulty:  DIFFICULTY_LABEL[difficulty] ?? difficulty,
          armorType:   tier.armorType,
          isTierToken: 'TRUE',
        };
      }
    }
    console.log(`  SKIP [NON_EQUIP] ${details.name}`);
    return null;
  }

  if (!slot) {
    console.log(`  SKIP [${invTypeId ?? 'null'}] ${details.name}`);
    return null;
  }

  const isAccessory = ACCESSORY_SLOTS.has(slot);
  const armorSubId  = details.item_subclass?.id;
  const armorType   = isAccessory ? 'Accessory' : (ARMOR_SUBCLASS[armorSubId] ?? 'Accessory');

  // Tier: equippable item that belongs to a set and occupies a tier slot
  const isTierToken = TIER_SLOTS.has(slot) && details.item_set != null;

  // Weapon type (e.g. "Sword", "Staff", "Dagger") — only for weapon slots
  const weaponType = (slot === 'Weapon' || slot === 'Off-Hand')
    ? (details.item_subclass?.name ?? '')
    : '';

  return {
    itemId:      String(details.id),
    name:        details.name,
    slot,
    sourceType:  difficulty === 'MYTHIC_KEYSTONE' ? 'Mythic+' : 'Raid',
    sourceName:  encounterName,
    instance:    instanceName,
    difficulty:  DIFFICULTY_LABEL[difficulty] ?? difficulty,
    armorType,
    isTierToken: isTierToken ? 'TRUE' : 'FALSE',
    weaponType,
  };
}

// ── Wowhead slot mapping ──────────────────────────────────────────────────────

// Wowhead `slot` field = WoW inventory type (numeric)
const WOWHEAD_INV_SLOT = {
  1:  'Head',
  2:  'Neck',
  3:  'Shoulders',
  5:  'Chest',
  6:  'Waist',
  7:  'Legs',
  8:  'Feet',
  9:  'Wrists',
  10: 'Hands',
  11: 'Ring',
  12: 'Trinket',
  13: 'Weapon',    // One-Hand
  14: 'Off-Hand',  // Shield / Off-Hand
  15: 'Weapon',    // Ranged
  16: 'Back',
  17: 'Weapon',    // Two-Hand
  20: 'Chest',     // Robe (cloth)
  21: 'Weapon',    // Main Hand
  22: 'Off-Hand',  // Off-Hand (held)
  23: 'Off-Hand',  // Held in Off-Hand
  25: 'Weapon',    // Thrown
  26: 'Weapon',    // Wand / Gun
};

function mapWowheadItem(item, { sourceName, instanceName, difficulty }) {
  const { id, name, quality, slot: slotNum, subclass, classs } = item;

  // Skip below Rare quality
  if ((quality ?? 0) < 3) return null;

  // Non-equippable (slot 0 or missing) — check for tier token
  if (!slotNum) {
    if (looksLikeTierToken(name)) {
      const tier = inferTierToken(name);
      if (tier) {
        console.log(`  [${id}] ${name} → tier token (${tier.slot} / ${tier.armorType})`);
        return { itemId: String(id), name, slot: tier.slot, sourceType: difficulty === 'Mythic+' ? 'Mythic+' : 'Raid', sourceName, instance: instanceName, difficulty, armorType: tier.armorType, isTierToken: 'TRUE' };
      }
    }
    console.log(`  SKIP [non-equip] ${name}`);
    return null;
  }

  const slot = WOWHEAD_INV_SLOT[slotNum];
  if (!slot) {
    console.log(`  SKIP [slot ${slotNum}] ${name}`);
    return null;
  }

  const isAccessory = ACCESSORY_SLOTS.has(slot);
  let armorType;

  if (slot === 'Trinket') {
    armorType = 'Trinket';
  } else if (isAccessory) {
    armorType = 'Accessory';
  } else {
    // classs=4 is Armor; subclass=1-4 is Cloth/Leather/Mail/Plate
    armorType = ARMOR_SUBCLASS[subclass] ?? 'Accessory';
  }

  console.log(`  [${id}] ${name} | slot=${slot} armorType=${armorType}`);
  return {
    itemId:      String(id),
    name,
    slot,
    sourceType:  difficulty === 'Mythic+' ? 'Mythic+' : 'Raid',
    sourceName,
    instance:    instanceName,
    difficulty,
    armorType,
    isTierToken: 'FALSE',
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdList(search = '') {
  console.log('Fetching journal instances…\n');
  const instances = await listInstances();

  // Sort by ID descending (newest first)
  instances.sort((a, b) => b.id - a.id);

  const filtered = search
    ? instances.filter(i => i.name.toLowerCase().includes(search.toLowerCase()))
    : instances;

  if (!filtered.length) {
    console.log(`  No instances matching "${search}"`);
    return;
  }

  const width = Math.max(...filtered.map(i => i.name.length));
  for (const inst of filtered) {
    console.log(`  ${String(inst.id).padStart(5)}  ${inst.name.padEnd(width)}`);
  }
  console.log(`\n  (${filtered.length} result${filtered.length === 1 ? '' : 's'}${search ? ` matching "${search}"` : ''})`);
}

async function cmdRaid(instanceId, sheetId, difficulty = 'MYTHIC') {
  console.log(`\nFetching ${difficulty} items from instance ${instanceId}…\n`);

  const raw   = await fetchRaidItems(instanceId, difficulty);
  const items = raw.map(mapItem).filter(Boolean);

  console.log(`\nMapped ${items.length} equippable items. Writing to sheet…`);
  const written = await writeItemDb(sheetId, items, { replace });
  const skipped = items.length - written;
  console.log(`✓ Done. ${written} new rows written${skipped ? `, ${skipped} already existed (skipped)` : ''}.`);
}

async function cmdDungeon(instanceId, sheetId) {
  return cmdRaid(instanceId, sheetId, 'MYTHIC_KEYSTONE');
}

async function cmdWowhead(url, sheetId, sourceName, instanceName, difficulty = 'Mythic') {
  console.log(`\nFetching Wowhead item list…`);
  console.log(`  URL:      ${url}`);
  console.log(`  Source:   ${sourceName}`);
  console.log(`  Instance: ${instanceName}`);
  console.log(`  Diff:     ${difficulty}\n`);

  const raw   = await fetchWowheadItems(url);
  console.log(`  Found ${raw.length} total items on page\n`);

  const items = raw.map(item => mapWowheadItem(item, { sourceName, instanceName, difficulty })).filter(Boolean);

  console.log(`\nMapped ${items.length} equippable items. Writing to sheet…`);
  const written = await writeItemDb(sheetId, items, { replace });
  const skipped = items.length - written;
  console.log(`✓ Done. ${written} new rows written${skipped ? `, ${skipped} already existed (skipped)` : ''}.`);
}

/**
 * Fetch a Wowhead guide/loot page, extract item IDs from the links,
 * then call the Blizzard item endpoint directly for accurate details.
 * Avoids the broken journal encounter → item mapping entirely.
 */
async function cmdGuide(url, sheetId, sourceName, instanceName, difficulty = 'MYTHIC') {
  console.log(`\nFetching item IDs from Wowhead guide page…`);
  console.log(`  URL:      ${url}`);
  console.log(`  Source:   ${sourceName}`);
  console.log(`  Instance: ${instanceName}`);
  console.log(`  Diff:     ${DIFFICULTY_LABEL[difficulty] ?? difficulty}\n`);

  const ids = await extractItemIdsFromPage(url);
  console.log(`  Found ${ids.length} unique item IDs in page links\n`);

  if (!ids.length) {
    console.error('❌ No item IDs found. Make sure this is a Wowhead page with item links.');
    process.exit(1);
  }

  // Fetch item details from Blizzard API (5 concurrent requests)
  let fetched = 0;
  let failed  = 0;

  const tasks = ids.map(id => async () => {
    try {
      const details = await getItemDetails(id);
      fetched++;
      return mapItem({ details, encounterName: sourceName, instanceName, difficulty });
    } catch (err) {
      console.log(`  ❌ [${id}] ${err.message}`);
      failed++;
      return null;
    }
  });

  const results = await pLimit(tasks, 5);

  const items = results.filter(Boolean);
  console.log(`\nFetched ${fetched}  |  Failed ${failed}  |  Mapped ${items.length} equippable`);
  console.log('Writing to sheet…');

  const written = await writeItemDb(sheetId, items, { replace });
  const skipped = items.length - written;
  console.log(`✓ Done. ${written} new rows written${skipped ? `, ${skipped} already existed (skipped)` : ''}.`);
}

async function cmdSync(sheetId) {
  const config = await getConfig(sheetId);
  const ids = String(config.journal_instance_ids ?? '')
    .split(/[,|;\s]+/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!ids.length) {
    console.error('❌ No instance IDs found. Add journal_instance_ids to the Config tab (comma-separated).');
    process.exit(1);
  }

  console.log(`\nSyncing Item DB for sheet ${sheetId}`);
  console.log(`Instances: ${ids.join(', ')}\n`);

  // Clear once up front, then append each instance
  const { clearRange } = await import('../src/lib/sheets.js');
  await clearRange(sheetId, 'Item DB!A2:J');
  console.log('✓ Cleared existing Item DB rows\n');

  let total = 0;
  for (const id of ids) {
    console.log(`── Instance ${id} ─────────────────────`);

    // Detect whether this is a raid or M+ dungeon so sourceType is set correctly.
    // fetchRaidItems calls getInstance again internally — acceptable for a seed script.
    const instanceMeta = await getInstance(id);
    const categoryType = instanceMeta.category?.type ?? '';
    const isDungeon    = DUNGEON_CATEGORY_TYPES.has(categoryType);
    const difficulty   = isDungeon ? 'MYTHIC_KEYSTONE' : 'MYTHIC';
    if (isDungeon) console.log(`  (Detected as dungeon — using MYTHIC_KEYSTONE)`);

    const raw   = await fetchRaidItems(id, difficulty);
    const items = raw.map(mapItem).filter(Boolean);
    console.log(`\nMapped ${items.length} equippable items. Writing…`);
    const written = await writeItemDb(sheetId, items);
    total += written;
    console.log(`✓ ${written} rows written\n`);
  }

  console.log(`✓ Sync complete. ${total} total rows written to Item DB.`);
}

/**
 * Parse the Midnight Season 1 Mythic+ loot guide page and write items to the
 * Item DB sheet. Each item row captures: itemId, name, slot, armorType,
 * sourceName (dungeon), instance, difficulty=Mythic+, isTierToken=FALSE.
 *
 * Usage:
 *   node --env-file=.env scripts/seed-item-db.js s1mplus <url> <sheetId> [instanceName]
 *
 * instanceName defaults to "Midnight Season 1".
 * Pass --overwrite to replace existing entries (default: skip duplicates).
 */
async function cmdS1Mplus(url, sheetId, instanceName = 'Midnight Season 1') {
  console.log(`\nFetching Midnight S1 M+ loot guide…`);
  console.log(`  URL:      ${url}`);
  console.log(`  Instance: ${instanceName}`);
  console.log(`  Sheet:    ${sheetId}\n`);

  const raw = await fetchS1MplusGuide(url);
  console.log(`\n  Total parsed: ${raw.length} items`);

  if (!raw.length) {
    console.error('❌ No items found. The page may not have rendered tables in its HTML.');
    process.exit(1);
  }

  const items = raw.map(({ itemId, name, slot, armorType, dungeon }) => ({
    itemId,
    name,
    slot,
    sourceType:  'Mythic+',
    sourceName:  dungeon,
    instance:    instanceName,
    difficulty:  'Mythic+',
    armorType,
    isTierToken: 'FALSE',
  }));

  // Show dungeon breakdown
  const byDungeon = {};
  for (const { sourceName } of items) byDungeon[sourceName] = (byDungeon[sourceName] ?? 0) + 1;
  console.log('\n  Items by dungeon:');
  for (const [dungeon, count] of Object.entries(byDungeon).sort()) {
    console.log(`    ${dungeon.padEnd(32)} ${count}`);
  }

  console.log(`\nWriting ${items.length} items to sheet…`);
  const written = await writeItemDb(sheetId, items, { replace });
  const skipped = items.length - written;
  console.log(`✓ Done. ${written} new rows written${skipped ? `, ${skipped} already existed (skipped)` : ''}.`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const flags   = new Set(process.argv.filter(a => a.startsWith('--')));
const posArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const [command, arg1, arg2, arg3] = posArgs;
const replace = flags.has('--overwrite');

try {
  switch (command) {
    case 'list':
      await cmdList(arg1 ?? '');
      break;

    case 'raid':
      if (!arg1 || !arg2) {
        console.error('Usage: seed-item-db.js raid <instanceId> <sheetId> [difficulty]');
        process.exit(1);
      }
      await cmdRaid(arg1, arg2, arg3?.toUpperCase() ?? 'MYTHIC');
      break;

    case 'dungeon':
      if (!arg1 || !arg2) {
        console.error('Usage: seed-item-db.js dungeon <instanceId> <sheetId>');
        process.exit(1);
      }
      await cmdDungeon(arg1, arg2);
      break;

    case 'inspect': {
      // inspect instance <id>  OR  inspect item <id>
      const [, inspectType, inspectId] = posArgs;
      if (!inspectType || !inspectId) {
        console.error('Usage: seed-item-db.js inspect instance <id>');
        console.error('       seed-item-db.js inspect item <id>');
        process.exit(1);
      }
      if (inspectType === 'instance') {
        const data = await getInstance(inspectId);
        console.log(JSON.stringify(data, null, 2));
      } else if (inspectType === 'item') {
        const data = await getItemDetails(inspectId);
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.error(`Unknown inspect type "${inspectType}". Use: instance | item`);
        process.exit(1);
      }
      break;
    }

    case 'guide': {
      // guide <url> <sheetId> <instanceName> [difficulty]
      const [, gUrl, gSheet, gInstance, gDiff] = posArgs;
      if (!gUrl || !gSheet || !gInstance) {
        console.error('Usage: seed-item-db.js guide <url> <sheetId> <instanceName> [difficulty]');
        console.error('  url          = Wowhead loot/guide page URL');
        console.error('  instanceName = instance name, e.g. "The Voidspire" or "Midnight Season 1"');
        console.error('  difficulty   = MYTHIC (default) | HEROIC | NORMAL | MYTHIC_KEYSTONE (alias: mplus)');
        process.exit(1);
      }
      // Accept "mplus" as a friendly alias for MYTHIC_KEYSTONE
      const gDiffNorm = (gDiff ?? 'MYTHIC').toUpperCase().replace(/^MPLUS$/, 'MYTHIC_KEYSTONE');
      await cmdGuide(gUrl, gSheet, gInstance, gInstance, gDiffNorm);
      break;
    }

    case 'wowhead': {
      // posArgs: wowhead <url> <sheetId> <sourceName> <instanceName> [difficulty]
      const [, whUrl, whSheet, whSource, whInstance, whDiff] = posArgs;
      if (!whUrl || !whSheet || !whSource || !whInstance) {
        console.error('Usage: seed-item-db.js wowhead <url> <sheetId> <sourceName> <instanceName> [difficulty]');
        console.error('  sourceName  = boss name or "All Bosses"');
        console.error('  instanceName = raid name, e.g. "The Voidspire"');
        console.error('  difficulty  = Mythic (default) | Heroic | Normal');
        process.exit(1);
      }
      await cmdWowhead(whUrl, whSheet, whSource, whInstance, whDiff ?? 'Mythic');
      break;
    }

    case 's1mplus': {
      // s1mplus <url> <sheetId> [instanceName]
      const [, s1Url, s1Sheet, s1Instance] = posArgs;
      if (!s1Url || !s1Sheet) {
        console.error('Usage: seed-item-db.js s1mplus <url> <sheetId> [instanceName]');
        console.error('  url          = Wowhead S1 M+ loot guide URL');
        console.error('  instanceName = defaults to "Midnight Season 1"');
        process.exit(1);
      }
      await cmdS1Mplus(s1Url, s1Sheet, s1Instance ?? 'Midnight Season 1');
      break;
    }

    case 'sync': {
      const sheetId = arg1 ?? process.env.TEAM_MYTHIC_SHEET_ID;
      if (!sheetId) {
        console.error('Usage: seed-item-db.js sync [sheetId]  (or set TEAM_MYTHIC_SHEET_ID in .env)');
        process.exit(1);
      }
      await cmdSync(sheetId);
      break;
    }

    default:
      console.log([
        'Usage:',
        '  node --env-file=.env scripts/seed-item-db.js list [search]',
        '  node --env-file=.env scripts/seed-item-db.js raid <instanceId> <sheetId> [difficulty]',
        '  node --env-file=.env scripts/seed-item-db.js dungeon <instanceId> <sheetId>',
        '  node --env-file=.env scripts/seed-item-db.js guide <url> <sheetId> <instanceName> [difficulty]',
        '  node --env-file=.env scripts/seed-item-db.js s1mplus <url> <sheetId> [instanceName]',
        '  node --env-file=.env scripts/seed-item-db.js sync [sheetId]',
        '  node --env-file=.env scripts/seed-item-db.js wowhead <url> <sheetId> <sourceName> <instanceName> [difficulty]',
      ].join('\n'));
  }
} catch (err) {
  console.error('\n❌', err.message);
  process.exit(1);
}
