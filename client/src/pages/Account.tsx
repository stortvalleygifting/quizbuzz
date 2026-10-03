import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

/** Change your password, say to replace a temporary one an admin gave you. */
export default function Account() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setDone(true);
      setCurrent('');
      setNext('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <Link to="/">
          <button className="small">Back</button>
        </Link>
        <h1>Change password</h1>
      </div>

      <div className="card">
        {done && <div className="notice">Done. Use your new password next time you sign in.</div>}
        {error && <div className="error">{error}</div>}
        <form onSubmit={submit}>
          <label htmlFor="current">Current password</label>
          <input
            id="current"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
          <label htmlFor="next">New password</label>
          <input
            id="next"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
          <button className="primary block" type="submit" disabled={busy}>
            {busy ? 'One moment…' : 'Change password'}
          </button>
        </form>
      </div>
    </div>
  );
}
