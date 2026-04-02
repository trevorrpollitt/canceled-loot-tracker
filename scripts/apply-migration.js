/**
 * apply-migration.js
 *
 * Applies migration-output.sql directly to the local D1 SQLite file,
 * bypassing wrangler for reliable bulk loading.
 *
 * Usage:
 *   node scripts/apply-migration.js
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';

const D1_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const files  = readdirSync(D1_DIR).filter(f => f.endsWith('.sqlite')).map(f => `${D1_DIR}/${f}`);

if (!files.length) {
  console.error(`No SQLite file found in ${D1_DIR}`);
  console.error('Run: npx wrangler d1 execute canceled-loot-tracker --local --command "SELECT 1"');
  process.exit(1);
}

const dbPath = files[0];
console.log(`DB: ${dbPath}`);

const sql = readFileSync('migration-output.sql', 'utf8');
const db  = new Database(dbPath);

console.log('Applying migration…');
db.exec(sql);
console.log('Done.');
