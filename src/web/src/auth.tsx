import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { UNAUTHORIZED_EVENT, api } from './api';

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'user';
}

interface AuthState {
  loading: boolean;
  needsSetup: boolean;
  user: AuthUser | null;
  isAdmin: boolean;
  login: (username: string, password: string) => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<{ needsSetup: boolean; user: AuthUser | null }>('/admin/auth/status');
      setNeedsSetup(s.needsSetup);
      setUser(s.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onExpired = () => setUser(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onExpired);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onExpired);
  }, [refresh]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      needsSetup,
      user,
      isAdmin: user?.role === 'admin',
      refresh,
      login: async (username, password) => {
        const r = await api<{ user: AuthUser }>('/admin/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        setUser(r.user);
      },
      setup: async (username, password) => {
        const r = await api<{ user: AuthUser }>('/admin/auth/setup', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        setNeedsSetup(false);
        setUser(r.user);
      },
      logout: async () => {
        try {
          await api('/admin/auth/logout', { method: 'POST', body: '{}' });
        } finally {
          setUser(null);
        }
      },
    }),
    [loading, needsSetup, user, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
