/**
 * sheets.js — Google Sheets abstraction layer.
 *
 * All bot code talks to this module; nothing else imports googleapis directly.
 *
 * Two kinds of functions:
 *   Master-sheet functions   — read/write the guild-wide master sheet (MASTER_SHEET_ID).
 *                              These have NO sheetId parameter; they resolve the ID internally.
 *                              Covers: Item DB, Default BIS, Spec BIS Config, Team Registry,
 *                              Global Config, Transfers.
 *   Team-sheet functions     — read/write a specific team's sheet.
 *                              These take sheetId as the first parameter.
 *                              Covers: Roster, Loot Log, BIS Submissions, Config, Raids,
 *                              RCLC Response Map.
 *
 * Auth strategy:
 *   Local dev  → node.js reads GOOGLE_SERVICE_ACCOUNT_KEY_PATH key file and injects it
 *                as GOOGLE_SERVICE_ACCOUNT_KEY_JSON before the app loads
 *   Production → GOOGLE_SERVICE_ACCOUNT_KEY_JSON is set directly in the environment
 */

import { randomUUID } from 'node:crypto';
import { log } from './logger.js';

// ── Auth — Web Crypto JWT (works in Cloudflare Workers and Node.js 18+) ────────

function loadCredentials() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_JSON is not set');
  }
  return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON);
}

function b64url(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let b64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function makeServiceAccountJwt(creds) {
  const pem    = creds.private_key;
  const body   = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der    = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  const key    = await crypto.subtle.importKey(
    'pkcs8', der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
  const now     = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: creds.client_email, sub: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

// Access token cache: { token, expiresAt }
let _tokenCache = null;

async function getAccessToken() {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt) {
    log.verbose('[sheets] Access token cache hit');
    return _tokenCache.token;
  }
  log.verbose('[sheets] Fetching new Google access token');
  const creds = loadCredentials();
  const jwt   = await makeServiceAccountJwt(creds);
  const res   = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed ${res.status}: ${await res.text()}`);
  const { access_token, expires_in } = await res.json();
  _tokenCache = { token: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 };
  log.verbose('[sheets] New access token acquired, expires in', expires_in, 's');
  return access_token;
}

// ── Sheets REST API helpers ────────────────────────────────────────────────────

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function sheetsRequest(method, url, body) {
  const token = await getAccessToken();
  const res   = await fetch(url, {
    method,
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    const err  = new Error(`Sheets ${method} ${url} failed ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
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
      log.warn(`[sheets] Rate limited (${status}) — retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
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

// In-flight deduplication: if multiple concurrent requests miss the cache for the
// same key simultaneously, they all share one in-flight promise instead of each
// firing their own API call.  Prevents stampedes on cold start.
const _inFlight = new Map(); // `${sheetId}|${tabKey}` → Promise

async function cachedRead(sheetId, tabKey, fn) {
  const key    = `${sheetId}|${tabKey}`;
  const cached = cacheGet(key);
  if (cached !== undefined) {
    log.verbose(`[sheets] cache hit  ${tabKey} (sheet ${sheetId.slice(-6)})`);
    return cached;
  }
  if (_inFlight.has(key)) {
    log.verbose(`[sheets] in-flight  ${tabKey} (sheet ${sheetId.slice(-6)}) — joining existing request`);
    return _inFlight.get(key);
  }
  log.verbose(`[sheets] cache miss ${tabKey} (sheet ${sheetId.slice(-6)}) — fetching`);
  const promise = fn().then(result => {
    cacheSet(key, result);
    _inFlight.delete(key);
    const count = result instanceof Map ? result.size : Array.isArray(result) ? result.length : 1;
    log.verbose(`[sheets] cached     ${tabKey} (sheet ${sheetId.slice(-6)}) — ${count} entries`);
    return result;
  }).catch(err => {
    _inFlight.delete(key);
    throw err;
  });
  _inFlight.set(key, promise);
  return promise;
}

// ── Master sheet accessor ─────────────────────────────────────────────────────

/**
 * Returns the guild-wide master sheet ID from MASTER_SHEET_ID env var.
 * Throws a clear error if the env var is not set so misconfiguration is obvious.
 */
function getMasterSheetId() {
  const id = process.env.MASTER_SHEET_ID;
  if (!id) throw new Error('MASTER_SHEET_ID env var is required but not set');
  return id;
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
  log.verbose(`[sheets] readRange  ${range} (sheet ${sheetId.slice(-6)})`);
  const qs  = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?${qs}`;
  const res = await withRetry(() => sheetsRequest('GET', url));
  const values = res.values ?? [];
  log.verbose(`[sheets] readRange  ${range} → ${values.length} rows`);
  return values;
}

/**
 * Fetch multiple ranges from the same spreadsheet in a single HTTP call.
 * Returns an array of value matrices in the same order as `ranges`.
 *
 * @param {string}   sheetId
 * @param {string[]} ranges  A1 notation ranges, e.g. ["Roster!A2:I", "Loot Log!A2:K"]
 * @returns {Array<Array<Array<string>>>}
 */
async function readBatchRanges(sheetId, ranges) {
  if (!ranges.length) return [];
  log.verbose(`[sheets] batchGet   ${ranges.length} range(s) (sheet ${sheetId.slice(-6)}): ${ranges.join(', ')}`);
  const qs = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
  for (const r of ranges) qs.append('ranges', r);
  const url = `${SHEETS_BASE}/${sheetId}/values:batchGet?${qs}`;
  const res = await withRetry(() => sheetsRequest('GET', url));
  return (res.valueRanges ?? []).map(vr => vr.values ?? []);
}

/**
 * Append rows to a sheet tab.
 *
 * @param {string}              sheetId
 * @param {string}              range   e.g. "Loot Log!A:Z"
 * @param {Array<Array<string>>} rows
 */
export async function appendRows(sheetId, range, rows) {
  log.verbose(`[sheets] appendRows ${range} (sheet ${sheetId.slice(-6)}) — ${rows.length} rows`);
  const qs  = new URLSearchParams({ valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' });
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}:append?${qs}`;
  await withRetry(() => sheetsRequest('POST', url, { values: rows }));
}

/**
 * Overwrite a specific range.
 *
 * @param {string}              sheetId
 * @param {string}              range
 * @param {Array<Array<string>>} values
 */
export async function writeRange(sheetId, range, values) {
  log.verbose(`[sheets] writeRange ${range} (sheet ${sheetId.slice(-6)}) — ${values.length} rows`);
  const qs  = new URLSearchParams({ valueInputOption: 'USER_ENTERED' });
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?${qs}`;
  await withRetry(() => sheetsRequest('PUT', url, { values }));
}

/**
 * Clear all values in a range (leaves formatting intact).
 *
 * @param {string} sheetId
 * @param {string} range   A1 notation, e.g. "Item DB!A2:I"
 */
export async function clearRange(sheetId, range) {
  log.verbose(`[sheets] clearRange ${range} (sheet ${sheetId.slice(-6)})`);
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}:clear`;
  await withRetry(() => sheetsRequest('POST', url, {}));
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

// ── Row parsers (pure functions, used by both cachedRead and primeTeamCache) ──

function parseRosterRows(rows) {
  return rows
    .map(r => ({
      charName:  String(r[0] ?? '').trim(),
      class:     String(r[1] ?? '').trim(),
      spec:      String(r[2] ?? '').trim(),
      role:      String(r[3] ?? '').trim(),
      status:    String(r[4] ?? '').trim(),
      ownerId:   String(r[5] ?? '').trim(),
      ownerNick: String(r[6] ?? '').trim(),
      charId:    String(r[7] ?? '').trim(),
      server:    String(r[8] ?? '').trim(),
    }))
    .filter(c => c.charName && c.status.toLowerCase() !== 'deleted');
}

function parseLootLogRows(rows) {
  return rows
    .map(r => ({
      id:              r[0] ?? '',
      raidId:          r[1] ?? '',
      date:            normalizeSheetDate(r[2]),
      boss:            r[3] ?? '',
      itemName:        r[4] ?? '',
      difficulty:      r[5] ?? '',
      recipientId:     r[6] ?? '',
      recipientChar:   r[7] ?? '',
      upgradeType:     r[8] ?? '',
      notes:           r[9] ?? '',
      recipientCharId: String(r[10] ?? '').trim(),
    }))
    .filter(e => e.id);
}

function parseBisRows(rows) {
  return rows
    .map(r => ({
      id:            String(r[0]  ?? '').trim(),
      charName:      String(r[1]  ?? '').trim(),
      spec:          String(r[2]  ?? '').trim(),
      slot:          String(r[3]  ?? '').trim(),
      trueBis:       String(r[4]  ?? '').trim(),
      raidBis:       String(r[5]  ?? '').trim(),
      rationale:     String(r[6]  ?? '').trim(),
      status:        String(r[7]  ?? 'Pending').trim(),
      submittedAt:   String(r[8]  ?? '').trim(),
      reviewedBy:    String(r[9]  ?? '').trim(),
      officerNote:   String(r[10] ?? '').trim(),
      trueBisItemId: String(r[11] ?? '').trim(),
      raidBisItemId: String(r[12] ?? '').trim(),
      charId:        String(r[13] ?? '').trim(),
    }))
    .filter(r => r.id);
}

function parseConfigRows(rows) {
  return Object.fromEntries(rows.filter(r => r[0]).map(([k, v]) => [k, v ?? '']));
}

function parseRaidsRows(rows) {
  return rows
    .map(r => ({
      raidId:      r[0] ?? '',
      date:        r[1] ?? '',
      instance:    r[2] ?? '',
      difficulty:  r[3] ?? '',
      attendeeIds: String(r[4] ?? '').split('|').map(s => s.trim()).filter(Boolean),
    }))
    .filter(r => r.raidId);
}

function parseTierSnapshotRows(rows) {
  return rows
    .map(r => ({
      charId:     r[0] ?? '',
      charName:   r[1] ?? '',
      raidId:     r[2] ?? '',
      tierCount:  Number(r[3] ?? 0),
      tierDetail: r[4] ?? '',
      updatedAt:  r[5] ?? '',
    }))
    .filter(r => r.charId);
}

function parseWornBisRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const charId = r[0] ?? '';
    const slot   = r[2] ?? '';
    if (!charId || !slot) continue;
    map.set(`${charId}:${slot}`, {
      charId,
      charName:        r[1] ?? '',
      slot,
      overallBISTrack: r[3] ?? '',
      raidBISTrack:    r[4] ?? '',
      otherTrack:      r[5] ?? '',
      updatedAt:       r[6] ?? '',
    });
  }
  return map;
}

// ── Per-team batch loader ─────────────────────────────────────────────────────

// Maps cache key → { range, parse } for all tabs that can be batch-loaded.
const TEAM_TAB_DEFS = {
  roster:         { range: 'Roster!A2:I',          parse: parseRosterRows },
  lootLog:        { range: 'Loot Log!A2:K',         parse: parseLootLogRows },
  bisSubmissions: { range: 'BIS Submissions!A2:N',  parse: parseBisRows },
  config:         { range: 'Config!A2:B',           parse: parseConfigRows },
  raids:          { range: 'Raids!A2:E',            parse: parseRaidsRows },
  tierSnapshot:   { range: 'Tier Snapshot!A2:F',    parse: parseTierSnapshotRows },
  wornBis:        { range: 'Worn BIS!A2:G',         parse: parseWornBisRows },
};

/**
 * Batch-load multiple tabs from a team sheet in a single API call, caching each
 * result individually so subsequent calls to getRoster(), getLootLog(), etc. are
 * pure cache hits.
 *
 * Tabs already in cache (or already in-flight from another concurrent request)
 * are skipped — only truly missing tabs are fetched.
 *
 * @param {string}   sheetId
 * @param {string[]} tabKeys  Keys from TEAM_TAB_DEFS. Defaults to all tabs.
 */
export async function primeTeamCache(sheetId, tabKeys = Object.keys(TEAM_TAB_DEFS)) {
  // Determine which tabs need fetching (not cached and not already in-flight)
  const missing = tabKeys.filter(k => {
    const cacheKey = `${sheetId}|${k}`;
    return !cacheGet(cacheKey) && !_inFlight.has(cacheKey);
  });
  if (!missing.length) {
    log.verbose(`[sheets] primeTeamCache (sheet ${sheetId.slice(-6)}) — all ${tabKeys.length} tab(s) already cached`);
    return;
  }
  log.verbose(`[sheets] primeTeamCache (sheet ${sheetId.slice(-6)}) — batch loading: ${missing.join(', ')}`);
  const ranges = missing.map(k => TEAM_TAB_DEFS[k].range);

  // Fire ONE batchGet for all missing ranges, register an in-flight promise for
  // each so any concurrent requests for the same keys share the same fetch.
  const batchPromise = readBatchRanges(sheetId, ranges);
  for (let i = 0; i < missing.length; i++) {
    const tabKey   = missing[i];
    const { parse } = TEAM_TAB_DEFS[tabKey];
    const cacheKey = `${sheetId}|${tabKey}`;
    const idx      = i; // capture loop variable
    _inFlight.set(cacheKey, batchPromise.then(batches => {
      const parsed = parse(batches[idx]);
      cacheSet(cacheKey, parsed);
      _inFlight.delete(cacheKey);
      return parsed;
    }).catch(err => {
      _inFlight.delete(cacheKey);
      throw err;
    }));
  }

  await batchPromise;
}

/**
 * Roster tab  (A=CharName B=Class C=Spec D=Role E=Status F=OwnerId G=OwnerNick H=CharId)
 *
 * CharId (col H) is a UUID appended to every row — stable across renames.
 * Cols A–G are unchanged from the old schema; old prod code reading A:G is unaffected.
 * Note: Role (col D) is computed by an Apps Script onEdit trigger — never write to it.
 *
 * @param {string} sheetId
 * @returns {object[]}
 */
export async function getRoster(sheetId) {
  log.verbose(`[sheets] getRoster (sheet ${sheetId.slice(-6)})`);
  return cachedRead(sheetId, 'roster', async () => parseRosterRows(await readRange(sheetId, 'Roster!A2:I')));
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
  log.verbose(`[sheets] setOwnerNick ownerId=${ownerId} nick="${ownerNick}" (sheet ${sheetId.slice(-6)})`);
  const rows    = await readRange(sheetId, 'Roster!A2:G');
  const updates = [];
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][5] ?? '') === ownerId) {
      updates.push({ range: `Roster!G${i + 2}`, values: [[ownerNick]] });
    }
  }
  if (!updates.length) throw new Error(`No characters found for ownerId "${ownerId}"`);
  log.debug(`[sheets] setOwnerNick updating ${updates.length} chars at rows`, updates.map(u => u.range));
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
export async function setRosterOwner(sheetId, charName, ownerId, ownerNick, charId = null) {
  log.verbose(`[sheets] setRosterOwner char="${charName}" charId=${charId} ownerId=${ownerId} (sheet ${sheetId.slice(-6)})`);
  const rows = await readRange(sheetId, 'Roster!A2:I');
  const idx  = charId
    ? rows.findIndex(r => String(r[7] ?? '') === charId)   // prefer stable charId (col H)
    : rows.findIndex(r => String(r[0] ?? '').toLowerCase() === charName.toLowerCase());
  if (idx < 0) throw new Error(`Character "${charId ?? charName}" not found in roster`);
  const rowNum = idx + 2;
  log.debug(`[sheets] setRosterOwner found at row ${rowNum}`);
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
export async function setRosterStatus(sheetId, charName, status, charId = null) {
  log.verbose(`[sheets] setRosterStatus char="${charName}" charId=${charId} status="${status}" (sheet ${sheetId.slice(-6)})`);
  const rows = await readRange(sheetId, 'Roster!A2:I');
  const idx  = charId
    ? rows.findIndex(r => String(r[7] ?? '') === charId)   // prefer stable charId (col H)
    : rows.findIndex(r => String(r[0] ?? '').toLowerCase() === charName.toLowerCase());
  if (idx < 0) throw new Error(`Character "${charId ?? charName}" not found in roster`);
  const rowNum = idx + 2;
  log.debug(`[sheets] setRosterStatus found at row ${rowNum}`);
  await writeRange(sheetId, `Roster!E${rowNum}`, [[status]]);
  cacheInvalidate(sheetId, 'roster');
}

/**
 * Append a new character row to the Roster tab. Generates a stable UUID (charId)
 * written to col H so the character can be renamed without breaking linked data.
 * Role is derived from spec here because the onEdit Apps Script trigger
 * only fires on manual sheet edits, not API writes.
 *
 * @param {string} sheetId
 * @param {string} charName
 * @param {string} cls       e.g. "Death Knight"
 * @param {string} spec      e.g. "Blood DK"
 * @param {string} role      e.g. "Tank" (pre-computed by caller)
 * @param {string} status    "Active" | "Bench" | "Inactive"
 * @returns {string} The generated charId
 */
export async function addRosterChar(sheetId, charName, cls, spec, role, status, server = '') {
  const charId = randomUUID();
  log.verbose(`[sheets] addRosterChar charId=${charId} char="${charName}" server="${server}" class="${cls}" spec="${spec}" role="${role}" status="${status}" (sheet ${sheetId.slice(-6)})`);
  await appendRows(sheetId, 'Roster!A:I', [[charName, cls, spec, role, status, '', '', charId, server]]);
  cacheInvalidate(sheetId, 'roster');
  return charId;
}

/**
 * Rename a character in the Roster tab (column A).
 * Because all linked data (BIS, loot) is keyed by charId (col H), this is the only
 * write needed — no cascading updates to other tabs required.
 *
 * @param {string} sheetId
 * @param {string} charId   Stable UUID from col H
 * @param {string} newName  New character name
 */
export async function renameRosterChar(sheetId, charId, newName) {
  log.verbose(`[sheets] renameRosterChar charId=${charId} newName="${newName}" (sheet ${sheetId.slice(-6)})`);
  const rows = await readRange(sheetId, 'Roster!A2:I');
  const idx  = rows.findIndex(r => String(r[7] ?? '') === charId); // col H (index 7)
  if (idx < 0) throw new Error(`Character ID "${charId}" not found in roster`);
  const rowNum = idx + 2;
  log.debug(`[sheets] renameRosterChar found charId at row ${rowNum}, writing new name "${newName}"`);
  await writeRange(sheetId, `Roster!A${rowNum}`, [[newName]]); // col A
  cacheInvalidate(sheetId, 'roster');
}

/**
 * Set the Server (column I) for a specific character, identified by charId.
 * Used when resolving a same-name conflict between two characters.
 *
 * @param {string} sheetId
 * @param {string} charId   Stable UUID from col H
 * @param {string} server   Server name (e.g. "Area52"), or '' to clear
 */
export async function setRosterServer(sheetId, charId, server) {
  log.verbose(`[sheets] setRosterServer charId=${charId} server="${server}" (sheet ${sheetId.slice(-6)})`);
  const rows = await readRange(sheetId, 'Roster!A2:I');
  const idx  = rows.findIndex(r => String(r[7] ?? '') === charId); // col H (index 7)
  if (idx < 0) throw new Error(`Character ID "${charId}" not found in roster`);
  const rowNum = idx + 2;
  log.debug(`[sheets] setRosterServer found charId at row ${rowNum}, writing server "${server}"`);
  await writeRange(sheetId, `Roster!I${rowNum}`, [[server]]); // col I
  cacheInvalidate(sheetId, 'roster');
}

/**
 * Soft-delete a character from the Roster tab.
 * Appends "-DELETED" to the name (visual indicator) and sets Status → "Deleted"
 * so getRoster filters it out.
 *
 * @param {string} sheetId
 * @param {string} charName
 */
export async function deleteRosterChar(sheetId, charName, charId = null) {
  log.verbose(`[sheets] deleteRosterChar char="${charName}" charId=${charId} (sheet ${sheetId.slice(-6)})`);
  const rows = await readRange(sheetId, 'Roster!A2:I');
  const idx  = charId
    ? rows.findIndex(r => String(r[7] ?? '') === charId)   // prefer stable charId (col H)
    : rows.findIndex(r => String(r[0] ?? '').toLowerCase() === charName.toLowerCase());
  if (idx < 0) throw new Error(`Character "${charId ?? charName}" not found in roster`);
  const rowNum    = idx + 2;
  const actualName = String(rows[idx][0] ?? charName); // use name from the actual row
  await batchWriteRanges(sheetId, [
    { range: `Roster!A${rowNum}`, values: [[`${actualName}-DELETED`]] },
    { range: `Roster!E${rowNum}`, values: [['Deleted']] },
  ]);
  cacheInvalidate(sheetId, 'roster');
}

/**
 * Loot Log tab  (A=Id B=RaidId C=Date D=Boss E=ItemName F=Difficulty
 *                G=RecipientId H=RecipientChar I=UpgradeType J=Notes K=RecipientCharId)
 *
 * RecipientCharId (col K) is the stable character UUID — empty for entries written
 * before the migration ran. Joins use charId if present, fall back to name.
 *
 * @param {string} sheetId
 * @returns {object[]}
 */
export async function getLootLog(sheetId) {
  log.verbose(`[sheets] getLootLog (sheet ${sheetId.slice(-6)})`);
  return cachedRead(sheetId, 'lootLog', async () => parseLootLogRows(await readRange(sheetId, 'Loot Log!A2:K')));
}

/**
 * Append entries to the Loot Log.
 * Each entry must have: id, raidId, date, boss, itemName, difficulty,
 *                       recipientId, recipientChar, upgradeType, notes, recipientCharId
 * @param {string}   sheetId
 * @param {object[]} entries
 */
export async function appendLootEntries(sheetId, entries) {
  log.verbose(`[sheets] appendLootEntries ${entries.length} entries (sheet ${sheetId.slice(-6)})`);
  log.debug(`[sheets] appendLootEntries data`, entries);
  if (!entries.length) return;
  const rows = entries.map(e => [
    e.id, e.raidId, e.date, e.boss, e.itemName,
    e.difficulty, e.recipientId, e.recipientChar, e.upgradeType, e.notes,
    e.recipientCharId ?? '',
  ]);
  await appendRows(sheetId, 'Loot Log!A:K', rows);
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
      map.set(r[0].trim().toLowerCase(), {
        internalType: r[1]?.trim() ?? 'Non-BIS',
        counted:      (r[2]?.trim() ?? 'Yes').toLowerCase() === 'yes',
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
  log.verbose(`[sheets] getConfig (sheet ${sheetId.slice(-6)})`);
  return cachedRead(sheetId, 'config', async () => parseConfigRows(await readRange(sheetId, 'Config!A2:B')));
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
  log.verbose(`[sheets] setConfigValue key="${key}" value="${value}" (sheet ${sheetId.slice(-6)})`);
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
 *                       G=Rationale H=Status I=SubmittedAt J=ReviewedBy K=OfficerNote
 *                       L=TrueBISItemId M=RaidBISItemId N=CharId)
 *
 * CharId (col N) is appended — stable across renames. Col B (CharName) is kept
 * for backward compat with old prod code reading A:M. New code joins via charId;
 * charName is the fallback for un-migrated rows.
 *
 * @param {string} sheetId
 * @returns {object[]}
 */
export async function getBisSubmissions(sheetId) {
  log.verbose(`[sheets] getBisSubmissions (sheet ${sheetId.slice(-6)})`);
  return cachedRead(sheetId, 'bisSubmissions', async () => parseBisRows(await readRange(sheetId, 'BIS Submissions!A2:N')));
}

/**
 * Upsert a single BIS submission row.
 *
 * If a row already exists for (charId, slot) — or (charName, slot) for un-migrated
 * rows — the TrueBIS, RaidBIS, Rationale, Status, SubmittedAt, and ItemId columns
 * are updated in place. ReviewedBy and OfficerNote are always preserved.
 * Status is always reset to "Pending" on upsert.
 *
 * Schema columns: A=Id B=CharName C=Spec D=Slot E=TrueBIS F=RaidBIS G=Rationale
 *                 H=Status I=SubmittedAt J=ReviewedBy K=OfficerNote
 *                 L=TrueBISItemId M=RaidBISItemId N=CharId
 */
export async function upsertBisSubmission(sheetId, {
  charId, charName, spec, slot,
  trueBis, trueBisItemId,
  raidBis, raidBisItemId,
  rationale,
}) {
  log.verbose(`[sheets] upsertBisSubmission charId=${charId} char="${charName}" slot="${slot}" trueBis="${trueBis}" raidBis="${raidBis}" (sheet ${sheetId.slice(-6)})`);
  const rows  = await readRange(sheetId, 'BIS Submissions!A2:N');
  const today = new Date().toISOString().slice(0, 10);

  // Match by charId (col N) if available, fall back to charName (col B) for un-migrated rows
  const idx = rows.findIndex(r => {
    const rowCharId   = String(r[13] ?? '');
    const rowCharName = String(r[1]  ?? '').toLowerCase();
    const slotMatch   = String(r[3]  ?? '').toLowerCase() === slot.toLowerCase();
    if (!slotMatch) return false;
    return charId && rowCharId ? rowCharId === charId : rowCharName === (charName ?? '').toLowerCase();
  });

  if (idx >= 0) {
    const rowNum = idx + 2;
    log.debug(`[sheets] upsertBisSubmission updating existing row ${rowNum} for charId=${charId} slot="${slot}"`);
    await writeRange(sheetId, `BIS Submissions!E${rowNum}:I${rowNum}`, [[
      trueBis   ?? '',
      raidBis   ?? '',
      rationale ?? '',
      'Pending',
      today,
    ]]);
    await batchWriteRanges(sheetId, [
      { range: `BIS Submissions!L${rowNum}:M${rowNum}`, values: [[trueBisItemId ?? '', raidBisItemId ?? '']] },
      { range: `BIS Submissions!N${rowNum}`,            values: [[charId ?? '']] }, // ensure charId is written
    ]);
  } else {
    const id = `bis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    log.debug(`[sheets] upsertBisSubmission inserting new row id="${id}" for charId=${charId} slot="${slot}"`);
    await appendRows(sheetId, 'BIS Submissions!A:N', [[
      id,
      charName      ?? '',
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
      charId         ?? '',
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
export async function batchWriteRanges(sheetId, updates) {
  if (!updates.length) return;
  log.verbose(`[sheets] batchWriteRanges ${updates.length} ranges (sheet ${sheetId.slice(-6)})`);
  log.debug(`[sheets] batchWriteRanges ranges:`, updates.map(u => u.range).join(', '));
  const url = `${SHEETS_BASE}/${sheetId}/values:batchUpdate`;
  await withRetry(() => sheetsRequest('POST', url, {
    valueInputOption: 'USER_ENTERED',
    data: updates,
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
 * @param {object[]} updates  Each: { charId, charName, spec, slot, trueBis,
 *                              trueBisItemId, raidBis, raidBisItemId, rationale }
 */
export async function batchUpsertBisSubmissions(sheetId, updates) {
  if (!updates.length) return;
  log.verbose(`[sheets] batchUpsertBisSubmissions ${updates.length} slots for charId=${updates[0]?.charId} (sheet ${sheetId.slice(-6)})`);

  const rows  = await readRange(sheetId, 'BIS Submissions!A2:N');
  const today = new Date().toISOString().slice(0, 10);

  const rangeWrites = [];
  const newRows     = [];

  updates.forEach((u, i) => {
    const {
      charId = '', charName = '', spec, slot,
      trueBis = '', trueBisItemId = '',
      raidBis = '', raidBisItemId = '',
      rationale = '',
    } = u;

    // Match by charId (col N) if available, fall back to charName (col B) for un-migrated rows
    const idx = rows.findIndex(r => {
      const rowCharId   = String(r[13] ?? '');
      const rowCharName = String(r[1]  ?? '').toLowerCase();
      const slotMatch   = String(r[3]  ?? '').toLowerCase() === slot.toLowerCase();
      if (!slotMatch) return false;
      return charId && rowCharId ? rowCharId === charId : rowCharName === charName.toLowerCase();
    });

    if (idx >= 0) {
      const rowNum = idx + 2;
      log.debug(`[sheets] batchUpsert slot="${slot}" → update row ${rowNum} trueBis="${trueBis}" raidBis="${raidBis}"`);
      rangeWrites.push(
        { range: `BIS Submissions!E${rowNum}:I${rowNum}`,
          values: [[trueBis, raidBis, rationale, 'Pending', today]] },
        { range: `BIS Submissions!L${rowNum}:M${rowNum}`,
          values: [[trueBisItemId, raidBisItemId]] },
        { range: `BIS Submissions!N${rowNum}`,
          values: [[charId]] }, // ensure charId is written (backfill for un-migrated updates)
      );
    } else {
      const id = `bis-${Date.now().toString(36)}-${i.toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      log.debug(`[sheets] batchUpsert slot="${slot}" → new row id="${id}" trueBis="${trueBis}" raidBis="${raidBis}"`);
      newRows.push([
        id, charName, spec, slot,
        trueBis, raidBis, rationale,
        'Pending', today,
        '', '',           // reviewedBy, officerNote
        trueBisItemId, raidBisItemId,
        charId,           // col N
      ]);
    }
  });

  log.verbose(`[sheets] batchUpsertBisSubmissions: ${rangeWrites.length / 3} updates, ${newRows.length} inserts`);
  if (rangeWrites.length) await batchWriteRanges(sheetId, rangeWrites);
  if (newRows.length) {
    const startRow = rows.length + 2;
    await writeRange(
      sheetId,
      `BIS Submissions!A${startRow}:N${startRow + newRows.length - 1}`,
      newRows,
    );
  }
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
  log.verbose(`[sheets] approveBisSubmission id="${submissionId}" reviewer="${reviewerName}" (sheet ${sheetId.slice(-6)})`);
  const rows = await readRange(sheetId, 'BIS Submissions!A2:I');
  const idx  = rows.findIndex(r => String(r[0] ?? '') === submissionId);
  if (idx < 0) throw new Error(`BIS submission "${submissionId}" not found`);

  const rowNum      = idx + 2;
  const r           = rows[idx];
  const submittedAt = r[8] ?? '';
  log.debug(`[sheets] approveBisSubmission row ${rowNum}: char="${r[1]}" slot="${r[3]}" trueBis="${r[4]}" raidBis="${r[5]}" → Approved by ${reviewerName}`);

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
  log.verbose(`[sheets] rejectBisSubmission id="${submissionId}" reviewer="${reviewerName}" (sheet ${sheetId.slice(-6)})`);
  const rows = await readRange(sheetId, 'BIS Submissions!A2:K');
  const idx  = rows.findIndex(r => String(r[0] ?? '') === submissionId);
  if (idx < 0) throw new Error(`BIS submission "${submissionId}" not found`);

  const rowNum = idx + 2;
  const r      = rows[idx];
  log.debug(`[sheets] rejectBisSubmission row ${rowNum}: char="${r[1]}" slot="${r[3]}" trueBis="${r[4]}" raidBis="${r[5]}" → Rejected by ${reviewerName}${officerNote ? ` note="${officerNote}"` : ''}`);

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
export async function clearPendingBisSubmission(sheetId, charId, slot, charName) {
  const rows = await readRange(sheetId, 'BIS Submissions!A2:N');
  const idx  = rows.findIndex(r => {
    const rowCharId   = String(r[13] ?? '');
    const rowCharName = String(r[1]  ?? '').toLowerCase();
    const slotMatch   = String(r[3]  ?? '').toLowerCase() === slot.toLowerCase();
    const isPending   = String(r[7]  ?? '').toLowerCase() === 'pending';
    if (!slotMatch || !isPending) return false;
    return charId && rowCharId ? rowCharId === charId : rowCharName === (charName ?? '').toLowerCase();
  });
  if (idx < 0) return false;

  const rowNum = idx + 2;
  await clearRange(sheetId, `BIS Submissions!A${rowNum}:N${rowNum}`);
  cacheInvalidate(sheetId, 'bisSubmissions');
  return true;
}

/**
 * Reset only the Raid BIS field of a submission to empty, without touching
 * the submission status or any other fields. The slot reverts to the spec
 * default for Raid BIS while keeping the Overall BIS personal override and
 * its approval status.
 *
 * @param {string} sheetId
 * @param {string} charName
 * @param {string} slot
 * @returns {boolean} true if a row was found and updated
 */
export async function resetBisRaidBisField(sheetId, charId, slot, charName) {
  const rows = await readRange(sheetId, 'BIS Submissions!A2:N');
  const idx  = rows.findIndex(r => {
    const rowCharId   = String(r[13] ?? '');
    const rowCharName = String(r[1]  ?? '').toLowerCase();
    const slotMatch   = String(r[3]  ?? '').toLowerCase() === slot.toLowerCase();
    if (!slotMatch) return false;
    return charId && rowCharId ? rowCharId === charId : rowCharName === (charName ?? '').toLowerCase();
  });
  if (idx < 0) return false;

  const rowNum = idx + 2;
  // Clear F (RaidBIS) and M (RaidBISItemId) only — status and approvals untouched.
  await batchWriteRanges(sheetId, [
    { range: `BIS Submissions!F${rowNum}`, values: [['']] },
    { range: `BIS Submissions!M${rowNum}`, values: [['']] },
  ]);
  cacheInvalidate(sheetId, 'bisSubmissions');
  return true;
}

/**
 * Clear a BIS submission for any status (Pending, Approved, or Rejected),
 * reverting the slot to the spec default. Is a no-op if no row exists.
 *
 * @param {string} sheetId
 * @param {string} charName
 * @param {string} slot
 * @returns {boolean} true if a row was found and cleared
 */
export async function clearBisSubmission(sheetId, charId, slot, charName) {
  const rows = await readRange(sheetId, 'BIS Submissions!A2:N');
  const idx  = rows.findIndex(r => {
    const rowCharId   = String(r[13] ?? '');
    const rowCharName = String(r[1]  ?? '').toLowerCase();
    const slotMatch   = String(r[3]  ?? '').toLowerCase() === slot.toLowerCase();
    if (!slotMatch) return false;
    return charId && rowCharId ? rowCharId === charId : rowCharName === (charName ?? '').toLowerCase();
  });
  if (idx < 0) return false;

  const rowNum = idx + 2;
  await clearRange(sheetId, `BIS Submissions!A${rowNum}:N${rowNum}`);
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
export async function clearRejectedBisSubmission(sheetId, charId, slot, charName) {
  const rows = await readRange(sheetId, 'BIS Submissions!A2:N');
  const idx  = rows.findIndex(r => {
    const rowCharId   = String(r[13] ?? '');
    const rowCharName = String(r[1]  ?? '').toLowerCase();
    const slotMatch   = String(r[3]  ?? '').toLowerCase() === slot.toLowerCase();
    const isRejected  = String(r[7]  ?? '').toLowerCase() === 'rejected';
    if (!slotMatch || !isRejected) return false;
    return charId && rowCharId ? rowCharId === charId : rowCharName === (charName ?? '').toLowerCase();
  });
  if (idx < 0) return false;

  const rowNum = idx + 2;
  await clearRange(sheetId, `BIS Submissions!A${rowNum}:N${rowNum}`);
  cacheInvalidate(sheetId, 'bisSubmissions');
  return true;
}

/**
 * Item DB tab  (A=ItemId B=Name C=Slot D=SourceType E=SourceName
 *               F=Instance G=Difficulty H=ArmorType I=IsTierToken J=WeaponType)
 *
 * Lives in the master sheet. No sheetId parameter.
 *
 * Upserts items by ItemId — new items are appended, existing ones are skipped.
 * Pass { replace: true } to clear first (full re-seed).
 *
 * @param {object[]} items   Array of item objects matching the schema above
 * @param {object}   opts    { replace?: boolean }
 */
export async function writeItemDb(items, { replace = false } = {}) {
  log.verbose(`[sheets] writeItemDb ${items.length} items replace=${replace}`);
  const sheetId = getMasterSheetId();
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
 * Item DB tab — read all items. Lives in the master sheet.
 * @returns {object[]}
 */
export async function getItemDb() {
  log.verbose('[sheets] getItemDb');
  const sheetId = getMasterSheetId();
  return cachedRead(sheetId, 'itemDb', async () => {
    const rows = await readRange(sheetId, 'Item DB!A2:J');
    return rows
      .map(r => ({
        itemId:      String(r[0] ?? '').trim(),
        name:        String(r[1] ?? '').trim(),
        slot:        String(r[2] ?? '').trim(),
        sourceType:  String(r[3] ?? '').trim(),
        sourceName:  String(r[4] ?? '').trim(),
        instance:    String(r[5] ?? '').trim(),
        difficulty:  String(r[6] ?? '').trim(),
        armorType:   String(r[7] ?? '').trim(),
        isTierToken: r[8] === true || String(r[8] ?? '').trim().toLowerCase() === 'true',
        weaponType:  String(r[9] ?? '').trim(),
      }))
      .filter(r => r.itemId);
  });
}

/**
 * Default BIS tab  (A=Spec B=Slot C=TrueBIS D=RaidBIS E=Source)
 * Lives in the master sheet. No sheetId parameter.
 * @returns {object[]}
 */
export async function getDefaultBis() {
  log.verbose('[sheets] getDefaultBis');
  const sheetId = getMasterSheetId();
  return cachedRead(sheetId, 'defaultBis', async () => {
    const rows = await readRange(sheetId, 'Default BIS!A2:G');
    return rows
      .map(r => ({
        spec:          String(r[0] ?? '').trim(),
        slot:          String(r[1] ?? '').trim(),
        trueBis:       String(r[2] ?? '').trim(),
        trueBisItemId: String(r[3] ?? '').trim(),
        raidBis:       String(r[4] ?? '').trim(),
        raidBisItemId: String(r[5] ?? '').trim(),
        source:        String(r[6] ?? '').trim(),
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
 * Write Default BIS entries. Lives in the master sheet. No sheetId parameter.
 *
 * Default (replace=false): skip rows whose (Spec, Slot, Source) already exists.
 *   Multiple sources for the same spec+slot coexist — each source gets its own row.
 *
 * With replace=true: delete all existing rows for the same (Spec, Source) combinations
 *   being written, then append the new entries. Other specs' rows and rows from other
 *   sources for the same spec are preserved.
 *
 * @param {object[]} entries  Array of { spec, slot, trueBis, trueBisItemId, raidBis, raidBisItemId, source }
 * @param {object}   opts     { replace?: boolean }
 * @returns {number} number of rows written
 */
export async function writeDefaultBis(entries, { replace = false } = {}) {
  const sheetId = getMasterSheetId();
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
// Lives in the master sheet. All functions here have no sheetId parameter.

const SPEC_BIS_CONFIG_TAB      = 'Spec BIS Config';
const DEFAULT_BIS_OVERRIDES_TAB = 'Default BIS Overrides';

/**
 * Create the Spec BIS Config tab in the master sheet if it doesn't already exist.
 * Safe to call repeatedly — a no-op if the tab is present.
 */
async function ensureSpecBisConfigTab() {
  const sheetId = getMasterSheetId();
  // Try a lightweight read first — if it succeeds the tab exists.
  try {
    await readRange(sheetId, `${SPEC_BIS_CONFIG_TAB}!A1:A1`);
    return;
  } catch {
    // Tab not found — fall through to create it.
  }

  // Add the sheet tab.
  const url = `${SHEETS_BASE}/${sheetId}:batchUpdate`;
  await withRetry(() => sheetsRequest('POST', url, {
    requests: [{ addSheet: { properties: { title: SPEC_BIS_CONFIG_TAB } } }],
  }));

  // Write the header row.
  await writeRange(sheetId, `${SPEC_BIS_CONFIG_TAB}!A1:B1`, [['Spec', 'PreferredSource']]);
  console.log(`[sheets] Created tab "${SPEC_BIS_CONFIG_TAB}"`);
}

/**
 * Read the Spec BIS Config tab (A=Spec B=PreferredSource) from the master sheet.
 * Returns a Map<specName, sourceName>.
 * If the tab doesn't exist yet, returns an empty Map.
 *
 * @returns {Map<string,string>}
 */
export async function getSpecBisConfig() {
  log.verbose('[sheets] getSpecBisConfig');
  const sheetId = getMasterSheetId();
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
 * Set the preferred BIS source for a single spec in the master sheet.
 * Creates the Spec BIS Config tab if it doesn't exist yet.
 * Upserts the row for the given spec.
 *
 * @param {string} spec    Canonical spec name, e.g. "Frost Mage"
 * @param {string} source  Canonical source name, e.g. "Icy Veins"
 */
export async function setSpecBisSource(spec, source) {
  const sheetId = getMasterSheetId();
  await ensureSpecBisConfigTab();
  const rows = await readRange(sheetId, `${SPEC_BIS_CONFIG_TAB}!A2:B`);
  const rowIndex = rows.findIndex(r => String(r[0] ?? '').toLowerCase() === spec.toLowerCase());
  if (rowIndex >= 0) {
    await writeRange(sheetId, `${SPEC_BIS_CONFIG_TAB}!B${rowIndex + 2}`, [[source]]);
  } else {
    await appendRows(sheetId, `${SPEC_BIS_CONFIG_TAB}!A:B`, [[spec, source]]);
  }
  cacheInvalidate(sheetId, 'specBisConfig', 'effectiveBis');
}

/**
 * Overwrite the entire Spec BIS Config tab in the master sheet with a new mapping.
 * Creates the tab if it doesn't exist yet.
 * Efficient for bulk operations like set-source-all.
 *
 * @param {object[]} entries  Array of { spec, source }
 */
export async function writeSpecBisConfig(entries) {
  const sheetId = getMasterSheetId();
  await ensureSpecBisConfigTab();
  await clearRange(sheetId, `${SPEC_BIS_CONFIG_TAB}!A2:B`);
  if (entries.length) {
    await appendRows(sheetId, `${SPEC_BIS_CONFIG_TAB}!A:B`, entries.map(e => [e.spec, e.source]));
  }
  cacheInvalidate(sheetId, 'specBisConfig', 'effectiveBis');
}

/**
 * Return Default BIS rows filtered to each spec's preferred source.
 * Reads from the master sheet. No sheetId parameter.
 *
 * For each (spec, slot), the row from the spec's preferred source (per Spec BIS Config)
 * is returned. Falls back to available sources in order: Icy Veins → Wowhead → Maxroll.
 *
 * @returns {object[]}
 */
export async function getEffectiveDefaultBis() {
  log.verbose('[sheets] getEffectiveDefaultBis');
  const sheetId = getMasterSheetId();
  return cachedRead(sheetId, 'effectiveBis', async () => {
    const [all, overrides, config] = await Promise.all([
      getDefaultBis(),
      getDefaultBisOverrides(),
      getSpecBisConfig(),
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
      const preferredLc = preferred.toLowerCase();
      let row = rows.find(r => r.source.toLowerCase() === preferredLc);
      if (!row) {
        // Preferred source not available — fall back in order
        for (const src of FALLBACK_ORDER) {
          const srcLc = src.toLowerCase();
          row = rows.find(r => r.source.toLowerCase() === srcLc);
          if (row) break;
        }
      }
      if (!row) continue;

      // Merge officer overrides on top of the seed row (override non-empty field wins)
      const ovr = overrides.find(o =>
        o.spec === row.spec && o.slot === row.slot && o.source.toLowerCase() === row.source.toLowerCase()
      );
      result.push(ovr ? {
        ...row,
        trueBis:       ovr.trueBis       || row.trueBis,
        trueBisItemId: ovr.trueBisItemId || row.trueBisItemId,
        raidBis:       ovr.raidBis       || row.raidBis,
        raidBisItemId: ovr.raidBisItemId || row.raidBisItemId,
      } : row);
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
      // raidBis was already set — check if it matches what inference would produce.
      // If so, treat it as auto (e.g. an officer override that saved a raid item as
      // both Overall BIS and Raid BIS should still show the Auto badge).
      const hypothetical = inferRaidBis({ ...row, raidBis: '' }, byName);
      const isAutoDerivable = hypothetical?.auto === true && hypothetical.raidBis === row.raidBis;
      return { ...row, raidBisAuto: isAutoDerivable };
    }
    return { ...row, raidBis: inferred.raidBis, raidBisItemId: inferred.raidBisItemId, raidBisAuto: inferred.auto };
  });
}

/**
 * Raids tab  (A=RaidId B=Date C=Instance D=Difficulty E=AttendeeIds)
 * AttendeeIds is a pipe-separated list of Discord user ID strings.
 * (TeamId column was removed — each team has its own sheet.)
 *
 * @param {string} sheetId
 * @returns {object[]}
 */
export async function getRaids(sheetId) {
  log.verbose(`[sheets] getRaids (sheet ${sheetId.slice(-6)})`);
  return cachedRead(sheetId, 'raids', async () => parseRaidsRows(await readRange(sheetId, 'Raids!A2:E')));
}

/**
 * Upsert a single Raids row by RaidId.
 * Writes a new row if the RaidId is not found; overwrites in place if it is.
 *
 * @param {string} sheetId
 * @param {{ raidId, date, instance, difficulty, attendeeIds }} raid
 */
export async function upsertRaid(sheetId, raid) {
  return upsertRaids(sheetId, [raid]);
}

/**
 * Upsert multiple Raids rows in one read + one batchUpdate + one optional append.
 * Keyed by RaidId.
 *
 * @param {string}   sheetId
 * @param {object[]} raids  Array of { raidId, date, instance, difficulty, attendeeIds }
 */
export async function upsertRaids(sheetId, raids) {
  if (!raids.length) return;
  log.verbose(`[sheets] upsertRaids (sheet ${sheetId.slice(-6)}) — ${raids.length} row(s)`);
  const existing = await readRange(sheetId, 'Raids!A2:A');
  const updates  = [];
  const appends  = [];

  for (const { raidId, date, instance, difficulty, attendeeIds } of raids) {
    const rowIdx = existing.findIndex(r => r[0] === raidId);
    const row    = [raidId, date, instance, difficulty, attendeeIds];
    if (rowIdx >= 0) {
      updates.push({ range: `Raids!A${rowIdx + 2}:E${rowIdx + 2}`, values: [row] });
    } else {
      appends.push(row);
      existing.push([raidId]); // prevent duplicate appends within same batch
    }
  }

  if (updates.length) await batchWriteRanges(sheetId, updates);
  if (appends.length) await appendRows(sheetId, 'Raids!A:E', appends);
  cacheInvalidate(sheetId, 'raids');
}

// ── Raid Encounters ───────────────────────────────────────────────────────────

/**
 * Raid Encounters tab  (A=RaidId B=EncounterId C=BossName D=Pulls E=Killed F=BestPct)
 * One row per boss per completed report. Written by WCL sync; never edited manually.
 *
 * @param {string} sheetId
 * @returns {object[]}
 */
export async function getRaidEncounters(sheetId) {
  log.verbose(`[sheets] getRaidEncounters (sheet ${sheetId.slice(-6)})`);
  const rows = await readRange(sheetId, 'Raid Encounters!A2:F');
  return rows
    .map(r => ({
      raidId:      r[0] ?? '',
      encounterId: Number(r[1] ?? 0),
      bossName:    r[2] ?? '',
      pulls:       Number(r[3] ?? 0),
      killed:      String(r[4] ?? '').toUpperCase() === 'TRUE',
      bestPct:     Number(r[5] ?? 100),
    }))
    .filter(r => r.raidId);
}

/**
 * Upsert Raid Encounters rows. Keyed by RaidId + EncounterId.
 *
 * @param {string}   sheetId
 * @param {object[]} rows  Array of { raidId, encounterId, bossName, pulls, killed, bestPct }
 */
export async function upsertRaidEncounters(sheetId, rows) {
  if (!rows.length) return;
  log.verbose(`[sheets] upsertRaidEncounters (sheet ${sheetId.slice(-6)}) — ${rows.length} row(s)`);
  const existing = await readRange(sheetId, 'Raid Encounters!A2:B');
  const updates  = [];
  const appends  = [];

  for (const row of rows) {
    const rowIdx = existing.findIndex(
      r => r[0] === row.raidId && String(r[1]) === String(row.encounterId),
    );
    const cells = [
      row.raidId,
      row.encounterId,
      row.bossName,
      row.pulls,
      row.killed ? 'TRUE' : 'FALSE',
      row.bestPct,
    ];
    if (rowIdx >= 0) {
      updates.push({ range: `Raid Encounters!A${rowIdx + 2}:F${rowIdx + 2}`, values: [cells] });
    } else {
      appends.push(cells);
      existing.push([row.raidId, String(row.encounterId)]); // prevent duplicate appends
    }
  }

  if (updates.length) await batchWriteRanges(sheetId, updates);
  if (appends.length) await appendRows(sheetId, 'Raid Encounters!A:F', appends);
}

// ── Tier Snapshot ─────────────────────────────────────────────────────────────

/**
 * Tier Snapshot tab  (A=CharId B=CharName C=RaidId D=TierCount E=TierDetail F=UpdatedAt)
 * One row per roster character — upserted on every WCL sync run, even for live reports.
 * Consumers should treat this as "current state" not a history.
 *
 * TierDetail: pipe-separated slot:track pairs, e.g. "Head:Mythic|Chest:Hero|Hands:Champion"
 *
 * @param {string} sheetId
 * @returns {object[]}
 */
export async function getTierSnapshot(sheetId) {
  log.verbose(`[sheets] getTierSnapshot (sheet ${sheetId.slice(-6)})`);
  return cachedRead(sheetId, 'tierSnapshot', async () => parseTierSnapshotRows(await readRange(sheetId, 'Tier Snapshot!A2:F')));
}

/**
 * Upsert Tier Snapshot rows. Keyed by CharId — one row per character, overwritten in place.
 *
 * @param {string}   sheetId
 * @param {object[]} snapshots  Array of { charId, charName, raidId, tierCount, tierDetail, updatedAt }
 */
export async function upsertTierSnapshot(sheetId, snapshots) {
  if (!snapshots.length) return;
  log.verbose(`[sheets] upsertTierSnapshot (sheet ${sheetId.slice(-6)}) — ${snapshots.length} row(s)`);
  const existing = await readRange(sheetId, 'Tier Snapshot!A2:A');
  const updates  = [];
  const appends  = [];

  for (const snap of snapshots) {
    const rowIdx = existing.findIndex(r => r[0] === snap.charId);
    const cells  = [snap.charId, snap.charName, snap.raidId, snap.tierCount, snap.tierDetail, snap.updatedAt];
    if (rowIdx >= 0) {
      updates.push({ range: `Tier Snapshot!A${rowIdx + 2}:F${rowIdx + 2}`, values: [cells] });
    } else {
      appends.push(cells);
      existing.push([snap.charId]); // prevent duplicate appends within same batch
    }
  }

  if (updates.length) await batchWriteRanges(sheetId, updates);
  if (appends.length) await appendRows(sheetId, 'Tier Snapshot!A:F', appends);
  cacheInvalidate(sheetId, 'tierSnapshot');
}

// ── Worn BIS ──────────────────────────────────────────────────────────────────

/**
 * Worn BIS tab  (A=CharId B=CharName C=Slot D=OverallBISTrack E=RaidBISTrack F=OtherTrack G=UpdatedAt)
 * One row per character × slot. Tracks the highest upgrade track ever worn for each
 * BIS category per slot. "Best ever" — values only increase, never decrease.
 *
 * Track values: 'Veteran' | 'Champion' | 'Hero' | 'Mythic' | '' (never worn at a known track)
 *
 * @param {string} sheetId
 * @returns {Map<string, object>}  Map keyed by `${charId}:${slot}`
 */
export async function getWornBis(sheetId) {
  log.verbose(`[sheets] getWornBis (sheet ${sheetId.slice(-6)})`);
  return cachedRead(sheetId, 'wornBis', async () => parseWornBisRows(await readRange(sheetId, 'Worn BIS!A2:G')));
}

/**
 * Upsert Worn BIS rows. Keyed by CharId + Slot (composite) — one row per character per slot.
 *
 * @param {string}   sheetId
 * @param {object[]} rows  Array of { charId, charName, slot, overallBISTrack, raidBISTrack, otherTrack }
 */
export async function upsertWornBis(sheetId, rows) {
  if (!rows.length) return;
  log.verbose(`[sheets] upsertWornBis (sheet ${sheetId.slice(-6)}) — ${rows.length} row(s)`);
  const existing = await readRange(sheetId, 'Worn BIS!A2:C');
  const updates  = [];
  const appends  = [];
  const now      = new Date().toISOString();

  for (const row of rows) {
    const rowIdx = existing.findIndex(r => r[0] === row.charId && r[2] === row.slot);
    const cells  = [row.charId, row.charName, row.slot, row.overallBISTrack, row.raidBISTrack, row.otherTrack, now];
    if (rowIdx >= 0) {
      updates.push({ range: `Worn BIS!A${rowIdx + 2}:G${rowIdx + 2}`, values: [cells] });
    } else {
      appends.push(cells);
      existing.push([row.charId, row.charName, row.slot]); // prevent duplicate appends within same batch
    }
  }

  if (updates.length) await batchWriteRanges(sheetId, updates);
  if (appends.length) await appendRows(sheetId, 'Worn BIS!A:G', appends);
  cacheInvalidate(sheetId, 'wornBis');
}

/**
 * Blank overallBISTrack and raidBISTrack for specific charId+slot pairs.
 * Used when the BIS definition for a slot changes (approval or default edit),
 * so the recorded "best-ever" tracks are cleared until the next WCL resync.
 * otherTrack is intentionally preserved.
 *
 * @param {string}   sheetId
 * @param {object[]} targets  Array of { charId, slot }
 */
export async function invalidateWornBisSlots(sheetId, targets) {
  if (!targets.length) return;
  log.verbose(`[sheets] invalidateWornBisSlots (sheet ${sheetId.slice(-6)}) — ${targets.length} target(s)`);
  const targetSet = new Set(targets.map(t => `${t.charId}:${t.slot}`));
  const existing  = await readRange(sheetId, 'Worn BIS!A2:G');
  const updates   = [];
  for (let i = 0; i < existing.length; i++) {
    const r      = existing[i];
    const charId = r[0] ?? '';
    const slot   = r[2] ?? '';
    if (!targetSet.has(`${charId}:${slot}`)) continue;
    // Blank D (OverallBISTrack) and E (RaidBISTrack) only; preserve otherTrack
    updates.push({ range: `Worn BIS!D${i + 2}:E${i + 2}`, values: [['', '']] });
  }
  if (updates.length) await batchWriteRanges(sheetId, updates);
  cacheInvalidate(sheetId, 'wornBis');
}

/**
 * Clear all data rows from the Worn BIS tab (keeps header row).
 * Used for season reset via the Admin page.
 *
 * @param {string} sheetId
 */
export async function clearWornBis(sheetId) {
  log.verbose(`[sheets] clearWornBis (sheet ${sheetId.slice(-6)})`);
  // Read how many rows exist so we can overwrite them with blanks
  const existing = await readRange(sheetId, 'Worn BIS!A2:A');
  if (!existing.length) return;
  const blankRows = existing.map(() => ['', '', '', '', '', '', '']);
  await writeRange(sheetId, 'Worn BIS!A2:G', blankRows);
  cacheInvalidate(sheetId, 'wornBis');
}

// ── Tier Items (master) ───────────────────────────────────────────────────────

/**
 * Tier Items tab in the master sheet  (A=Class B=Slot C=ItemId)
 * Stores the current season's tier piece item IDs per class and slot.
 * Seeded via /admin → Sync Tier Items (Blizzard API).
 *
 * @returns {object[]}  Array of { class, slot, itemId }
 */
export async function getTierItems() {
  log.verbose('[sheets] getTierItems');
  const masterSheetId = getMasterSheetId();
  return cachedRead(masterSheetId, 'tierItems', async () => {
    const rows = await readRange(masterSheetId, 'Tier Items!A2:C');
    return rows
      .filter(r => r[0] && r[1] && r[2])
      .map(r => ({ class: r[0].trim(), slot: r[1].trim(), itemId: Number(r[2]) }));
  });
}

/**
 * Overwrite the Tier Items tab in the master sheet.
 * Called by /admin → Sync Tier Items after fetching from Blizzard API.
 *
 * @param {object[]} items  Array of { class, slot, itemId }
 */
export async function setTierItems(items) {
  log.verbose(`[sheets] setTierItems — ${items.length} rows`);
  const masterSheetId = getMasterSheetId();
  await clearRange(masterSheetId, 'Tier Items!A2:C');
  if (items.length) {
    const values = items.map(i => [i.class, i.slot, i.itemId]);
    await writeRange(masterSheetId, `Tier Items!A2:C${items.length + 1}`, values);
  }
  cacheInvalidate(masterSheetId, 'tierItems');
}

/**
 * Write Raid BIS values for specific (spec, slot, source) rows in the Default BIS tab.
 * Writes to the master sheet. No sheetId parameter.
 *
 * @param {object[]} updates  Array of { spec, slot, source, raidBis, raidBisItemId }
 */
export async function updateDefaultBisRaidBis(updates) {
  const sheetId = getMasterSheetId();
  if (!updates.length) return;

  const rows = await readRange(sheetId, 'Default BIS!A2:G');
  const batchData = [];
  const newRows   = [];

  for (const upd of updates) {
    const idx = rows.findIndex(r =>
      String(r[0] ?? '').trim() === upd.spec &&
      String(r[1] ?? '').trim() === upd.slot &&
      String(r[6] ?? '').trim().toLowerCase() === upd.source.toLowerCase()
    );
    if (idx < 0) {
      // Row doesn't exist yet — create it (e.g. Off-Hand for a dual-wield spec
      // whose default BIS was seeded from a 2H guide).
      newRows.push([
        upd.spec, upd.slot, upd.trueBis ?? '', itemIdCell(upd.trueBisItemId ?? ''),
        upd.raidBis ?? '', itemIdCell(upd.raidBisItemId ?? ''), upd.source,
      ]);
      continue;
    }

    const rowNum = idx + 2; // +1 for 1-indexed, +1 for header row
    if (upd.raidBis !== undefined) {
      batchData.push({
        range:  `Default BIS!E${rowNum}:F${rowNum}`,
        values: [[upd.raidBis, itemIdCell(upd.raidBisItemId ?? '')]],
      });
    }
    if (upd.trueBis !== undefined) {
      batchData.push({
        range:  `Default BIS!C${rowNum}:D${rowNum}`,
        values: [[upd.trueBis, itemIdCell(upd.trueBisItemId ?? '')]],
      });
    }
  }

  if (newRows.length) await appendRows(sheetId, 'Default BIS!A:G', newRows);
  if (!batchData.length) return;

  const url = `${SHEETS_BASE}/${sheetId}/values:batchUpdate`;
  await withRetry(() => sheetsRequest('POST', url, {
    valueInputOption: 'USER_ENTERED',
    data: batchData,
  }));
  cacheInvalidate(sheetId, 'defaultBis', 'effectiveBis');
}

// ── Default BIS Overrides ─────────────────────────────────────────────────────

/**
 * Create the Default BIS Overrides tab in the master sheet if it doesn't exist.
 * Safe to call repeatedly — a no-op if the tab is present.
 */
async function ensureDefaultBisOverridesTab() {
  const sheetId = getMasterSheetId();
  try {
    await readRange(sheetId, `${DEFAULT_BIS_OVERRIDES_TAB}!A1:A1`);
    return;
  } catch {
    // Tab not found — fall through to create it.
  }
  const url = `${SHEETS_BASE}/${sheetId}:batchUpdate`;
  await withRetry(() => sheetsRequest('POST', url, {
    requests: [{ addSheet: { properties: { title: DEFAULT_BIS_OVERRIDES_TAB } } }],
  }));
  await writeRange(sheetId, `${DEFAULT_BIS_OVERRIDES_TAB}!A1:G1`, [[
    'Spec', 'Slot', 'TrueBIS', 'TrueBISItemId', 'RaidBIS', 'RaidBISItemId', 'Source',
  ]]);
  console.log(`[sheets] Created tab "${DEFAULT_BIS_OVERRIDES_TAB}"`);
}

/**
 * Read all officer overrides from the Default BIS Overrides tab.
 * Returns [] if the tab doesn't exist yet.
 *
 * @returns {object[]}
 */
export async function getDefaultBisOverrides() {
  log.verbose('[sheets] getDefaultBisOverrides');
  const sheetId = getMasterSheetId();
  return cachedRead(sheetId, 'defaultBisOverrides', async () => {
    try {
      const rows = await readRange(sheetId, `${DEFAULT_BIS_OVERRIDES_TAB}!A1:G`);
      return rows
        .filter(r => r[0] && r[0] !== 'Spec') // skip header row if present
        .map(r => ({
          spec:          String(r[0] ?? '').trim(),
          slot:          String(r[1] ?? '').trim(),
          trueBis:       String(r[2] ?? '').trim(),
          trueBisItemId: String(r[3] ?? '').trim(),
          raidBis:       String(r[4] ?? '').trim(),
          raidBisItemId: String(r[5] ?? '').trim(),
          source:        String(r[6] ?? '').trim(),
        }));
    } catch {
      return [];
    }
  });
}

/**
 * Write officer overrides to the Default BIS Overrides tab.
 * Never touches the seed Default BIS tab.
 * Creates the overrides tab if it doesn't exist yet.
 *
 * Each update object: { spec, slot, source, trueBis?, trueBisItemId?, raidBis?, raidBisItemId? }
 * Fields left undefined are not written.
 *
 * @param {object[]} updates
 */
export async function updateDefaultBisOverrides(updates) {
  const sheetId = getMasterSheetId();
  if (!updates.length) return;

  await ensureDefaultBisOverridesTab();
  // Read from A1 so we find data even if it landed at row 1 (no header).
  // Track actual sheet row numbers alongside each raw row array.
  const allRows = await readRange(sheetId, `${DEFAULT_BIS_OVERRIDES_TAB}!A1:G`);
  const dataRows = allRows
    .map((r, i) => ({ r, sheetRowNum: i + 1 }))
    .filter(({ r }) => r[0] && r[0] !== 'Spec'); // skip empty + header

  const batchData = [];
  const newRows   = [];

  for (const upd of updates) {
    const match = dataRows.find(({ r }) =>
      String(r[0] ?? '').trim() === upd.spec &&
      String(r[1] ?? '').trim() === upd.slot &&
      String(r[6] ?? '').trim().toLowerCase() === upd.source.toLowerCase()
    );
    if (!match) {
      newRows.push([
        upd.spec, upd.slot,
        upd.trueBis  ?? '', itemIdCell(upd.trueBisItemId  ?? ''),
        upd.raidBis  ?? '', itemIdCell(upd.raidBisItemId  ?? ''),
        upd.source,
      ]);
      continue;
    }

    const { sheetRowNum: rowNum } = match;
    if (upd.trueBis !== undefined) {
      batchData.push({
        range:  `${DEFAULT_BIS_OVERRIDES_TAB}!C${rowNum}:D${rowNum}`,
        values: [[upd.trueBis, itemIdCell(upd.trueBisItemId ?? '')]],
      });
    }
    if (upd.raidBis !== undefined) {
      batchData.push({
        range:  `${DEFAULT_BIS_OVERRIDES_TAB}!E${rowNum}:F${rowNum}`,
        values: [[upd.raidBis, itemIdCell(upd.raidBisItemId ?? '')]],
      });
    }
  }

  if (newRows.length) {
    // If tab is empty (no header yet), write the header first as part of the batch.
    // Use explicit row numbers instead of appendRows to avoid Sheets API table-detection
    // issues where data can land at row 1 even when a header is expected.
    let nextRow = allRows.length + 1;
    if (allRows.length === 0) {
      batchData.push({
        range:  `${DEFAULT_BIS_OVERRIDES_TAB}!A1:G1`,
        values: [['Spec', 'Slot', 'TrueBIS', 'TrueBISItemId', 'RaidBIS', 'RaidBISItemId', 'Source']],
      });
      nextRow = 2;
    }
    for (const row of newRows) {
      batchData.push({
        range:  `${DEFAULT_BIS_OVERRIDES_TAB}!A${nextRow}:G${nextRow}`,
        values: [row],
      });
      nextRow++;
    }
  }
  if (batchData.length) {
    const url = `${SHEETS_BASE}/${sheetId}/values:batchUpdate`;
    await withRetry(() => sheetsRequest('POST', url, {
      valueInputOption: 'USER_ENTERED',
      data: batchData,
    }));
  }
  cacheInvalidate(sheetId, 'defaultBisOverrides', 'effectiveBis');
}

// ── Master sheet — registry and global config ─────────────────────────────────

/**
 * Teams tab in the master sheet  (A=TeamName  B=SheetId)
 *
 * Returns the list of all registered teams. Used by initTeams() in teams.js
 * to discover which team sheets to load at startup.
 *
 * @returns {{ name: string, sheetId: string }[]}
 */
export async function getTeamRegistry() {
  log.verbose('[sheets] getTeamRegistry');
  const masterSheetId = getMasterSheetId();
  return cachedRead(masterSheetId, 'teamRegistry', async () => {
    const rows = await readRange(masterSheetId, 'Teams!A2:B');
    return rows
      .filter(r => r[0] && r[1])
      .map(r => ({ name: r[0].trim(), sheetId: r[1].trim() }));
  });
}

/**
 * Global Config tab in the master sheet  (A=Key  B=Value)
 *
 * Holds guild-wide settings that apply across all teams:
 *   guild_id    — Discord guild (server) ID; required for officer role checks
 *   web_app_url — base URL of the web app (used in Discord link buttons)
 *
 * Returns a flat object: { guild_id: "...", web_app_url: "...", ... }
 *
 * @returns {object}
 */
export async function getGlobalConfig() {
  log.verbose('[sheets] getGlobalConfig');
  const masterSheetId = getMasterSheetId();
  return cachedRead(masterSheetId, 'globalConfig', async () => {
    const rows = await readRange(masterSheetId, 'Global Config!A2:B');
    return Object.fromEntries(
      rows.filter(r => r[0]).map(([k, v]) => [k, v ?? ''])
    );
  });
}
