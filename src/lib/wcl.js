/**
 * wcl.js — Warcraft Logs v2 GraphQL API client.
 *
 * Handles OAuth client credentials and all GQL queries needed by the WCL sync.
 * No Sheets access here — pure WCL API calls.
 *
 * All exported functions accept (clientId, clientSecret) so the caller
 * (wcl-sync.js) passes credentials from Global Config rather than reading env
 * directly.
 */

const WCL_TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';
const WCL_API_URL   = 'https://www.warcraftlogs.com/api/v2/client';

// ── OAuth token (module-level cache — survives within one Worker invocation) ──

let _wclToken       = null;
let _wclTokenExpiry = 0;

async function getToken(clientId, clientSecret) {
  if (_wclToken && Date.now() < _wclTokenExpiry) return _wclToken;

  const resp = await fetch(WCL_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });

  if (!resp.ok) {
    throw new Error(`WCL OAuth failed: ${resp.status} ${await resp.text()}`);
  }

  const { access_token, expires_in } = await resp.json();
  _wclToken       = access_token;
  _wclTokenExpiry = Date.now() + (expires_in - 60) * 1000; // 60 s buffer
  return _wclToken;
}

// ── GraphQL helper ─────────────────────────────────────────────────────────────

async function gql(query, variables, clientId, clientSecret) {
  const token = await getToken(clientId, clientSecret);
  const resp  = await fetch(WCL_API_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    throw new Error(`WCL API error: ${resp.status} ${await resp.text()}`);
  }

  const json = await resp.json();
  if (json.errors?.length) {
    throw new Error(`WCL GQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// ── Queries ────────────────────────────────────────────────────────────────────

const Q_REPORTS = `
  query GetReports($guildId: Int!, $startTime: Float) {
    reportData {
      reports(guildID: $guildId, startTime: $startTime, limit: 25) {
        data {
          code
          title
          startTime
          endTime
          zone { id name }
        }
      }
    }
  }
`;

const Q_REPORT_FIGHTS = `
  query GetReportFights($code: String!) {
    reportData {
      report(code: $code) {
        startTime
        endTime
        fights(killType: All) {
          id
          encounterID
          name
          kill
          startTime
          endTime
          bossPercentage
          difficulty
          inProgress
        }
        masterData {
          actors(type: "Player") {
            id
            name
            server
            subType
          }
        }
      }
    }
  }
`;

const Q_COMBATANT_INFO = `
  query GetCombatantInfo($code: String!, $fightIds: [Int]!) {
    reportData {
      report(code: $code) {
        events(dataType: CombatantInfo, fightIDs: $fightIds) {
          data
        }
      }
    }
  }
`;

const Q_ZONE_ENCOUNTERS = `
  query GetZoneEncounters($zoneId: Int!) {
    worldData {
      zone(id: $zoneId) {
        id
        name
        encounters {
          id
          name
        }
      }
    }
  }
`;

// ── Exported API ───────────────────────────────────────────────────────────────

/**
 * Build a Set of valid WCL encounter IDs for the given zone IDs.
 * Called once per sync run; results used to filter out dirty-log fights.
 *
 * @param {number[]} zoneIds
 * @param {string}   clientId
 * @param {string}   clientSecret
 * @returns {Set<number>}
 */
export async function getValidEncounterIds(zoneIds, clientId, clientSecret) {
  const ids = new Set();
  for (const zoneId of zoneIds) {
    const data = await gql(Q_ZONE_ENCOUNTERS, { zoneId }, clientId, clientSecret);
    for (const enc of data.worldData?.zone?.encounters ?? []) {
      ids.add(enc.id);
    }
  }
  return ids;
}

/**
 * Fetch reports for a WCL guild created/updated on or after `sinceMs`.
 *
 * @param {number} guildId      WCL guild ID (numeric)
 * @param {number} sinceMs      Unix timestamp in milliseconds
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {object[]}  Array of report summary objects
 */
export async function getReportsForGuild(guildId, sinceMs, clientId, clientSecret) {
  const data = await gql(
    Q_REPORTS,
    { guildId, startTime: sinceMs || undefined },
    clientId,
    clientSecret,
  );
  return data.reportData?.reports?.data ?? [];
}

/**
 * Fetch full fight list + actor list for a single report.
 *
 * @param {string} code          WCL report code (e.g. "AbCdEf12")
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {{ startTime, endTime, fights, masterData } | null}
 */
export async function getReportFights(code, clientId, clientSecret) {
  const data = await gql(Q_REPORT_FIGHTS, { code }, clientId, clientSecret);
  return data.reportData?.report ?? null;
}

/**
 * Fetch CombatantInfo events for a specific fight within a report.
 * Returns the raw `data` array of combatant event objects.
 *
 * @param {string}   code          WCL report code
 * @param {number}   fightId       Fight ID (integer)
 * @param {string}   clientId
 * @param {string}   clientSecret
 * @returns {object[]}
 */
export async function getCombatantInfo(code, fightId, clientId, clientSecret) {
  const data = await gql(Q_COMBATANT_INFO, { code, fightIds: [fightId] }, clientId, clientSecret);
  return data.reportData?.report?.events?.data ?? [];
}
