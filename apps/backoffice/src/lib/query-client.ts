import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from '@rhoyards/shared';
import { setCsrfToken } from './api';

export const SESSION_QUERY_KEY = ['auth', 'me'] as const;

/** Any 401 means the session has ended (expired, revoked, signed out elsewhere): drop to the login screen. */
export function createQueryClient(options: { retry?: number | false } = {}) {
  const maxRetries = options.retry === false ? 0 : (options.retry ?? 1);
  const onError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      setCsrfToken(undefined);
      client.setQueryData(SESSION_QUERY_KEY, null);
    }
  };
  const client = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // Client errors (4xx) will not succeed on retry; only network/server failures are retried.
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < maxRetries,
      },
    },
  });
  return client;
}
