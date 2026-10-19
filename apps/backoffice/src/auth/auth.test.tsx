import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { LoginStep } from '@rhoyards/shared';
import { json, mockApi, renderApp, sessionFor } from '../test/render';

const unauthenticated = () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
const challenge: LoginStep = { next: 'TWO_FACTOR', challengeToken: 'c'.repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString() };

async function enterPassword(user: ReturnType<typeof userEvent.setup>, identifier = 'owner@test.local') {
  await user.type(await screen.findByLabelText('Email or username'), identifier);
  await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

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
    expect(await screen.findByText('Enter your email or username')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/login'))).toHaveLength(0);
  });

  it('shows the server error for bad credentials', async () => {
    mockApi({
      'GET /auth/me': unauthenticated,
      'POST /auth/login': () =>
        json(401, { error: { code: 'UNAUTHENTICATED', message: 'Invalid email, username or password, or the account is temporarily locked' } }),
    });
    const user = userEvent.setup();
    renderApp('/login');
    await enterPassword(user);
    expect(await screen.findByText(/Invalid email, username or password/)).toBeInTheDocument();
  });

  it('signs in with a username and an authenticator code, continuing to the page asked for, never off-site', async () => {
    let sentLogin: unknown;
    let sentCode: unknown;
    mockApi({
      'GET /auth/me': unauthenticated,
      'POST /auth/login': (_u, init) => {
        sentLogin = JSON.parse(String(init.body));
        return json(200, { data: challenge });
      },
      'POST /auth/login/two-factor': (_u, init) => {
        sentCode = JSON.parse(String(init.body));
        return sentCode && (sentCode as { code: string }).code === '123456'
          ? json(200, { data: sessionFor(['users.view']) })
          : json(401, { error: { code: 'UNAUTHENTICATED', message: 'That code is not right. Check your authenticator app and try again.' } });
      },
      'GET /users': () => json(200, { data: [], meta: { page: 1, pageSize: 20, total: 0 } }),
    });
    const user = userEvent.setup();
    const { router } = renderApp('/login?next=%2F%2Fevil.example');
    await enterPassword(user, 'ada');
    expect(sentLogin).toEqual({ identifier: 'ada', password: 'correct-horse-battery' });

    await user.type(await screen.findByLabelText('Authentication code'), '654321');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/That code is not right/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Authentication code'), '123 456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(sentCode).toEqual({ challengeToken: challenge.challengeToken, code: '123456' });
  });

  it('accepts a backup code instead, and goes back to the password when the sign-in has expired', async () => {
    let calls = 0;
    mockApi({
      'GET /auth/me': unauthenticated,
      'POST /auth/login': () => json(200, { data: challenge }),
      'POST /auth/login/two-factor': () => {
        calls += 1;
        return json(401, { error: { code: 'UNAUTHENTICATED', message: 'This sign-in has expired. Please sign in again.', details: { restart: true } } });
      },
    });
    const user = userEvent.setup();
    renderApp('/login');
    await enterPassword(user);
    await user.click(await screen.findByRole('button', { name: /Use a backup code/ }));
    await user.type(screen.getByLabelText('Backup code'), 'abcde-fghjk');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('This sign-in has expired. Please sign in again.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email or username')).toBeInTheDocument();
    expect(calls).toBe(1);
  });

  it('sets up an authenticator at first sign-in and shows the backup codes before continuing', async () => {
    const setupStep: LoginStep = {
      next: 'TWO_FACTOR_SETUP',
      challengeToken: 's'.repeat(43),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      setup: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/Rhoyards%3Aowner%40test.local?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' },
    };
    const codes = Array.from({ length: 10 }, (_, i) => `aaaa${i}-bbbbb`);
    mockApi({
      'GET /auth/me': unauthenticated,
      'POST /auth/login': () => json(200, { data: setupStep }),
      'POST /auth/login/two-factor-setup': () => json(200, { data: { ...sessionFor(['users.view'], { mustChangePassword: true }), backupCodes: codes } }),
    });
    const user = userEvent.setup();
    const { router } = renderApp('/login');
    await enterPassword(user);
    expect(await screen.findByTitle('QR code for your authenticator app')).toBeInTheDocument();
    expect(screen.getByLabelText('Set-up key')).toHaveTextContent('JBSW Y3DP');
    await user.type(screen.getByLabelText('Code from the app'), '123456');
    await user.click(screen.getByRole('button', { name: 'Turn on two-step sign-in' }));

    const list = await screen.findByRole('list', { name: 'Backup codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(router.state.location.pathname).toBe('/login');
    const proceed = screen.getByRole('button', { name: 'Continue' });
    expect(proceed).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'I have saved my backup codes' }));
    await user.click(proceed);
    await waitFor(() => expect(router.state.location.pathname).toBe('/account/password'));
  });

  it('requests a reset link and sets a new password from the emailed link', async () => {
    let requested: unknown;
    let confirmed: unknown;
    mockApi({
      'GET /auth/me': unauthenticated,
      'POST /auth/password-reset': (_u, init) => {
        requested = JSON.parse(String(init.body));
        return json(202, { data: { message: 'ok' } });
      },
      'POST /auth/password-reset/confirm': (_u, init) => {
        confirmed = JSON.parse(String(init.body));
        return new Response(null, { status: 204 });
      },
    });
    const user = userEvent.setup();
    const { unmount } = renderApp('/login');
    await user.click(await screen.findByRole('link', { name: 'Forgot your password?' }));
    await user.type(await screen.findByLabelText('Email or username'), 'ada');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If an account matches/)).toBeInTheDocument();
    expect(requested).toEqual({ identifier: 'ada' });
    unmount();

    window.history.replaceState(null, '', '/reset-password#token=' + 't'.repeat(43));
    renderApp('/reset-password');
    expect(window.location.hash).toBe('');
    await user.type(await screen.findByLabelText('New password'), 'a-fresh-passphrase');
    await user.type(screen.getByLabelText('Confirm new password'), 'a-fresh-passphrase');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText(/Your password has been changed/)).toBeInTheDocument();
    expect(confirmed).toEqual({ token: 't'.repeat(43), newPassword: 'a-fresh-passphrase' });
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
