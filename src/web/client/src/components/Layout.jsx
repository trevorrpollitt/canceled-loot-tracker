import { NavLink } from 'react-router-dom';
import { useMe, refreshMe } from '../hooks/useMe.js';
import { apiPath } from '../lib/api.js';

export default function Layout({ children }) {
  const { user } = useMe();
  const label = user?.charName ?? user?.username ?? '';

  async function switchTeam(teamName) {
    await fetch(apiPath('/api/me/active-team'), {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ teamName }),
    });
    await refreshMe();
    window.location.reload();
  }

  return (
    <div className="layout">
      <header className="nav-header">
        <div className="nav-top">
          <NavLink to="/" className="nav-brand">
            <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Canceled" className="nav-logo" />
          </NavLink>
          {user?.teams?.length > 0 && (
            <div className="nav-team">
              <span className="nav-team-label">Select Raid Team:</span>
              <select
                className="nav-team-select"
                value={user.teamName ?? ''}
                onChange={e => switchTeam(e.target.value)}
                disabled={user.teams.length <= 1}
              >
                {user.teams.map(t => (
                  <option key={t.teamName} value={t.teamName}>{t.teamName}</option>
                ))}
              </select>
            </div>
          )}
          <div className="nav-right">
            {label && <span className="nav-user">{label}</span>}
            <a className="nav-logout" href={apiPath('/api/auth/logout')}>Logout</a>
          </div>
        </div>

        <nav className="nav-tabs">
          <NavLink to="/" className="nav-tab">Character Summary</NavLink>
          {user?.isOfficer && (
            <NavLink to="/bis/review" className="nav-tab">BIS Review</NavLink>
          )}
          <NavLink to="/council" className="nav-tab">Council</NavLink>
          {user?.isOfficer && (
            <NavLink to="/roster" className="nav-tab">Roster</NavLink>
          )}
          {user?.isOfficer && (
            <NavLink to="/loot-history" className="nav-tab">Loot History</NavLink>
          )}
          {user?.isOfficer && (
            <NavLink to="/import" className="nav-tab">Loot Import</NavLink>
          )}
          {user?.isGlobalOfficer && (
            <NavLink to="/admin/default-bis" className="nav-tab">Raid BIS</NavLink>
          )}
          {user?.isOfficer && (
            <NavLink to="/admin" end className="nav-tab">Logs</NavLink>
          )}
          {user?.isOfficer && (
            <NavLink to="/admin/team-config" className="nav-tab">Team Config</NavLink>
          )}
          {user?.isOfficer && (
            <NavLink to="/admin/global-config" className="nav-tab">Global Config</NavLink>
          )}
        </nav>
      </header>

      <main className="main">{children}</main>
    </div>
  );
}
