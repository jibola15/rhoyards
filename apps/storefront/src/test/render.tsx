import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import { Toaster } from '@rhoyards/ui';
import { CustomerProvider } from '../account/CustomerProvider';
import { createQueryClient } from '../lib/query-client';
import { routes } from '../routes';

export function renderStore(path = '/') {
  const queryClient = createQueryClient({ retry: false });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CustomerProvider>
        <RouterProvider router={router} />
        <Toaster />
      </CustomerProvider>
    </QueryClientProvider>,
  );
  return { ...view, router };
}

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export const unauthenticated = () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Please sign in' } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Routes fetch calls by "METHOD /path" (under /api/v1/store); unmatched calls fail loudly. */
export function mockApi(routesMap: Record<string, Handler>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.replace(/^\/api\/v1\/store/, '');
    const key = Object.keys(routesMap).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && (path === p || path.startsWith(`${p}?`));
    });
    if (!key) throw new Error(`Unmocked request: ${method} ${url}`);
    return routesMap[key]!(url, init);
  });
}
