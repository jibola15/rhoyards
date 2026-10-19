import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type DataEnvelope, type StoreCustomer, type StoreSession } from '@rhoyards/shared';
import { api, setCsrfToken } from '../lib/api';

interface CustomerState {
  customer: StoreCustomer | null;
  loading: boolean;
  signedIn: (session: StoreSession) => void;
  signOut: () => Promise<void>;
}

const CustomerContext = createContext<CustomerState | null>(null);
export const SESSION_KEY = ['store', 'me'] as const;

/** Loads the signed-in customer (if any) once; a 401 simply means "guest". */
export function CustomerProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: SESSION_KEY,
    queryFn: async ({ signal }) => {
      try {
        const res = await api.get<DataEnvelope<StoreSession>>('/auth/me', { signal });
        setCsrfToken(res.data.csrfToken);
        return res.data;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
  const value: CustomerState = {
    customer: me.data?.customer ?? null,
    loading: me.isPending,
    signedIn: (session) => {
      setCsrfToken(session.csrfToken);
      queryClient.setQueryData(SESSION_KEY, session);
    },
    signOut: async () => {
      await api.post('/auth/logout').catch(() => undefined);
      setCsrfToken(undefined);
      queryClient.setQueryData(SESSION_KEY, null);
      queryClient.removeQueries({ queryKey: ['store', 'orders'] });
    },
  };
  return <CustomerContext.Provider value={value}>{children}</CustomerContext.Provider>;
}

export function useCustomer(): CustomerState {
  const ctx = useContext(CustomerContext);
  if (!ctx) throw new Error('useCustomer must be used inside CustomerProvider');
  return ctx;
}
