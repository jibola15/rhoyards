import { useQuery } from '@tanstack/react-query';
import type { DataEnvelope, StoreInfo } from '@rhoyards/shared';
import { api } from './api';

export function useStoreInfo() {
  return useQuery({
    queryKey: ['store', 'info'],
    queryFn: ({ signal }) => api.get<DataEnvelope<StoreInfo>>('/info', { signal }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}
