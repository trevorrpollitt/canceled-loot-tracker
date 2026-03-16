/**
 * requireAuth.js — Hono middleware that rejects unauthenticated requests.
 */

export async function requireAuth(c, next) {
  if (!c.get('session')?.user) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  await next();
}
