/**
 * seed-default-bis.js — Seed the Default BIS tab from public BIS guides.
 *
 * Fetches the "Best Gear for Each Slot" table from Icy Veins, Wowhead, or
 * Maxroll spec guides and writes slot → item name mappings to the Default BIS
 * sheet tab.
 *
 * TrueBIS is set to the item name from the guide.
 * RaidBIS is left blank — officers or players can fill it in via the web app,
 * or re-run with --raid-bis to attempt automatic detection (Raid items only).
 *
 * Usage:
 *   node --env-file=.env scripts/seed-default-bis.js list [search]
 *   node --env-file=.env scripts/seed-default-bis.js show "<Spec Name>" <sheetId>
 *   node --env-file=.env scripts/seed-default-bis.js fetch "<Spec Name>" <sheetId>
 *   node --env-file=.env scripts/seed-default-bis.js fetch-all <sheetId>
 *   node --env-file=.env scripts/seed-default-bis.js clear <sheetId> [specName]
 *
 * Flags:
 *   --overwrite          Replace existing entries for the targeted spec(s) (default: skip)
 *   --raid-bis           Also populate RaidBIS by cross-referencing the Item DB in the sheet
 *   --source=<source>    Guide source: icy-veins (default) | wowhead | maxroll
 *
 * Spec names use "Spec Class" format, e.g.:
 *   "Frost Death Knight", "Holy Paladin", "Restoration Shaman"
 *
 * Notes:
 *   • Not all specs may have Midnight guides yet — the script skips them
 *     with a warning. Re-run as guides are published.
 *   • Item names are stored as-is from the guide. Officers should review
 *     and replace crafted items with the <Crafted> sentinel where appropriate.
 *   • Maxroll items won't have Wowhead item IDs; use --raid-bis to cross-reference
 *     item names against the Item DB to populate RaidBIS automatically.
 */

import {
  writeDefaultBis,
  getItemDb,
  clearRange,
  appendRows,
  readRange,
  writeRange,
  getSpecBisConfig,
  setSpecBisSource,
  writeSpecBisConfig,
  getDefaultBis,
} from '../src/lib/sheets.js';

// ── Slot normalization ─────────────────────────────────────────────────────────
// Maps slot names found on guide pages → our canonical slot names.
// Ring / Trinket are resolved to numbered variants (Ring 1 / Ring 2, etc.)
// during table parsing, so we map them to a base token here.

const SLOT_ALIASES = {
  // Head
  'Head': 'Head', 'Helm': 'Head', 'Helmet': 'Head',
  // Neck
  'Neck': 'Neck', 'Necklace': 'Neck', 'Amulet': 'Neck',
  // Shoulders
  'Shoulder': 'Shoulders', 'Shoulders': 'Shoulders', 'Mantle': 'Shoulders',
  'Spaulders': 'Shoulders', 'Epaulettes': 'Shoulders',
  // Back
  'Back': 'Back', 'Cloak': 'Back', 'Cape': 'Back',
  // Chest
  'Chest': 'Chest', 'Robe': 'Chest', 'Tunic': 'Chest',
  'Breastplate': 'Chest', 'Chestplate': 'Chest', 'Chestguard': 'Chest',
  // Wrists
  'Wrist': 'Wrists', 'Wrists': 'Wrists', 'Bracers': 'Wrists', 'Bracer': 'Wrists',
  // Hands
  'Hands': 'Hands', 'Hand': 'Hands', 'Gloves': 'Hands', 'Gauntlets': 'Hands',
  // Waist
  'Waist': 'Waist', 'Belt': 'Waist',
  // Legs
  'Legs': 'Legs', 'Leggings': 'Legs', 'Pants': 'Legs', 'Greaves': 'Legs',
  // Feet
  'Feet': 'Feet', 'Boots': 'Feet', 'Shoes': 'Feet', 'Sandals': 'Feet',
  // Ring (special — numbered during parse)
  'Ring': 'Ring', 'Ring 1': 'Ring', 'Ring 2': 'Ring',
  'Finger': 'Ring', 'Finger 1': 'Ring', 'Finger 2': 'Ring',
  // Trinket (special — numbered during parse)
  'Trinket': 'Trinket', 'Trinkets': 'Trinket', 'Trinket 1': 'Trinket', 'Trinket 2': 'Trinket',
  // Weapon — main hand, one-handed, and two-handed weapons
  'Weapon': 'Weapon', 'Weapons': 'Weapon', 'Weapon 1': 'Weapon',
  'Main Hand': 'Weapon', 'Main-Hand': 'Weapon', 'Mainhand': 'Weapon',
  'One-Hand': 'Weapon', 'One Hand': 'Weapon', '1H': 'Weapon', '1-Hand': 'Weapon',
  '1H Weapon': 'Weapon', '1h Weapon': 'Weapon', 'One-Hand Weapon': 'Weapon', 'One Hand Weapon': 'Weapon',
  'Two-Hand': 'Weapon', 'Two Hand': 'Weapon', '2H': 'Weapon', '2-Hand': 'Weapon',
  '2H Weapon': 'Weapon', '2h Weapon': 'Weapon',
  // Off-Hand — separate slot: off-hand weapons, shields, held-in-off-hand
  'Off Hand': 'Off-Hand', 'Off-Hand': 'Off-Hand', 'Offhand': 'Off-Hand',
  'Shield': 'Off-Hand', 'Off Hand Weapon': 'Off-Hand', 'Held In Off-Hand': 'Off-Hand',
  'Weapon 2': 'Off-Hand', 'Weapon Off-Hand': 'Off-Hand', 'Weapon Offhand': 'Off-Hand',
};

// Ordered canonical slots (used for display / validation)
const ALL_SLOTS = [
  'Head', 'Neck', 'Shoulders', 'Back', 'Chest', 'Wrists',
  'Hands', 'Waist', 'Legs', 'Feet',
  'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2', 'Weapon', 'Off-Hand',
];

// Professions that produce craftable gear — used to detect <Crafted> sentinel.
// Matches guide annotations like "Blacksmithing", "Tailoring", etc.
const CRAFTING_PROFESSIONS = [
  'Blacksmithing', 'Leatherworking', 'Tailoring', 'Jewelcrafting',
  'Engineering', 'Inscription', 'Alchemy',
];
const CRAFTED_RE = new RegExp(
  `\\bCraft(?:ed|ing)\\b|\\b(?:${CRAFTING_PROFESSIONS.join('|')})\\b`, 'i'
);

// Slots that carry a tier set piece — <Catalyst> is invalid here, always use <Tier>
const TIER_SLOTS = new Set(['Head', 'Shoulders', 'Chest', 'Hands', 'Legs']);

// Non-tier armor slots where <Catalyst> is valid (accessory slots get neither)
const CATALYST_SLOTS = new Set(['Neck', 'Back', 'Wrists', 'Waist', 'Feet']);

// Tier-set item name prefixes for the current expansion/tier.
// When a guide lists the actual tier piece name (rather than annotating it as
// "Tier"), items whose names start with one of these prefixes are promoted to
// <Tier> (for TIER_SLOTS) or <Catalyst> (for CATALYST_SLOTS) automatically.
// Update this list at the start of each new tier.
const TIER_SET_PREFIXES = [
  // TWW Season 1 — Midnight tier sets (update as more sets are discovered)
  "Devouring Reaver's",   // Demon Hunter (Leather)
  "Luminant Verdict's",   // Paladin (Plate)
  "Relentless Rider's",   // Death Knight (Plate)
];

// ── Spec catalog ──────────────────────────────────────────────────────────────
// Spec names use "Spec Class" format to be unambiguous (e.g. "Frost Death Knight").
// These should match the values used in the Default BIS tab's Spec column.
//
// URLs follow the Icy Veins pattern for current raid tier BIS pages.
// Verify / update URLs if Icy Veins changes their URL structure.

// ── URL generators ────────────────────────────────────────────────────────────

// role = 'dps' | 'tank' | 'healing'
function ivUrl(slug, role) {
  return `https://www.icy-veins.com/wow/${slug}-pve-${role}-gear-best-in-slot`;
}

// Derives slug from spec + cls:  "Beast Mastery Hunter" + "Hunter" → "beast-mastery"
function specOnlySlug(spec, cls) {
  return spec.slice(0, spec.length - cls.length).trim().toLowerCase().replace(/\s+/g, '-');
}

// https://www.wowhead.com/guide/classes/death-knight/frost/bis-gear
function whUrl(spec, cls) {
  const c = cls.toLowerCase().replace(/\s+/g, '-');
  const s = specOnlySlug(spec, cls);
  return `https://www.wowhead.com/guide/classes/${c}/${s}/bis-gear`;
}

// https://maxroll.gg/wow/class-guides/frost-death-knight-raid-guide
function mrUrl(spec) {
  return `https://maxroll.gg/wow/class-guides/${spec.toLowerCase().replace(/\s+/g, '-')}-raid-guide`;
}

/** Return the guide URL for a given source label. */
function getSpecUrl(entry, source) {
  if (source === 'Wowhead') return entry.wowheadUrl;
  if (source === 'Maxroll')  return entry.maxrollUrl;
  return entry.ivUrl;
}

const VALID_SOURCES  = ['Icy Veins', 'Wowhead', 'Maxroll'];
const SOURCE_FLAG_MAP = { 'icy-veins': 'Icy Veins', 'wowhead': 'Wowhead', 'maxroll': 'Maxroll' };

// iv: icy-veins slug + role are needed because IV uses custom slugs.
// wowhead / maxroll URLs are derived automatically from spec + cls.
const _CATALOG_RAW = [
  // Death Knight
  { spec: 'Blood Death Knight',     cls: 'Death Knight', ivSlug: 'blood-death-knight',     ivRole: 'tank'    },
  { spec: 'Frost Death Knight',     cls: 'Death Knight', ivSlug: 'frost-death-knight',     ivRole: 'dps'     },
  { spec: 'Unholy Death Knight',    cls: 'Death Knight', ivSlug: 'unholy-death-knight',    ivRole: 'dps'     },
  // Demon Hunter
  { spec: 'Havoc Demon Hunter',     cls: 'Demon Hunter', ivSlug: 'havoc-demon-hunter',     ivRole: 'dps'     },
  { spec: 'Vengeance Demon Hunter', cls: 'Demon Hunter', ivSlug: 'vengeance-demon-hunter', ivRole: 'tank'    },
  { spec: 'Devourer Demon Hunter',  cls: 'Demon Hunter', ivSlug: 'devourer-demon-hunter',  ivRole: 'dps'     },
  // Druid
  { spec: 'Balance Druid',          cls: 'Druid',        ivSlug: 'balance-druid',          ivRole: 'dps'     },
  { spec: 'Feral Druid',            cls: 'Druid',        ivSlug: 'feral-druid',            ivRole: 'dps'     },
  { spec: 'Guardian Druid',         cls: 'Druid',        ivSlug: 'guardian-druid',         ivRole: 'tank'    },
  { spec: 'Restoration Druid',      cls: 'Druid',        ivSlug: 'restoration-druid',      ivRole: 'healing' },
  // Evoker
  { spec: 'Devastation Evoker',     cls: 'Evoker',       ivSlug: 'devastation-evoker',     ivRole: 'dps'     },
  { spec: 'Preservation Evoker',    cls: 'Evoker',       ivSlug: 'preservation-evoker',    ivRole: 'healing' },
  { spec: 'Augmentation Evoker',    cls: 'Evoker',       ivSlug: 'augmentation-evoker',    ivRole: 'dps'     },
  // Hunter
  { spec: 'Beast Mastery Hunter',   cls: 'Hunter',       ivSlug: 'beast-mastery-hunter',   ivRole: 'dps'     },
  { spec: 'Marksmanship Hunter',    cls: 'Hunter',       ivSlug: 'marksmanship-hunter',    ivRole: 'dps'     },
  { spec: 'Survival Hunter',        cls: 'Hunter',       ivSlug: 'survival-hunter',        ivRole: 'dps'     },
  // Mage
  { spec: 'Arcane Mage',            cls: 'Mage',         ivSlug: 'arcane-mage',            ivRole: 'dps'     },
  { spec: 'Fire Mage',              cls: 'Mage',         ivSlug: 'fire-mage',              ivRole: 'dps'     },
  { spec: 'Frost Mage',             cls: 'Mage',         ivSlug: 'frost-mage',             ivRole: 'dps'     },
  // Monk
  { spec: 'Brewmaster Monk',        cls: 'Monk',         ivSlug: 'brewmaster-monk',        ivRole: 'tank'    },
  { spec: 'Mistweaver Monk',        cls: 'Monk',         ivSlug: 'mistweaver-monk',        ivRole: 'healing' },
  { spec: 'Windwalker Monk',        cls: 'Monk',         ivSlug: 'windwalker-monk',        ivRole: 'dps'     },
  // Paladin
  { spec: 'Holy Paladin',           cls: 'Paladin',      ivSlug: 'holy-paladin',           ivRole: 'healing' },
  { spec: 'Protection Paladin',     cls: 'Paladin',      ivSlug: 'protection-paladin',     ivRole: 'tank'    },
  { spec: 'Retribution Paladin',    cls: 'Paladin',      ivSlug: 'retribution-paladin',    ivRole: 'dps'     },
  // Priest
  { spec: 'Discipline Priest',      cls: 'Priest',       ivSlug: 'discipline-priest',      ivRole: 'healing' },
  { spec: 'Holy Priest',            cls: 'Priest',       ivSlug: 'holy-priest',            ivRole: 'healing' },
  { spec: 'Shadow Priest',          cls: 'Priest',       ivSlug: 'shadow-priest',          ivRole: 'dps'     },
  // Rogue
  { spec: 'Assassination Rogue',    cls: 'Rogue',        ivSlug: 'assassination-rogue',    ivRole: 'dps'     },
  { spec: 'Outlaw Rogue',           cls: 'Rogue',        ivSlug: 'outlaw-rogue',           ivRole: 'dps'     },
  { spec: 'Subtlety Rogue',         cls: 'Rogue',        ivSlug: 'subtlety-rogue',         ivRole: 'dps'     },
  // Shaman
  { spec: 'Elemental Shaman',       cls: 'Shaman',       ivSlug: 'elemental-shaman',       ivRole: 'dps'     },
  { spec: 'Enhancement Shaman',     cls: 'Shaman',       ivSlug: 'enhancement-shaman',     ivRole: 'dps'     },
  { spec: 'Restoration Shaman',     cls: 'Shaman',       ivSlug: 'restoration-shaman',     ivRole: 'healing' },
  // Warlock
  { spec: 'Affliction Warlock',     cls: 'Warlock',      ivSlug: 'affliction-warlock',     ivRole: 'dps'     },
  { spec: 'Demonology Warlock',     cls: 'Warlock',      ivSlug: 'demonology-warlock',     ivRole: 'dps'     },
  { spec: 'Destruction Warlock',    cls: 'Warlock',      ivSlug: 'destruction-warlock',    ivRole: 'dps'     },
  // Warrior
  { spec: 'Arms Warrior',           cls: 'Warrior',      ivSlug: 'arms-warrior',           ivRole: 'dps'     },
  { spec: 'Fury Warrior',           cls: 'Warrior',      ivSlug: 'fury-warrior',           ivRole: 'dps'     },
  { spec: 'Protection Warrior',     cls: 'Warrior',      ivSlug: 'protection-warrior',     ivRole: 'tank'    },
];

// Enrich each entry with all three source URLs
const SPEC_CATALOG = _CATALOG_RAW.map(e => ({
  ...e,
  ivUrl:       ivUrl(e.ivSlug, e.ivRole),
  wowheadUrl:  whUrl(e.spec, e.cls),
  maxrollUrl:  mrUrl(e.spec),
}));

// ── HTML helpers ──────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

/** Strip all HTML tags and collapse whitespace to a single space. */
function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Decode common HTML entities (numeric hex/dec and named). */
function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g,          (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Extract a wowhead item ID from a cell's HTML.
 * Handles full URLs (Icy Veins / external links) and relative links (on Wowhead's own pages):
 *   https://www.wowhead.com/item=249293          ← Icy Veins / external
 *   https://www.wowhead.com/ptr-2/item=249293    ← PTR
 *   href="/item=249293"                          ← Wowhead guide pages (relative)
 */
function extractItemId(cellHtml) {
  // Full wowhead URL
  let m = cellHtml.match(/wowhead\.com\/(?:[\w-]+\/)?item=(\d+)/);
  if (m) return m[1];
  // Relative link on wowhead.com: href="/item=12345" or href="/ptr-2/item=12345"
  m = cellHtml.match(/href=["'][^"']*[/?]item=(\d+)/);
  if (m) return m[1];
  // Maxroll: data-wow-item="251217:bonus1:bonus2"
  m = cellHtml.match(/data-wow-item=["'](\d+)/);
  if (m) return m[1];
  return null;
}

/**
 * Extract the display name from the first wowhead item link in a cell.
 * Falls back to stripping all tags if no link is found.
 */
function extractItemName(cellHtml) {
  // Full wowhead URL: href="https://www.wowhead.com/item=...">Name</a>
  let m = cellHtml.match(/href="[^"]*wowhead[^"]*"[^>]*>([^<]+)<\/a>/);
  if (m) return decodeEntities(m[1].trim());
  // Relative item link on Wowhead guide pages: href="/item=12345">ID</a>
  m = cellHtml.match(/href="[^"]*[/?]item=\d+[^"]*"[^>]*>([^<]+)<\/a>/);
  if (m) return decodeEntities(m[1].trim());
  // Fallback: strip everything and return plain text
  const plain = decodeEntities(stripTags(cellHtml));
  return plain.length > 1 ? plain : null;
}

/**
 * Normalise a raw slot cell string to our canonical slot name.
 * Returns the base slot token (Ring / Trinket are NOT yet numbered here).
 */
function normaliseSlot(rawCellHtml) {
  // Strip tags and take text before any parenthetical annotation like "(Tier)"
  const text = stripTags(rawCellHtml).split(/[(\[]/)[0].trim();
  // Direct match
  if (SLOT_ALIASES[text]) return SLOT_ALIASES[text];
  // Case-insensitive match
  const lower = text.toLowerCase();
  for (const [alias, canonical] of Object.entries(SLOT_ALIASES)) {
    if (alias.toLowerCase() === lower) return canonical;
  }
  return null;
}

// ── BIS table parsers ─────────────────────────────────────────────────────────

/**
 * Shared table-scanning core used by all three source parsers.
 *
 * filterFn(tableHtml) → bool — called on each <table> block to pre-screen it.
 * Returns an array of { slot, itemName, itemId } objects, or [] if none found.
 */
const DEBUG_PARSE = process.argv.includes('--debug-parse');

function scanBisTables(html, filterFn) {
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  const cellRe  = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  for (const tableMatch of html.matchAll(tableRe)) {
    const tableHtml = tableMatch[0];
    if (!filterFn(tableHtml)) continue;

    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const rows  = [...tableHtml.matchAll(rowRe)].map(m => m[1]);
    if (rows.length < 3) continue;

    // Header row should mention "slot" or "gear"
    const headerText = stripTags(rows[0]).toLowerCase();
    if (!headerText.includes('slot') && !headerText.includes('gear')) continue;

    if (DEBUG_PARSE) {
      // Show 300 chars of HTML immediately before this table so we can see
      // what section heading / container wraps it.
      const start   = tableMatch.index ?? html.indexOf(tableMatch[0]);
      const before  = html.slice(Math.max(0, start - 300), start);
      const snippet = before.replace(/\s+/g, ' ').trim().slice(-200);
      console.log(`  [debug] table candidate — context before: …${snippet}`);
    }

    // Confirm at least 3 of the first 6 data rows have a recognised slot name
    let slotHits = 0;
    for (const row of rows.slice(1, 7)) {
      const cells = [...row.matchAll(cellRe)].map(m => m[1]);
      if (cells.length >= 2 && normaliseSlot(cells[0]) !== null) slotHits++;
    }
    if (slotHits < 3) continue;

    // ── This is our BIS table — parse it ──────────────────────────────────
    const results    = [];
    const slotCounts = { Ring: 0, Trinket: 0 };
    const seenSlots  = new Set();

    for (const row of rows.slice(1)) {
      const cells = [...row.matchAll(cellRe)].map(m => m[1]);
      if (cells.length < 2) continue;

      const base = normaliseSlot(cells[0]);
      if (!base) {
        const rawSlot = stripTags(cells[0]).trim();
        if (rawSlot) console.warn(`  ⚠ Unrecognised slot — skipping row: "${rawSlot}"`);
        continue;
      }

      let slot;
      if (base === 'Ring')         { slotCounts.Ring++;    slot = `Ring ${slotCounts.Ring}`;    }
      else if (base === 'Trinket') { slotCounts.Trinket++; slot = `Trinket ${slotCounts.Trinket}`; }
      else                         { slot = base; }

      if (seenSlots.has(slot)) continue;
      seenSlots.add(slot);

      if (DEBUG_PARSE) {
        cells.forEach((c, i) =>
          console.log(`  [debug] cell[${i}] : ${c.replace(/\s+/g, ' ').trim()}`)
        );
      }

      // Check all cells in the row for Tier / Catalyst / Crafted annotation.
      // Icy Veins writes "Head (Tier)" in column 1; Wowhead has a dedicated
      // third column whose text is "Tier" / "Catalyst" / "Tier (Catalyst)" etc.
      // Maxroll explicitly labels crafted items with "Crafted" in a column.
      const allCellsText  = cells.map(c => stripTags(c)).join(' ');
      const slotRaw       = stripTags(cells[0]);
      const itemCell      = cells[1];
      const isTier        = /\bTier\b/i.test(allCellsText);
      const isCatalyst    = !isTier && /\bCatalyst\b/i.test(allCellsText);
      // Suppress crafted detection when the item cell has paired items ("A & B") —
      // the & split logic below handles each item individually in that case.
      const hasPairedItems = /\s+&\s+/.test(decodeEntities(stripTags(itemCell)));
      const isCrafted     = !isTier && !isCatalyst && !hasPairedItems && CRAFTED_RE.test(allCellsText);
      // Sentinel availability: tier slots can only ever be <Tier>.
      // A guide that says <Catalyst> for Head/Shoulders/Chest/Hands/Legs is wrong
      // (those slots use tier tokens, not the Catalyst forge) — promote to <Tier>.
      const effectivelyTier = isTier || (isCatalyst && TIER_SLOTS.has(slot));
      let itemName, itemId;
      if (effectivelyTier)  { itemName = '<Tier>';     itemId = null; }
      else if (isCatalyst)  { itemName = '<Catalyst>'; itemId = null; }
      else if (isCrafted)   { itemName = '<Crafted>';  itemId = null; }
      else                  { itemName = extractItemName(itemCell); itemId = extractItemId(itemCell); }

      if (!itemName) continue;

      // Handle paired items listed as "Item A & Item B" in one cell.
      // Split into two entries and assign the second to the companion slot.
      // Per-item crafted detection: check BOTH the item name segment AND the
      // corresponding source-column segment (e.g. "Midnight Falls & Crafted").
      // This covers Maxroll, where "Crafted" appears in column 3, not in the
      // item name itself.
      const COMPANION_SLOT = { 'Weapon': 'Off-Hand', 'Ring 1': 'Ring 2', 'Trinket 1': 'Trinket 2' };
      const nameParts = itemName.split(/\s+&\s+/);
      if (nameParts.length > 1 && COMPANION_SLOT[slot]) {
        // Extract all item IDs from the cell in document order.
        // Handles Wowhead/Icy Veins (/item=ID links) and Maxroll (data-wow-item="ID:...").
        const idRe   = /(?:data-wow-item=["'](\d+)[:"']|[/?]item=(\d+))/g;
        const allIds = [...itemCell.matchAll(idRe)].map(m => m[1] ?? m[2]);
        // Split the source column by & to match per-item crafted annotations.
        const sourceParts = cells[2]
          ? decodeEntities(stripTags(cells[2])).split(/\s+&\s+/)
          : [];
        const isPartCrafted = i =>
          CRAFTED_RE.test(nameParts[i] ?? '') ||
          CRAFTED_RE.test(sourceParts[i] ?? '');
        const name0 = isPartCrafted(0) ? '<Crafted>' : nameParts[0].trim();
        const id0   = name0 === '<Crafted>' ? null : (allIds[0] ?? itemId ?? null);
        results.push({ slot, itemName: name0, itemId: id0 });
        const companion = COMPANION_SLOT[slot];
        if (!seenSlots.has(companion)) {
          seenSlots.add(companion);
          const name1 = isPartCrafted(1) ? '<Crafted>' : nameParts[1].trim();
          const id1   = name1 === '<Crafted>' ? null : (allIds[1] ?? null);
          results.push({ slot: companion, itemName: name1, itemId: id1 });
        }
      } else {
        results.push({ slot, itemName, itemId });
      }
    }

    if (results.length >= 5) return results;
    // Fewer than 5 results — probably not the BIS table, keep scanning
  }

  return [];
}

/**
 * Icy Veins — tables must contain full wowhead.com/item= links.
 */
function parseIcyVeinsBis(html) {
  return scanBisTables(html, t => t.includes('wowhead.com/item='));
}

/**
 * Wowhead guide pages have two formats:
 *   1. HTML with relative item links: <a href="/item=12345">Name</a>
 *   2. BBCode (most newer guides): [td]Slot[/td][td][item=12345 bonus=...][/td]
 *
 * For BBCode, we convert to HTML first so the rest of the parser can handle it.
 * Item names are not embedded in the BBCode — we use the numeric ID as a placeholder
 * and resolve to real names from the Item DB in fetchAndWrite.
 */
function bbcodeToHtml(html) {
  // Wowhead stores guide content as a JSON-encoded string, so forward slashes
  // in closing tags are escaped: [\/td] instead of [/td]. Handle both forms.
  return html
    .replace(/\[table[^\]]*\]/gi,  '<table>')
    .replace(/\[\\?\/table\]/gi,   '</table>')
    .replace(/\[tr[^\]]*\]/gi,     '<tr>')
    .replace(/\[\\?\/tr\]/gi,      '</tr>')
    .replace(/\[th[^\]]*\]/gi,     '<th>')
    .replace(/\[\\?\/th\]/gi,      '</th>')
    .replace(/\[td[^\]]*\]/gi,     '<td>')
    .replace(/\[\\?\/td\]/gi,      '</td>')
    .replace(/\[b\]/gi,  '<b>').replace(/\[\\?\/b\]/gi,  '</b>')
    .replace(/\[i\]/gi,  '<i>').replace(/\[\\?\/i\]/gi,  '</i>')
    // [color=q3]...[/color] — quality-colour wrappers, strip entirely
    .replace(/\[color=[^\]]*\]/gi, '').replace(/\[\\?\/color\]/gi, '')
    // [item=ID] and [item=ID bonus=...] → <a href="/item=ID">ID</a>
    // Name is not in the BBCode; use numeric ID as placeholder for later resolution.
    .replace(/\[item=(\d+)[^\]]*\]/gi, '<a href="/item=$1">$1</a>')
    // [skill=ID] — Wowhead's BBCode tag for a crafting profession source (e.g. [skill=165]
    // for Leatherworking). Rendered as the profession icon+name by Wowhead's JS, but we
    // never execute JS — convert to the literal text "Crafted" so CRAFTED_RE can detect it.
    .replace(/\[skill=[^\]]*\]/gi, 'Crafted');
}

/**
 * When a Wowhead guide has toggle sections (e.g. "Overall" vs "Preseason"),
 * extract only the "Overall" section's content so we don't parse the wrong table.
 * Falls back to the full content if no [toggle] blocks are found.
 *
 * Handles both [/toggle] and [\/toggle] (Wowhead JSON-escapes forward slashes).
 */
function extractWowheadOverallSection(raw) {
  // Match every [toggle title="..."]...[/toggle] block
  const toggleRe = /\[toggle\b[^\]]*title="([^"]*)"[^\]]*\]([\s\S]*?)\[\\?\/toggle\]/gi;
  const blocks   = [...raw.matchAll(toggleRe)];

  if (DEBUG_PARSE) {
    if (blocks.length === 0) {
      // Show first 400 chars so we can see the actual toggle markup
      const sample = raw.slice(0, 400).replace(/\n/g, '\\n');
      console.log(`  [debug] no [toggle] blocks found. raw start: ${sample}`);
    } else {
      blocks.forEach((b, i) => console.log(`  [debug] toggle[${i}] title="${b[1]}"`));
    }
  }

  if (blocks.length === 0) return raw; // No toggles present — use everything

  // Prefer a block whose title contains "overall" (case-insensitive)
  const overall = blocks.find(b => /overall/i.test(b[1]));
  if (overall) return overall[2];

  // Otherwise skip any "preseason" / "pre-season" / "pre season" block
  const nonPreseason = blocks.find(b => !/pre.?season/i.test(b[1]));
  if (nonPreseason) return nonPreseason[2];

  // Last resort: first block
  return blocks[0][2];
}

/**
 * Extract item names from the Wowhead-embedded item JSON blob.
 * Wowhead inlines item data as: "ITEMID":{"name_enus":"Item Name",...}
 * This covers every item referenced in the page, so we can resolve names
 * for BBCode items that might not be in the local Item DB yet.
 */
function extractWowheadItemNames(html) {
  const map = new Map();
  const re  = /"(\d{5,})"\s*:\s*\{"name_enus"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) map.set(m[1], m[2]);
  return map;
}

function parseWowheadBis(html) {
  const hasBBCode = /\[table\b|\[tr\]|\[td\b/i.test(html);
  const raw = hasBBCode ? extractWowheadOverallSection(html) : html;
  let src   = hasBBCode ? bbcodeToHtml(raw) : raw;

  // For BBCode pages, substitute item names from the Wowhead JSON blob into the
  // link text so resolveItemIds gets real names rather than bare numeric IDs.
  // This lets TIER_SET_PREFIXES matching (Pass 3) work even for items not yet
  // in the local Item DB — e.g. Blood DK chest whose source cell is empty.
  if (hasBBCode) {
    const wowheadNames = extractWowheadItemNames(html);
    if (wowheadNames.size > 0) {
      // Replace <a href="/item=ID">ID</a> → <a href="/item=ID">Item Name</a>
      src = src.replace(/<a href="\/item=(\d+)"[^>]*>(\d+)<\/a>/gi, (match, id) => {
        const name = wowheadNames.get(id);
        return name ? `<a href="/item=${id}">${name}</a>` : match;
      });
    }
  }

  return scanBisTables(src, t => /[/?]item=\d+/.test(t));
}

/**
 * Maxroll — items link to Maxroll's own CDN, not Wowhead.
 * No item link requirement; we rely purely on slot-name detection.
 * itemId will be null for all results (names-only from the guide).
 */
function parseMaxrollBis(html) {
  return scanBisTables(html, () => true);
}

const SOURCE_PARSERS = {
  'Icy Veins': parseIcyVeinsBis,
  'Wowhead':   parseWowheadBis,
  'Maxroll':   parseMaxrollBis,
};

// ── RaidBIS enrichment ────────────────────────────────────────────────────────

const SENTINELS = new Set(['<Tier>', '<Catalyst>', '<Crafted>']);

/**
 * Multi-pass item ID resolution against the Item DB.
 * Mutates entries in-place. quiet suppresses "NOT FOUND" warnings.
 *
 *   Pass 0 — ID already known (Maxroll data-wow-item) → canonicalise name.
 *   Pass 1 — numeric placeholder (Wowhead BBCode) → real name.
 *   Pass 2 — name → ID lookup (Maxroll / Icy Veins / any source without IDs).
 *   Pass 3 — tier-set name prefix → promote to <Tier> or <Catalyst>.
 *            Runs unconditionally after the resolution passes — catches guides
 *            that list the actual tier piece by name/ID rather than labelling
 *            the row "Tier" (e.g. Holy Paladin on Wowhead).
 */
function resolveItemIds(entries, itemDb, { quiet = false } = {}) {
  const byId   = new Map(itemDb.map(i => [String(i.itemId), i]));
  const byName = new Map(itemDb.map(i => [i.name.toLowerCase(), i]));

  for (const e of entries) {
    if (SENTINELS.has(e.trueBis)) { e.trueBisItemId = e.trueBis; continue; }

    // Pass 0: ID already known (e.g. Maxroll data-wow-item) — canonicalise name from Item DB.
    // Fixes guide pages that have typos in item names but correct IDs in their data attributes.
    if (e.trueBisItemId && /^\d+$/.test(String(e.trueBisItemId))) {
      const item = byId.get(String(e.trueBisItemId));
      if (item) {
        if (item.name !== e.trueBis && !quiet)
          console.log(`  ✎ [${e.trueBisItemId}] "${e.trueBis}" → "${item.name}"`);
        e.trueBis = item.name;
      } else if (!quiet) {
        console.log(`  ⚠ [${e.trueBisItemId}] ${e.trueBis} — ID not in Item DB, guide name kept`);
      }
      // Fall through to Pass 3 so tier-set names are promoted even when the ID was pre-known.

    // Pass 1: numeric placeholder (Wowhead BBCode) — ID is embedded as the name itself.
    } else if (/^\d+$/.test(e.trueBis)) {
      e.trueBisItemId = e.trueBis;
      const item = byId.get(e.trueBis);
      if (item) {
        e.trueBis = item.name;
      } else {
        e.trueBis = 'NOT FOUND';
        if (!quiet) console.log(`  ⚠ Item ${e.trueBisItemId} not found in Item DB`);
      }
      // Fall through to Pass 3 so tier-set names are promoted after ID resolution.

    // Pass 2: name-based lookup for sources that don't provide IDs (Maxroll, Icy Veins)
    } else if (!e.trueBisItemId && e.trueBis && e.trueBis !== 'NOT FOUND') {
      const item = byName.get(e.trueBis.toLowerCase());
      if (item) e.trueBisItemId = String(item.itemId);
    }

    // Pass 3: tier-set name prefix → promote to <Tier> or <Catalyst>.
    // Runs for every entry that reaches here (Passes 0, 1, and 2 all fall through).
    // Handles guides that list the actual tier piece name rather than annotating the
    // row with "Tier" — e.g. Holy Paladin on Wowhead lists tier slots by boss name
    // and the item resolves to "Luminant Verdict's ..." in Pass 1.
    if (e.trueBis && !SENTINELS.has(e.trueBis) && e.trueBis !== 'NOT FOUND') {
      const nameLower = e.trueBis.toLowerCase();
      const isTierSet = TIER_SET_PREFIXES.some(p => nameLower.startsWith(p.toLowerCase()));
      if (isTierSet) {
        if (TIER_SLOTS.has(e.slot))          e.trueBis = '<Tier>';
        else if (CATALYST_SLOTS.has(e.slot)) e.trueBis = '<Catalyst>';
        // Accessory / weapon slots: leave as-is (no tier equivalent)
        if (SENTINELS.has(e.trueBis)) e.trueBisItemId = e.trueBis;
      }
    }
  }
}

/**
 * For each entry, look up the item name in the Item DB.
 * If it exists and has sourceType = 'Raid', set raidBis = trueBis.
 * Returns a new array with raidBis populated where applicable.
 */
function applyRaidBis(entries, itemDb) {
  // Build a name→item map (case-insensitive)
  const byName = new Map();
  for (const item of itemDb) {
    byName.set(item.name.toLowerCase(), item);
  }

  return entries.map(entry => {
    const dbItem = byName.get(entry.trueBis.toLowerCase());
    const isRaid = dbItem?.sourceType === 'Raid';
    return {
      ...entry,
      raidBis:       isRaid ? entry.trueBis       : '',
      raidBisItemId: isRaid ? (dbItem?.itemId ?? '') : '',
    };
  });
}

// ── Commands ──────────────────────────────────────────────────────────────────

function cmdList(search = '', source = 'Icy Veins') {
  const filtered = search
    ? SPEC_CATALOG.filter(s =>
        s.spec.toLowerCase().includes(search.toLowerCase()) ||
        s.cls.toLowerCase().includes(search.toLowerCase()))
    : SPEC_CATALOG;

  if (!filtered.length) {
    console.log(`\n  No specs found matching "${search}". Run without a search term to list all specs.`);
    return;
  }

  const specW = Math.max(...filtered.map(s => s.spec.length));
  const clsW  = Math.max(...filtered.map(s => s.cls.length));

  console.log(`\n  Source: ${source}`);
  console.log(`  ${'Spec'.padEnd(specW)}  ${'Class'.padEnd(clsW)}  URL`);
  console.log(`  ${'-'.repeat(specW + clsW + 50)}`);

  for (const entry of filtered) {
    const url = getSpecUrl(entry, source);
    console.log(`  ${entry.spec.padEnd(specW)}  ${entry.cls.padEnd(clsW)}  ${url}`);
  }
  console.log(`\n  (${filtered.length} spec${filtered.length === 1 ? '' : 's'}${search ? ` matching "${search}"` : ''})`);
}

/**
 * Show what's actually stored in the sheet for a given spec.
 * Groups rows by source and prints slot → Overall BIS / Raid BIS per row.
 * Usage: show "<Spec Name>" <sheetId>
 */
async function cmdShow(specName, sheetId) {
  const entry = SPEC_CATALOG.find(s => s.spec.toLowerCase() === specName.toLowerCase());
  if (!entry) {
    const close = SPEC_CATALOG.filter(s =>
      s.spec.toLowerCase().includes(specName.toLowerCase()) ||
      s.cls.toLowerCase().includes(specName.toLowerCase())
    );
    if (close.length) {
      console.error(`❌ Spec "${specName}" not found. Did you mean:`);
      close.forEach(s => console.error(`     "${s.spec}"`));
    } else {
      console.error(`❌ Spec "${specName}" not found. Run "list" to see all spec names.`);
    }
    process.exit(1);
  }

  const allRows = await getDefaultBis(sheetId);
  const rows    = allRows.filter(r => r.spec === entry.spec);

  if (!rows.length) {
    console.log(`\n  No Default BIS data found for ${entry.spec}. Run fetch first.`);
    return;
  }

  // Group by source
  const bySrc = new Map();
  for (const r of rows) {
    if (!bySrc.has(r.source)) bySrc.set(r.source, []);
    bySrc.get(r.source).push(r);
  }

  const slotW    = Math.max(...rows.map(r => r.slot.length), 'Slot'.length);
  const overallW = Math.max(...rows.map(r => (r.trueBis ?? '').length), 'Overall BIS'.length);
  const raidW    = Math.max(...rows.map(r => (r.raidBis ?? '').length), 'Raid BIS'.length);

  for (const [src, srcRows] of bySrc) {
    console.log(`\n  ── ${entry.spec}  [${src}] ─────────────────────────────────`);
    console.log(`  ${'Slot'.padEnd(slotW)}  ${'Overall BIS'.padEnd(overallW)}  ${'Raid BIS'.padEnd(raidW)}`);
    console.log(`  ${'-'.repeat(slotW + overallW + raidW + 6)}`);
    // Sort by canonical slot order
    const sorted = [...srcRows].sort((a, b) =>
      ALL_SLOTS.indexOf(a.slot) - ALL_SLOTS.indexOf(b.slot));
    for (const r of sorted) {
      const overall = r.trueBis  ?? '';
      const raid    = r.raidBis  ?? '';
      console.log(`  ${r.slot.padEnd(slotW)}  ${overall.padEnd(overallW)}  ${raid.padEnd(raidW)}`);
    }
    console.log(`  (${srcRows.length} slots)`);
  }
  console.log();
}

async function cmdFetch(specName, sheetId, { overwrite = false, raidBis = false, source = 'Icy Veins' } = {}) {
  // Fuzzy-find the spec
  const entry = SPEC_CATALOG.find(s => s.spec.toLowerCase() === specName.toLowerCase());
  if (!entry) {
    const close = SPEC_CATALOG.filter(s =>
      s.spec.toLowerCase().includes(specName.toLowerCase()) ||
      s.cls.toLowerCase().includes(specName.toLowerCase())
    );
    if (close.length) {
      console.error(`❌ Spec "${specName}" not found. Did you mean:`);
      close.forEach(s => console.error(`     "${s.spec}"`));
    } else {
      console.error(`❌ Spec "${specName}" not found. Run "list" to see all specs.`);
    }
    process.exit(1);
  }

  let itemDb = null;
  if (raidBis) {
    console.log('Loading Item DB for Raid BIS detection…');
    itemDb = await getItemDb(sheetId);
    console.log(`  ${itemDb.length} items loaded\n`);
  }

  const written = await fetchAndWrite(entry, sheetId, { overwrite, raidBis, itemDb, source });
  if (written === 0) {
    console.log(`\n– All slots already exist for ${entry.spec}. Use --overwrite to replace.`);
  } else {
    console.log(`\n✓ Done. ${written} slots written.`);
  }
}

async function cmdFetchAll(sheetId, { overwrite = false, raidBis = false, source = 'Icy Veins' } = {}) {
  console.log(`\nFetching Default BIS for all ${SPEC_CATALOG.length} specs…`);
  console.log(`Sheet:  ${sheetId}`);
  console.log(`Source: ${source}`);
  console.log(`Mode:   ${overwrite ? 'OVERWRITE' : 'skip existing'}`);
  if (raidBis) console.log('Raid BIS: enabled (cross-referencing Item DB)');
  console.log();

  let itemDb = null;
  if (raidBis) {
    console.log('Loading Item DB…');
    itemDb = await getItemDb(sheetId);
    console.log(`  ${itemDb.length} items loaded\n`);
  }

  // ── Phase 1: Fetch all guide pages (no Sheets writes yet) ─────────────────
  const allEntries = [];
  let ok = 0, skipped = 0, failed = 0;

  for (const entry of SPEC_CATALOG) {
    try {
      const entries = await fetchEntries(entry, { raidBis, itemDb, source, quiet: true });

      // Resolve item IDs: numeric placeholders → names, and names → IDs
      const db = itemDb ?? await getItemDb(sheetId);
      resolveItemIds(entries, db, { quiet: true });

      allEntries.push(...entries);
      console.log(`  ✓ ${entry.spec}: ${entries.length} slots`);
      ok++;
    } catch (err) {
      console.log(`  ❌ ${entry.spec}: ${err.message}`);
      failed++;
    }

    // Polite delay between requests (avoid hammering the source site)
    await new Promise(r => setTimeout(r, 700));
  }

  // ── Phase 2: Single batch write to Sheets ────────────────────────────────
  if (allEntries.length > 0) {
    console.log(`\nWriting ${allEntries.length} total entries to sheet…`);
    const written = await writeDefaultBis(allEntries, { replace: overwrite });
    console.log(`✓ ${written} rows written  (${allEntries.length - written} already existed)`);
    skipped += (allEntries.length - written);
  }

  console.log(`\n✓ Done.  ${ok} specs fetched  ·  ${failed} failed`);
  if (failed > 0) {
    console.log('\n  Failed specs likely have no Midnight guide yet. Re-run once guides are published.');
    console.log('  You can also run a single spec once its guide is live:');
    console.log('    node --env-file=.env scripts/seed-default-bis.js fetch "<Spec Name>" <sheetId>');
  }
}

/**
 * Fetch a spec's BIS guide page, parse it, and write to the sheet.
 * Returns the number of new rows written.
 */
/**
 * Fetches and parses a spec's BIS guide. Returns the entry array without writing.
 * Throws if the page has no BIS table.
 */
async function fetchEntries(entry, { raidBis = false, itemDb = null, source = 'Icy Veins', quiet = false } = {}) {
  const url    = getSpecUrl(entry, source);
  const parser = SOURCE_PARSERS[source];

  if (!quiet) {
    console.log(`\nFetching ${entry.spec}…`);
    console.log(`  Source: ${source}`);
    console.log(`  URL: ${url}`);
  }

  const html   = await fetchHtml(url);
  const parsed = parser(html);

  if (!parsed.length) {
    throw new Error(
      'No BIS table found on page. The guide may not have a "Best Gear for Each Slot" ' +
      'section yet, or the URL may be wrong. Check the URL in a browser.'
    );
  }

  if (!quiet) {
    console.log(`  Found ${parsed.length} slots:`);
    for (const { slot, itemName } of parsed) {
      console.log(`    ${slot.padEnd(12)} → ${itemName}`);
    }
  }

  let entries = parsed.map(({ slot, itemName, itemId }) => ({
    spec:          entry.spec,
    slot,
    trueBis:       itemName,
    trueBisItemId: itemId ?? '',
    raidBis:       '',
    raidBisItemId: '',
    source,
  }));

  if (raidBis && itemDb) {
    entries = applyRaidBis(entries, itemDb);
    if (!quiet) {
      const raidCount = entries.filter(e => e.raidBis).length;
      console.log(`  Raid BIS matched: ${raidCount}/${entries.length} slots`);
    }
  }

  return entries;
}

/**
 * Fetch a spec's BIS guide page, parse it, and write to the sheet.
 * Returns the number of new rows written.
 */
async function fetchAndWrite(entry, sheetId, {
  overwrite = false,
  raidBis   = false,
  itemDb    = null,
  source    = 'Icy Veins',
  quiet     = false,
} = {}) {
  let entries = await fetchEntries(entry, { raidBis, itemDb, source, quiet });

  // Resolve item IDs: numeric placeholders → names (Wowhead BBCode),
  // and names → IDs (Maxroll / Icy Veins / any source without inline IDs).
  const db = itemDb ?? await getItemDb(sheetId);
  resolveItemIds(entries, db, { quiet });

  return writeDefaultBis(entries, { replace: overwrite });
}

async function cmdClear(sheetId, specName, source) {
  const all = await readRange(sheetId, 'Default BIS!A2:G');

  if (!specName && !source) {
    // Clear everything
    await clearRange(sheetId, 'Default BIS!A2:G');
    console.log(`✓ Cleared all ${all.length} Default BIS rows.`);
    return;
  }

  // Build filter: keep rows that do NOT match the deletion criteria
  const keep = all.filter(r => {
    const rowSpec   = (r[0] ?? '').toLowerCase();
    const rowSource = r[6] ?? '';
    const specMatch   = specName ? rowSpec === specName.toLowerCase() : true;
    const sourceMatch = source   ? rowSource === source               : true;
    return !(specMatch && sourceMatch);
  });

  const removed = all.length - keep.length;

  if (!removed) {
    const desc = [specName && `"${specName}"`, source && `source "${source}"`].filter(Boolean).join(', ');
    console.log(`  No rows found for ${desc} — nothing to clear.`);
    return;
  }

  await clearRange(sheetId, 'Default BIS!A2:G');
  if (keep.length) {
    await writeRange(sheetId, `Default BIS!A2:G${keep.length + 1}`, keep);
  }

  const desc = [specName && `"${specName}"`, source && `source "${source}"`].filter(Boolean).join(', ');
  console.log(`✓ Cleared ${removed} rows for ${desc}.`);
}

// ── Source management commands ────────────────────────────────────────────────

/**
 * Normalize a user-supplied source string to a canonical source name.
 * Accepts both slug form ("icy-veins") and display form ("Icy Veins").
 * Returns null if unrecognised.
 */
function resolveSourceArg(raw) {
  if (!raw) return null;
  const mapped = SOURCE_FLAG_MAP[raw.toLowerCase()];
  if (mapped) return mapped;
  return VALID_SOURCES.find(s => s.toLowerCase() === raw.toLowerCase()) ?? null;
}

/**
 * Set the preferred BIS source for a single spec.
 * Usage: set-source "<Spec Name>" <source> <sheetId>
 */
async function cmdSetSource(specName, sourceArg, sheetId) {
  const entry = SPEC_CATALOG.find(s => s.spec.toLowerCase() === specName.toLowerCase());
  if (!entry) {
    const close = SPEC_CATALOG.filter(s =>
      s.spec.toLowerCase().includes(specName.toLowerCase()) ||
      s.cls.toLowerCase().includes(specName.toLowerCase())
    );
    if (close.length) {
      console.error(`❌ Spec "${specName}" not found. Did you mean:`);
      close.forEach(s => console.error(`     "${s.spec}"`));
    } else {
      console.error(`❌ Spec "${specName}" not found. Run "list" to see all specs.`);
    }
    process.exit(1);
  }

  const canonical = resolveSourceArg(sourceArg);
  if (!canonical) {
    console.error(`❌ Unknown source "${sourceArg}". Valid values: ${Object.keys(SOURCE_FLAG_MAP).join(' | ')}`);
    process.exit(1);
  }

  await setSpecBisSource(sheetId, entry.spec, canonical);
  console.log(`✓ ${entry.spec} → ${canonical}`);
}

/**
 * Set the preferred BIS source for ALL specs at once.
 * Usage: set-source-all <source> <sheetId>
 */
async function cmdSetSourceAll(sourceArg, sheetId) {
  const canonical = resolveSourceArg(sourceArg);
  if (!canonical) {
    console.error(`❌ Unknown source "${sourceArg}". Valid values: ${Object.keys(SOURCE_FLAG_MAP).join(' | ')}`);
    process.exit(1);
  }

  console.log(`Setting all ${SPEC_CATALOG.length} specs → ${canonical}…`);
  const entries = SPEC_CATALOG.map(e => ({ spec: e.spec, source: canonical }));
  await writeSpecBisConfig(sheetId, entries);
  console.log(`✓ Done.`);
}

/**
 * Display the current per-spec source configuration alongside which sources
 * have data available in the sheet.
 * Usage: show-sources <sheetId>
 */
async function cmdShowSources(sheetId) {
  const [config, allBis] = await Promise.all([
    getSpecBisConfig(sheetId),
    getDefaultBis(sheetId),
  ]);

  // Which (spec, source) combos actually have rows in the sheet?
  const hasData = new Set(allBis.map(r => `${r.spec}|${r.source}`));

  const specW = Math.max(...SPEC_CATALOG.map(s => s.spec.length));

  console.log(`\n  ${'Spec'.padEnd(specW)}  Configured Source   Data available`);
  console.log(`  ${'-'.repeat(specW + 50)}`);

  for (const entry of SPEC_CATALOG) {
    const configured = config.get(entry.spec);
    const label      = configured ?? `Icy Veins`;
    const defaultTag = configured ? '' : ' *';

    const available = VALID_SOURCES.filter(s => hasData.has(`${entry.spec}|${s}`));
    const dataStr   = available.length ? available.join(', ') : '(none)';

    console.log(`  ${entry.spec.padEnd(specW)}  ${(label + defaultTag).padEnd(18)}  ${dataStr}`);
  }

  const unset = SPEC_CATALOG.filter(e => !config.has(e.spec)).length;
  if (unset > 0) {
    console.log(`\n  * = no preference set; defaults to "Icy Veins" at runtime.`);
    console.log(`      Set with: set-source "<Spec Name>" <source> <sheetId>`);
    console.log(`      Or:       set-source-all <source> <sheetId>`);
  }
  console.log();
}

// ── Entry point ───────────────────────────────────────────────────────────────

const flags   = new Set(process.argv.filter(a => a.startsWith('--') && !a.includes('=')));
const posArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const [command, arg1, arg2, arg3] = posArgs;

const overwrite   = flags.has('--overwrite');
const withRaidBis = flags.has('--raid-bis');

// --source=icy-veins (default) | --source=wowhead | --source=maxroll
// Used for fetch/fetch-all/list/clear. Not used for set-source (which takes a positional arg).
const sourceFlagArg = process.argv.find(a => a.startsWith('--source='));
const sourceFlagKey = sourceFlagArg ? sourceFlagArg.slice('--source='.length).toLowerCase() : 'icy-veins';
const source        = SOURCE_FLAG_MAP[sourceFlagKey];
if (!source && !['set-source', 'set-source-all', 'show-sources'].includes(command)) {
  console.error(`❌ Unknown --source "${sourceFlagKey}". Valid values: ${Object.keys(SOURCE_FLAG_MAP).join(' | ')}`);
  process.exit(1);
}

try {
  switch (command) {
    case 'list':
      cmdList(arg1 ?? '', source);
      break;

    case 'show':
      if (!arg1 || !arg2) {
        console.error('Usage: seed-default-bis.js show "<Spec Name>" <sheetId>');
        process.exit(1);
      }
      await cmdShow(arg1, arg2);
      break;

    case 'fetch':
      if (!arg1 || !arg2) {
        console.error('Usage: seed-default-bis.js fetch "<Spec Name>" <sheetId>');
        console.error('  Spec name must be quoted if it contains spaces.');
        console.error('  Run "list" to see all spec names.');
        process.exit(1);
      }
      await cmdFetch(arg1, arg2, { overwrite, raidBis: withRaidBis, source });
      break;

    case 'fetch-all':
      if (!arg1) {
        console.error('Usage: seed-default-bis.js fetch-all <sheetId>');
        process.exit(1);
      }
      await cmdFetchAll(arg1, { overwrite, raidBis: withRaidBis, source });
      break;

    case 'clear':
      if (!arg1) {
        console.error('Usage: seed-default-bis.js clear <sheetId> [specName]');
        console.error('  Omit specName to clear ALL Default BIS rows.');
        console.error('  Add --source=<source> to clear only rows from that source.');
        process.exit(1);
      }
      // --source flag filters clear to a specific source; omit to clear all sources
      await cmdClear(arg1, arg2, sourceFlagArg ? source : null);
      break;

    case 'set-source':
      // set-source "<Spec Name>" <source> <sheetId>
      if (!arg1 || !arg2 || !arg3) {
        console.error('Usage: seed-default-bis.js set-source "<Spec Name>" <source> <sheetId>');
        console.error(`  source: ${Object.keys(SOURCE_FLAG_MAP).join(' | ')}`);
        process.exit(1);
      }
      await cmdSetSource(arg1, arg2, arg3);
      break;

    case 'set-source-all':
      // set-source-all <source> <sheetId>
      if (!arg1 || !arg2) {
        console.error('Usage: seed-default-bis.js set-source-all <source> <sheetId>');
        console.error(`  source: ${Object.keys(SOURCE_FLAG_MAP).join(' | ')}`);
        process.exit(1);
      }
      await cmdSetSourceAll(arg1, arg2);
      break;

    case 'show-sources':
      // show-sources <sheetId>
      if (!arg1) {
        console.error('Usage: seed-default-bis.js show-sources <sheetId>');
        process.exit(1);
      }
      await cmdShowSources(arg1);
      break;

    default:
      console.log([
        'Usage:',
        '  node --env-file=.env scripts/seed-default-bis.js list [search]',
        '  node --env-file=.env scripts/seed-default-bis.js show "<Spec Name>" <sheetId>',
        '  node --env-file=.env scripts/seed-default-bis.js fetch "<Spec Name>" <sheetId>',
        '  node --env-file=.env scripts/seed-default-bis.js fetch-all <sheetId>',
        '  node --env-file=.env scripts/seed-default-bis.js clear <sheetId> [specName]',
        '  node --env-file=.env scripts/seed-default-bis.js set-source "<Spec Name>" <source> <sheetId>',
        '  node --env-file=.env scripts/seed-default-bis.js set-source-all <source> <sheetId>',
        '  node --env-file=.env scripts/seed-default-bis.js show-sources <sheetId>',
        '',
        'Flags (fetch/fetch-all/list/clear):',
        '  --overwrite          Replace existing entries for the same source (default: skip)',
        '  --raid-bis           Also populate RaidBIS by cross-referencing Item DB',
        `  --source=<source>    Guide source (default: icy-veins)`,
        `                       Valid: ${Object.keys(SOURCE_FLAG_MAP).join(' | ')}`,
        '',
        'Source management:',
        '  Each spec stores its BIS list independently per source (Icy Veins, Wowhead, Maxroll).',
        '  "set-source" records which source is the preferred default for a spec.',
        '  The web app and loot council use the preferred source at runtime.',
        '',
        'Examples:',
        '  # Seed from Icy Veins (default) — skip specs already seeded from this source',
        '  node --env-file=.env scripts/seed-default-bis.js fetch "Frost Mage" $SHEET_ID',
        '',
        '  # Seed Wowhead data alongside existing Icy Veins data',
        '  node --env-file=.env scripts/seed-default-bis.js fetch "Frost Mage" $SHEET_ID --source=wowhead',
        '',
        '  # Re-seed a spec from Maxroll after guide update (replaces only Maxroll rows)',
        '  node --env-file=.env scripts/seed-default-bis.js fetch "Frost Mage" $SHEET_ID --source=maxroll --overwrite',
        '',
        '  # Seed all specs from all three sources',
        '  node --env-file=.env scripts/seed-default-bis.js fetch-all $SHEET_ID --source=icy-veins',
        '  node --env-file=.env scripts/seed-default-bis.js fetch-all $SHEET_ID --source=wowhead',
        '  node --env-file=.env scripts/seed-default-bis.js fetch-all $SHEET_ID --source=maxroll',
        '',
        '  # Set preferred source for a spec',
        '  node --env-file=.env scripts/seed-default-bis.js set-source "Frost Mage" maxroll $SHEET_ID',
        '',
        '  # Set all specs to use Wowhead by default',
        '  node --env-file=.env scripts/seed-default-bis.js set-source-all wowhead $SHEET_ID',
        '',
        '  # See current config and which sources have data',
        '  node --env-file=.env scripts/seed-default-bis.js show-sources $SHEET_ID',
        '',
        '  # Clear only Icy Veins rows for one spec',
        '  node --env-file=.env scripts/seed-default-bis.js clear $SHEET_ID "Frost Mage" --source=icy-veins',
      ].join('\n'));
  }
} catch (err) {
  console.error('\n❌', err.message);
  process.exit(1);
}
