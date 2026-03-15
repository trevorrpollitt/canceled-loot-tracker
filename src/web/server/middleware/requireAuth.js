/**
 * requireAuth.js — Express middleware that rejects unauthenticated requests.
 */

export function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}
