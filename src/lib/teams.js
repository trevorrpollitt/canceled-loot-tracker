/**
 * teams.js — resolves which team a Discord interaction belongs to.
 *
 * Team config lives in environment variables (see .env.example).
 * The bot calls getTeamByChannel(channelId) on every interaction to
 * figure out which Sheet to read from and what permissions to check.
 *
 * Adding a new team = add five env vars and redeploy. No code changes.
 */

// ── Build team registry from env vars ────────────────────────────────────────
// Looks for TEAM_<NAME>_SHEET_ID and derives the rest of the block from it.

function buildTeamRegistry() {
  const teams = {};

  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^TEAM_([A-Z0-9_]+)_SHEET_ID$/);
    if (!match) continue;

    const name  = match[1].toLowerCase(); // e.g. "mythic"
    const prefix = match[1];              // e.g. "MYTHIC"

    teams[name] = {
      name,
      sheetId:          value,
      consoleChannelId: process.env[`TEAM_${prefix}_CONSOLE_CHANNEL`] ?? null,
      briefChannelId:   process.env[`TEAM_${prefix}_BRIEF_CHANNEL`]   ?? null,
      officerRoleId:    process.env[`TEAM_${prefix}_OFFICER_ROLE`]     ?? null,
      memberRoleId:     process.env[`TEAM_${prefix}_MEMBER_ROLE`]      ?? null,
    };
  }

  return teams;
}

const TEAMS = buildTeamRegistry();

// ── Lookup helpers ────────────────────────────────────────────────────────────

/**
 * Get team config by channel ID.
 * Returns the team whose console channel matches, or null if not found.
 *
 * @param {string} channelId
 * @returns {{ name, sheetId, consoleChannelId, briefChannelId, officerRoleId, memberRoleId } | null}
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
