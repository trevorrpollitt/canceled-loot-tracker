/**
 * run-wcl-sync.js — Run the WCL sync pipeline and write results to the sheet.
 *
 * Usage:
 *   node --env-file=.env scripts/run-wcl-sync.js
 *
 * Set LOG_LEVEL=debug for full data dumps; LOG_LEVEL=off to silence everything.
 */

// Default to verbose so progress is visible when running manually.
// Must be set before dynamic import so logger.js picks it up on load.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'verbose';

const { initTeams } = await import('../src/lib/teams.js');
const { runWclSync } = await import('../src/lib/wcl-sync.js');

await initTeams();
await runWclSync();
