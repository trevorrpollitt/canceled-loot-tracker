import { useState, useEffect } from 'react';
import { apiPath } from '../lib/api.js';

function formatDate(ms) {
  if (!ms) return 'Never';
  return new Date(ms).toLocaleString();
}

export default function Admin() {
  const [lastCheck,       setLastCheck]       = useState(undefined);
  const [syncing,         setSyncing]         = useState(false);
  const [result,          setResult]          = useState(null); // { ok: true } | { error: string }
  const [syncingWornBis,  setSyncingWornBis]  = useState(false);
  const [wornBisResult,   setWornBisResult]   = useState(null); // { ok: true } | { error: string }
  const [resetting,       setResetting]       = useState(false);
  const [resetResult,     setResetResult]     = useState(null); // { ok: true } | { error: string }

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

  async function handleSyncWornBis() {
    setSyncingWornBis(true);
    setWornBisResult(null);
    try {
      const r = await fetch(apiPath('/api/admin/wcl-sync-worn-bis'), {
        method: 'POST', credentials: 'include',
      });
      const d = await r.json();
      setWornBisResult(d.ok ? { ok: true } : { error: d.error ?? 'Unknown error' });
    } catch {
      setWornBisResult({ error: 'Request failed' });
    } finally {
      setSyncingWornBis(false);
    }
  }

  async function handleResetWornBis() {
    if (!window.confirm('Reset all Worn BIS data for this team? This cannot be undone. The next sync will repopulate it from scratch.')) return;
    setResetting(true);
    setResetResult(null);
    try {
      const r = await fetch(apiPath('/api/admin/worn-bis'), {
        method: 'DELETE', credentials: 'include',
      });
      const d = await r.json();
      setResetResult(d.ok ? { ok: true } : { error: d.error ?? 'Unknown error' });
    } catch {
      setResetResult({ error: 'Request failed' });
    } finally {
      setResetting(false);
    }
  }

  return (
    <div>
      <h2 className="page-title">Logs</h2>

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

        <hr style={{ margin: '20px 0', borderColor: 'var(--border, #333)' }} />

        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          Resync Worn BIS only — re-parses all season reports and updates Worn BIS tracks
          without touching Raids, Encounters, or the sync cursor.
        </p>

        <button
          className="btn-secondary"
          onClick={handleSyncWornBis}
          disabled={syncingWornBis}
        >
          {syncingWornBis ? 'Resyncing…' : 'Resync Worn BIS'}
        </button>

        {wornBisResult && (
          <p style={{ marginTop: 12, fontSize: 13, color: wornBisResult.ok ? 'var(--bis)' : 'var(--danger, #e05)' }}>
            {wornBisResult.ok ? 'Worn BIS resync complete.' : `Error: ${wornBisResult.error}`}
          </p>
        )}
      </div>

      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-title">Worn BIS Reset</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Clear all Worn BIS tracking data for this team. Use at the start of a new season.
          The next WCL sync will repopulate the data from scratch.
        </p>

        <button
          className="btn-danger"
          onClick={handleResetWornBis}
          disabled={resetting}
        >
          {resetting ? 'Resetting…' : 'Reset Worn BIS Data'}
        </button>

        {resetResult && (
          <p style={{ marginTop: 12, fontSize: 13, color: resetResult.ok ? 'var(--bis)' : 'var(--danger, #e05)' }}>
            {resetResult.ok ? 'Worn BIS data cleared.' : `Error: ${resetResult.error}`}
          </p>
        )}
      </div>
    </div>
  );
}
