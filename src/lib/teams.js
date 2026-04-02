/**
 * teams.js — resolves which team a Discord interaction belongs to.
 *
 * Team discovery is D1-backed:
 *   1. The `teams` table lists all registered teams.
 *   2. initTeams(db) reads that table, then reads each team's `team_config` rows to
 *      load channel IDs and role IDs into the in-memory cache.
 *
 * Adding a new team = insert a row into `teams` + insert config rows into `team_config`.
 * No env var changes, no code changes, no redeploy needed.
 */

import { getAllTeams as dbGetAllTeams, getTeamConfig } from './db.js';
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
 * Load all teams from D1, then load each team's config rows to populate
 * channel IDs and role IDs into the in-memory cache.
 *
 * Must be called once at startup (before bot login / server listen).
 *
 * Config keys read from team_config:
 *   console_channel_id — #raid-console channel where panels are posted
 *   brief_channel_id   — pre-raid brief channel
 *   officer_role_id    — Discord role ID(s) for officers (pipe-separated for multiple)
 *   team_role_id       — Discord role ID(s) for team members (pipe-separated for multiple)
 *
 * guild_id is NOT loaded here — it lives in global_config and is read directly
 * by auth.js via getGlobalConfig().
 *
 * @param {import('./db.js').D1Database} db
 */
export async function initTeams(db) {
  log.verbose('[teams] initTeams — loading team registry from D1');
  // Clear any previous state (safe for hot-reload scenarios)
  for (const key of Object.keys(TEAMS)) delete TEAMS[key];

  let registry;
  try {
    registry = await dbGetAllTeams(db);
  } catch (err) {
    log.error('[teams] Failed to load team registry from D1:', err.message);
    return;
  }

  if (!registry.length) {
    log.warn('[teams] Team registry is empty — insert rows into the teams table');
    return;
  }

  log.verbose(`[teams] Found ${registry.length} team(s):`, registry.map(t => t.name).join(', '));

  for (const { id, name } of registry) {
    TEAMS[name.toLowerCase()] = {
      id,
      name,
      consoleChannelId: null,
      briefChannelId:   null,
      officerRoleIds:   [],
      memberRoleIds:    [],
    };
  }

  // Load per-team config — all teams in parallel
  await Promise.all(Object.values(TEAMS).map(async (team) => {
    try {
      const config = await getTeamConfig(db, team.id);
      team.consoleChannelId = config.console_channel_id || null;
      team.briefChannelId   = config.brief_channel_id   || null;
      team.officerRoleIds   = parseRoleIds(config.officer_role_id);
      team.memberRoleIds    = parseRoleIds(config.team_role_id);
      log.verbose(`[teams] Loaded config for team "${team.name}" — officerRoles=[${team.officerRoleIds}] memberRoles=[${team.memberRoleIds}]`);
      log.debug(`[teams] Full config for team "${team.name}"`, config);
    } catch (err) {
      log.error(`[teams] Failed to load config for team "${team.name}":`, err.message);
    }
  }));
  log.verbose('[teams] initTeams complete');
}

// ── Lookup helpers ────────────────────────────────────────────────────────────

/**
 * Get team config by channel ID.
 * Returns the team whose console channel matches, or null if not found.
 *
 * @param {string} channelId
 * @returns {{ id, name, consoleChannelId, briefChannelId, officerRoleIds, memberRoleIds } | null}
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
