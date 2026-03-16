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
      <nav className="nav">
        <div className="nav-left">
          <NavLink to="/" className="nav-brand">Home</NavLink>
          <NavLink to="/bis" className="nav-link">Edit BIS</NavLink>
          {user?.isOfficer && (
            <NavLink to="/bis/review" className="nav-link">BIS Review</NavLink>
          )}
          {user?.isOfficer && (
            <NavLink to="/council" className="nav-link">Council</NavLink>
          )}
          {user?.isOfficer && (
            <NavLink to="/roster" className="nav-link">Roster</NavLink>
          )}
          {user?.isOfficer && (
            <NavLink to="/import" className="nav-link">Loot Import</NavLink>
          )}
          {user?.isGlobalOfficer && (
            <NavLink to="/admin/default-bis" className="nav-link">Raid BIS</NavLink>
          )}
        </div>
        <div className="nav-right">
          {label && <span className="nav-user">{label}</span>}
          <a className="nav-logout" href={apiPath('/api/auth/logout')}>Logout</a>
        </div>
      </nav>

      {user?.teams?.length > 1 && (
        <div className="team-banner">
          <span className="team-banner-label">Select Raid Team:</span>
          <select
            className="team-banner-select"
            value={user.teamName ?? ''}
            onChange={e => switchTeam(e.target.value)}
          >
            {user.teams.map(t => (
              <option key={t.teamName} value={t.teamName}>{t.teamName}</option>
            ))}
          </select>
        </div>
      )}

      <main className="main">{children}</main>
    </div>
  );
}
