import { useState, useEffect } from 'react';
import { apiPath } from '../lib/api.js';

function formatDate(ms) {
  if (!ms) return 'Never';
  return new Date(ms).toLocaleString();
}

export default function Admin() {
  const [lastCheck, setLastCheck]   = useState(undefined);
  const [syncing,   setSyncing]     = useState(false);
  const [result,    setResult]      = useState(null); // { ok: true } | { error: string }

  useEffect(() => {
    fetch(apiPath('/api/admin/wcl-status'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => setLastCheck(d.lastCheck))
      .catch(() => setLastCheck(null));
  }, []);

  async function handleSync() {
    setSyncing(true);
    setResult(null);
    try {
      const r = await fetch(apiPath('/api/admin/wcl-sync'), {
        method: 'POST', credentials: 'include',
      });
      const d = await r.json();
      setResult(d.ok ? { ok: true } : { error: d.error ?? 'Unknown error' });
      if (d.ok) setLastCheck(Date.now());
    } catch {
      setResult({ error: 'Request failed' });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <h2 className="page-title">Admin</h2>

      <div className="card">
        <div className="card-title">WCL Sync</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Manually pull the latest raid reports from Warcraft Logs for this team.
          Updates Raids, Raid Encounters, and Tier Snapshot tabs.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <button
            className="btn-primary"
            onClick={handleSync}
            disabled={syncing}
          >
            {syncing ? 'Syncing…' : 'Run WCL Sync'}
          </button>

          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Last sync:{' '}
            {lastCheck === undefined
              ? '…'
              : <span style={{ color: 'var(--text)' }}>{formatDate(lastCheck)}</span>
            }
          </span>
        </div>

        {result && (
          <p style={{ marginTop: 12, fontSize: 13, color: result.ok ? 'var(--bis)' : 'var(--danger, #e05)' }}>
            {result.ok ? 'Sync complete.' : `Error: ${result.error}`}
          </p>
        )}
      </div>
    </div>
  );
}
