/**
 * blizzard.js — Blizzard Game Data API client.
 *
 * Uses client credentials OAuth flow (no user login required).
 * Token is cached in-process and refreshed automatically.
 *
 * Region is read from BLIZZARD_REGION env var (default: us).
 */

const REGION    = process.env.BLIZZARD_REGION ?? 'us';
const OAUTH_URL = `https://oauth.battle.net/token`;
const API_BASE  = `https://${REGION}.api.blizzard.com`;

// Override with BLIZZARD_NAMESPACE env var, e.g. for a specific build namespace.
// Defaults to static-us (or static-eu etc. for other regions).
function getNamespace() {
  return process.env.BLIZZARD_NAMESPACE ?? `static-${REGION}`;
}

console.log(`[blizzard] namespace: ${getNamespace()}`);

let _token       = null;
let _tokenExpiry = 0;

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const creds = Buffer
    .from(`${process.env.BLIZZARD_CLIENT_ID}:${process.env.BLIZZARD_CLIENT_SECRET}`)
    .toString('base64');

  const res = await fetch(OAUTH_URL, {
    method:  'POST',
    headers: {
      Authorization:  `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blizzard auth failed (${res.status}): ${text}`);
  }

  const data       = await res.json();
  _token           = data.access_token;
  _tokenExpiry     = Date.now() + (data.expires_in - 60) * 1000;
  return _token;
}

// ── API fetch ─────────────────────────────────────────────────────────────────

async function blizzardFetch(path, extraParams = {}) {
  const token = await getToken();
  const url   = new URL(API_BASE + path);

  url.searchParams.set('namespace', getNamespace());
  url.searchParams.set('locale', 'en_US');
  for (const [k, v] of Object.entries(extraParams)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) throw new Error(`Blizzard API ${res.status}: GET ${path}`);
  return res.json();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Run promises with a max concurrency limit to avoid hammering the API.
 */
async function pLimit(tasks, concurrency = 5) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** List all journal instances (raids + dungeons). */
export async function listInstances() {
  const data = await blizzardFetch('/data/wow/journal-instance/index');
  return data.instances ?? [];
}

/** Get a journal instance by ID (includes encounters list). */
export async function getInstance(instanceId) {
  return blizzardFetch(`/data/wow/journal-instance/${instanceId}`);
}

/**
 * Get a journal encounter by ID.
 * Pass difficulty: 'NORMAL' | 'HEROIC' | 'MYTHIC' | 'LOOKING_FOR_RAID' | 'MYTHIC_KEYSTONE'
 */
export async function getEncounter(encounterId, difficulty = 'MYTHIC') {
  return blizzardFetch(`/data/wow/journal-encounter/${encounterId}`, { difficulty });
}

/** Get full item details by item ID. */
export async function getItemDetails(itemId) {
  return blizzardFetch(`/data/wow/item/${itemId}`);
}

/**
 * Fetch all items from a raid instance at the given difficulty.
 * Returns a flat array of { item, encounterName } objects.
 */
export async function fetchRaidItems(instanceId, difficulty = 'MYTHIC') {
  const instance = await getInstance(instanceId);
  const instanceName = instance.name;

  console.log(`  Instance: ${instanceName} (${instance.encounters?.length ?? 0} encounters)`);

  const encounterItems = [];

  for (const enc of instance.encounters ?? []) {
    try {
      const encounter = await getEncounter(enc.id, difficulty);
      const items = encounter.items ?? [];
      for (const item of items) {
        encounterItems.push({ item, encounterName: encounter.name, instanceName, difficulty });
      }
      console.log(`  ✓ ${encounter.name}: ${items.length} items`);
      for (const item of items) {
        console.log(`      [${item.item?.id ?? item.id}] ${item.item?.name ?? item.name ?? '?'}`);
      }
    } catch (err) {
      console.warn(`  ⚠ ${enc.name}: ${err.message}`);
    }
  }

  // Deduplicate by item ID (same item may appear under multiple encounters)
  // Deduplicate by actual item ID (item.item.id), not journal item ID (item.id)
  const seen = new Set();
  const unique = encounterItems.filter(({ item }) => {
    const realId = item.item?.id ?? item.id;
    if (seen.has(realId)) return false;
    seen.add(realId);
    return true;
  });

  // Fetch full details for each item (needed for inventory type, armor type)
  console.log(`\n  Fetching details for ${unique.length} unique items…`);
  const detailed = await pLimit(
    unique.map(({ item, encounterName, instanceName, difficulty }) => async () => {
      const realId   = item.item?.id ?? item.id;
      const realName = item.item?.name ?? item.name ?? '?';
      try {
        const details = await getItemDetails(realId);
        console.log(`  [${details.id}] ${details.name} | class=${details.item_class?.name} subclass=${details.item_subclass?.name} invType=${details.inventory_type?.type} set=${details.item_set?.name ?? 'none'}`);
        return { details, encounterName, instanceName, difficulty };
      } catch (err) {
        console.warn(`  ⚠ Item ${realId} (${realName}): ${err.message}`);
        return null;
      }
    }),
    8,
  );

  return detailed.filter(Boolean);
}

/**
 * Get an item set by ID.
 * Returns the set name and its item list (each with id + name).
 */
export async function getItemSet(itemSetId) {
  return blizzardFetch(`/data/wow/item-set/${itemSetId}`);
}

export { pLimit };
