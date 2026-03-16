import { useState, useEffect } from 'react';
import { apiPath } from '../lib/api.js';

let cache     = null; // module-level cache so multiple consumers don't re-fetch
let listeners = [];   // callbacks registered by mounted useMe() consumers

function notify(data) {
  cache = data;
  listeners.forEach(fn => fn(data));
}

export function useMe() {
  const [user, setUser]       = useState(cache);
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    // Register this component as a listener so refreshMe() can push updates
    listeners.push(setUser);
    return () => { listeners = listeners.filter(fn => fn !== setUser); };
  }, []);

  useEffect(() => {
    if (cache !== null) return;
    fetch(apiPath('/api/me'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        notify(data);
        setLoading(false);
      })
      .catch(() => {
        cache = null;
        setLoading(false);
      });
  }, []);

  return { user, loading };
}

export function clearMeCache() {
  cache = null;
}

/**
 * Re-fetch /api/me and push the updated user to all mounted useMe() consumers.
 * Call this after switching active character so the header reflects the change.
 */
export async function refreshMe() {
  cache = null;
  try {
    const res  = await fetch(apiPath('/api/me'), { credentials: 'include' });
    const data = res.ok ? await res.json() : null;
    notify(data);
    return data;
  } catch {
    return null;
  }
}
