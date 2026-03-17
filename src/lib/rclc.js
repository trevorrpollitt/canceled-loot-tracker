/**
 * rclc.js — RCLC CSV parser and loot entry builder.
 *
 * RCLC export columns (0-indexed):
 *   0=player  1=date  2=time  3=item  4=itemID  5=itemString
 *   6=response  7=votes  8=class  9=instance  10=boss  11+=gear slots
 *
 * player:   "CharName-RealmName" — realm suffix is stripped
 * date:     "MM/DD/YY"
 * instance: "Instance Name-Difficulty" — difficulty is the last hyphen segment
 * response: raw RCLC button label — mapped via RCLC Response Map sheet tab
 */

import { randomUUID } from 'node:crypto';

// ── CSV parser ────────────────────────────────────────────────────────────────

/**
 * Parse a single CSV line, handling double-quoted fields and escaped quotes.
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parse a full RCLC CSV export text into an array of row objects keyed by header.
 *
 * @param {string} text  raw CSV text (UTF-8, may have BOM)
 * @returns {object[]}
 */
export function parseRclcCsv(text) {
  const clean = text.replace(/^\uFEFF/, '').trim();
  const lines = clean.split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (values[idx] ?? '').trim(); });
    rows.push(row);
  }

  return rows;
}

// ── Field helpers ─────────────────────────────────────────────────────────────

/**
 * Strip realm suffix from a RCLC player field.
 * "Anzhem-Area52" → "Anzhem"
 * "Anzhem" → "Anzhem" (unchanged if no hyphen)
 */
function stripRealm(playerName) {
  const idx = playerName.lastIndexOf('-');
  return idx > 0 ? playerName.slice(0, idx) : playerName;
}

/**
 * Parse a RCLC date string "MM/DD/YY" → ISO "YYYY-MM-DD".
 */
function parseDate(dateStr) {
  const parts = dateStr.split('/');
  if (parts.length !== 3) return dateStr;
  const [m, d, y] = parts;
  const year = y.length === 2 ? `20${y}` : y;
  return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * Extract difficulty from an instance string.
 * "Manaforge Omega-Heroic" → "Heroic"
 * "Manaforge Omega" → "Manaforge Omega" (fallback)
 */
function parseDifficulty(instance) {
  const idx = instance.lastIndexOf('-');
  return idx > 0 ? instance.slice(idx + 1).trim() : instance;
}

/**
 * Strip surrounding brackets from an item name if present.
 * "[Chrysalis of Sundered Souls]" → "Chrysalis of Sundered Souls"
 */
function stripBrackets(name) {
  return name.replace(/^\[|\]$/g, '').trim();
}

// ── Entry builder ─────────────────────────────────────────────────────────────

/**
 * Build Loot Log entry objects from parsed RCLC CSV rows.
 *
 * Dedup key: `charName.toLowerCase()|itemName.toLowerCase()|dateIso`
 * This matches the key format used when building existingKeys from getLootLog().
 *
 * @param {object[]} rows          Parsed CSV rows from parseRclcCsv()
 * @param {object[]} roster        From getRoster() — array of { charName, ownerId }
 * @param {Map}      responseMap   From getRclcResponseMap() — Map<label, { internalType }>
 * @param {Set}      existingKeys  Dedup set — mutated in-place as new entries are added
 * @returns {{ entries: object[], warnings: string[], skipped: number }}
 */
export function buildLootEntries(rows, roster, responseMap, existingKeys) {
  const rosterByChar = new Map(roster.map(r => [r.charName.toLowerCase(), r]));
  const entries  = [];
  const warnings = [];
  let skipped    = 0;

  for (const row of rows) {
    const charName     = stripRealm(row.player ?? '');
    const itemName     = stripBrackets(row.item ?? '');
    const dateIso      = parseDate(row.date ?? '');
    const boss         = (row.boss ?? '').trim();
    const difficulty   = parseDifficulty(row.instance ?? '');
    const responseLabel = (row.response ?? '').trim();

    if (!charName || !itemName) continue;

    // Skip rows where response indicates the item wasn't awarded as loot
    // (handled by response map — unmapped = warn + Non-BIS, not skip)

    // Dedup
    const dedupKey = `${charName.toLowerCase()}|${itemName.toLowerCase()}|${dateIso}`;
    if (existingKeys.has(dedupKey)) {
      skipped++;
      continue;
    }

    // Map RCLC response label to internal upgrade type
    let upgradeType = 'Non-BIS';
    const mapped = responseMap.get(responseLabel.toLowerCase());
    if (mapped) {
      upgradeType = mapped.internalType;
    } else {
      warnings.push(`Unknown response "${responseLabel}" for ${charName} / ${itemName} — defaulted to Non-BIS`);
    }

    // Look up Discord user ID from roster (best-effort)
    const rosterEntry = rosterByChar.get(charName.toLowerCase());
    const recipientId = rosterEntry?.ownerId ?? '';

    entries.push({
      id:            randomUUID(),
      raidId:        '',
      date:          dateIso,
      boss,
      itemName,
      difficulty,
      recipientId,
      recipientChar: charName,
      upgradeType,
      notes:         responseLabel,
    });

    existingKeys.add(dedupKey);
  }

  return { entries, warnings, skipped };
}

/**
 * Build the dedup key set from an existing Loot Log for use with buildLootEntries().
 *
 * @param {object[]} lootLog  From getLootLog()
 * @returns {Set<string>}
 */
export function buildExistingKeys(lootLog) {
  return new Set(
    lootLog.map(e =>
      `${(e.recipientChar ?? '').toLowerCase()}|${(e.itemName ?? '').toLowerCase()}|${e.date}`
    )
  );
}
