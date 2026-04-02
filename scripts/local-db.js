/**
 * local-db.js
 *
 * Wraps better-sqlite3 to expose the same async interface as a D1 binding,
 * so db.js functions work identically in local scripts and tests.
 */

import Database    from 'better-sqlite3';
import { readdirSync } from 'fs';

const D1_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';

export function openLocalDb() {
  const files = readdirSync(D1_DIR).filter(f => f.endsWith('.sqlite'));
  if (!files.length) throw new Error(`No SQLite file found in ${D1_DIR}. Run sync-sheets-to-d1.sh first.`);
  return wrapDb(new Database(`${D1_DIR}/${files[0]}`));
}

function wrapStmt(stmt) {
  const bound = (args) => ({
    all:   () => Promise.resolve({ results: stmt.all(...args) }),
    first: () => Promise.resolve(stmt.get(...args) ?? null),
    run:   () => Promise.resolve({ meta: stmt.run(...args) }),
  });
  return {
    bind:  (...args) => bound(args),
    all:   (...args) => Promise.resolve({ results: stmt.all(...args) }),
    first: (...args) => Promise.resolve(stmt.get(...args) ?? null),
    run:   (...args) => Promise.resolve({ meta: stmt.run(...args) }),
  };
}

function wrapDb(sqlite) {
  return {
    prepare: (sql) => wrapStmt(sqlite.prepare(sql)),
  };
}
