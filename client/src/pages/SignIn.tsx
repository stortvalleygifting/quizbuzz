import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import PasswordInput from '../lib/PasswordInput';

export default function SignIn() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (mode === 'up' && password !== repeat) {
      setError('Those two passwords don’t match. Type the same one in both boxes.');
      return;
    }
    setBusy(true);
    try {
      await (mode === 'in' ? signIn(username, password) : signUp(username, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>QuizBuzz</h1>
      </div>

      <div className="card">
        <p className="sub" style={{ marginTop: 0 }}>
          {mode === 'in' ? 'Sign in to buzz and play.' : 'Pick a username and a password. That is all you need.'}
        </p>
        {error && <div className="error">{error}</div>}
        <form onSubmit={submit}>
          <label htmlFor="username">Username</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            required
          />
          <label htmlFor="password">Password</label>
          <PasswordInput
            id="password"
            value={password}
            onChange={setPassword}
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            minLength={mode === 'up' ? 8 : undefined}
          />
          {mode === 'up' && (
            <>
              <label htmlFor="repeat">Repeat password</label>
              <PasswordInput id="repeat" value={repeat} onChange={setRepeat} autoComplete="new-password" />
            </>
          )}
          <button className="primary block" type="submit" disabled={busy}>
            {busy ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <button
          className="link block"
          onClick={() => {
            setMode(mode === 'in' ? 'up' : 'in');
            setError('');
            setRepeat('');
          }}
        >
          {mode === 'in' ? 'New here? Create an account' : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}
