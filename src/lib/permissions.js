/**
 * permissions.js — access control helpers.
 *
 * All officer checks go through here. The bot checks officer role before
 * acting on any button or slash command in the console channel.
 *
 * Usage in a handler:
 *
 *   const team   = getTeamByChannel(interaction.channelId);
 *   const config = team ? await getConfig(team.sheetId) : null;
 *   if (!await requireOfficer(interaction, team, config)) return;
 */

/**
 * Returns true if the member holds the officer role.
 *
 * Resolution order:
 *   1. Config tab `officer_role_id` (authoritative, set per-team in the sheet)
 *   2. Env var `TEAM_<NAME>_OFFICER_ROLE` (fallback before Config tab is populated)
 *   3. Any role literally named "Officer" (last-resort fallback)
 *
 * @param {GuildMember} member
 * @param {object}      team    - team object from teams.js
 * @param {object}      config  - parsed Config tab from getConfig()
 * @returns {boolean}
 */
export function memberIsOfficer(member, team, config) {
  const roleId = config?.officer_role_id || team?.officerRoleId;
  if (roleId) return member.roles.cache.has(roleId);
  // Last-resort: match by role name
  return member.roles.cache.some(r => r.name.toLowerCase() === 'officer');
}

/**
 * Guard for officer-only buttons and commands.
 * Replies ephemerally on failure and returns false so handlers can early-return.
 *
 * @param {Interaction} interaction
 * @param {object|null} team    - resolved team (null = unregistered channel)
 * @param {object|null} config  - parsed Config tab
 * @returns {Promise<boolean>}  true = allowed, false = rejected
 */
export async function requireOfficer(interaction, team, config) {
  if (!team) {
    await interaction.reply({
      content: '❌ Could not resolve a team for this channel. Check env vars.',
      ephemeral: true,
    });
    return false;
  }

  if (!memberIsOfficer(interaction.member, team, config)) {
    await interaction.reply({
      content: '❌ You need the Officer role to use this.',
      ephemeral: true,
    });
    return false;
  }

  return true;
}
