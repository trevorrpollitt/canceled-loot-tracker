/**
 * teams.js — resolves which team a Discord interaction belongs to.
 *
 * Team discovery is entirely sheet-driven:
 *   1. The master sheet (MASTER_SHEET_ID) has a "Teams" tab with TeamName + SheetId rows.
 *   2. initTeams() reads that registry, then reads each team's own Config tab to load
 *      channel IDs and role IDs.
 *
 * Adding a new team = add a row to the Teams tab in the master sheet + create the
 * team sheet. No env var changes, no code changes, no redeploy needed.
 */

import { getTeamRegistry, getConfig } from './sheets.js';
import { log } from './logger.js';

// In-memory team registry — populated by initTeams() at startup.
const TEAMS = {};

/** Parse a pipe-separated role ID string into a trimmed array of non-empty IDs. */
function parseRoleIds(value) {
  if (!value) return [];
  return value.split('|').map(s => s.trim()).filter(Boolean);
}

// ── Startup initialisation ────────────────────────────────────────────────────

/**
 * Load all teams from the master sheet Teams registry, then load each team's
 * Config tab to populate channel IDs and role IDs.
 *
 * Must be called once at startup (before bot login / server listen).
 *
 * Config keys read from each team's sheet:
 *   console_channel_id — #raid-console channel where panels are posted
 *   brief_channel_id   — pre-raid brief channel
 *   officer_role_id    — Discord role ID(s) for officers (pipe-separated for multiple)
 *   team_role_id       — Discord role ID(s) for team members (pipe-separated for multiple)
 *
 * guild_id is NOT loaded here — it lives in the master sheet Global Config tab
 * and is read directly by auth.js via getGlobalConfig().
 */
export async function initTeams() {
  log.verbose('[teams] initTeams — loading team registry');
  // Clear any previous state (safe for hot-reload scenarios)
  for (const key of Object.keys(TEAMS)) delete TEAMS[key];

  let registry;
  try {
    registry = await getTeamRegistry();
  } catch (err) {
    log.error('[teams] Failed to load team registry from master sheet:', err.message);
    return;
  }

  if (!registry.length) {
    log.warn('[teams] Team registry is empty — add rows to the Teams tab in the master sheet');
    return;
  }

  log.verbose(`[teams] Found ${registry.length} team(s) in registry:`, registry.map(t => t.name).join(', '));

  for (const { name, sheetId } of registry) {
    TEAMS[name.toLowerCase()] = {
      name,
      sheetId,
      consoleChannelId: null,
      briefChannelId:   null,
      officerRoleIds:   [],
      memberRoleIds:    [],
    };
  }

  // Load per-team config from each team's Config tab
  for (const team of Object.values(TEAMS)) {
    try {
      const config = await getConfig(team.sheetId);
      team.consoleChannelId = config.console_channel_id || null;
      team.briefChannelId   = config.brief_channel_id   || null;
      team.officerRoleIds   = parseRoleIds(config.officer_role_id);
      team.memberRoleIds    = parseRoleIds(config.team_role_id);
      log.verbose(`[teams] Loaded config for team "${team.name}" — officerRoles=[${team.officerRoleIds}] memberRoles=[${team.memberRoleIds}]`);
      log.debug(`[teams] Full config for team "${team.name}"`, config);
    } catch (err) {
      log.error(`[teams] Failed to load config for team "${team.name}":`, err.message);
    }
  }
  log.verbose('[teams] initTeams complete');
}

// ── Lookup helpers ────────────────────────────────────────────────────────────

/**
 * Get team config by channel ID.
 * Returns the team whose console channel matches, or null if not found.
 *
 * @param {string} channelId
 * @returns {{ name, sheetId, consoleChannelId, briefChannelId, officerRoleIds, memberRoleIds } | null}
 */
export function getTeamByChannel(channelId) {
  for (const team of Object.values(TEAMS)) {
    if (team.consoleChannelId === channelId) return team;
  }
  return null;
}

/**
 * Get team config by team name.
 *
 * @param {string} name  e.g. "mythic"
 * @returns {object | null}
 */
export function getTeamByName(name) {
  return TEAMS[name.toLowerCase()] ?? null;
}

/**
 * Returns true if the given channel is a registered console channel for any team.
 *
 * @param {string} channelId
 * @returns {boolean}
 */
export function isConsoleChannel(channelId) {
  return Object.values(TEAMS).some(t => t.consoleChannelId === channelId);
}

/**
 * Returns all registered teams.
 *
 * @returns {object[]}
 */
export function getAllTeams() {
  return Object.values(TEAMS);
}
