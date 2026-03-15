/**
 * server/index.js — Express entry point for the web app.
 *
 * Env vars are loaded via --env-file flag in the dev:server script,
 * ensuring they are available before any module is evaluated.
 */

import express from 'express';
import session from 'express-session';
import cors from 'cors';
import { initTeams } from '../../lib/teams.js';

import authRouter      from './routes/auth.js';
import meRouter        from './routes/me.js';
import dashboardRouter from './routes/dashboard.js';
import bisRouter       from './routes/bis.js';
import adminRouter     from './routes/admin.js';
import councilRouter   from './routes/council.js';
import lootRouter      from './routes/loot.js';
import rosterRouter    from './routes/roster.js';

const app  = express();
const PORT = process.env.WEB_PORT ?? 3001;

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(cors({
  origin:      process.env.CLIENT_URL ?? 'http://localhost:3000',
  credentials: true,
}));

app.use(express.json());

app.use(session({
  secret:            process.env.SESSION_SECRET ?? 'dev-secret-change-in-prod',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// ── Routes ─────────────────────────────────────────────────────────────────────

app.use('/api/auth',      authRouter);
app.use('/api/me',        meRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/bis',       bisRouter);
app.use('/api/admin',     adminRouter);
app.use('/api/council',   councilRouter);
app.use('/api/loot',      lootRouter);
app.use('/api/roster',    rosterRouter);

// ── Start ──────────────────────────────────────────────────────────────────────

// Load per-team config from each sheet before accepting requests.
// This populates guildId and officerRoleId so auth works on first login.
await initTeams();

app.listen(PORT, () => {
  console.log(`[WEB] Server running on http://localhost:${PORT}`);
});
