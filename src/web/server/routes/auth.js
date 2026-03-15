/**
 * auth.js — Discord OAuth2 routes.
 *
 * GET /api/auth/login    → redirect to Discord OAuth consent screen
 * GET /api/auth/callback → exchange code, resolve team + role, set session
 * GET /api/auth/logout   → destroy session and redirect to /login
 */

import { Router } from 'express';
import { getAllTeams } from '../../../lib/teams.js';
import { getRoster } from '../../../lib/sheets.js';

const router       = Router();
const DISCORD_API  = 'https://discord.com/api/v10';

function redirectUri() {
  return process.env.DISCORD_REDIRECT_URI ?? 'http://localhost:3000/api/auth/callback';
}

// ── Login ──────────────────────────────────────────────────────────────────────

router.get('/login', (_req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  redirectUri(),
    response_type: 'code',
    scope:         'identify',
  });
  res.redirect(`${DISCORD_API}/oauth2/authorize?${params}`);
});

// ── Callback ───────────────────────────────────────────────────────────────────

router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/login?error=no_code');

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
    console.log(`[AUTH] Discord user: id=${discordUser.id} username=${discordUser.username}`);

    // 3. Check officer role via guild member (uses bot token)
    let guildRoles = [];
    const guildId = process.env.DISCORD_GUILD_ID;
    if (guildId) {
      const memberRes = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${discordUser.id}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
      });
      if (memberRes.ok) {
        const member = await memberRes.json();
        guildRoles = member.roles ?? [];
      }
    }

    // 4. Resolve team and ALL characters for this Discord user from roster
    let resolvedTeam  = null;
    let resolvedChars = [];
    for (const team of getAllTeams()) {
      const roster = await getRoster(team.sheetId);
      console.log(`[AUTH] Roster for team ${team.name}: ${roster.map(c => `${c.charName}(${c.ownerId})`).join(', ')}`);
      const chars  = roster.filter(c => c.ownerId === discordUser.id);
      if (chars.length) {
        resolvedTeam  = team;
        resolvedChars = chars;
        break;
      }
    }

    // Active character defaults to the first one found
    const activeChar = resolvedChars[0] ?? null;

    // 5. Determine officer status
    const officerRoleId = resolvedTeam?.officerRoleId;
    const isOfficer     = officerRoleId ? guildRoles.includes(officerRoleId) : false;

    // 6. Store session — chars holds the full list for the account switcher
    req.session.user = {
      id:          discordUser.id,
      username:    discordUser.username,
      avatar:      discordUser.avatar,
      teamName:    resolvedTeam?.name    ?? null,
      teamSheetId: resolvedTeam?.sheetId ?? null,
      charName:    activeChar?.charName  ?? null,
      spec:        activeChar?.spec      ?? null,
      role:        activeChar?.role      ?? null,
      status:      activeChar?.status    ?? null,
      isOfficer,
      // Full list so the UI can render the character switcher
      chars: resolvedChars.map(c => ({
        charName: c.charName,
        spec:     c.spec,
        role:     c.role,
        status:   c.status,
      })),
    };

    res.redirect('/');
  } catch (err) {
    console.error('[AUTH] OAuth error:', err);
    res.redirect('/login?error=auth_failed');
  }
});

// ── Logout ─────────────────────────────────────────────────────────────────────

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

export default router;
