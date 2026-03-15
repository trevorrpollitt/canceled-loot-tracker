/**
 * panels.js — builds and manages the single persistent raid console panel.
 *
 * One embed with all buttons is posted to the #raid-console channel.
 * The message ID is stored in the Config tab under `console_message_id`.
 * On startup, ensurePanels() verifies the message still exists and reposts if not.
 *
 * Layout:
 *   Row 1 — Start Raid · End Raid · Import Loot
 *   Row 2 — Open Roster →
 *   Row 3 — Pending Submissions → · Run Brief
 *   Row 4 — Open Console → · Officer Guide →
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { setConfigValue } from './sheets.js';

const PANEL_COLOR = 0x1A1A1A;
const PLACEHOLDER_URL = 'https://example.com';

// ── Panel builder ─────────────────────────────────────────────────────────────

function buildPanel(webAppUrl) {
  const embed = new EmbedBuilder()
    .setTitle('Canceled — Raid Console')
    .setColor(PANEL_COLOR);

  const rowLinks = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Open Console →')
      .setStyle(ButtonStyle.Link)
      .setURL(webAppUrl),
    new ButtonBuilder()
      .setLabel('Officer Guide →')
      .setStyle(ButtonStyle.Link)
      .setURL(`${webAppUrl}/guide`),
  );

  const rowNavLinks = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Edit Roster →')
      .setStyle(ButtonStyle.Link)
      .setURL(`${webAppUrl}/roster`),
    new ButtonBuilder()
      .setLabel('Pending Submissions →')
      .setStyle(ButtonStyle.Link)
      .setURL(`${webAppUrl}/bis/review`),
  );

  const rowSeparator = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('_separator')
      .setLabel('── Officer Commands ──')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

  const rowRaid = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('start_raid')
      .setLabel('Start Raid')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('end_raid')
      .setLabel('End Raid')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('import_loot')
      .setLabel('Import Loot')
      .setStyle(ButtonStyle.Secondary),
  );

  const rowRoster = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('view_roster')
      .setLabel('View Roster')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('run_brief')
      .setLabel('Run Brief')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [rowLinks, rowNavLinks, rowSeparator, rowRaid, rowRoster] };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Post the console panel and save its message ID to the Config tab.
 * Called by /setup and by ensurePanels when the message is missing.
 *
 * @param {TextChannel} channel
 * @param {object}      team    - team object from teams.js
 * @param {object}      config  - parsed Config tab from getConfig()
 * @returns {string}  the posted message ID
 */
export async function postAllPanels(channel, team, config) {
  const webAppUrl = config.web_app_url || PLACEHOLDER_URL;
  const msg = await channel.send(buildPanel(webAppUrl));
  await setConfigValue(team.sheetId, 'console_message_id', msg.id);
  console.log(`[PANELS] Posted console panel for team ${team.name} (${msg.id})`);
  return msg.id;
}

/**
 * Verify the console panel message still exists. Reposts if missing.
 * Called automatically on bot startup for each team.
 *
 * @param {Client}  client
 * @param {object}  team
 * @param {object}  config
 */
export async function ensurePanels(client, team, config) {
  if (!team.consoleChannelId) {
    console.warn(`[PANELS] No console channel configured for team ${team.name} — skipping`);
    return;
  }

  const channel = await client.channels.fetch(team.consoleChannelId).catch(() => null);
  if (!channel) {
    console.warn(`[PANELS] Console channel ${team.consoleChannelId} not found for team ${team.name}`);
    return;
  }

  const messageId = config.console_message_id;
  if (messageId) {
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) {
      console.log(`[PANELS] Console panel present for team ${team.name}`);
      return;
    }
    console.log(`[PANELS] Console panel was deleted for team ${team.name} — reposting`);
  } else {
    console.log(`[PANELS] No console panel ID stored for team ${team.name} — posting`);
  }

  await postAllPanels(channel, team, config);
}
