/**
 * sheets.js — Google Sheets abstraction layer.
 *
 * All bot code talks to this module; nothing else imports googleapis directly.
 * Every public function takes a sheetId so the same code serves multiple teams.
 *
 * Auth strategy:
 *   Local dev  → GOOGLE_SERVICE_ACCOUNT_KEY_PATH points to a JSON key file
 *   Railway    → GOOGLE_SERVICE_ACCOUNT_KEY_JSON holds the JSON as a single-line string
 */

import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Auth ──────────────────────────────────────────────────────────────────────

function loadCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON);
  }
  const path = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH
    ?? resolve(__dirname, '../../config/service-account.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

let _auth = null;

function getAuth() {
  if (_auth) return _auth;
  _auth = new google.auth.GoogleAuth({
    credentials: loadCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return _auth;
}

function client() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

// ── Retry helper ─────────────────────────────────────────────────────────────

/**
 * Retries an async Sheets API call on 429 / 503 with exponential backoff.
 * @param {() => Promise<any>} fn
 * @param {number} retries
 * @param {number} baseDelayMs
 */
async function withRetry(fn, retries = 6, baseDelayMs = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.code ?? err.status;
      const isRateLimit = status === 429 || status === 503;
      if (!isRateLimit || attempt === retries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`[sheets] Rate limited (${status}) — retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── In-memory TTL cache ───────────────────────────────────────────────────────
// Prevents redundant Sheets API calls within the same request burst (e.g. an
// officer rapidly clicking items on the council page).  Each cached value lives
// for CACHE_TTL_MS; write functions call cacheInvalidate() so mutations are
// always reflected on the next read.

const _cache   = new Map(); // `${sheetId}|${tabKey}` → { value, expiresAt }
const CACHE_TTL_MS = 60_000; // 60 s

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return undefined; }
  return entry.value;
}

function cacheSet(key, value) {
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheInvalidate(sheetId, ...tabKeys) {
  for (const k of tabKeys) _cache.delete(`${sheetId}|${k}`);
}

async function cachedRead(sheetId, tabKey, fn) {
  const key    = `${sheetId}|${tabKey}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const result = await fn();
  cacheSet(key, result);
  return result;
}

// ── Low-level read/write ──────────────────────────────────────────────────────

/**
 * Read a range. Returns a 2-D array of cell values.
 * Empty trailing cells are omitted by the API; we don't pad them here.
 *
 * @param {string} sheetId
 * @param {string} range    A1 notation, e.g. "Roster!A2:G"
 * @returns {Array<Array<string>>}
 */
export async function readRange(sheetId, range) {
  const res = await withRetry(() => client().spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  }));
  return res.data.values ?? [];
}

/**
 * Append rows to a sheet tab.
 *
 * @param {string}              sheetId
 * @param {string}              range   e.g. "Loot Log!A:Z"
 * @param {Array<Array<string>>} rows
 */
export async function appendRows(sheetId, range, rows) {
  await withRetry(() => client().spreadsheets.values.append({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  }));
}

/**
 * Overwrite a specific range.
 *
 * @param {string}              sheetId
 * @param {string}              range
 * @param {Array<Array<string>>} values
 */
export async function writeRange(sheetId, range, values) {
  await withRetry(() => client().spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  }));
}

/**
 * Clear all values in a range (leaves formatting intact).
 *
 * @param {string} sheetId
 * @param {string} range   A1 notation, e.g. "Item DB!A2:I"
 */
export async function clearRange(sheetId, range) {
  await withRetry(() => client().spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range,
  }));
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Normalise a Sheets date value to an ISO "YYYY-MM-DD" string.
 *
 * When USER_ENTERED writes a date string like "2026-03-14", Sheets parses it
 * as a date and stores a serial number internally.  UNFORMATTED_VALUE then
 * returns that number (e.g. 46094) instead of the original string.
 * This helper converts either form to a consistent ISO string so dedup keys
 * always match between freshly-parsed CSV rows and values read back from the
 * sheet.
 *
 * Sheets serial epoch: Dec 30 1899 (with the Lotus 1-2-3 leap-year bug that
 * treats 1900 as a leap year, hence the 25569-day JS-epoch offset).
 */
function normalizeSheetDate(val) {
  if (typeof val === 'number') {
    const ms = (val - 25569) * 86400 * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return String(val ?? '');
}

// ── Tab helpers ───────────────────────────────────────────────────────────────
// Return plain JS objects so handler code never touches raw cell arrays.
// Column order must match the sheet schema in CLAUDE.md exactly.

/**
 * Roster tab  (A=CharName B=Class C=Spec D=Role E=Status F=OwnerId G=OwnerNick)
 *
 * Note: Role (col D) is computed by an Apps Script onEdit trigger — never write to it.
 *
 * @param {string} sheetId
 * @returns {object[]}
 */
export async function getRoster(sheetId) {
  return cachedRead(sheetId, 'roster', async () => {
    const rows = await readRange(sheetId, 'Roster!A2:G');
    return rows
      .map(r => ({
        charName:  r[0] ?? '',
        class:     r[1] ?? '',
        spec:      r[2] ?? '',
        role:      r[3] ?? '',
        status:    r[4] ?? '',
        ownerId:   r[5] ?? '',
        ownerNick: r[6] ?? '',
      }))
      .filter(c => c.charName);
  });
}

/**
 * Update the OwnerNick (column G) for every character in the Roster tab
 * that shares the given ownerId. One batch write regardless of character count.
 *
 * @param {string} sheetId
 * @param {string} ownerId    Discord user ID snowflake (column F)
 * @param {string} ownerNick  New display name to set
 */
export async function setOwnerNick(sheetId, ownerId, ownerNick) {
  const rows    = await readRange(sheetId, 'Roster!A2:G');
  const updates = [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][5] ?? '') === ownerId) {
      updates.push({ range: `Roster!G${i + 2}`, values: [[ownerNick]] });
    }
  }
  if (!updates.length) throw new Error(`No characters found for ownerId "${ownerId}"`);
  await batchWriteRanges(sheetId, updates);
  cacheInvalidate(sheetId, 'roster');
}

/**
 * Set the OwnerId (column F) and OwnerNick (column G) for a specific character.
 * Used when linking a previously unlinked character to a Discord account.
 *
 * @param {string} sheetId
 * @param {string} charName
 * @param {string} ownerId    Discord user ID snowflake
 * @param {string} ownerNick  Display name (may be empty string)
 */
export async function setRosterOwner(sheetId, charName, ownerId, ownerNick) {
  const rows = await readRange(sheetId, 'Roster!A2:G');
  const idx  = rows.findIndex(r => (r[0] ?? '') === charName);
  if (idx < 0) throw new Error(`Character "${charName}" not found in roster`);
  const rowNum = idx + 2;
  await writeRange(sheetId, `Roster!F${rowNum}:G${rowNum}`, [[ownerId, ownerNick ?? '']]);
  cacheInvalidate(sheetId, 'roster');
}

/**
 * Update a character's Status in the Roster tab (column E).
 * Valid values: Active | Bench | Inactive
 *
 * @param {string} sheetId
 * @param {string} charName
 * @param {string} status
 */
export async function setRosterStatus(sheetId, charName, status) {
  const rows = await readRange(sheetId, 'Roster!A2:E');
  const idx  = rows.findIndex(r => (r[0] ?? '') === charName);
  if (idx < 0) throw new Error(`Character "${charName}" not found in roster`);
  const rowNum = idx + 2; // +1 for 1-indexed, +1 for header
  await writeRange(sheetId, `Roster!E${rowNum}`, [[status]]);
  cacheInvalidate(sheetId, 'roster');
}

/**
 * Loot Log tab  (A=Id B=RaidId C=Date D=Boss E=ItemName F=Difficulty
 *                G=RecipientId H=RecipientChar I=UpgradeType J=Notes)
 * @param {string} sheetId
 * @returns {object[]}
 */
export async function getLootLog(sheetId) {
  return cachedRead(sheetId, 'lootLog', async () => {
    const rows = await readRange(sheetId, 'Loot Log!A2:J');
    return rows
      .map(r => ({
        id:            r[0] ?? '',
        raidId:        r[1] ?? '',
        date:          normalizeSheetDate(r[2]),
        boss:          r[3] ?? '',
        itemName:      r[4] ?? '',
        difficulty:    r[5] ?? '',
        recipientId:   r[6] ?? '',
        recipientChar: r[7] ?? '',
        upgradeType:   r[8] ?? '',
        notes:         r[9] ?? '',
      }))
      .filter(e => e.id);
  });
}

/**
 * Append entries to the Loot Log.
 * Each entry must have: id, raidId, date, boss, itemName, difficulty,
 *                       recipientId, recipientChar, upgradeType, notes
 * @param {string}   sheetId
 * @param {object[]} entries
 */
export async function appendLootEntries(sheetId, entries) {
  if (!entries.length) return;
  const rows = entries.map(e => [
    e.id, e.raidId, e.date, e.boss, e.itemName,
    e.difficulty, e.recipientId, e.recipientChar, e.upgradeType, e.notes,
  ]);
  await appendRows(sheetId, 'Loot Log!A:J', rows);
  cacheInvalidate(sheetId, 'lootLog');
}

/**
 * RCLC Response Map tab  (A=RCLCButton  B=InternalType  C=CountedInTotals)
 * Returns a Map<rclcButtonLabel, { internalType: string, counted: boolean }>
 *
 * @param {string} sheetId
 * @returns {Map<string, { internalType: string, counted: boolean }>}
 */
export async function getRclcResponseMap(sheetId) {
  return cachedRead(sheetId, 'rclcResponseMap', async () => {
    const rows = await readRange(sheetId, 'RCLC Response Map!A2:C');
    const map = new Map();
    for (const r of rows) {
      if (!r[0]) continue;
      map.set(r[0].trim(), {
        internalType: r[1]?.trim() ?? 'Non-BIS',
        counted:      (r[2]?.trim() ?? 'Yes') === 'Yes',
      });
    }
    return map;
  });
}

/**
 * Config tab  (A=Key  B=Value)
 * Returns a flat object: { raid_days: "Tue,Thu", current_difficulty: "Mythic", ... }
 *
 * @param {string} sheetId
 * @returns {object}
 */
export async function getConfig(sheetId) {
  return cachedRead(sheetId, 'config', async () => {
    const rows = await readRange(sheetId, 'Config!A2:B');
    return Object.fromEntries(
      rows.filter(r => r[0]).map(([k, v]) => [k, v ?? ''])
    );
  });
}

/**
 * Write or update a single key in the Config tab.
 * Finds the row with the matching key and overwrites column B.
 * If the key doesn't exist, appends a new row.
 *
 * @param {string} sheetId
 * @param {string} key
 * @param {string} value
 */
export async function setConfigValue(sheetId, key, value) {
  const rows = await readRange(sheetId, 'Config!A2:B');
  const rowIndex = rows.findIndex(r => r[0] === key);

  if (rowIndex >= 0) {
    // Row exists — overwrite just the value cell (rowIndex is 0-based; +2 for header + 1-indexing)
    const rowNum = rowIndex + 2;
    await writeRange(sheetId, `Config!B${rowNum}`, [[String(value)]]);
  } else {
    // Key not found — append a new row
    await appendRows(sheetId, 'Config!A:B', [[key, String(value)]]);
  }
  cacheInvalidate(sheetId, 'config');
}

/**
 * BIS Submissions tab  (A=Id B=CharName C=Spec D=Slot E=TrueBIS F=RaidBIS
 *                       G=Rationale H=Status I=SubmittedAt J=ReviewedBy K=OfficerNote)
 * @param {string} sheetId
 * @returns {object[]}
 */
export async function getBisSubmissions(sheetId) {
  return cachedRead(sheetId, 'bisSubmissions', async () => {
    // Schema: A=Id B=CharName C=Spec D=Slot E=TrueBIS F=RaidBIS G=Rationale
    //         H=Status I=SubmittedAt J=ReviewedBy K=OfficerNote
    //         L=TrueBISItemId M=RaidBISItemId
    const rows = await readRange(sheetId, 'BIS Submissions!A2:M');
    return rows
      .map(r => ({
        id:           r[0]  ?? '',
        charName:     r[1]  ?? '',
        spec:         r[2]  ?? '',
        slot:         r[3]  ?? '',
        trueBis:      r[4]  ?? '',
        raidBis:      r[5]  ?? '',
        rationale:    r[6]  ?? '',
        status:       r[7]  ?? 'Pending',
        submittedAt:  r[8]  ?? '',
        reviewedBy:   r[9]  ?? '',
        officerNote:  r[10] ?? '',
        trueBisItemId:  r[11] ?? '',
        raidBisItemId:  r[12] ?? '',
      }))
      .filter(r => r.id);
  });
}

/**
 * Upsert a single BIS submission row.
 *
 * If a row already exists for (charName, slot), the TrueBIS, RaidBIS,
 * Rationale, Status, SubmittedAt, and ItemId columns are updated in place.
 * ReviewedBy and OfficerNote are always preserved.
 * Status is always reset to "Pending" on upsert.
 *
 * Extends the sheet schema with two optional columns:
 *   L = TrueBISItemId   (numeric Wowhead item ID or '')
 *   M = RaidBISItemId
 */
export async function upsertBisSubmission(sheetId, {
  charName, spec, slot,
  trueBis, trueBisItemId,
  raidBis, raidBisItemId,
  rationale,
}) {
  const rows  = await readRange(sheetId, 'BIS Submissions!A2:K');
  const today = new Date().toISOString().slice(0, 10);

  const idx = rows.findIndex(
    r => (r[1] ?? '') === charName && (r[3] ?? '') === slot
  );

  if (idx >= 0) {
    const rowNum = idx + 2; // +1 for 1-indexed, +1 for header
    // Update content columns (E–I) and item-ID columns (L–M) separately
    // so that ReviewedBy (J) and OfficerNote (K) are never overwritten.
    await writeRange(sheetId, `BIS Submissions!E${rowNum}:I${rowNum}`, [[
      trueBis   ?? '',
      raidBis   ?? '',
      rationale ?? '',
      'Pending',
      today,
    ]]);
    await writeRange(sheetId, `BIS Submissions!L${rowNum}:M${rowNum}`, [[
      trueBisItemId ?? '',
      raidBisItemId ?? '',
    ]]);
  } else {
    const id = `bis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await appendRows(sheetId, 'BIS Submissions!A:M', [[
      id,
      charName,
      spec,
      slot,
      trueBis        ?? '',
      raidBis        ?? '',
      rationale      ?? '',
      'Pending',
      today,
      '',                    // reviewedBy
      '',                    // officerNote
      trueBisItemId  ?? '',
      raidBisItemId  ?? '',
    ]]);
  }
  cacheInvalidate(sheetId, 'bisSubmissions');
}

/**
 * Batch-write multiple named ranges in a single Sheets API call.
 * Used internally by batchUpsertBisSubmissions.
 *
 * @param {string} sheetId
 * @param {{ range: string, values: string[][] }[]} updates
 */
async function batchWriteRanges(sheetId, updates) {
  if (!updates.length) return;
  await withRetry(() => client().spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates,
    },
  }));
}

/**
 * Upsert multiple BIS submission rows in as few API calls as possible.
 *
 * Cost: 1 read + 1 batchUpdate (all row updates) + 1 appendRows (all inserts).
 * Replaces N×upsertBisSubmission() which makes 3N sequential API calls and
 * triggers 429 rate-limiting when saving many slots at once.
 *
 * @param {string} sheetId
 * @param {object[]} updates  Each: { charName, spec, slot, trueBis,
 *                              trueBisItemId, raidBis, raidBisItemId, rationale }
 */
export async function batchUpsertBisSubmissions(sheetId, updates) {
  if (!updates.length) return;

  const rows  = await readRange(sheetId, 'BIS Submissions!A2:K');
  const today = new Date().toISOString().slice(0, 10);

  const rangeWrites = [];
  const newRows     = [];

  updates.forEach((u, i) => {
    const {
      charName, spec, slot,
      trueBis = '', trueBisItemId = '',
      raidBis = '', raidBisItemId = '',
      rationale = '',
    } = u;

    const idx = rows.findIndex(
      r => (r[1] ?? '') === charName && (r[3] ?? '') === slot
    );

    if (idx >= 0) {
      const rowNum = idx + 2;
      // Two sub-ranges per updated row, batched into a single API call.
      // J (ReviewedBy) and K (OfficerNote) are intentionally skipped.
      rangeWrites.push(
        { range: `BIS Submissions!E${rowNum}:I${rowNum}`,
          values: [[trueBis, raidBis, rationale, 'Pending', today]] },
        { range: `BIS Submissions!L${rowNum}:M${rowNum}`,
          values: [[trueBisItemId, raidBisItemId]] }
      );
    } else {
      // Mix index into the ID so two inserts in the same ms still differ
      const id = `bis-${Date.now().toString(36)}-${i.toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      newRows.push([
        id, charName, spec, slot,
        trueBis, raidBis, rationale,
        'Pending', today,
        '', '',           // reviewedBy, officerNote
        trueBisItemId, raidBisItemId,
      ]);
    }
  });

  if (rangeWrites.length) await batchWriteRanges(sheetId, rangeWrites);
  if (newRows.length)     await appendRows(sheetId, 'BIS Submissions!A:M', newRows);
  cacheInvalidate(sheetId, 'bisSubmissions');
}

/**
 * Approve a Pending BIS submission.
 *
 * Sets Status → Approved, writes ReviewedBy, clears any prior OfficerNote,
 * and snapshots the current TrueBIS/RaidBIS values into the LastApproved columns
 * (N–Q) so the player can detect and revert to this state later.
 *
 * @param {string} sheetId
 * @param {string} submissionId  Value in column A (the generated row ID)
 * @param {string} reviewerName  Officer's character name or username
 */
export async function approveBisSubmission(sheetId, submissionId, reviewerName) {
  const rows = await readRange(sheetId, 'BIS Submissions!A2:I');
  const idx  = rows.findIndex(r => (r[0] ?? '') === submissionId);
  if (idx < 0) throw new Error(`BIS submission "${submissionId}" not found`);

  const rowNum    = idx + 2;
  const submittedAt = rows[idx][8] ?? '';

  // Single write: Status=Approved (H), preserve SubmittedAt (I), ReviewedBy (J), clear OfficerNote (K)
  await writeRange(sheetId, `BIS Submissions!H${rowNum}:K${rowNum}`, [[
    'Approved', submittedAt, reviewerName, '',
  ]]);
  cacheInvalidate(sheetId, 'bisSubmissions');
}

/**
 * Reject a Pending BIS submission.
 *
 * Sets Status → Rejected, writes ReviewedBy and an optional OfficerNote.
 * Does NOT touch the LastApproved snapshot columns (N–Q).
 *
 * @param {string} sheetId
 * @param {string} submissionId
 * @param {string} reviewerName
 * @param {string} [officerNote]
 */
export async function rejectBisSubmission(sheetId, submissionId, reviewerName, officerNote = '') {
  const rows = await readRange(sheetId, 'BIS Submissions!A2:K');
  const idx  = rows.findIndex(r => (r[0] ?? '') === submissionId);
  if (idx < 0) throw new Error(`BIS submission "${submissionId}" not found`);

  const rowNum = idx + 2;
  const r      = rows[idx];

  // Status (H), SubmittedAt preserved (I), ReviewedBy (J), OfficerNote (K)
  await writeRange(sheetId, `BIS Submissions!H${rowNum}:K${rowNum}`, [[
    'Rejected', r[8] ?? '', reviewerName, officerNote,
  ]]);
  cacheInvalidate(sheetId, 'bisSubmissions');
}

/**
 * Clear a Pending BIS submission for a player's slot.
 *
 * Wipes the row (A–M) so getBisSubmissions filters it out and the slot
 * falls back to the spec default. Is a no-op if the row does not exist
 * or is not currently Pending.
 *
 * @param {string} sheetId
 * @param {string} charName
 * @param {string} slot
 * @returns {boolean} true if a row was found and cleared
 */
export async function clearPendingBisSubmission(sheetId, charName, slot) {
  const rows = await readRange(sheetId, 'BIS Submissions!A2:M');
  const idx  = rows.findIndex(
    r => (r[1] ?? '') === charName &&
         (r[3] ?? '') === slot     &&
         (r[7] ?? '') === 'Pending'
  );
  if (idx < 0) return false;

  const rowNum = idx + 2;
  await clearRange(sheetId, `BIS Submissions!A${rowNum}:M${rowNum}`);
  cacheInvalidate(sheetId, 'bisSubmissions');
  return true;
}

/**
 * Acknowledge a Rejected BIS submission, wiping the row so the slot reverts
 * to the spec default. Is a no-op if no Rejected row exists for the slot.
 *
 * @param {string} sheetId
 * @param {string} charName
 * @param {string} slot
 * @returns {boolean} true if a row was found and cleared
 */
export async function clearRejectedBisSubmission(sheetId, charName, slot) {
  const rows = await readRange(sheetId, 'BIS Submissions!A2:M');
  const idx  = rows.findIndex(
    r => (r[1] ?? '') === charName &&
         (r[3] ?? '') === slot     &&
         (r[7] ?? '') === 'Rejected'
  );
  if (idx < 0) return false;

  const rowNum = idx + 2;
  await clearRange(sheetId, `BIS Submissions!A${rowNum}:M${rowNum}`);
  cacheInvalidate(sheetId, 'bisSubmissions');
  return true;
}

/**
 * Item DB tab  (A=ItemId B=Name C=Slot D=SourceType E=SourceName
 *               F=Instance G=Difficulty H=ArmorType I=IsTierToken J=WeaponType)
 *
 * Upserts items by ItemId — new items are appended, existing ones are skipped.
 * Pass { replace: true } to clear first (full re-seed).
 *
 * @param {string}   sheetId
 * @param {object[]} items   Array of item objects matching the schema above
 * @param {object}   opts    { replace?: boolean }
 */
export async function writeItemDb(sheetId, items, { replace = false } = {}) {
  if (replace) {
    await clearRange(sheetId, 'Item DB!A2:J');
  }

  if (!items.length) return 0;

  // Read existing item IDs to avoid duplicates
  const existing = replace ? [] : await readRange(sheetId, 'Item DB!A2:A');
  const existingIds = new Set(existing.flat().filter(Boolean));

  const newItems = items.filter(item => !existingIds.has(String(item.itemId)));
  if (!newItems.length) return 0;

  const rows = newItems.map(item => [
    item.itemId,
    item.name,
    item.slot,
    item.sourceType,
    item.sourceName,
    item.instance,
    item.difficulty,
    item.armorType,
    item.isTierToken,
    item.weaponType ?? '',
  ]);

  await appendRows(sheetId, 'Item DB!A:J', rows);
  cacheInvalidate(sheetId, 'itemDb');
  return newItems.length;
}

/**
 * Item DB tab — read all items.
 * @param {string} sheetId
 * @returns {object[]}
 */
export async function getItemDb(sheetId) {
  return cachedRead(sheetId, 'itemDb', async () => {
    const rows = await readRange(sheetId, 'Item DB!A2:J');
    return rows
      .map(r => ({
        itemId:      r[0] ?? '',
        name:        r[1] ?? '',
        slot:        r[2] ?? '',
        sourceType:  r[3] ?? '',
        sourceName:  r[4] ?? '',
        instance:    r[5] ?? '',
        difficulty:  r[6] ?? '',
        armorType:   r[7] ?? '',
        isTierToken: r[8] === true || r[8] === 'TRUE',
        weaponType:  r[9] ?? '',
      }))
      .filter(r => r.itemId);
  });
}

/**
 * Default BIS tab  (A=Spec B=Slot C=TrueBIS D=RaidBIS E=Source)
 * @param {string} sheetId
 * @returns {object[]}
 */
export async function getDefaultBis(sheetId) {
  return cachedRead(sheetId, 'defaultBis', async () => {
    const rows = await readRange(sheetId, 'Default BIS!A2:G');
    return rows
      .map(r => ({
        spec:          r[0] ?? '',
        slot:          r[1] ?? '',
        trueBis:       r[2] ?? '',
        trueBisItemId: r[3] ?? '',
        raidBis:       r[4] ?? '',
        raidBisItemId: r[5] ?? '',
        source:        r[6] ?? '',
      }))
      .filter(r => r.spec);
  });
}

// ── Default BIS helpers ───────────────────────────────────────────────────────

/**
 * Wrap an item ID in a Sheets HYPERLINK formula pointing to Wowhead.
 * Returns the bare ID string if id is falsy or not a valid numeric item ID.
 */
function itemIdCell(id) {
  if (!id || !/^\d+$/.test(String(id))) return id ?? '';
  return `=HYPERLINK("https://www.wowhead.com/item=${id}","${id}")`;
}

/**
 * Write Default BIS entries.
 *
 * Default (replace=false): skip rows whose (Spec, Slot, Source) already exists.
 *   Multiple sources for the same spec+slot coexist — each source gets its own row.
 *
 * With replace=true: delete all existing rows for the same (Spec, Source) combinations
 *   being written, then append the new entries. Other specs' rows and rows from other
 *   sources for the same spec are preserved.
 *
 * @param {string}   sheetId
 * @param {object[]} entries  Array of { spec, slot, trueBis, trueBisItemId, raidBis, raidBisItemId, source }
 * @param {object}   opts     { replace?: boolean }
 * @returns {number} number of rows written
 */
export async function writeDefaultBis(sheetId, entries, { replace = false } = {}) {
  if (!entries.length) return 0;

  if (replace) {
    // Remove existing rows that match the (Spec, Source) combinations being written.
    // Rows for the same spec but a different source are preserved.
    const specSourcePairs = new Set(entries.map(e => `${e.spec}|${e.source ?? ''}`));
    const existing = await readRange(sheetId, 'Default BIS!A2:G');
    const keepRows = existing
      .filter(r => !specSourcePairs.has(`${r[0] ?? ''}|${r[6] ?? ''}`))
      .map(r => [r[0], r[1], r[2], itemIdCell(r[3]), r[4], itemIdCell(r[5]), r[6]]);

    const newRows = entries.map(e => [
      e.spec,
      e.slot,
      e.trueBis              ?? '',
      itemIdCell(e.trueBisItemId),
      e.raidBis              ?? '',
      itemIdCell(e.raidBisItemId),
      e.source               ?? '',
    ]);

    const allRows = [...keepRows, ...newRows];

    await clearRange(sheetId, 'Default BIS!A2:G');
    if (allRows.length) {
      // Write to an explicit range so the data lands exactly at row 2.
      await writeRange(sheetId, `Default BIS!A2:G${allRows.length + 1}`, allRows);
    }
    cacheInvalidate(sheetId, 'defaultBis', 'effectiveBis');
    return entries.length;
  }

  // Skip existing (Spec, Slot, Source) triples — each source has its own rows.
  const existing     = await readRange(sheetId, 'Default BIS!A2:G');
  const existingKeys = new Set(existing.map(r => `${r[0] ?? ''}|${r[1] ?? ''}|${r[6] ?? ''}`));

  const newEntries = entries.filter(e => !existingKeys.has(`${e.spec}|${e.slot}|${e.source ?? ''}`));
  if (!newEntries.length) return 0;

  const rows = newEntries.map(e => [
    e.spec,
    e.slot,
    e.trueBis              ?? '',
    itemIdCell(e.trueBisItemId),
    e.raidBis              ?? '',
    itemIdCell(e.raidBisItemId),
    e.source               ?? '',
  ]);
  await appendRows(sheetId, 'Default BIS!A:G', rows);
  cacheInvalidate(sheetId, 'defaultBis', 'effectiveBis');
  return newEntries.length;
}

// ── Spec BIS Config ───────────────────────────────────────────────────────────

const SPEC_BIS_CONFIG_TAB = 'Spec BIS Config';

/**
 * Create the Spec BIS Config tab with its header row if it doesn't already exist.
 * Safe to call repeatedly — a no-op if the tab is present.
 *
 * @param {string} sheetId
 */
async function ensureSpecBisConfigTab(sheetId) {
  // Try a lightweight read first — if it succeeds the tab exists.
  try {
    await readRange(sheetId, `${SPEC_BIS_CONFIG_TAB}!A1:A1`);
    return;
  } catch {
    // Tab not found — fall through to create it.
  }

  // Add the sheet tab.
  await withRetry(() => client().spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        addSheet: { properties: { title: SPEC_BIS_CONFIG_TAB } },
      }],
    },
  }));

  // Write the header row.
  await writeRange(sheetId, `${SPEC_BIS_CONFIG_TAB}!A1:B1`, [['Spec', 'PreferredSource']]);
  console.log(`[sheets] Created tab "${SPEC_BIS_CONFIG_TAB}"`);
}

/**
 * Read the Spec BIS Config tab (A=Spec B=PreferredSource).
 * Returns a Map<specName, sourceName>.
 * If the tab doesn't exist yet, returns an empty Map.
 *
 * @param {string} sheetId
 * @returns {Map<string,string>}
 */
export async function getSpecBisConfig(sheetId) {
  return cachedRead(sheetId, 'specBisConfig', async () => {
    try {
      const rows = await readRange(sheetId, `${SPEC_BIS_CONFIG_TAB}!A2:B`);
      return new Map(rows.filter(r => r[0]).map(r => [r[0], r[1] ?? '']));
    } catch {
      // Tab doesn't exist yet — treat as empty config.
      return new Map();
    }
  });
}

/**
 * Set the preferred BIS source for a single spec.
 * Creates the Spec BIS Config tab if it doesn't exist yet.
 * Upserts the row for the given spec.
 *
 * @param {string} sheetId
 * @param {string} spec    Canonical spec name, e.g. "Frost Mage"
 * @param {string} source  Canonical source name, e.g. "Icy Veins"
 */
export async function setSpecBisSource(sheetId, spec, source) {
  await ensureSpecBisConfigTab(sheetId);
  const rows = await readRange(sheetId, `${SPEC_BIS_CONFIG_TAB}!A2:B`);
  const rowIndex = rows.findIndex(r => r[0] === spec);
  if (rowIndex >= 0) {
    await writeRange(sheetId, `${SPEC_BIS_CONFIG_TAB}!B${rowIndex + 2}`, [[source]]);
  } else {
    await appendRows(sheetId, `${SPEC_BIS_CONFIG_TAB}!A:B`, [[spec, source]]);
  }
  cacheInvalidate(sheetId, 'specBisConfig', 'effectiveBis');
}

/**
 * Overwrite the entire Spec BIS Config tab with a new mapping.
 * Creates the tab if it doesn't exist yet.
 * Efficient for bulk operations like set-source-all.
 *
 * @param {string}   sheetId
 * @param {object[]} entries  Array of { spec, source }
 */
export async function writeSpecBisConfig(sheetId, entries) {
  await ensureSpecBisConfigTab(sheetId);
  await clearRange(sheetId, `${SPEC_BIS_CONFIG_TAB}!A2:B`);
  if (entries.length) {
    await appendRows(sheetId, `${SPEC_BIS_CONFIG_TAB}!A:B`, entries.map(e => [e.spec, e.source]));
  }
  cacheInvalidate(sheetId, 'specBisConfig', 'effectiveBis');
}

/**
 * Return Default BIS rows filtered to each spec's preferred source.
 *
 * For each (spec, slot), the row from the spec's preferred source (per Spec BIS Config)
 * is returned. Falls back to available sources in order: Icy Veins → Wowhead → Maxroll.
 *
 * @param {string} sheetId
 * @returns {object[]}
 */
export async function getEffectiveDefaultBis(sheetId) {
  return cachedRead(sheetId, 'effectiveBis', async () => {
    const [all, config] = await Promise.all([
      getDefaultBis(sheetId),
      getSpecBisConfig(sheetId),
    ]);

    const FALLBACK_ORDER = ['Icy Veins', 'Wowhead', 'Maxroll'];

    // Group rows by (spec, slot)
    const bySpecSlot = new Map();
    for (const row of all) {
      const key = `${row.spec}|${row.slot}`;
      if (!bySpecSlot.has(key)) bySpecSlot.set(key, []);
      bySpecSlot.get(key).push(row);
    }

    const result = [];
    for (const [, rows] of bySpecSlot) {
      const preferred = config.get(rows[0].spec) ?? 'Icy Veins';
      let row = rows.find(r => r.source === preferred);
      if (!row) {
        // Preferred source not available — fall back in order
        for (const src of FALLBACK_ORDER) {
          row = rows.find(r => r.source === src);
          if (row) break;
        }
      }
      if (row) result.push(row);
    }

    return result;
  });
}

// ── Raid BIS inference ────────────────────────────────────────────────────────

/**
 * Given a Default BIS row and an Item DB lookup (Map keyed by lowercase name),
 * return the inferred { raidBis, raidBisItemId } for the slot, or null if the
 * row already has a Raid BIS set or inference is not possible.
 *
 * Inference rules (applied only when raidBis is currently empty):
 *   <Tier>     → <Tier>      (always from raid)
 *   <Catalyst> → <Catalyst>  (catalyst-eligible raid item)
 *   <Crafted>  → needsInput  (no raid equivalent)
 *   Named item → if Item DB says SourceType="Raid" → same item; else needsInput
 *
 * @param {object} row          A row from getDefaultBis / getEffectiveDefaultBis
 * @param {Map}    itemDbByName Map<lowercase name, itemDb row>
 * @returns {{ raidBis: string, raidBisItemId: string, auto: boolean } | null}
 *   null  → row already has raidBis; no change needed
 *   auto:true  → inferred automatically; show as read-only in UI
 *   auto:false → inference not possible; officer must fill it in
 */
export function inferRaidBis(row, itemDbByName) {
  // Already explicitly set — leave it alone
  if (row.raidBis) return null;

  const { trueBis, trueBisItemId } = row;

  if (trueBis === '<Tier>' || trueBis === '<Catalyst>') {
    return { raidBis: trueBis, raidBisItemId: trueBis, auto: true };
  }

  if (trueBis === '<Crafted>' || !trueBis) {
    return { raidBis: '', raidBisItemId: '', auto: false };
  }

  // Named item — look up source type in Item DB
  const dbItem = itemDbByName.get(trueBis.toLowerCase());
  if (dbItem?.sourceType === 'Raid') {
    const id = String(trueBisItemId || dbItem.itemId || '');
    return { raidBis: trueBis, raidBisItemId: id, auto: true };
  }

  // Mythic+, unknown source, or not in Item DB — officer input needed
  return { raidBis: '', raidBisItemId: '', auto: false };
}

/**
 * Apply inferRaidBis to every row in an effective-default-BIS result set,
 * filling in raidBis/raidBisItemId where inference is possible.
 * Attaches an `raidBisAuto` boolean so the UI can show/lock auto-filled rows.
 *
 * @param {object[]} rows       From getEffectiveDefaultBis
 * @param {object[]} itemDb     From getItemDb
 * @returns {object[]}          Same rows, mutated in-place (raidBis may change)
 */
export function applyRaidBisInference(rows, itemDb) {
  const byName = new Map(itemDb.map(i => [i.name.toLowerCase(), i]));
  return rows.map(row => {
    const inferred = inferRaidBis(row, byName);
    if (inferred === null) {
      // raidBis was already set — mark as manually set
      return { ...row, raidBisAuto: false };
    }
    return { ...row, raidBis: inferred.raidBis, raidBisItemId: inferred.raidBisItemId, raidBisAuto: inferred.auto };
  });
}

/**
 * Raids tab  (A=RaidId B=TeamId C=Date D=Instance E=Difficulty F=AttendeeIds)
 * AttendeeIds is a comma-separated list of Discord user ID strings.
 *
 * @param {string} sheetId
 * @returns {object[]}
 */
export async function getRaids(sheetId) {
  return cachedRead(sheetId, 'raids', async () => {
    const rows = await readRange(sheetId, 'Raids!A2:F');
    return rows
      .map(r => ({
        raidId:      r[0] ?? '',
        teamId:      r[1] ?? '',
        date:        r[2] ?? '',
        instance:    r[3] ?? '',
        difficulty:  r[4] ?? '',
        attendeeIds: String(r[5] ?? '').split(',').map(s => s.trim()).filter(Boolean),
      }))
      .filter(r => r.raidId);
  });
}

/**
 * Write Raid BIS values for specific (spec, slot, source) rows in the Default BIS tab.
 *
 * @param {string}   sheetId
 * @param {object[]} updates  Array of { spec, slot, source, raidBis, raidBisItemId }
 */
export async function updateDefaultBisRaidBis(sheetId, updates) {
  if (!updates.length) return;

  const rows = await readRange(sheetId, 'Default BIS!A2:G');
  const batchData = [];

  for (const upd of updates) {
    const idx = rows.findIndex(r =>
      (r[0] ?? '') === upd.spec &&
      (r[1] ?? '') === upd.slot &&
      (r[6] ?? '') === upd.source
    );
    if (idx < 0) continue;

    const rowNum = idx + 2; // +1 for 1-indexed, +1 for header row
    batchData.push({
      range: `Default BIS!E${rowNum}:F${rowNum}`,
      values: [[upd.raidBis ?? '', itemIdCell(upd.raidBisItemId ?? '')]],
    });
  }

  if (!batchData.length) return;

  await withRetry(() => client().spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: batchData,
    },
  }));
  cacheInvalidate(sheetId, 'defaultBis', 'effectiveBis');
}
