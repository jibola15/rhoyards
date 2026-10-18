import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AdjustmentDetail,
  AdjustmentSummary,
  BatchRow,
  DataEnvelope,
  ListEnvelope,
  MovementRow,
  StockRow,
  TransferDetail,
  TransferSummary,
} from '@rhoyards/shared';
import { api, qs } from '../../lib/api';

type Params = Record<string, string | number | boolean | undefined>;

function useList<T>(key: string, path: string, params: Params) {
  return useQuery({
    queryKey: [key, 'list', params],
    queryFn: ({ signal }) => api.get<ListEnvelope<T>>(`${path}${qs(params)}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export const useStock = (p: Params) => useList<StockRow>('stock', '/inventory/stock', p);
export const useMovements = (p: Params) => useList<MovementRow>('movements', '/inventory/movements', p);
export const useBatches = (p: Params) => useList<BatchRow>('batches', '/inventory/batches', p);
export const useAdjustments = (p: Params) => useList<AdjustmentSummary>('stock-adjustments', '/stock-adjustments', p);
export const useTransfers = (p: Params) => useList<TransferSummary>('stock-transfers', '/stock-transfers', p);

export interface Valuation {
  stockLedgerValue: string;
  glInventoryBalance: string;
  difference: string;
  stockQty: string;
  inTransitQty: string;
  variantsWithStock: number;
}

export function useValuation() {
  return useQuery({
    queryKey: ['stock', 'valuation'],
    queryFn: ({ signal }) => api.get<DataEnvelope<Valuation>>('/inventory/valuation', { signal }).then((r) => r.data),
  });
}

export function useAdjustment(id: string | undefined) {
  return useQuery({
    queryKey: ['stock-adjustments', 'detail', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<AdjustmentDetail>>(`/stock-adjustments/${id}`, { signal }).then((r) => r.data),
    enabled: Boolean(id),
  });
}

export function useTransfer(id: string | undefined) {
  return useQuery({
    queryKey: ['stock-transfers', 'detail', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<TransferDetail>>(`/stock-transfers/${id}`, { signal }).then((r) => r.data),
    enabled: Boolean(id),
  });
}

/** Query keys whose data changes when stock moves. */
export const STOCK_KEYS = [['stock'], ['movements'], ['batches'], ['products'], ['variants']] as const;
