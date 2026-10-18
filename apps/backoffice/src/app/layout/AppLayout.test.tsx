import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '@rhoyards/shared';
import { json, mockApi, renderApp, sessionFor } from '../../test/render';

const health = () => json(200, { data: { status: 'ok', service: 'rhoyards-api', version: '0.1.0', uptimeSeconds: 5, time: new Date().toISOString() } });

describe('AppLayout', () => {
  it('renders navigation, top bar with the signed-in user, and the main landmark', async () => {
    mockApi({ 'GET /auth/me': () => json(200, { data: sessionFor([...ALL_PERMISSIONS]) }), 'GET /health': health });
    renderApp('/');
    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'System status' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Test Owner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('only shows navigation the user is permitted to use', async () => {
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['pos.sell'], { roles: [{ id: 'c', code: 'CASHIER', name: 'Cashier' }] }) }),
      'GET /health': health,
    });
    renderApp('/');
    await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(screen.queryByRole('link', { name: 'Staff users' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('collapses the sidebar and remembers the preference', async () => {
    mockApi({ 'GET /auth/me': () => json(200, { data: sessionFor([]) }), 'GET /health': health });
    const user = userEvent.setup();
    renderApp('/');
    await user.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false');
    expect(localStorage.getItem('sidebar-collapsed')).toBe('true');
  });

  it('toggles dark mode', async () => {
    mockApi({ 'GET /auth/me': () => json(200, { data: sessionFor([]) }), 'GET /health': health });
    const user = userEvent.setup();
    renderApp('/');
    await user.click(await screen.findByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement).toHaveClass('dark');
    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('signs out and returns to the login page', async () => {
    let signedIn = true;
    mockApi({
      'GET /auth/me': () => (signedIn ? json(200, { data: sessionFor([]) }) : json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } })),
      'GET /health': health,
      'POST /auth/logout': (_u, init) => {
        expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-test-token');
        signedIn = false;
        return new Response(null, { status: 204 });
      },
    });
    const user = userEvent.setup();
    renderApp('/');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
