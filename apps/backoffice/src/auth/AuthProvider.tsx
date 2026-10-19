import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type AuthSession, type DataEnvelope, type LoginInput, type LoginStep, type Permission } from '@rhoyards/shared';
import { api, setCsrfToken } from '../lib/api';
import { SESSION_QUERY_KEY } from '../lib/query-client';

async function fetchSession(): Promise<AuthSession | null> {
  try {
    const res = await api.get<DataEnvelope<AuthSession>>('/auth/me');
    setCsrfToken(res.data.csrfToken);
    return res.data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setCsrfToken(undefined);
      return null;
    }
    throw error;
  }
}

interface AuthContextValue {
  session: AuthSession | null;
  isLoading: boolean;
  error: Error | null;
  can: (permission: Permission) => boolean;
  /** Password step: returns what the second step is (no session yet). */
  login: (input: LoginInput) => Promise<LoginStep>;
  /** Adopts the session returned by the second step. */
  finishSignIn: (session: AuthSession) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<unknown>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: fetchSession, staleTime: 5 * 60_000 });
  const session = query.data ?? null;

  const login = useCallback(async (input: LoginInput) => (await api.post<DataEnvelope<LoginStep>>('/auth/login', input)).data, []);

  const finishSignIn = useCallback(
    (next: AuthSession) => {
      setCsrfToken(next.csrfToken);
      // A different user may now be signed in: discard everything cached for the previous one.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_QUERY_KEY[0] });
      queryClient.setQueryData(SESSION_QUERY_KEY, next);
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setCsrfToken(undefined);
      // Keep the session query itself (the provider observes it) and drop everything cached for this user.
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_QUERY_KEY[0] });
    }
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    const permissions = new Set(session?.user.permissions ?? []);
    return {
      session,
      isLoading: query.isPending,
      error: query.error,
      can: (p) => permissions.has(p),
      login,
      finishSignIn,
      logout,
      refresh: () => query.refetch(),
    };
  }, [session, query, login, finishSignIn, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
