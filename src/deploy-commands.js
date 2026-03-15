/**
 * deploy-commands.js
 *
 * Registers slash commands with Discord. Run this once after any command
 * definition change:
 *
 *   node src/deploy-commands.js
 *
 * Only /setup exists — all other interactions are button/modal driven.
 * Set DISCORD_GUILD_ID in .env for instant guild-scoped registration during dev.
 * Omit it for global registration (up to 1 hour to propagate).
 */

import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { readdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const commands = [];

const files = readdirSync(join(__dirname, 'commands')).filter(f => f.endsWith('.js'));
for (const file of files) {
  const mod = await import(pathToFileURL(join(__dirname, 'commands', file)).href);
  if (mod.data) commands.push(mod.data.toJSON());
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId  = process.env.DISCORD_GUILD_ID;

try {
  console.log(`Registering ${commands.length} command(s)…`);

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`✓ Registered to guild ${guildId} (instant)`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✓ Registered globally (may take up to 1 hour)');
  }
} catch (err) {
  console.error(err);
}
