import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { UserSummary } from '@rhoyards/shared';
import { json, mockApi, renderApp, sessionFor } from '../../test/render';

const ada: UserSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ada@test.local',
  username: 'ada',
  fullName: 'Ada Okafor',
  status: 'ACTIVE',
  mustChangePassword: false,
  twoFactorEnabled: true,
  lastLoginAt: null,
  createdAt: new Date().toISOString(),
  roles: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', code: 'CASHIER', name: 'Cashier' }],
  locations: [{ id: 'bbbbbbbb-0000-4000-8000-000000000001', code: 'MAIN', name: 'Main Store' }],
};

const roles = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', code: 'CASHIER', name: 'Cashier', description: null, isSystem: true, permissions: [], userCount: 1 },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', code: 'MANAGER', name: 'Manager', description: null, isSystem: true, permissions: [], userCount: 0 },
];
const locations = [{ id: 'bbbbbbbb-0000-4000-8000-000000000001', code: 'MAIN', name: 'Main Store', type: 'STORE', isPosEnabled: true, isOnlineFulfilment: true, address: null, phone: null, isActive: true }];

function baseRoutes(permissions: string[]) {
  return {
    'GET /auth/me': () => json(200, { data: sessionFor(permissions) }),
    'GET /users': () => json(200, { data: [ada], meta: { page: 1, pageSize: 20, total: 1 } }),
    'GET /roles': () => json(200, { data: roles }),
    'GET /locations': () => json(200, { data: locations }),
  };
}

describe('UsersPage', () => {
  it('resets a lost authenticator after confirmation', async () => {
    let resetCalled = '';
    mockApi({
      ...baseRoutes(['users.view', 'users.manage']),
      'POST /users/11111111-1111-4111-8111-111111111111/reset-two-factor': (url) => {
        resetCalled = url;
        return new Response(null, { status: 204 });
      },
    });
    const user = userEvent.setup();
    renderApp('/users');
    await user.click(await screen.findByRole('button', { name: 'Reset two-step sign-in for Ada Okafor' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/lost their phone/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reset two-step sign-in' }));
    expect(await screen.findByText(/Two-step sign-in reset/)).toBeInTheDocument();
    expect(resetCalled).toContain('/reset-two-factor');
  });

  it('lists users from the API', async () => {
    mockApi(baseRoutes(['users.view', 'users.manage']));
    renderApp('/users');
    const row = (await screen.findByText('Ada Okafor')).closest('tr')!;
    expect(within(row).getByText(/ada@test\.local · ada/)).toBeInTheDocument();
    expect(within(row).getByText('Cashier')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('1–1 of 1')).toBeInTheDocument();
  });

  it('hides management actions from view-only users', async () => {
    mockApi(baseRoutes(['users.view']));
    renderApp('/users');
    await screen.findByText('Ada Okafor');
    expect(screen.queryByRole('button', { name: 'New user' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Ada Okafor' })).not.toBeInTheDocument();
  });

  it('validates and creates a user, sending the CSRF token', async () => {
    let posted: unknown;
    let csrf: string | undefined;
    mockApi({
      ...baseRoutes(['users.view', 'users.manage']),
      'POST /users': (_u, init) => {
        posted = JSON.parse(String(init.body));
        csrf = (init.headers as Record<string, string>)['X-CSRF-Token'];
        return json(201, { data: { ...ada, id: 'new', fullName: 'Bola Ade' } });
      },
    });
    const user = userEvent.setup();
    renderApp('/users');
    await user.click(await screen.findByRole('button', { name: 'New user' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(await within(dialog).findByText('Full name is required')).toBeInTheDocument();
    expect(within(dialog).getByText('Password must be at least 10 characters')).toBeInTheDocument();
    expect(within(dialog).getByText('Assign at least one role')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Full name'), 'Bola Ade');
    await user.type(within(dialog).getByLabelText('Email'), 'bola@test.local');
    await user.type(within(dialog).getByLabelText('Username (optional)'), 'bola@');
    await user.type(within(dialog).getByLabelText('Temporary password'), 'temporary-pass-1');
    await user.click(within(dialog).getByRole('checkbox', { name: /Manager/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(await within(dialog).findByText(/Use 3–32 letters/)).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Username (optional)'));
    await user.type(within(dialog).getByLabelText('Username (optional)'), 'Bola');
    await user.click(within(dialog).getByRole('checkbox', { name: /Main Store/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));

    expect(await screen.findByText(/User created/)).toBeInTheDocument();
    expect(posted).toEqual({
      email: 'bola@test.local',
      username: 'bola',
      fullName: 'Bola Ade',
      password: 'temporary-pass-1',
      roleIds: ['aaaaaaaa-0000-4000-8000-000000000002'],
      locationIds: ['bbbbbbbb-0000-4000-8000-000000000001'],
    });
    expect(csrf).toBe('csrf-test-token');
  });

  it('shows a duplicate-email error from the server on the email field', async () => {
    mockApi({
      ...baseRoutes(['users.view', 'users.manage']),
      'POST /users': () =>
        json(409, { error: { code: 'CONFLICT', message: 'A user with this email already exists', details: { field: 'email' } } }),
    });
    const user = userEvent.setup();
    renderApp('/users');
    await user.click(await screen.findByRole('button', { name: 'New user' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Full name'), 'Ada Again');
    await user.type(within(dialog).getByLabelText('Email'), 'ada@test.local');
    await user.type(within(dialog).getByLabelText('Temporary password'), 'temporary-pass-1');
    await user.click(within(dialog).getByRole('checkbox', { name: /Cashier/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(await within(dialog).findByText('A user with this email already exists')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });
});
