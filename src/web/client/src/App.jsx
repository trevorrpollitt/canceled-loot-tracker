import { Routes, Route, Navigate } from 'react-router-dom';
import { useMe } from './hooks/useMe.js';
import Login            from './pages/Login.jsx';
import Dashboard        from './pages/Dashboard.jsx';
import Bis              from './pages/Bis.jsx';
import Admin            from './pages/Admin.jsx';
import AdminDefaultBis  from './pages/AdminDefaultBis.jsx';
import AdminBisReview   from './pages/AdminBisReview.jsx';
import Council          from './pages/Council.jsx';
import LootImport       from './pages/LootImport.jsx';
import RosterPage       from './pages/Roster.jsx';
import Layout           from './components/Layout.jsx';

function ProtectedRoute({ children }) {
  const { user, loading } = useMe();
  if (loading) return <div className="loading">Loading…</div>;
  if (!user)   return <Navigate to="/login" replace />;
  return children;
}

function OfficerRoute({ children }) {
  const { user, loading } = useMe();
  if (loading)           return <div className="loading">Loading…</div>;
  if (!user)             return <Navigate to="/login" replace />;
  if (!user.isOfficer)   return <Navigate to="/" replace />;
  return children;
}

function GlobalOfficerRoute({ children }) {
  const { user, loading } = useMe();
  if (loading)                  return <div className="loading">Loading…</div>;
  if (!user)                    return <Navigate to="/login" replace />;
  if (!user.isGlobalOfficer)    return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={
        <ProtectedRoute>
          <Layout><Dashboard /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/bis" element={
        <ProtectedRoute>
          <Layout><Bis /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/admin/default-bis" element={
        <GlobalOfficerRoute>
          <Layout><AdminDefaultBis /></Layout>
        </GlobalOfficerRoute>
      } />
      <Route path="/bis/review" element={
        <OfficerRoute>
          <Layout><AdminBisReview /></Layout>
        </OfficerRoute>
      } />
      <Route path="/council" element={
        <ProtectedRoute>
          <Layout><Council /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/import" element={
        <OfficerRoute>
          <Layout><LootImport /></Layout>
        </OfficerRoute>
      } />
      <Route path="/roster" element={
        <OfficerRoute>
          <Layout><RosterPage /></Layout>
        </OfficerRoute>
      } />
      <Route path="/admin" element={
        <OfficerRoute>
          <Layout><Admin /></Layout>
        </OfficerRoute>
      } />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
