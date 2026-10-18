import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, mockApi, renderApp, sessionFor } from '../test/render';

const unauthenticated = () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });

describe('authentication flow', () => {
  it('redirects anonymous users to the login page, keeping the destination', async () => {
    mockApi({ 'GET /auth/me': unauthenticated });
    const { router } = renderApp('/users');
    expect(await screen.findByRole('heading', { name: 'Rhoyards Back Office' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?next=%2Fusers');
  });

  it('validates the login form before calling the API', async () => {
    const fetchMock = mockApi({ 'GET /auth/me': unauthenticated });
    const user = userEvent.setup();
    renderApp('/login');
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/login'))).toHaveLength(0);
  });

  it('shows the server error for bad credentials', async () => {
    mockApi({
      'GET /auth/me': unauthenticated,
      'POST /auth/login': () =>
        json(401, { error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password, or the account is temporarily locked' } }),
    });
    const user = userEvent.setup();
    renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), 'owner@test.local');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Invalid email or password/)).toBeInTheDocument();
  });

  it('signs in and continues to the requested page, ignoring off-site redirects', async () => {
    mockApi({
      'GET /auth/me': unauthenticated,
      'POST /auth/login': () => json(200, { data: sessionFor(['users.view']) }),
      'GET /users': () => json(200, { data: [], meta: { page: 1, pageSize: 20, total: 0 } }),
    });
    const user = userEvent.setup();
    const { router } = renderApp('/login?next=%2F%2Fevil.example');
    await user.type(await screen.findByLabelText('Email'), 'owner@test.local');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('forces a pending password change', async () => {
    mockApi({ 'GET /auth/me': () => json(200, { data: sessionFor(['users.view'], { mustChangePassword: true }) }) });
    const { router } = renderApp('/users');
    expect(await screen.findByRole('heading', { name: 'Change password' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/account/password');
  });

  it('shows an access-denied page for routes outside the user’s permissions', async () => {
    mockApi({ 'GET /auth/me': () => json(200, { data: sessionFor(['pos.sell']) }) });
    renderApp('/settings');
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
  });
});
