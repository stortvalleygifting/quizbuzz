import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import SignIn from './pages/SignIn';
import Groups from './pages/Groups';
import GroupDetail from './pages/GroupDetail';
import Event from './pages/Event';

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <div className="app"><div className="empty">Loading…</div></div>;
  if (!user) return <SignIn />;

  return (
    <Routes>
      <Route path="/" element={<Groups />} />
      <Route path="/groups/:groupId" element={<GroupDetail />} />
      <Route path="/events/:eventId" element={<Event />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
