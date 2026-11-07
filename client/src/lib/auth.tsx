import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getToken, setToken, type User } from './api';
import { closeSocket } from './socket';

interface AuthValue {
  user: User | null;
  loading: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signUp: (username: string, password: string) => Promise<void>;
  signOut: () => void;
  /**
   * The temporary password they just signed in with, held in memory only, so
   * the change-password screen it leads to needn't ask for it again.
   */
  temporaryPassword: string | null;
  /** Their password has been changed, so stop insisting on it. */
  passwordChanged: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const adopt = useCallback((r: { token: string; user: User }) => {
    setToken(r.token);
    setUser(r.user);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      loading,
      signIn: async (u, p) => {
        const r = await api.login(u, p);
        setTemporaryPassword(r.user.mustChangePassword ? p : null);
        adopt(r);
      },
      signUp: async (u, p) => adopt(await api.register(u, p)),
      signOut: () => {
        // Drop the socket too, so it doesn't reconnect with the old token.
        closeSocket();
        setToken(null);
        setUser(null);
        setTemporaryPassword(null);
      },
      temporaryPassword,
      passwordChanged: () => {
        setTemporaryPassword(null);
        setUser((u) => (u ? { ...u, mustChangePassword: false } : u));
      },
    }),
    [user, loading, adopt, temporaryPassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
