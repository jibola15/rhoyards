import { createApiClient } from '@rhoyards/shared';

let csrfToken: string | undefined;

/** The customer's CSRF token lives in memory only; /store/auth/me returns it again after a reload. */
export function setCsrfToken(token: string | undefined): void {
  csrfToken = token;
}

export const api = createApiClient({ baseUrl: '/api/v1/store', getCsrfToken: () => csrfToken });

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  const s = search.toString();
  return s ? `?${s}` : '';
}

// Display only: amounts arrive as exact decimal strings and are never used for arithmetic here.
const money = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeStyle: 'short' });

export const formatMoney = (v: string | null | undefined) => (v === null || v === undefined ? '—' : money.format(Number(v)));
export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : '—');
export const formatQty = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);
