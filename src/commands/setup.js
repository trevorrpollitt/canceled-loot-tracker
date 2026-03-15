/**
 * setup.js — /setup command.
 *
 * Posts or reposts all four raid console panels in the current channel.
 * This is the only slash command in the bot — everything else is button-driven.
 *
 * Must be run from the team's configured console channel by an officer.
 * Stores panel message IDs in the Config tab so they survive restarts.
 */

import { SlashCommandBuilder } from 'discord.js';
import { getTeamByChannel } from '../lib/teams.js';
import { getConfig } from '../lib/sheets.js';
import { memberIsOfficer } from '../lib/permissions.js';
import { postAllPanels } from '../lib/panels.js';

export const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Post the raid console panels in this channel. Run once per team. Officers only.');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const team = getTeamByChannel(interaction.channelId);
  if (!team) {
    return interaction.editReply('❌ Run /setup from a registered console channel (`TEAM_<NAME>_CONSOLE_CHANNEL`).');
  }

  const config = await getConfig(team.sheetId);

  if (!memberIsOfficer(interaction.member, team, config)) {
    return interaction.editReply('❌ You need the Officer role to run /setup.');
  }

  await postAllPanels(interaction.channel, team, config);
  await interaction.editReply('✅ Console panels posted.');
}
