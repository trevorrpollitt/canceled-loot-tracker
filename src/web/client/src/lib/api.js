/**
 * api.js — base-path-aware API URL helper.
 *
 * Vite sets import.meta.env.BASE_URL from vite.config.js `base`:
 *   dev build  (base: '/')       → BASE_URL = '/'       → apiPath('/api/me') = '/api/me'
 *   prod build (base: '/loot/')  → BASE_URL = '/loot/'  → apiPath('/api/me') = '/loot/api/me'
 *
 * Use apiPath() everywhere instead of bare '/api/...' strings so the client
 * works correctly whether served from the root or a subdirectory.
 */

const BASE = import.meta.env.BASE_URL.replace(/\/$/, ''); // '/loot' or ''

export const apiPath = (path) => `${BASE}${path}`;
