import { useQuery } from '@tanstack/react-query';
import type { DataEnvelope, PaymentMethodSummary } from '@rhoyards/shared';
import { api } from '../../lib/api';

/** Active payment methods, for refunds and customer payments. */
export function usePaymentMethods() {
  return useQuery({
    queryKey: ['payment-methods'],
    queryFn: ({ signal }) => api.get<DataEnvelope<PaymentMethodSummary[]>>('/payment-methods', { signal }).then((r) => r.data.filter((m) => m.isActive)),
    staleTime: 60_000,
  });
}
