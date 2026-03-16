/**
 * session.js — Cookie-based session middleware for Hono.
 *
 * Sessions are stored client-side in a signed cookie using HMAC-SHA256.
 * Web Crypto is used throughout — compatible with Cloudflare Workers runtime.
 *
 * Usage:
 *   app.use('*', sessionMiddleware());
 *   // In a handler:
 *   c.get('session').user       // read
 *   c.get('session').user = {}  // write (marks cookie dirty)
 *   c.get('session').destroy()  // clear cookie on next response
 */

const COOKIE_NAME = 'session';
const MAX_AGE     = 7 * 24 * 60 * 60; // 7 days in seconds

async function getKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signCookie(payload, secret) {
  const key     = await getKey(secret);
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  const sigBuf  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded));
  const sig     = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return `${encoded}.${sig}`;
}

async function verifyCookie(value, secret) {
  const dot = value.lastIndexOf('.');
  if (dot === -1) return null;
  const encoded = value.slice(0, dot);
  const sig     = value.slice(dot + 1);
  try {
    const key    = await getKey(secret);
    const sigBuf = Uint8Array.from(atob(sig), ch => ch.charCodeAt(0));
    const valid  = await crypto.subtle.verify('HMAC', key, sigBuf, new TextEncoder().encode(encoded));
    if (!valid) return null;
    return JSON.parse(decodeURIComponent(escape(atob(encoded))));
  } catch {
    return null;
  }
}

function parseCookieHeader(header) {
  const cookies = {};
  for (const part of (header ?? '').split(';')) {
    const [k, ...vs] = part.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(vs.join('='));
  }
  return cookies;
}

// Proxy that marks the session dirty whenever any property on user is set directly.
function makeUserProxy(user, onMutate) {
  return new Proxy(user, {
    set(target, prop, value) {
      target[prop] = value;
      onMutate();
      return true;
    },
  });
}

export function sessionMiddleware() {
  return async (c, next) => {
    const secret  = process.env.SESSION_SECRET ?? 'dev-secret-change-in-prod';
    const cookies = parseCookieHeader(c.req.header('cookie'));
    const raw     = cookies[COOKIE_NAME];
    const stored  = raw ? await verifyCookie(raw, secret) : null;

    let dirty     = false;
    let destroyed = false;
    const markDirty = () => { dirty = true; };

    let userData = stored?.user
      ? makeUserProxy({ ...stored.user }, markDirty)
      : null;

    const session = {
      get user()  { return userData; },
      set user(v) {
        userData = v ? makeUserProxy({ ...v }, markDirty) : null;
        dirty    = true;
      },
      destroy() {
        userData  = null;
        dirty     = true;
        destroyed = true;
      },
    };

    c.set('session', session);
    await next();

    if (!dirty) return;

    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    if (destroyed) {
      c.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax${secure}`);
    } else {
      const signed = await signCookie({ user: userData }, secret);
      c.header('Set-Cookie', `${COOKIE_NAME}=${signed}; Path=/; HttpOnly; Max-Age=${MAX_AGE}; SameSite=Lax${secure}`);
    }
  };
}
