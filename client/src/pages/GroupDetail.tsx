import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type GroupDetail as Detail } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function GroupDetail() {
  const { groupId } = useParams();
  const id = Number(groupId);
  const { user } = useAuth();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setDetail(await api.group(id));
  }, [id]);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);

  async function act(fn: () => Promise<unknown>, afterwards?: () => void) {
    setError('');
    setBusy(true);
    try {
      await fn();
      if (afterwards) afterwards();
      else await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <div className="app">
        <div className="topbar">
          <Link to="/">
            <button className="small">Back</button>
          </Link>
          <h1 />
        </div>
        {error ? <div className="error">{error}</div> : <div className="empty">Loading…</div>}
      </div>
    );
  }

  const { group, members, requests } = detail;
  const isAdmin = group.myRole === 'admin';
  const isMember = group.myStatus === 'approved';

  return (
    <div className="app">
      <div className="topbar">
        <Link to="/">
          <button className="small">Back</button>
        </Link>
        <h1>{group.name}</h1>
        {isAdmin && <span className="pill admin">Admin</span>}
      </div>

      {error && <div className="error">{error}</div>}

      {group.description && <div className="card sub">{group.description}</div>}

      {!isMember && (
        <div className="card">
          <p className="sub" style={{ marginTop: 0 }}>
            {group.myStatus === 'pending'
              ? 'Your application is with the admins.'
              : 'You are not in this group yet.'}
          </p>
          {group.myStatus === 'pending' ? (
            <button className="block" disabled={busy} onClick={() => act(() => api.withdraw(id))}>
              Withdraw application
            </button>
          ) : (
            <button className="primary block" disabled={busy} onClick={() => act(() => api.apply(id))}>
              Ask to join
            </button>
          )}
        </div>
      )}

      {isAdmin && requests.length > 0 && (
        <>
          <h2>Requests to join</h2>
          <div className="card list">
            {requests.map((r) => (
              <div className="row" key={r.id}>
                <div className="grow">
                  <div className="name">{r.username}</div>
                </div>
                <button className="small primary" disabled={busy} onClick={() => act(() => api.approve(id, r.id))}>
                  Approve
                </button>
                <button
                  className="small danger"
                  disabled={busy}
                  onClick={() => act(() => api.removeMember(id, r.id))}
                >
                  Decline
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {isMember && (
        <>
          <h2>Members</h2>
          <div className="card list">
            {members.map((m) => {
              const isMe = m.id === user?.id;
              return (
                <div className="row" key={m.id}>
                  <div className="grow">
                    <div className="name">
                      {m.username}
                      {isMe && <span className="sub"> (you)</span>}
                    </div>
                  </div>
                  {m.role === 'admin' && <span className="pill admin">Admin</span>}
                  {isAdmin && !isMe && m.role === 'member' && (
                    <button className="small" disabled={busy} onClick={() => act(() => api.setRole(id, m.id, 'admin'))}>
                      Make admin
                    </button>
                  )}
                  {isAdmin && !isMe && m.role === 'admin' && (
                    <button
                      className="small"
                      disabled={busy}
                      onClick={() => act(() => api.setRole(id, m.id, 'member'))}
                    >
                      Step down
                    </button>
                  )}
                  {isAdmin && !isMe && (
                    <button
                      className="small danger"
                      disabled={busy}
                      onClick={() => act(() => api.removeMember(id, m.id))}
                    >
                      Remove
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <button
            className="danger block"
            disabled={busy}
            onClick={() => act(() => api.removeMember(id, user!.id), () => navigate('/'))}
          >
            Leave group
          </button>
        </>
      )}
    </div>
  );
}
