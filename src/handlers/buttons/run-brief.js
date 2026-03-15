/**
 * run-brief.js — handler for the "Run Brief" button.
 *
 * Full implementation in Phase 8.
 * Posts the pre-raid brief to the brief channel on demand.
 */

import { getTeamByChannel } from '../../lib/teams.js';
import { getConfig } from '../../lib/sheets.js';
import { requireOfficer } from '../../lib/permissions.js';

export const customId = 'run_brief';

export async function execute(interaction) {
  const team   = getTeamByChannel(interaction.channelId);
  const config = team ? await getConfig(team.sheetId) : null;
  if (!await requireOfficer(interaction, team, config)) return;

  // TODO Phase 8: post pre-raid brief (pending BIS, zero-BIS raiders, roster changes)
  await interaction.reply({
    content: '⚙️ Run Brief — coming in Phase 8.',
    ephemeral: true,
  });
}
