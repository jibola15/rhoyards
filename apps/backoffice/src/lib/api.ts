import { createApiClient } from '@rhoyards/shared';

let csrfToken: string | undefined;

/** The CSRF token is held in memory only (never in storage); it is re-fetched with /auth/me after a reload. */
export function setCsrfToken(token: string | undefined): void {
  csrfToken = token;
}

export const api = createApiClient({ baseUrl: '/api/v1', getCsrfToken: () => csrfToken });

/** Builds a query string from defined, non-empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
