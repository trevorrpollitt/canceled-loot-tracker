/**
 * import-loot.js — "Import Loot" button handler.
 *
 * Flow:
 *   1. Officer clicks the Import Loot button on the Raid panel.
 *   2. Bot replies ephemerally asking them to attach a RCLC CSV in the channel.
 *   3. Bot registers a pending import for that channel (expires in 5 min).
 *   4. When the officer posts a message with a .csv attachment, the messageCreate
 *      listener in index.js calls processAttachment() from this module.
 *   5. Bot parses the CSV, deduplicates against the existing Loot Log, writes new
 *      entries to the sheet, and posts a summary embed.
 */

import { EmbedBuilder } from 'discord.js';
import { getTeamByChannel } from '../../lib/teams.js';
import {
  getConfig, getRoster, getRclcResponseMap,
  getLootLog, appendLootEntries,
} from '../../lib/sheets.js';
import { requireOfficer } from '../../lib/permissions.js';
import { parseRclcCsv, buildLootEntries, buildExistingKeys } from '../../lib/rclc.js';

export const customId = 'import_loot';

// ── Pending import state ──────────────────────────────────────────────────────
// channelId → { officerId, sheetId, timeoutHandle }

export const pendingImports = new Map();

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── Button handler ────────────────────────────────────────────────────────────

export async function execute(interaction) {
  const team   = getTeamByChannel(interaction.channelId);
  const config = team ? await getConfig(team.sheetId) : null;
  if (!await requireOfficer(interaction, team, config)) return;

  // Cancel any existing pending import for this channel
  const existing = pendingImports.get(interaction.channelId);
  if (existing) {
    clearTimeout(existing.timeoutHandle);
    pendingImports.delete(interaction.channelId);
  }

  // Register pending import
  const timeoutHandle = setTimeout(() => {
    pendingImports.delete(interaction.channelId);
  }, TIMEOUT_MS);

  pendingImports.set(interaction.channelId, {
    officerId:     interaction.user.id,
    sheetId:       team.sheetId,
    timeoutHandle,
  });

  await interaction.reply({
    content: [
      '📋 **Ready to import.** Attach your RCLC CSV export as a file in this channel.',
      '*Waiting for the next `.csv` you post — times out in 5 minutes.*',
    ].join('\n'),
    ephemeral: true,
  });
}

// ── Attachment processor ──────────────────────────────────────────────────────

/**
 * Called from the messageCreate listener in index.js.
 * Returns true if the message was consumed as a loot import, false otherwise.
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>}
 */
export async function processAttachment(message) {
  const pending = pendingImports.get(message.channelId);
  if (!pending) return false;
  if (message.author.id !== pending.officerId) return false;

  const csvAttachment = message.attachments.find(a =>
    a.name?.toLowerCase().endsWith('.csv')
  );
  if (!csvAttachment) return false;

  // Consume the pending state immediately so a second upload doesn't re-trigger
  clearTimeout(pending.timeoutHandle);
  pendingImports.delete(message.channelId);

  const working = await message.reply('⏳ Processing RCLC import…');

  try {
    // Download CSV
    const res = await fetch(csvAttachment.url);
    if (!res.ok) throw new Error(`Failed to download attachment (HTTP ${res.status}).`);
    const csvText = await res.text();

    // Parse
    const rows = parseRclcCsv(csvText);
    if (!rows.length) throw new Error('CSV appears to be empty or has no data rows.');

    // Load sheet data in parallel
    const [roster, responseMap, existingLog] = await Promise.all([
      getRoster(pending.sheetId),
      getRclcResponseMap(pending.sheetId),
      getLootLog(pending.sheetId),
    ]);

    // Build entries (dedup set is mutated in-place so within-batch dupes are also caught)
    const existingKeys = buildExistingKeys(existingLog);
    const { entries, warnings, skipped } = buildLootEntries(rows, roster, responseMap, existingKeys);

    // Write
    if (entries.length) {
      await appendLootEntries(pending.sheetId, entries);
    }

    // Result embed
    const embed = new EmbedBuilder()
      .setColor(entries.length ? 0xCC1010 : 0x1A1A1A)
      .setTitle('📦 Loot Import Complete')
      .addFields(
        { name: 'Imported',  value: String(entries.length), inline: true },
        { name: 'Skipped',   value: String(skipped),        inline: true },
        { name: 'CSV rows',  value: String(rows.length),    inline: true },
      );

    if (warnings.length) {
      const warningText = warnings.slice(0, 10).join('\n');
      embed.addFields({
        name:  `⚠️ Warnings (${warnings.length})`,
        value: warningText.slice(0, 1024),
      });
    }

    await working.edit({ content: '', embeds: [embed] });

  } catch (err) {
    console.error('[IMPORT] Error processing RCLC CSV:', err);
    await working.edit({ content: `❌ Import failed: ${err.message}` });
  }

  return true;
}
