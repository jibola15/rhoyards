import { useQuery, useQueryClient } from '@tanstack/react-query';
import { JOURNAL_SOURCES, type AccountRow, type DataEnvelope, type FiscalYearRow } from '@rhoyards/shared';
import { api } from '../../lib/api';

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: ({ signal }) => api.get<DataEnvelope<AccountRow[]>>('/accounting/accounts', { signal }).then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useFiscalYears() {
  return useQuery({
    queryKey: ['fiscal-years'],
    queryFn: ({ signal }) => api.get<DataEnvelope<FiscalYearRow[]>>('/accounting/fiscal-years', { signal }).then((r) => r.data),
  });
}

/** After anything that posts to the ledger: balances, journals and every statement may have changed. */
export function useRefreshLedger() {
  const queryClient = useQueryClient();
  return async () => {
    for (const key of ['accounts', 'journals', 'ledger', 'fiscal-years', 'opening-balances', 'report']) {
      await queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

export const sourceLabel = (s: string) => (JOURNAL_SOURCES as Record<string, string>)[s] ?? s;

export const today = () => new Date().toISOString().slice(0, 10);
export const yearStart = () => `${today().slice(0, 4)}-01-01`;

export const TYPE_LABELS = { ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Equity', INCOME: 'Income', EXPENSE: 'Expenses' } as const;
