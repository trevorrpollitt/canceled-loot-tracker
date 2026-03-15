/**
 * loot-import.js — modal submit handler for the loot import flow.
 *
 * Full implementation in Phase 5.
 */

export const customId = 'loot_import';

export async function execute(interaction) {
  // TODO Phase 5: parse submitted CSV content and write to Loot Log
  await interaction.reply({
    content: '⚙️ Loot import — coming in Phase 5.',
    ephemeral: true,
  });
}
