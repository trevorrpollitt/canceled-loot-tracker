/**
 * server/index.js — Hono entry point for the web app (Cloudflare Workers).
 *
 * Environment variables come from process.env, which is populated by:
 *   Local dev  → wrangler dev reads .dev.vars (or --env-file flag)
 *   Production → Cloudflare Worker secrets / env vars
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sessionMiddleware } from './session.js';
import { log } from '../../lib/logger.js';
import { runWclSync } from '../../lib/wcl-sync.js';

import authRouter      from './routes/auth.js';
import meRouter        from './routes/me.js';
import dashboardRouter from './routes/dashboard.js';
import bisRouter       from './routes/bis.js';
import adminRouter     from './routes/admin.js';
import councilRouter   from './routes/council.js';
import lootRouter      from './routes/loot.js';
import rosterRouter    from './routes/roster.js';

// ── Base path ──────────────────────────────────────────────────────────────────
// APP_BASE_PATH controls the URL prefix the app is mounted under.
//   Production / wrangler dev: APP_BASE_PATH=/loot  → routes match /loot/api/...
//   Local Node dev (.env):     APP_BASE_PATH=        → routes match /api/...
//
// Set APP_BASE_PATH= (empty) in your local .env to use the Vite dev server
// proxy without the /loot prefix.

const BASE_PATH = process.env.APP_BASE_PATH ?? '/loot';
const app = BASE_PATH ? new Hono().basePath(BASE_PATH) : new Hono();

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use('*', cors({
  origin:      process.env.CLIENT_URL ?? 'http://localhost:3000',
  credentials: true,
}));

app.use('*', sessionMiddleware());

app.use('*', async (c, next) => {
  log.verbose(`[web] ${c.req.method} ${c.req.path}`);
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

// ── SPA fallback ────────────────────────────────────────────────────────────
// For any non-API route (e.g. /login, /bis, /council), serve the React app.
// c.req.path returns the full URL path, so we strip BASE_PATH manually before
// looking up files in the ASSETS binding (which maps to dist/ with no prefix).
app.get('/*', async (c) => {
  log.verbose('[SPA] fallback hit for path:', c.req.path);
  if (!c.env?.ASSETS) return c.notFound(); // Node dev — no ASSETS binding

  const origin  = new URL(c.req.url).origin;
  const rawPath = c.req.path;
  const path    = BASE_PATH ? rawPath.slice(BASE_PATH.length) || '/' : rawPath;

  // Try the exact static file first (assets, index.html, etc.)
  const res = await c.env.ASSETS.fetch(new Request(`${origin}${path}`));
  if (res.ok) return res;

  // SPA fallback — serve index.html and let React Router handle the route
  return c.env.ASSETS.fetch(new Request(`${origin}/index.html`));
});

log.verbose(`[web] Worker ready — BASE_PATH="${BASE_PATH}" LOG_LEVEL="${process.env.LOG_LEVEL ?? 'off'}"`);

// ── Cloudflare Worker exports ─────────────────────────────────────────────────
// Export both fetch (HTTP handler) and scheduled (cron handler) so wrangler
// can route cron triggers to runWclSync without touching the HTTP path.

export default {
  fetch: app.fetch.bind(app),

  async scheduled(event, env, ctx) {
    log.verbose(`[cron] Scheduled trigger fired — cron="${event.cron}"`);
    await runWclSync(env.DB);
  },
};
