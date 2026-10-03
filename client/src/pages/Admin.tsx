import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AdminGroup, type AdminUser } from '../lib/api';
import { useConfirm } from '../lib/confirm';
import { formatSignupDate } from '../lib/dates';

/**
 * The system admin's screen: every group in the app, and every account, with
 * a way to give someone a new password when they have forgotten theirs.
 */
export default function Admin() {
  const confirm = useConfirm();
  const [groups, setGroups] = useState<AdminGroup[] | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [query, setQuery] = useState('');
  const [reset, setReset] = useState<{ username: string; temporaryPassword: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .adminGroups()
      .then((r) => setGroups(r.groups))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .adminUsers(query.trim())
        .then((r) => setUsers(r.users))
        .catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  async function resetPassword(u: AdminUser) {
    const ok = await confirm({
      title: `Reset ${u.username}'s password?`,
      message: 'Their old password stops working. You will get a temporary one to pass on to them.',
      confirmLabel: 'Reset',
      danger: true,
    });
    if (!ok) return;
    setError('');
    try {
      setReset(await api.resetPassword(u.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <Link to="/">
          <button className="small">Back</button>
        </Link>
        <h1>System admin</h1>
      </div>

      {error && <div className="error">{error}</div>}

      <h2>All groups{groups ? ` (${groups.length})` : ''}</h2>
      {!groups ? (
        <div className="card empty">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="card empty">Nobody has made a group yet.</div>
      ) : (
        <div className="card list">
          {groups.map((g) => (
            <Link key={g.id} className="group-link" to={`/groups/${g.id}`}>
              <div className="row">
                <div className="grow">
                  <div className="name">{g.name}</div>
                  <div className="sub">
                    {g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}
                    {g.admins.length > 0 && ` · run by ${g.admins.join(', ')}`}
                  </div>
                </div>
                {g.pendingCount > 0 && <span className="pill pending">{g.pendingCount} waiting</span>}
              </div>
            </Link>
          ))}
        </div>
      )}

      <h2>People</h2>
      <input
        placeholder="Search by username"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
      />
      {users && (
        <div className="card list">
          {users.length === 0 ? (
            <div className="empty">Nobody by that name.</div>
          ) : (
            users.map((u) => (
              <div className="row" key={u.id}>
                <div className="grow">
                  <div className="name">{u.username}</div>
                  <div className="sub">Joined {formatSignupDate(u.signedUpAt)}</div>
                </div>
                <button className="small" onClick={() => resetPassword(u)}>
                  Reset password
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {reset && (
        <div className="modal-backdrop" onClick={() => setReset(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>{reset.username}'s temporary password</h2>
            <div className="temp-password">{reset.temporaryPassword}</div>
            <p className="sub">
              Pass this on to {reset.username}. It is only shown once. They can change it from "Change password" once
              they have signed in.
            </p>
            <button className="primary block" onClick={() => setReset(null)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
