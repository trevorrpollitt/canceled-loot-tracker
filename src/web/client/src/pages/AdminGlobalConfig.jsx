import { useState, useEffect } from 'react';
import { apiPath } from '../lib/api.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a Sheets date serial (e.g. 46091) to an ISO date string (e.g. "2025-01-21").
 *  Passes through values that are already ISO strings or empty. */
function normaliseDate(value) {
  if (!value) return '';
  const num = Number(value);
  if (!isNaN(num) && num > 0 && num < 200000) {
    return new Date((num - 25569) * 86400 * 1000).toISOString().split('T')[0];
  }
  return String(value);
}

async function saveKey(key, value) {
  const r = await fetch(apiPath('/api/admin/global-config'), {
    method:      'POST',
    credentials: 'include',
    headers:     { 'Content-Type': 'application/json' },
    body:        JSON.stringify({ key, value }),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error ?? 'Save failed');
}

async function saveFields(fields) {
  try {
    await Promise.all(fields.map(([k, v]) => saveKey(k, v)));
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ResultMsg({ result }) {
  if (!result) return null;
  return (
    <p style={{ marginTop: 10, fontSize: 13, color: result.ok ? 'var(--bis)' : 'var(--danger, #e05)' }}>
      {result.ok ? 'Saved.' : `Error: ${result.error}`}
    </p>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="config-field">
      <label className="config-label">{label}</label>
      {hint && <p className="config-hint">{hint}</p>}
      {children}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminGlobalConfig() {
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  // Discord
  const [guildId,           setGuildId]           = useState('');
  const [globalOfficerRole, setGlobalOfficerRole] = useState('');
  const [discordResult,     setDiscordResult]     = useState(null);
  const [discordSaving,     setDiscordSaving]     = useState(false);

  // Season
  const [seasonStart,   setSeasonStart]   = useState('');
  const [seasonResult,  setSeasonResult]  = useState(null);
  const [seasonSaving,  setSeasonSaving]  = useState(false);

  // Curio
  const [curioItemId,   setCurioItemId]   = useState('');
  const [curioResult,   setCurioResult]   = useState(null);
  const [curioSaving,   setCurioSaving]   = useState(false);

  // WCL
  const [wclClientId,       setWclClientId]       = useState('');
  const [wclZoneIds,        setWclZoneIds]         = useState('');
  const [wclVeteranBonus,   setWclVeteranBonus]   = useState('');
  const [wclCraftedBonuses, setWclCraftedBonuses] = useState('');
  const [wclResult,         setWclResult]         = useState(null);
  const [wclSaving,         setWclSaving]         = useState(false);

  // Migration
  const [migrating,     setMigrating]     = useState(false);
  const [migrateResult, setMigrateResult] = useState(null);

  // ── Load ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch(apiPath('/api/admin/global-config'), { credentials: 'include' })
      .then(r => r.json())
      .then(({ config }) => {
        const c = config ?? {};
        setGuildId(           c.guild_id                  ?? '');
        setGlobalOfficerRole( c.global_officer_role_id    ?? '');
        setSeasonStart(       normaliseDate(c.season_start ?? ''));
        setCurioItemId(       c.curio_item_id             ?? '');
        setWclClientId(       c.wcl_client_id             ?? '');
        setWclZoneIds(        c.wcl_zone_ids              ?? '');
        setWclVeteranBonus(   c.wcl_veteran_bonus_id      ?? '');
        setWclCraftedBonuses( c.wcl_crafted_bonus_ids     ?? '');
      })
      .catch(() => setError('Failed to load global config'))
      .finally(() => setLoading(false));
  }, []);

  // ── Save handlers ───────────────────────────────────────────────────────────

  async function saveDiscord() {
    setDiscordSaving(true); setDiscordResult(null);
    setDiscordResult(await saveFields([
      ['guild_id',               guildId],
      ['global_officer_role_id', globalOfficerRole],
    ]));
    setDiscordSaving(false);
  }

  async function saveSeason() {
    setSeasonSaving(true); setSeasonResult(null);
    setSeasonResult(await saveFields([['season_start', seasonStart]]));
    setSeasonSaving(false);
  }

  async function saveCurio() {
    setCurioSaving(true); setCurioResult(null);
    setCurioResult(await saveFields([['curio_item_id', curioItemId]]));
    setCurioSaving(false);
  }

  async function saveWcl() {
    setWclSaving(true); setWclResult(null);
    setWclResult(await saveFields([
      ['wcl_client_id',         wclClientId],
      ['wcl_zone_ids',          wclZoneIds],
      ['wcl_veteran_bonus_id',  wclVeteranBonus],
      ['wcl_crafted_bonus_ids', wclCraftedBonuses],
    ]));
    setWclSaving(false);
  }

  async function runMigration() {
    if (!window.confirm(
      'This will wipe ALL data in D1 (except sentinel rows) and re-import from Google Sheets.\n\n' +
      'Run the migration?'
    )) return;
    setMigrating(true); setMigrateResult(null);
    try {
      const r = await fetch(apiPath('/api/admin/migrate-from-sheets'), {
        method: 'POST', credentials: 'include',
      });
      const d = await r.json();
      if (d.ok) {
        const teamSummary = Object.entries(d.stats ?? {})
          .filter(([k]) => k !== 'itemDb' && k !== 'defaultBis')
          .map(([team, s]) => `${team}: ${s.roster} chars, ${s.loot} loot, ${s.raids} raids`)
          .join(' | ');
        setMigrateResult({ ok: true, msg: `Done. ${teamSummary}` });
      } else {
        setMigrateResult({ error: d.error ?? 'Migration failed' });
      }
    } catch {
      setMigrateResult({ error: 'Request failed' });
    } finally {
      setMigrating(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) return <div className="loading">Loading…</div>;
  if (error)   return <div className="page-error">{error}</div>;

  return (
    <div>
      <h2 className="page-title">Global Config</h2>

      {/* ── Discord ───────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">Discord</div>
        <Field label="Discord Guild ID" hint="The server ID from Discord developer mode. Required for OAuth role checks.">
          <input className="config-input" value={guildId} onChange={e => setGuildId(e.target.value)} placeholder="e.g. 123456789012345678" />
        </Field>
        <Field label="Global Officer Role ID" hint="Optional — a guild-wide role that grants officer access across all teams.">
          <input className="config-input" value={globalOfficerRole} onChange={e => setGlobalOfficerRole(e.target.value)} placeholder="Role ID" />
        </Field>
        <button className="btn-primary" onClick={saveDiscord} disabled={discordSaving}>
          {discordSaving ? 'Saving…' : 'Save'}
        </button>
        <ResultMsg result={discordResult} />
      </div>

      {/* ── Season ────────────────────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-title">Season</div>
        <Field label="Season Start Date" hint="ISO date (YYYY-MM-DD). All raid data and WCL reports before this date are ignored.">
          <input
            className="config-input config-input-narrow"
            value={seasonStart}
            onChange={e => setSeasonStart(e.target.value)}
            placeholder="e.g. 2025-01-21"
          />
        </Field>
        <button className="btn-primary" onClick={saveSeason} disabled={seasonSaving}>
          {seasonSaving ? 'Saving…' : 'Save'}
        </button>
        <ResultMsg result={seasonResult} />
      </div>

      {/* ── Curio ────────────────────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-title">Council — Curio Item</div>
        <Field label="Curio Item ID" hint="Optional — item ID of a guild-wide special rotation item shown in the council view.">
          <input
            className="config-input config-input-narrow"
            value={curioItemId}
            onChange={e => setCurioItemId(e.target.value)}
            placeholder="e.g. 212456"
          />
        </Field>
        <button className="btn-primary" onClick={saveCurio} disabled={curioSaving}>
          {curioSaving ? 'Saving…' : 'Save'}
        </button>
        <ResultMsg result={curioResult} />
      </div>

      {/* ── WCL ───────────────────────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-title">Warcraft Logs</div>
        <Field label="WCL Client ID" hint="OAuth client ID from your WCL API application.">
          <input className="config-input" value={wclClientId} onChange={e => setWclClientId(e.target.value)} placeholder="WCL client ID" />
        </Field>
        <Field label="Zone IDs" hint="Pipe-separated WCL zone IDs for the current tier, e.g. 38|41. Fights outside these zones are excluded.">
          <input className="config-input" value={wclZoneIds} onChange={e => setWclZoneIds(e.target.value)} placeholder="e.g. 38|41" />
        </Field>
        <Field label="Veteran Track Bonus ID" hint="Starting bonus ID of the Veteran upgrade track. Each track uses 8 consecutive IDs. Update each new season.">
          <input className="config-input config-input-narrow" value={wclVeteranBonus} onChange={e => setWclVeteranBonus(e.target.value)} placeholder="e.g. 12777" />
        </Field>
        <Field label="Crafted Item Bonus IDs" hint="Pipe-separated bonus IDs that identify crafted items in WCL gear data. Update each new season.">
          <input className="config-input" value={wclCraftedBonuses} onChange={e => setWclCraftedBonuses(e.target.value)} placeholder="e.g. 9481|9513" />
        </Field>
        <button className="btn-primary" onClick={saveWcl} disabled={wclSaving}>
          {wclSaving ? 'Saving…' : 'Save'}
        </button>
        <ResultMsg result={wclResult} />
      </div>

      {/* ── Sheets → D1 Migration ────────────────────────────────────────── */}
      {false && <div className="card" style={{ marginTop: 24 }}>
        <div className="card-title">Sheets → D1 Migration</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Wipe all D1 data and re-import everything from Google Sheets. Use once when
          setting up a fresh database. Requires <code>GOOGLE_SERVICE_ACCOUNT_KEY_JSON</code> to
          be set as a Worker secret.
        </p>
        <button className="btn-danger" onClick={runMigration} disabled={migrating}>
          {migrating ? 'Migrating…' : 'Run Migration'}
        </button>
        {migrateResult && (
          <p style={{ marginTop: 12, fontSize: 13, color: migrateResult.ok ? 'var(--bis)' : 'var(--danger, #e05)' }}>
            {migrateResult.ok ? migrateResult.msg : `Error: ${migrateResult.error}`}
          </p>
        )}
      </div>}
    </div>
  );
}
