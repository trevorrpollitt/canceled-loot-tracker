/**
 * teams.js — resolves which team a Discord interaction belongs to.
 *
 * Team identification lives in environment variables (one TEAM_<NAME>_SHEET_ID per team).
 * All other team config (channel IDs, role IDs, guild ID) lives in each team's
 * Google Sheet Config tab and is loaded at startup via initTeams().
 *
 * Adding a new team = add one env var (TEAM_<NAME>_SHEET_ID) and add the config
 * values to that team's Config sheet. No other code changes.
 */

import { getConfig } from './sheets.js';

// ── Build team registry from env vars ────────────────────────────────────────
// Only reads TEAM_<NAME>_SHEET_ID. All other config is loaded from the sheet
// by initTeams() at startup.

function buildTeamRegistry() {
  const teams = {};

  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^TEAM_([A-Z0-9_]+)_SHEET_ID$/);
    if (!match) continue;

    const name = match[1].toLowerCase(); // e.g. "mythic"

    teams[name] = {
      name,
      sheetId:          value,
      // Populated by initTeams() from the Config sheet:
      consoleChannelId: null,
      briefChannelId:   null,
      officerRoleId:    null,
      memberRoleId:     null,
      guildId:          null,
    };
  }

  return teams;
}

const TEAMS = buildTeamRegistry();

// ── Startup initialisation ────────────────────────────────────────────────────

/**
 * Load per-team config from each team's Google Sheet Config tab.
 * Must be called once at startup (before bot login / server listen).
 *
 * Config keys read:
 *   console_channel_id — #raid-console channel where panels are posted
 *   brief_channel_id   — pre-raid brief channel
 *   officer_role_id    — Discord role ID for officers
 *   team_role_id       — Discord role ID for team members
 *   guild_id           — Discord guild (server) ID
 */
export async function initTeams() {
  for (const team of Object.values(TEAMS)) {
    try {
      const config = await getConfig(team.sheetId);
      team.consoleChannelId = config.console_channel_id || null;
      team.briefChannelId   = config.brief_channel_id   || null;
      team.officerRoleId    = config.officer_role_id     || null;
      team.memberRoleId     = config.team_role_id        || null;
      team.guildId          = config.guild_id            || null;
      console.log(`[teams] Loaded config for team "${team.name}" from sheet`);
    } catch (err) {
      console.error(`[teams] Failed to load config for team "${team.name}":`, err.message);
    }
  }
}

// ── Lookup helpers ────────────────────────────────────────────────────────────

/**
 * Get team config by channel ID.
 * Returns the team whose console channel matches, or null if not found.
 *
 * @param {string} channelId
 * @returns {{ name, sheetId, consoleChannelId, briefChannelId, officerRoleId, memberRoleId, guildId } | null}
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
