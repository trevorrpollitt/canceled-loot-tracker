/**
 * me.js — /api/me
 *
 * GET  /api/me
 *   Returns the current session user (safe subset — no access token).
 *   Includes the full `chars` array so the UI can render the character switcher.
 *
 * POST /api/me/active-char
 *   Body: { charName }
 *   Switches the active character within the session. The charName must belong
 *   to this Discord account (i.e. be present in session.user.chars).
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.get('/', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });

  const { id, username, avatar, teamName, charName, spec, role, status, isOfficer, chars } = req.session.user;
  res.json({ id, username, avatar, teamName, charName, spec, role, status, isOfficer, chars: chars ?? [] });
});

router.post('/active-char', requireAuth, (req, res) => {
  const { charName } = req.body;
  if (!charName) return res.status(400).json({ error: 'charName is required' });

  const { chars = [] } = req.session.user;
  const target = chars.find(c => c.charName === charName);
  if (!target) return res.status(400).json({ error: 'Character not found on this account' });

  // Update the active character fields in the session
  req.session.user.charName = target.charName;
  req.session.user.spec     = target.spec;
  req.session.user.role     = target.role;
  req.session.user.status   = target.status;

  res.json({ ok: true, charName: target.charName, spec: target.spec });
});

export default router;
