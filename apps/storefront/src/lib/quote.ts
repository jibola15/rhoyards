import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { CartProblem, CartQuote, DataEnvelope } from '@rhoyards/shared';
import { api } from './api';
import { cartPayload, useCart } from './cart';

export const PROBLEM_TEXT: Record<CartProblem, string> = {
  UNAVAILABLE: 'No longer sold online',
  OUT_OF_STOCK: 'Out of stock',
  INSUFFICIENT: 'Not enough in stock',
};

/** Server-side price and stock check for the cart (and a delivery choice, at checkout). */
export function useQuote(extra: { shippingMethodId?: string; state?: string } = {}) {
  const items = useCart();
  return useQuery<CartQuote>({
    queryKey: ['store', 'quote', items, extra],
    queryFn: ({ signal }) => api.post<DataEnvelope<CartQuote>>('/cart/quote', { items: cartPayload(items), ...extra }, { signal }).then((r) => r.data),
    enabled: items.length > 0,
    placeholderData: keepPreviousData,
  });
}
