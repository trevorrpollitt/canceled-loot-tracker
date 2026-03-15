import { NavLink } from 'react-router-dom';
import { useMe } from '../hooks/useMe.js';

export default function Layout({ children }) {
  const { user } = useMe();
  const label = user?.charName ?? user?.username ?? '';

  return (
    <div className="layout">
      <nav className="nav">
        <div className="nav-left">
          <NavLink to="/" className="nav-brand">❌ Canceled</NavLink>
          <NavLink to="/bis" className="nav-link">My BIS</NavLink>
          {user?.isOfficer && (
            <NavLink to="/admin/default-bis" className="nav-link">Raid BIS</NavLink>
          )}
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
            <NavLink to="/loot/import" className="nav-link">Loot Import</NavLink>
          )}
        </div>
        <div className="nav-right">
          {label && <span className="nav-user">{label}</span>}
          <a className="nav-logout" href="/api/auth/logout">Logout</a>
        </div>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
