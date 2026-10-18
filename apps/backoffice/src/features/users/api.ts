import { useQuery } from '@tanstack/react-query';
import type { DataEnvelope, ListEnvelope, LocationSummary, RoleSummary, UserSummary } from '@rhoyards/shared';
import { api, qs } from '../../lib/api';

export interface UserListParams {
  q?: string;
  status?: 'ACTIVE' | 'DISABLED' | '';
  page: number;
  pageSize: number;
}

export const usersKeys = {
  all: ['users'] as const,
  list: (p: UserListParams) => ['users', 'list', p] as const,
};

export function useUsers(params: UserListParams) {
  return useQuery({
    queryKey: usersKeys.list(params),
    queryFn: ({ signal }) => api.get<ListEnvelope<UserSummary>>(`/users${qs({ ...params })}`, { signal }),
    placeholderData: (prev) => prev,
  });
}

export function useRoles() {
  return useQuery({
    queryKey: ['roles'],
    queryFn: ({ signal }) => api.get<DataEnvelope<RoleSummary[]>>('/roles', { signal }).then((r) => r.data),
  });
}

export function useLocations() {
  return useQuery({
    queryKey: ['locations'],
    queryFn: ({ signal }) => api.get<DataEnvelope<LocationSummary[]>>('/locations', { signal }).then((r) => r.data),
  });
}
