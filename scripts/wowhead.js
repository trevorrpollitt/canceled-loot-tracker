/**
 * wowhead.js — Fetch and parse item data from Wowhead pages.
 *
 * Three modes:
 *   fetchWowheadItems(url)      — item list pages with embedded Listview JSON
 *   extractItemIdsFromPage(url) — any page (guides, loot pages) via item links
 *   parseS1MplusGuide(html)     — structured loot guide tables (Slot|Item|Dungeon)
 */

/**
 * Extract the data array from a Listview with id='items' embedded in raw HTML.
 * Uses bracket-depth counting rather than regex to handle arbitrarily large JSON.
 */
function extractListviewData(html) {
  for (const idToken of ["'items'", '"items"']) {
    const marker = `id: ${idToken}`;
    const markerPos = html.indexOf(marker);
    if (markerPos === -1) continue;

    const dataPos = html.indexOf('data:', markerPos);
    if (dataPos === -1) continue;

    const arrStart = html.indexOf('[', dataPos);
    if (arrStart === -1) continue;

    let depth = 0;
    let i = arrStart;
    for (; i < html.length; i++) {
      if (html[i] === '[') depth++;
      else if (html[i] === ']' && --depth === 0) break;
    }

    return JSON.parse(html.slice(arrStart, i + 1));
  }

  throw new Error(
    'No item Listview found on page.\n' +
    '  • Make sure the URL is a multi-item list page (not a single-item page).\n' +
    '  • Try adding "?filter=minqual=3" to filter to Rare+ items.\n' +
    '  • Wowhead must be returning HTML — verify the URL in a browser first.',
  );
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`Wowhead HTTP ${res.status}: ${url}`);
  return res.text();
}

/**
 * Fetch a Wowhead item list page and return the raw item objects from the Listview.
 * Each object contains at minimum: id, name, quality, slot, subclass, classs.
 * Works on zone loot pages, item filter pages, etc.
 */
export async function fetchWowheadItems(url) {
  const html = await fetchHtml(url);
  return extractListviewData(html);
}

/**
 * Fetch any Wowhead page (including guide/loot pages) and return unique item IDs
 * found in item links (href="/item=ITEMID" or ?item=ITEMID).
 * Use this for guide pages that list boss drops as item tooltips/links.
 */
export async function extractItemIdsFromPage(url) {
  const html  = await fetchHtml(url);
  const found = [...html.matchAll(/[?&/]item=(\d+)/g)].map(m => m[1]);
  return [...new Set(found)];
}

// ── S1 M+ guide parser ────────────────────────────────────────────────────────

function guidStripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

const GUIDE_SLOT_MAP = {
  neck:      'Neck',
  ring:      'Ring',
  finger:    'Ring',
  back:      'Back',
  cloak:     'Back',
  wrist:     'Wrists',
  wrists:    'Wrists',
  waist:     'Waist',
  belt:      'Waist',
  feet:      'Feet',
  boots:     'Feet',
  head:      'Head',
  helm:      'Head',
  helmet:    'Head',
  shoulder:  'Shoulders',
  shoulders: 'Shoulders',
  chest:     'Chest',
  hands:     'Hands',
  gloves:    'Hands',
  legs:      'Legs',
  trinket:   'Trinket',
};

function guideNormalizeSlot(raw) {
  return GUIDE_SLOT_MAP[raw.trim().toLowerCase()] ?? null;
}

/**
 * Parse the Midnight Season 1 Mythic+ loot guide page HTML.
 * Expects structured tables under h3 headings with id= attributes.
 *
 * Armor sections (id: accessories | cloth-armor | leather-armor | mail-armor |
 *                     plate-armor | trinkets):
 *   Columns: Slot | Item | Dungeon
 *
 * Weapon section (id: weapons):
 *   Columns: Type | Stat | Item | Dungeon
 *
 * Returns an array of { itemId, name, slot, armorType, dungeon }.
 */
export function parseS1MplusGuide(html) {
  const items = [];

  const sections = [
    { id: 'accessories',   armorType: 'Accessory', weaponTable: false },
    { id: 'cloth-armor',   armorType: 'Cloth',     weaponTable: false },
    { id: 'leather-armor', armorType: 'Leather',   weaponTable: false },
    { id: 'mail-armor',    armorType: 'Mail',       weaponTable: false },
    { id: 'plate-armor',   armorType: 'Plate',      weaponTable: false },
    { id: 'trinkets',      armorType: 'Accessory', weaponTable: false },
    { id: 'weapons',       armorType: 'Accessory', weaponTable: true  },
  ];

  for (const { id, armorType, weaponTable } of sections) {
    const before = items.length;

    // Find <h3 ... id="sectionId" ...>
    const h3Re    = new RegExp(`<h3[^>]+\\bid="${id}"[^>]*>[\\s\\S]*?</h3>`, 'i');
    const h3Match = html.match(h3Re);
    if (!h3Match) { console.warn(`  ⚠ Section "${id}" not found on page`); continue; }

    // Slice to next h2/h3 to avoid cross-section leakage
    const afterH3     = html.slice(h3Match.index + h3Match[0].length);
    const nextHeading = afterH3.search(/<h[23][\s>]/i);
    const sectionHtml = nextHeading > -1 ? afterH3.slice(0, nextHeading) : afterH3;

    // Extract all <tr> rows; skip index 0 (header row)
    const allRows = [...sectionHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)];

    for (let ri = 1; ri < allRows.length; ri++) {
      const rowHtml = allRows[ri][0];
      const cells   = [...rowHtml.matchAll(/<td[\s\S]*?<\/td>/gi)].map(m => m[0]);

      if (weaponTable) {
        // Weapons: Type(0) | Stat(1) | Item(2) | Dungeon(3)
        if (cells.length < 4) continue;
        const itemCell = cells[2];
        const dungeon  = guidStripTags(cells[3]).trim();
        const idMatch  = itemCell.match(/\/item=(\d+)/);
        if (!idMatch || !dungeon) continue;
        const name = guidStripTags(itemCell).trim();
        if (!name) continue;
        items.push({ itemId: idMatch[1], name, slot: 'Weapon', armorType: 'Accessory', dungeon });
      } else {
        // Armor: Slot(0) | Item(1) | Dungeon(2)
        if (cells.length < 3) continue;
        const slotRaw  = guidStripTags(cells[0]).trim();
        const slot     = guideNormalizeSlot(slotRaw);
        if (!slot) { if (slotRaw) console.warn(`  ⚠ Unknown slot "${slotRaw}"`); continue; }
        const itemCell = cells[1];
        const dungeon  = guidStripTags(cells[2]).trim();
        const idMatch  = itemCell.match(/\/item=(\d+)/);
        if (!idMatch || !dungeon) continue;
        const name = guidStripTags(itemCell).trim();
        if (!name) continue;
        items.push({ itemId: idMatch[1], name, slot, armorType, dungeon });
      }
    }

    console.log(`  ${id}: ${items.length - before} items`);
  }

  return items;
}

/**
 * Fetch the Midnight S1 M+ guide page and return parsed item rows.
 */
export async function fetchS1MplusGuide(url) {
  const html = await fetchHtml(url);
  return parseS1MplusGuide(html);
}
