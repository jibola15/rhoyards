import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, mockApi, renderApp, sessionFor } from '../test/render';

describe('account security', () => {
  it('shows two-step status and replaces backup codes with a current code', async () => {
    let sent: unknown;
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor([], { username: 'owner' }) }),
      'GET /auth/two-factor': () => json(200, { data: { enabledAt: '2026-10-19T09:00:00.000Z', backupCodesLeft: 2 } }),
      'POST /auth/two-factor/backup-codes': (_u, init) => {
        sent = JSON.parse(String(init.body));
        return (sent as { code: string }).code === '123456'
          ? json(200, { data: { backupCodes: Array.from({ length: 10 }, (_, i) => `new${i}0-codes`) } })
          : json(422, { error: { code: 'BUSINESS_RULE', message: 'That code is not right.', details: { field: 'code' } } });
      },
    });
    const user = userEvent.setup();
    renderApp('/account/security');
    expect(await screen.findByText('2 backup codes left.')).toBeInTheDocument();
    expect(screen.getByText(/username owner/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Current code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Generate new backup codes' }));
    expect(await screen.findByText('That code is not right.')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Current code'));
    await user.type(screen.getByLabelText('Current code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Generate new backup codes' }));
    const list = await screen.findByRole('list', { name: 'Backup codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(sent).toEqual({ code: '123456' });
  });
});
