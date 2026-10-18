import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import type { AuthSession } from '@rhoyards/shared';
import { Toaster } from '@rhoyards/ui';
import { AuthProvider } from '../auth/AuthProvider';
import { createQueryClient } from '../lib/query-client';
import { routes } from '../routes';

/** Renders the real route tree at `path` with an isolated query client. */
export function renderApp(path = '/') {
  const queryClient = createQueryClient({ retry: false });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient };
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function sessionFor(permissions: string[], overrides: Partial<AuthSession['user']> = {}): AuthSession {
  return {
    csrfToken: 'csrf-test-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'owner@test.local',
      fullName: 'Test Owner',
      mustChangePassword: false,
      roles: [{ id: 'r1', code: 'OWNER', name: 'Owner / Administrator' }],
      locationIds: [],
      permissions,
      ...overrides,
    },
  };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Routes fetch calls by "METHOD /path" prefix; unmatched calls fail loudly. */
export function mockApi(routesMap: Record<string, Handler>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.replace(/^\/api\/v1/, '');
    const key = Object.keys(routesMap).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && (path === p || path.startsWith(`${p}?`));
    });
    if (!key) throw new Error(`Unmocked request: ${method} ${url}`);
    return routesMap[key]!(url, init);
  });
}
