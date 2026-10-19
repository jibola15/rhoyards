import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomerSummary, DataEnvelope, ListEnvelope, PosContext, ReceiptData, SaleDetail, SaleSummary, ShiftSummary } from '@rhoyards/shared';
import { api, qs } from '../../lib/api';

export const POS_CONTEXT_KEY = ['pos-context'] as const;

export function usePosContext() {
  return useQuery({
    queryKey: POS_CONTEXT_KEY,
    queryFn: ({ signal }) => api.get<DataEnvelope<PosContext>>('/pos/context', { signal }).then((r) => r.data),
  });
}

export function useSuspendedSales(registerId: string | undefined) {
  return useQuery({
    queryKey: ['sales', 'suspended', registerId],
    queryFn: ({ signal }) => api.get<ListEnvelope<SaleSummary>>(`/pos/sales/suspended${qs({ registerId, pageSize: 50 })}`, { signal }).then((r) => r.data),
    enabled: Boolean(registerId),
  });
}

export function useShift(id: string | undefined) {
  return useQuery({
    queryKey: ['shifts', 'detail', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<ShiftSummary>>(`/pos/shifts/${id}`, { signal }).then((r) => r.data),
    enabled: Boolean(id),
  });
}

export function useSale(id: string | undefined) {
  return useQuery({
    queryKey: ['sales', 'detail', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<SaleDetail>>(`/sales/${id}`, { signal }).then((r) => r.data),
    enabled: Boolean(id),
  });
}

export function useReceipt(id: string | undefined) {
  return useQuery({
    queryKey: ['sales', 'receipt', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<ReceiptData>>(`/sales/${id}/receipt`, { signal }).then((r) => r.data),
    enabled: Boolean(id),
  });
}

export function useCustomerSearch(q: string, enabled = true) {
  return useQuery({
    queryKey: ['customers', 'search', q],
    queryFn: ({ signal }) => api.get<ListEnvelope<CustomerSummary>>(`/customers${qs({ q, pageSize: 10 })}`, { signal }).then((r) => r.data),
    enabled,
  });
}

/** After a sale or shift change: the till context, stock figures and sales lists are stale. */
export function useRefreshPos() {
  const queryClient = useQueryClient();
  return async () => {
    for (const k of ['sales', 'shifts', 'stock', 'movements', 'batches', 'variants', 'customers']) void queryClient.invalidateQueries({ queryKey: [k] });
    await queryClient.invalidateQueries({ queryKey: POS_CONTEXT_KEY });
  };
}
