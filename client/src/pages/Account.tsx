import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import PasswordInput from '../lib/PasswordInput';

/**
 * Change your password. With `forced`, this is the only screen someone sees
 * after signing in with a temporary password from a system admin, until they
 * have picked their own.
 */
export default function Account({ forced = false }: { forced?: boolean }) {
  const { user, temporaryPassword, passwordChanged, signOut } = useAuth();
  // Straight after signing in with the temporary password we already know it,
  // so don't make them type it twice. After a reload we have to ask.
  const knowsCurrent = forced && temporaryPassword !== null;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (next !== repeat) {
      setError('Those two passwords don’t match. Type the same one in both boxes.');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(knowsCurrent ? temporaryPassword! : current, next);
      setCurrent('');
      setNext('');
      setRepeat('');
      if (forced) {
        // Unlocks the rest of the app; this screen goes away.
        passwordChanged();
        return;
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        {forced ? (
          <button className="small" onClick={signOut}>
            Sign out
          </button>
        ) : (
          <Link to="/">
            <button className="small">Back</button>
          </Link>
        )}
        <h1>{forced ? 'Pick a new password' : 'Change password'}</h1>
      </div>

      <div className="card">
        {forced && (
          <p className="sub" style={{ marginTop: 0 }}>
            Welcome back{user ? `, ${user.username}` : ''}. That temporary password only works once, so choose your own
            to carry on.
          </p>
        )}
        {done && <div className="notice">Done. Use your new password next time you sign in.</div>}
        {error && <div className="error">{error}</div>}
        <form onSubmit={submit}>
          {!knowsCurrent && (
            <>
              <label htmlFor="current">{forced ? 'Temporary password' : 'Current password'}</label>
              <PasswordInput id="current" value={current} onChange={setCurrent} autoComplete="current-password" />
            </>
          )}
          <label htmlFor="next">New password</label>
          <PasswordInput
            id="next"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            minLength={8}
            autoFocus={knowsCurrent}
          />
          <label htmlFor="repeat">Repeat new password</label>
          <PasswordInput id="repeat" value={repeat} onChange={setRepeat} autoComplete="new-password" />
          <button className="primary block" type="submit" disabled={busy}>
            {busy ? 'One moment…' : forced ? 'Save and carry on' : 'Change password'}
          </button>
        </form>
      </div>
    </div>
  );
}
