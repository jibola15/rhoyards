import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountOption, DataEnvelope, ListEnvelope, SupplierSummary } from '@rhoyards/shared';
import { api } from '../../lib/api';

/** Active suppliers for selects (a small business has well under the page limit). */
export function useSupplierOptions() {
  return useQuery({
    queryKey: ['suppliers', 'options'],
    queryFn: ({ signal }) => api.get<ListEnvelope<SupplierSummary>>('/suppliers?pageSize=100', { signal }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useAccountOptions(kind: 'payment' | 'expense') {
  return useQuery({
    queryKey: ['purchasing-accounts', kind],
    queryFn: ({ signal }) => api.get<DataEnvelope<AccountOption[]>>(`/purchasing/accounts?kind=${kind}`, { signal }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useDocument<T>(key: string, path: string, id: string | undefined) {
  return useQuery({
    queryKey: [key, 'detail', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<T>>(`${path}/${id}`, { signal }).then((r) => r.data),
    enabled: Boolean(id),
  });
}

/** After a purchasing action: refresh the document, its lists, and anything stock/ledger-derived. */
export function useRefreshPurchasing() {
  const queryClient = useQueryClient();
  return async (key: string, id: string, data: unknown) => {
    queryClient.setQueryData([key, 'detail', id], data);
    for (const k of [key, 'purchase-orders', 'goods-receipts', 'supplier-invoices', 'supplier-payments', 'purchase-returns', 'stock', 'movements', 'batches', 'products', 'supplier-statement', 'payables-aging']) {
      if (k !== key) void queryClient.invalidateQueries({ queryKey: [k] });
    }
    await queryClient.invalidateQueries({ queryKey: [key, 'list'] });
  };
}

export const PO_STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'PARTIALLY_RECEIVED', label: 'Partly received' },
  { value: 'RECEIVED', label: 'Received' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];
export const DOC_STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'POSTED', label: 'Posted' },
  { value: 'CANCELLED', label: 'Cancelled' },
];
export const INVOICE_STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'POSTED', label: 'Unpaid' },
  { value: 'PARTIALLY_PAID', label: 'Partly paid' },
  { value: 'PAID', label: 'Paid' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export const today = () => new Date().toISOString().slice(0, 10);
