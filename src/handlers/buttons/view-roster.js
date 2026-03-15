/**
 * view-roster.js — handler for the "View Roster" button.
 *
 * Shows the roster as an ephemeral reply.
 * One embed per role group (Tank / Healer / Melee DPS / Ranged DPS).
 * Players are sorted Active → Bench → Inactive with a coloured dot per line.
 * No officer check required.
 */

import { EmbedBuilder } from 'discord.js';
import { getTeamByChannel } from '../../lib/teams.js';
import { getRoster, getConfig } from '../../lib/sheets.js';

export const customId = 'view_roster';

const ROLE_COLOR = {
  'Tank':       0x3B82F6,
  'Healer':     0x22C55E,
  'Melee DPS':  0xCC1010,
  'Ranged DPS': 0xA855F7,
};

const ROLE_ICON = {
  'Tank':       '🛡️',
  'Healer':     '💚',
  'Melee DPS':  '⚔️',
  'Ranged DPS': '🏹',
};

const ROLE_ORDER = ['Tank', 'Healer', 'Melee DPS', 'Ranged DPS'];


// Specs that deal damage from melee range
const MELEE_SPECS = new Set([
  'Frost', 'Unholy',                          // Death Knight
  'Havoc',                                    // Demon Hunter
  'Feral',                                    // Druid
  'Augmentation',                             // Evoker (plays at melee range)
  'Survival',                                 // Hunter
  'Windwalker',                               // Monk
  'Retribution',                              // Paladin
  'Assassination', 'Outlaw', 'Subtlety',      // Rogue
  'Enhancement',                              // Shaman
  'Arms', 'Fury',                             // Warrior
]);

function dpsSubrole(spec) {
  return MELEE_SPECS.has(spec) ? 'Melee DPS' : 'Ranged DPS';
}

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const team = getTeamByChannel(interaction.channelId);
  if (!team) {
    return interaction.editReply('❌ Could not resolve a team for this channel.');
  }

  const [roster, config] = await Promise.all([
    getRoster(team.sheetId),
    getConfig(team.sheetId),
  ]);

  if (!roster.length) {
    return interaction.editReply('No characters found in the roster.');
  }

  const teamLabel = config.team_name ?? team.name;

  // Group by role, then status within each role
  const byRole = {};
  for (const char of roster) {
    const role = char.role === 'DPS' ? dpsSubrole(char.spec)
               : char.role           ? char.role
               :                       'Unknown';
    if (!byRole[role]) byRole[role] = { Active: [], Bench: [], Inactive: [] };
    const bucket = byRole[role][char.status] ?? byRole[role]['Inactive'];
    bucket.push(char);
  }

  const orderedRoles = [
    ...ROLE_ORDER.filter(r => byRole[r]),
    ...Object.keys(byRole).filter(r => !ROLE_ORDER.includes(r)),
  ];

  const totalRoster = roster.length;
  const headerEmbed = new EmbedBuilder()
    .setTitle(`${teamLabel} Roster`)
    .setDescription(`${totalRoster} characters`)
    .setColor(0x1A1A1A);

  const roleEmbeds = orderedRoles.map(role => {
    const byStatus = byRole[role];
    const total = Object.values(byStatus).reduce((n, arr) => n + arr.length, 0);

    const allChars = Object.values(byStatus).flat();
    const lines = allChars
      .sort((a, b) =>
        (a.class ?? '').localeCompare(b.class ?? '') ||
        (a.spec  ?? '').localeCompare(b.spec  ?? '') ||
        (a.ownerNick ?? a.charName).localeCompare(b.ownerNick ?? b.charName)
      )
      .map(c => {
        const label = c.ownerNick && c.ownerNick !== c.charName
          ? `${c.ownerNick} (${c.charName})`
          : c.charName;
        return `${label} — ${c.spec}`;
      });

    return new EmbedBuilder()
      .setTitle(`${ROLE_ICON[role] ?? ''}  ${role} (${total})`)
      .setColor(ROLE_COLOR[role] ?? 0x1A1A1A)
      .setDescription(lines.join('\n'));
  });

  await interaction.editReply({ embeds: [headerEmbed, ...roleEmbeds] });
}
