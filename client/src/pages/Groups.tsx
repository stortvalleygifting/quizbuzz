import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type GroupSummary } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatSignupDate } from '../lib/dates';

export default function Groups() {
  const { user, signOut } = useAuth();
  const [mine, setMine] = useState<GroupSummary[]>([]);
  const [pending, setPending] = useState<GroupSummary[]>([]);
  const [results, setResults] = useState<GroupSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const r = await api.myGroups();
    setMine(r.groups);
    setPending(r.pending);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);

  // Search as they type, once they have typed something worth searching for.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .searchGroups(q)
        .then((r) => setResults(r.groups))
        .catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  async function act(fn: () => Promise<unknown>) {
    setError('');
    setBusy(true);
    try {
      await fn();
      await refresh();
      if (query.trim()) setResults((await api.searchGroups(query.trim())).groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    await act(async () => {
      await api.createGroup(newName, newDescription);
      setNewName('');
      setNewDescription('');
      setCreating(false);
    });
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>Your groups</h1>
        <span className="who">{user?.username}</span>
        <button className="small" onClick={signOut}>
          Sign out
        </button>
      </div>

      {user?.signedUpAt && <div className="since">Member since {formatSignupDate(user.signedUpAt)}</div>}

      {error && <div className="error">{error}</div>}

      {mine.length === 0 ? (
        <div className="card empty">You are not in a group yet. Create one, or search below to join one.</div>
      ) : (
        <div className="card list">
          {mine.map((g) => (
            <Link key={g.id} className="group-link" to={`/groups/${g.id}`}>
              <div className="row">
                <div className="grow">
                  <div className="name">{g.name}</div>
                  <div className="sub">
                    {g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}
                  </div>
                </div>
                {g.myRole === 'admin' && <span className="pill admin">Admin</span>}
              </div>
            </Link>
          ))}
        </div>
      )}

      {creating ? (
        <form className="card" onSubmit={create}>
          <label htmlFor="group-name">Group name</label>
          <input id="group-name" value={newName} onChange={(e) => setNewName(e.target.value)} required />
          <label htmlFor="group-description">What is it for? (optional)</label>
          <textarea
            id="group-description"
            rows={2}
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
          />
          <div className="row">
            <button className="primary grow" type="submit" disabled={busy}>
              Create group
            </button>
            <button type="button" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button className="primary block" onClick={() => setCreating(true)}>
          Create a group
        </button>
      )}

      {pending.length > 0 && (
        <>
          <h2>Waiting for approval</h2>
          <div className="card list">
            {pending.map((g) => (
              <div className="row" key={g.id}>
                <div className="grow">
                  <div className="name">{g.name}</div>
                  <div className="sub">An admin needs to let you in.</div>
                </div>
                <button className="small" disabled={busy} onClick={() => act(() => api.withdraw(g.id))}>
                  Withdraw
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Find a group</h2>
      <input
        placeholder="Search by name"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
      />
      {results && (
        <div className="card list">
          {results.length === 0 && <div className="empty">No groups match that.</div>}
          {results.map((g) => (
            <div className="row" key={g.id}>
              <div className="grow">
                <div className="name">{g.name}</div>
                <div className="sub">
                  {g.description || `${g.memberCount} ${g.memberCount === 1 ? 'member' : 'members'}`}
                </div>
              </div>
              {g.myStatus === 'approved' ? (
                <Link to={`/groups/${g.id}`}>
                  <button className="small">Open</button>
                </Link>
              ) : g.myStatus === 'pending' ? (
                <span className="pill pending">Applied</span>
              ) : (
                <button className="small primary" disabled={busy} onClick={() => act(() => api.apply(g.id))}>
                  Ask to join
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
