import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMe } from '../hooks/useMe.js';
import { apiPath } from '../lib/api.js';

export default function Login() {
  const { user, loading } = useMe();
  const navigate = useNavigate();

  // Already logged in — skip straight to dashboard
  useEffect(() => {
    if (!loading && user) navigate('/', { replace: true });
  }, [user, loading, navigate]);

  const error = new URLSearchParams(window.location.search).get('error');

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Canceled" className="login-logo" />
          <span>Canceled</span>
        </h1>
        <p className="login-sub">Loot Tracker</p>
        {error && (
          <p className="login-error">
            {error === 'auth_failed' ? 'Authentication failed. Please try again.' : 'Something went wrong.'}
          </p>
        )}
        <a className="btn-discord" href={apiPath('/api/auth/login')}>
          Login with Discord
        </a>
      </div>
    </div>
  );
}
