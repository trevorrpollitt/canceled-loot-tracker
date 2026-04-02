/**
 * me.js — /api/me
 *
 * GET  /api/me
 *   Returns the current session user (safe subset — no access token).
 *
 * POST /api/me/active-char
 *   Body: { charName }
 *   Switches the active character within the current team.
 *
 * POST /api/me/active-team
 *   Body: { teamName }
 *   Switches the active team. Updates all active team/char session fields.
 *   Officer status is pre-computed per team at login — no re-fetch needed.
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';

const router = new Hono();

router.get('/', (c) => {
  const session = c.get('session');
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401);

  const {
    id, username, avatar,
    teamName, charId, charName, spec, role, status, isOfficer, isGlobalOfficer,
    chars, teams,
  } = session.user;
  return c.json({ id, username, avatar, teamName, charId, charName, spec, role, status, isOfficer, isGlobalOfficer: isGlobalOfficer ?? false, chars: chars ?? [], teams: teams ?? [] });
});

router.post('/active-char', requireAuth, async (c) => {
  const { charName } = await c.req.json();
  if (!charName) return c.json({ error: 'charName is required' }, 400);

  const session     = c.get('session');
  const { chars = [] } = session.user;
  const target = chars.find(ch => ch.charName.toLowerCase() === charName.toLowerCase());
  if (!target) return c.json({ error: 'Character not found on this account' }, 400);

  session.user.charId   = target.charId;
  session.user.charName = target.charName;
  session.user.spec     = target.spec;
  session.user.role     = target.role;
  session.user.status   = target.status;

  return c.json({ ok: true, charId: target.charId, charName: target.charName, spec: target.spec });
});

router.post('/active-team', requireAuth, async (c) => {
  const { teamName } = await c.req.json();
  if (!teamName) return c.json({ error: 'teamName is required' }, 400);

  const session      = c.get('session');
  const { teams = [] } = session.user;
  const target = teams.find(t => t.teamName === teamName);
  if (!target) return c.json({ error: 'Team not found for this account' }, 400);

  const activeChar = target.chars[0] ?? null;

  session.user.teamName  = target.teamName;
  session.user.teamId    = target.teamId;
  session.user.isOfficer = target.isOfficer;
  session.user.chars       = target.chars;
  session.user.charId      = activeChar?.charId   ?? null;
  session.user.charName    = activeChar?.charName ?? null;
  session.user.spec        = activeChar?.spec     ?? null;
  session.user.role        = activeChar?.role     ?? null;
  session.user.status      = activeChar?.status   ?? null;

  return c.json({ ok: true, teamName: target.teamName });
});

export default router;
