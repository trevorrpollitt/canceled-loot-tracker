/**
 * node.js — Node.js entry point for local development.
 *
 * Uses @hono/node-server to run the Hono app on a local port.
 * Not used in production — wrangler.toml points to index.js directly.
 *
 * Handles GOOGLE_SERVICE_ACCOUNT_KEY_PATH → KEY_JSON injection so that
 * sheets.js doesn't need Node.js filesystem APIs (which don't exist in Workers).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';

// Inject key file into env before app loads (so sheets.js can read KEY_JSON)
if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH
    ?? resolve(__dirname, '../../../config/service-account.json');
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON = readFileSync(keyPath, 'utf8');
}

const { default: app } = await import('./index.js');

const PORT = Number(process.env.WEB_PORT ?? 3001);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[WEB] Server running on http://localhost:${PORT}`);
});
