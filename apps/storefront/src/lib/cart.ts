import { useSyncExternalStore } from 'react';

/**
 * The cart lives in this browser only (variant + quantity). Prices, stock and delivery always come from the server's
 * quote, so nothing stored here is trusted.
 */
export interface CartItem {
  variantId: string;
  qty: number;
}

const KEY = 'rh_cart';
const listeners = new Set<() => void>();
let items: CartItem[] = load();

function load(): CartItem[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((i): i is CartItem => typeof i?.variantId === 'string' && Number.isInteger(i?.qty) && i.qty > 0).slice(0, 50)
      : [];
  } catch {
    return [];
  }
}

function save(next: CartItem[]) {
  items = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable (private mode): the cart still works for this page view
  }
  for (const l of listeners) l();
}

export const cart = {
  add(variantId: string, qty = 1) {
    const existing = items.find((i) => i.variantId === variantId);
    save(existing ? items.map((i) => (i.variantId === variantId ? { ...i, qty: Math.min(i.qty + qty, 99) } : i)) : [...items, { variantId, qty }]);
  },
  setQty(variantId: string, qty: number) {
    save(qty <= 0 ? items.filter((i) => i.variantId !== variantId) : items.map((i) => (i.variantId === variantId ? { ...i, qty: Math.min(qty, 99) } : i)));
  },
  remove(variantId: string) {
    save(items.filter((i) => i.variantId !== variantId));
  },
  clear() {
    save([]);
  },
  /** For tests: re-read storage. */
  reload() {
    items = load();
    for (const l of listeners) l();
  },
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useCart(): CartItem[] {
  return useSyncExternalStore(subscribe, () => items, () => items);
}

/** Quote/checkout payload. */
export const cartPayload = (list: CartItem[]) => list.map((i) => ({ variantId: i.variantId, qty: String(i.qty) }));
