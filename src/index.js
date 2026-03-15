/**
 * index.js — bot entry point.
 *
 * Loads all commands, button handlers, and modal handlers, then logs in.
 * On ready, ensures the persistent raid console panels are posted for each team.
 */

import 'dotenv/config';
import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { readdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';
import { getAllTeams, initTeams } from './lib/teams.js';
import { ensurePanels } from './lib/panels.js';
import { getConfig } from './lib/sheets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Bot client ────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ── Loader helper ─────────────────────────────────────────────────────────────

async function loadHandlers(collection, dir, label) {
  const files = readdirSync(dir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    if (!mod.customId && !mod.data) {
      console.warn(`[WARN] ${file} missing customId/data — skipping`);
      continue;
    }
    const key = mod.customId ?? mod.data?.name;
    collection.set(key, mod);
    console.log(`[${label}] Loaded: ${key}`);
  }
}

// ── Load slash commands (just /setup) ─────────────────────────────────────────

client.commands = new Collection();
await loadHandlers(client.commands, join(__dirname, 'commands'), 'CMD');

// ── Load button handlers ──────────────────────────────────────────────────────

client.buttons = new Collection();
await loadHandlers(client.buttons, join(__dirname, 'handlers/buttons'), 'BTN');

// ── Load modal handlers ───────────────────────────────────────────────────────

client.modals = new Collection();
await loadHandlers(client.modals, join(__dirname, 'handlers/modals'), 'MDL');

// ── Interaction handler ───────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);

    } else if (interaction.isButton()) {
      const handler = client.buttons.get(interaction.customId);
      if (!handler) {
        await interaction.reply({ content: '❌ Unknown button.', ephemeral: true });
        return;
      }
      await handler.execute(interaction);

    } else if (interaction.isModalSubmit()) {
      const handler = client.modals.get(interaction.customId);
      if (!handler) {
        await interaction.reply({ content: '❌ Unknown modal.', ephemeral: true });
        return;
      }
      await handler.execute(interaction);
    }
  } catch (err) {
    console.error('[ERROR] Interaction:', err);
    const msg = { content: '❌ Something went wrong. Check the logs.', ephemeral: true };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    } catch { /* ignore secondary reply errors */ }
  }
});

// ── Ready ─────────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);
  console.log(`[BOT] Serving ${client.guilds.cache.size} guild(s)`);

  for (const team of getAllTeams()) {
    try {
      const config = await getConfig(team.sheetId);
      await ensurePanels(client, team, config);
    } catch (err) {
      console.error(`[ERROR] Failed to ensure panels for team ${team.name}:`, err);
    }
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────

// Load per-team config from each sheet before connecting to Discord.
// This populates consoleChannelId, officerRoleId, guildId, etc. so that
// button handlers and panel posting work correctly from the first interaction.
await initTeams();

client.login(process.env.DISCORD_TOKEN);
