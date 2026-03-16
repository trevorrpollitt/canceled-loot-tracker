/**
 * logger.js — simple levelled logger.
 *
 * Controlled by the LOG_LEVEL environment variable:
 *   off     — no output (default)
 *   verbose — chatty about what the app is doing (operations, flow, decisions)
 *   debug   — everything verbose does, plus full data dumps going in/out of Sheets
 *
 * Usage:
 *   import { log } from './logger.js';
 *   log.verbose('getRoster called', sheetId);
 *   log.debug('getRoster result', rows);
 *   log.error('something blew up', err);   // always on
 */

const LEVELS = { off: 0, verbose: 1, debug: 2 };

const level = LEVELS[(process.env.LOG_LEVEL ?? 'off').toLowerCase()] ?? 0;

function fmt(tag, msg, args) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  if (args.length) {
    console.log(`[${ts}] ${tag} ${msg}`, ...args);
  } else {
    console.log(`[${ts}] ${tag} ${msg}`);
  }
}

export const log = {
  /** Always printed — use for errors and warnings regardless of LOG_LEVEL. */
  error: (msg, ...args) => {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`[${ts}] [ERROR] ${msg}`, ...args);
  },

  warn: (msg, ...args) => {
    const ts = new Date().toISOString().slice(11, 23);
    console.warn(`[${ts}] [WARN]  ${msg}`, ...args);
  },

  /**
   * Verbose: chatty about operations — what's being fetched, cache hits,
   * auth token refreshes, route decisions, etc. No raw data.
   */
  verbose: (msg, ...args) => {
    if (level >= 1) fmt('[VERBOSE]', msg, args);
  },

  /**
   * Debug: everything verbose does, plus full data dumps.
   * Logs raw rows going into and coming out of Sheets API calls.
   * Can be very noisy — only enable when actively debugging data issues.
   */
  debug: (msg, ...args) => {
    if (level >= 2) fmt('[DEBUG]  ', msg, args);
  },

  /** Whether a given level is active — useful to guard expensive serialisation. */
  isVerbose: () => level >= 1,
  isDebug:   () => level >= 2,
};
