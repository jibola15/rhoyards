import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@rhoyards/shared';

export function createQueryClient(options: { retry?: number | false } = {}) {
  const maxRetries = options.retry === false ? 0 : (options.retry ?? 1);
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // 4xx answers will not change on retry; only network and server failures are retried.
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < maxRetries,
      },
    },
  });
}
