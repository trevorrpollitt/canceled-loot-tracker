/**
 * auth.js — Discord OAuth2 routes.
 *
 * GET /api/auth/login    → redirect to Discord OAuth consent screen
 * GET /api/auth/callback → exchange code, resolve team + role, set session
 * GET /api/auth/logout   → clear session and redirect to /login
 */

import { Hono } from 'hono';
import { getAllTeams } from '../../../lib/teams.js';
import { getRoster, getGlobalConfig } from '../../../lib/sheets.js';
import { log } from '../../../lib/logger.js';

const router      = new Hono();
const DISCORD_API = 'https://discord.com/api/v10';

// Base path for server-side redirects — must match APP_BASE_PATH in index.js.
// E.g. '/loot' in production, '' locally.
const BASE = (process.env.APP_BASE_PATH ?? '/loot').replace(/\/$/, '');

function redirectUri() {
  return process.env.DISCORD_REDIRECT_URI ?? 'http://localhost:3000/api/auth/callback';
}

// ── Login ──────────────────────────────────────────────────────────────────────

router.get('/login', (c) => {
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  redirectUri(),
    response_type: 'code',
    scope:         'identify',
  });
  return c.redirect(`${DISCORD_API}/oauth2/authorize?${params}`);
});

// ── Callback ───────────────────────────────────────────────────────────────────

router.get('/callback', async (c) => {
  const code = c.req.query('code');
  if (!code) return c.redirect(`${BASE}/login?error=no_code`);

  try {
    // 1. Exchange code for access token
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri(),
      }),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();

    // 2. Fetch Discord user identity
    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!userRes.ok) throw new Error(`Discord user fetch failed: ${userRes.status}`);
    const discordUser = await userRes.json();
    log.verbose(`[auth] Discord user: id=${discordUser.id} username=${discordUser.username}`);

    // 3. Find ALL teams this Discord user belongs to (no early exit)
    const userTeams = [];
    for (const team of getAllTeams()) {
      const roster = await getRoster(team.sheetId);
      const chars = roster.filter(ch => ch.ownerId === discordUser.id);
      if (chars.length) userTeams.push({ team, chars });
    }

    // 4. Fetch guild roles once — used to check officer status across all teams.
    //    guild_id and global_officer_role_id come from the master sheet Global Config.
    let guildRoles         = [];
    let globalOfficerRoles = [];
    try {
      const globalConfig = await getGlobalConfig();
      const guildId      = globalConfig.guild_id || null;
      globalOfficerRoles = (globalConfig.global_officer_role_id || '')
        .split('|').map(s => s.trim()).filter(Boolean);
      if (guildId) {
        log.verbose(`[auth] fetching guild member guildId=${guildId} userId=${discordUser.id} botTokenPrefix=${process.env.DISCORD_TOKEN?.slice(0, 10)}…`);
        const memberRes = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${discordUser.id}`, {
          headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
        });
        if (memberRes.ok) {
          const member = await memberRes.json();
          guildRoles = member.roles ?? [];
          log.verbose(`[auth] guild roles for ${discordUser.username}: [${guildRoles.join(', ')}]`);
        } else {
          log.warn(`[auth] guild member fetch failed: ${memberRes.status} for user ${discordUser.id}`);
        }
      }
    } catch (err) {
      log.warn('[auth] Could not fetch guild roles:', err.message);
    }

    // 5. Build the teams array with per-team officer status.
    //    officerRoleId is already loaded into the in-memory team object by initTeams().
    const teams = userTeams.map(({ team, chars }) => ({
      teamName:    team.name,
      teamSheetId: team.sheetId,
      isOfficer:   team.officerRoleIds.some(id => guildRoles.includes(id)),
      chars:       chars.map(ch => ({ charName: ch.charName, spec: ch.spec, role: ch.role, status: ch.status })),
    }));

    // 6. Active team defaults to first match; active character to first char in that team.
    const activeTeam = teams[0] ?? null;
    const activeChar = activeTeam?.chars[0] ?? null;

    for (const t of teams) {
      log.verbose(`[auth]   team=${t.teamName} isOfficer=${t.isOfficer} chars=[${t.chars.map(ch => ch.charName).join(', ')}]`);
    }
    const isGlobalOfficer = globalOfficerRoles.some(id => guildRoles.includes(id));
    log.verbose(`[auth] resolved → char=${activeChar?.charName ?? 'none'} spec=${activeChar?.spec ?? 'none'} isOfficer=${activeTeam?.isOfficer ?? false} isGlobalOfficer=${isGlobalOfficer} teams=${teams.length}`);

    // 7. Store session
    c.get('session').user = {
      id:          discordUser.id,
      username:    discordUser.username,
      avatar:      discordUser.avatar,
      teamName:    activeTeam?.teamName    ?? null,
      teamSheetId: activeTeam?.teamSheetId ?? null,
      charName:    activeChar?.charName    ?? null,
      spec:        activeChar?.spec        ?? null,
      role:        activeChar?.role        ?? null,
      status:      activeChar?.status      ?? null,
      isOfficer:       activeTeam?.isOfficer ?? false,
      isGlobalOfficer: isGlobalOfficer,
      chars:           activeTeam?.chars    ?? [],
      teams,
    };

    return c.redirect(`${BASE}/`);
  } catch (err) {
    log.error('[auth] OAuth error:', err);
    return c.redirect(`${BASE}/login?error=auth_failed`);
  }
});

// ── Logout ─────────────────────────────────────────────────────────────────────

router.get('/logout', (c) => {
  c.get('session').destroy();
  return c.redirect(`${BASE}/login`);
});

export default router;
