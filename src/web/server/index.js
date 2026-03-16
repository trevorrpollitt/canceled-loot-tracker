/**
 * server/index.js — Hono entry point for the web app (Cloudflare Workers).
 *
 * Environment variables come from process.env, which is populated by:
 *   Local dev  → wrangler dev reads .dev.vars (or --env-file flag)
 *   Production → Cloudflare Worker secrets / env vars
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { initTeams } from '../../lib/teams.js';
import { sessionMiddleware } from './session.js';

import authRouter      from './routes/auth.js';
import meRouter        from './routes/me.js';
import dashboardRouter from './routes/dashboard.js';
import bisRouter       from './routes/bis.js';
import adminRouter     from './routes/admin.js';
import councilRouter   from './routes/council.js';
import lootRouter      from './routes/loot.js';
import rosterRouter    from './routes/roster.js';

const app = new Hono();

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use('*', cors({
  origin:      process.env.CLIENT_URL ?? 'http://localhost:3000',
  credentials: true,
}));

app.use('*', sessionMiddleware());

// ── Lazy team initialisation ───────────────────────────────────────────────────
// Workers disallow fetch() at module load time (global scope).
// We init once on the first request and cache the promise so concurrent
// requests still wait for the same initialisation rather than racing.

let _teamsReady = null;

app.use('*', async (_c, next) => {
  if (!_teamsReady) _teamsReady = initTeams();
  await _teamsReady;
  await next();
});

// ── Routes ─────────────────────────────────────────────────────────────────────

app.route('/api/auth',      authRouter);
app.route('/api/me',        meRouter);
app.route('/api/dashboard', dashboardRouter);
app.route('/api/bis',       bisRouter);
app.route('/api/admin',     adminRouter);
app.route('/api/council',   councilRouter);
app.route('/api/loot',      lootRouter);
app.route('/api/roster',    rosterRouter);

console.log('[WEB] Worker ready');

export default app;
