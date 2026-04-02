import { useState, useEffect } from 'react';
import { apiPath } from '../lib/api.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** POST a single key/value to /api/admin/team-config. Returns true on success. */
async function saveKey(key, value) {
  const r = await fetch(apiPath('/api/admin/team-config'), {
    method:      'POST',
    credentials: 'include',
    headers:     { 'Content-Type': 'application/json' },
    body:        JSON.stringify({ key, value }),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error ?? 'Save failed');
}

/** Save multiple key/value pairs, returning a result object. */
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

export default function AdminTeamConfig() {
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  // Raid Settings
  const [raidInstance,  setRaidInstance]  = useState('');
  const [difficulty,    setDifficulty]    = useState('Mythic');
  const [raidResult,    setRaidResult]    = useState(null);
  const [raidSaving,    setRaidSaving]    = useState(false);

  // Council Settings
  const [tierPriority,    setTierPriority]    = useState('bonus-first');
  const [heroicWeight,    setHeroicWeight]    = useState('0.2');
  const [normalWeight,    setNormalWeight]    = useState('0');
  const [nonBisWeight,    setNonBisWeight]    = useState('0.333');
  const [councilResult,   setCouncilResult]   = useState(null);
  const [councilSaving,   setCouncilSaving]   = useState(false);

  // Discord
  const [consoleChannel, setConsoleChannel] = useState('');
  const [briefChannel,   setBriefChannel]   = useState('');
  const [officerRoleId,  setOfficerRoleId]  = useState('');
  const [teamRoleId,     setTeamRoleId]     = useState('');
  const [discordResult,  setDiscordResult]  = useState(null);
  const [discordSaving,  setDiscordSaving]  = useState(false);

  // WCL
  const [wclGuildId,  setWclGuildId]  = useState('');
  const [wclResult,   setWclResult]   = useState(null);
  const [wclSaving,   setWclSaving]   = useState(false);

  // RCLC Map
  const [rclcRows,    setRclcRows]    = useState([]); // [{ button, internalType, counted }]
  const [rclcResult,  setRclcResult]  = useState(null);
  const [rclcSaving,  setRclcSaving]  = useState(false);

  // ── Load ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    Promise.all([
      fetch(apiPath('/api/admin/team-config'),  { credentials: 'include' }).then(r => r.json()),
      fetch(apiPath('/api/admin/rclc-map'),     { credentials: 'include' }).then(r => r.json()),
    ]).then(([{ config }, { entries }]) => {
      const c = config ?? {};
      setRaidInstance(c.raid_instance         ?? '');
      setDifficulty(  c.current_difficulty    ?? 'Mythic');
      setTierPriority(c.tier_distribution_priority ?? 'bonus-first');
      setHeroicWeight(c.council_heroic_weight  ?? '0.2');
      setNormalWeight(c.council_normal_weight  ?? '0');
      setNonBisWeight(c.council_nonbis_weight  ?? '0.333');
      setConsoleChannel(c.console_channel_id  ?? '');
      setBriefChannel(  c.brief_channel_id    ?? '');
      setOfficerRoleId( c.officer_role_id     ?? '');
      setTeamRoleId(    c.team_role_id        ?? '');
      setWclGuildId(    c.wcl_guild_id        ?? '');

      setRclcRows((entries ?? []).map(e => ({
        button:       e.rclc_button,
        internalType: e.internal_type,
        counted:      e.counted_in_totals === 1,
      })));
    }).catch(() => {
      setError('Failed to load config');
    }).finally(() => setLoading(false));
  }, []);

  // ── Save handlers ───────────────────────────────────────────────────────────

  async function saveRaid() {
    setRaidSaving(true); setRaidResult(null);
    setRaidResult(await saveFields([
      ['raid_instance',      raidInstance],
      ['current_difficulty', difficulty],
    ]));
    setRaidSaving(false);
  }

  async function saveCouncil() {
    setCouncilSaving(true); setCouncilResult(null);
    setCouncilResult(await saveFields([
      ['tier_distribution_priority', tierPriority],
      ['council_heroic_weight',      heroicWeight],
      ['council_normal_weight',      normalWeight],
      ['council_nonbis_weight',      nonBisWeight],
    ]));
    setCouncilSaving(false);
  }

  async function saveDiscord() {
    setDiscordSaving(true); setDiscordResult(null);
    setDiscordResult(await saveFields([
      ['console_channel_id', consoleChannel],
      ['brief_channel_id',   briefChannel],
      ['officer_role_id',    officerRoleId],
      ['team_role_id',       teamRoleId],
    ]));
    setDiscordSaving(false);
  }

  async function saveWcl() {
    setWclSaving(true); setWclResult(null);
    setWclResult(await saveFields([['wcl_guild_id', wclGuildId]]));
    setWclSaving(false);
  }

  async function saveRclc() {
    setRclcSaving(true); setRclcResult(null);
    try {
      const r = await fetch(apiPath('/api/admin/rclc-map'), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ entries: rclcRows }),
      });
      const d = await r.json();
      setRclcResult(d.ok ? { ok: true } : { error: d.error ?? 'Save failed' });
    } catch {
      setRclcResult({ error: 'Request failed' });
    }
    setRclcSaving(false);
  }

  function addRclcRow() {
    setRclcRows(prev => [...prev, { button: '', internalType: 'Non-BIS', counted: true }]);
  }

  function updateRclcRow(i, field, value) {
    setRclcRows(prev => prev.map((row, idx) => idx === i ? { ...row, [field]: value } : row));
  }

  function removeRclcRow(i) {
    setRclcRows(prev => prev.filter((_, idx) => idx !== i));
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) return <div className="loading">Loading…</div>;
  if (error)   return <div className="page-error">{error}</div>;

  return (
    <div>
      <h2 className="page-title">Team Config</h2>

      {/* ── Raid Settings ─────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">Raid Settings</div>
        <Field label="Current Raid Instance">
          <input
            className="config-input"
            value={raidInstance}
            onChange={e => setRaidInstance(e.target.value)}
            placeholder="e.g. Liberation of Undermine"
          />
        </Field>
        <Field label="Default Difficulty">
          <select className="config-select" value={difficulty} onChange={e => setDifficulty(e.target.value)}>
            <option>Normal</option>
            <option>Heroic</option>
            <option>Mythic</option>
          </select>
        </Field>
        <button className="btn-primary" onClick={saveRaid} disabled={raidSaving}>
          {raidSaving ? 'Saving…' : 'Save'}
        </button>
        <ResultMsg result={raidResult} />
      </div>

      {/* ── Council Settings ──────────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-title">Council Settings</div>
        <Field label="Tier Distribution Priority">
          <select className="config-select" value={tierPriority} onChange={e => setTierPriority(e.target.value)}>
            <option value="bonus-first">Bonus First (push toward 2-set and 4-set)</option>
            <option value="four-first">Four First (prioritise 4-set completions)</option>
            <option value="two-first">Two First (prioritise 2-set completions)</option>
            <option value="even">Even (spread tier pieces)</option>
          </select>
        </Field>
        <Field label="Heroic Loot Weight" hint="How much a Heroic drop counts relative to Mythic (0–1). Default: 0.2">
          <input
            className="config-input config-input-narrow"
            type="number" step="0.01" min="0" max="1"
            value={heroicWeight}
            onChange={e => setHeroicWeight(e.target.value)}
          />
        </Field>
        <Field label="Normal Loot Weight" hint="How much a Normal drop counts relative to Mythic (0–1). Default: 0 (not counted)">
          <input
            className="config-input config-input-narrow"
            type="number" step="0.01" min="0" max="1"
            value={normalWeight}
            onChange={e => setNormalWeight(e.target.value)}
          />
        </Field>
        <Field label="Non-BIS Loot Weight" hint="How much a Non-BIS drop counts relative to BIS (0–1). Default: 0.333">
          <input
            className="config-input config-input-narrow"
            type="number" step="0.01" min="0" max="1"
            value={nonBisWeight}
            onChange={e => setNonBisWeight(e.target.value)}
          />
        </Field>
        <button className="btn-primary" onClick={saveCouncil} disabled={councilSaving}>
          {councilSaving ? 'Saving…' : 'Save'}
        </button>
        <ResultMsg result={councilResult} />
      </div>

      {/* ── Discord Integration ───────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-title">Discord Integration</div>
        <Field label="Raid Console Channel ID">
          <input className="config-input" value={consoleChannel} onChange={e => setConsoleChannel(e.target.value)} placeholder="Channel ID" />
        </Field>
        <Field label="Pre-Raid Brief Channel ID">
          <input className="config-input" value={briefChannel} onChange={e => setBriefChannel(e.target.value)} placeholder="Channel ID" />
        </Field>
        <Field label="Officer Role ID(s)" hint="Pipe-separated for multiple roles, e.g. 123|456">
          <input className="config-input" value={officerRoleId} onChange={e => setOfficerRoleId(e.target.value)} placeholder="Role ID(s)" />
        </Field>
        <Field label="Team Member Role ID(s)" hint="Pipe-separated for multiple roles, e.g. 123|456">
          <input className="config-input" value={teamRoleId} onChange={e => setTeamRoleId(e.target.value)} placeholder="Role ID(s)" />
        </Field>
        <button className="btn-primary" onClick={saveDiscord} disabled={discordSaving}>
          {discordSaving ? 'Saving…' : 'Save'}
        </button>
        <ResultMsg result={discordResult} />
      </div>

      {/* ── WCL Integration ───────────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-title">WCL Integration</div>
        <Field label="WCL Guild / Team ID" hint="The numeric WCL guild ID for this raid team. Found in the WCL guild URL.">
          <input className="config-input" value={wclGuildId} onChange={e => setWclGuildId(e.target.value)} placeholder="e.g. 787359" />
        </Field>
        <button className="btn-primary" onClick={saveWcl} disabled={wclSaving}>
          {wclSaving ? 'Saving…' : 'Save'}
        </button>
        <ResultMsg result={wclResult} />
      </div>

      {/* ── RCLC Response Map ─────────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-title">RCLC Response Map</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Maps RCLootCouncil button labels to internal upgrade types. Unlisted buttons default to Non-BIS.
        </p>
        <table className="config-rclc-table">
          <thead>
            <tr>
              <th>Button Label</th>
              <th>Upgrade Type</th>
              <th>Counted in Totals</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rclcRows.map((row, i) => (
              <tr key={i}>
                <td>
                  <input
                    className="config-input"
                    value={row.button}
                    onChange={e => updateRclcRow(i, 'button', e.target.value)}
                    placeholder="Button label"
                  />
                </td>
                <td>
                  <select
                    className="config-select"
                    value={row.internalType}
                    onChange={e => updateRclcRow(i, 'internalType', e.target.value)}
                  >
                    <option value="BIS">BIS</option>
                    <option value="Non-BIS">Non-BIS</option>
                    <option value="Tertiary">Tertiary</option>
                  </select>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={row.counted}
                    onChange={e => updateRclcRow(i, 'counted', e.target.checked)}
                  />
                </td>
                <td>
                  <button className="btn-icon-danger" onClick={() => removeRclcRow(i)} title="Remove">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button className="btn-secondary" onClick={addRclcRow}>+ Add Row</button>
          <button className="btn-primary" onClick={saveRclc} disabled={rclcSaving}>
            {rclcSaving ? 'Saving…' : 'Save Map'}
          </button>
        </div>
        <ResultMsg result={rclcResult} />
      </div>
    </div>
  );
}
