/**
 * run-wcl-sync.js — Run the WCL sync pipeline and write results to the sheet.
 *
 * Usage:
 *   node --env-file=.env scripts/run-wcl-sync.js
 *   node --env-file=.env scripts/run-wcl-sync.js --worn-bis-only
 *
 * --worn-bis-only  Re-parse reports from the last 24h and update Worn BIS only.
 *                  Does NOT advance wcl_last_check or write raids/encounters/snapshots.
 *
 * Set LOG_LEVEL=debug for full data dumps; LOG_LEVEL=off to silence everything.
 */

// Default to verbose so progress is visible when running manually.
// Must be set before dynamic import so logger.js picks it up on load.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'verbose';

const wornBisOnly = process.argv.includes('--worn-bis-only');

const { initTeams, getAllTeams } = await import('../src/lib/teams.js');
const { runWclSync, runWclSyncWornBisOnly } = await import('../src/lib/wcl-sync.js');

await initTeams();

if (wornBisOnly) {
  for (const team of getAllTeams()) {
    await runWclSyncWornBisOnly(team);
  }
} else {
  await runWclSync();
}
