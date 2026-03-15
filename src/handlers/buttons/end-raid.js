/**
 * end-raid.js — handler for the "End Raid" button.
 *
 * Full implementation in Phase 6.
 */

import { getTeamByChannel } from '../../lib/teams.js';
import { getConfig } from '../../lib/sheets.js';
import { requireOfficer } from '../../lib/permissions.js';

export const customId = 'end_raid';

export async function execute(interaction) {
  const team   = getTeamByChannel(interaction.channelId);
  const config = team ? await getConfig(team.sheetId) : null;
  if (!await requireOfficer(interaction, team, config)) return;

  // TODO Phase 6: confirm end of active raid session
  await interaction.reply({
    content: '⚙️ End Raid — coming in Phase 6.',
    ephemeral: true,
  });
}
