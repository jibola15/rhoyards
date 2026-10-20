import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AuditLogRow, DashboardData } from '@rhoyards/shared';
import { json, mockApi, renderApp, sessionFor } from '../../test/render';
// Load the lazily imported dashboard (and its charting library) while the file is collected, not inside a test's
// wait: under a full parallel run its first transform alone can take longer than the find-by timeout.
import './DashboardPage';

const dashboard: DashboardData = {
  asOf: '2026-10-19',
  stores: null,
  today: { salesCount: 3, salesTotal: '4300.00', onlineOrders: 1 },
  monthToDate: { from: '2026-10-01', netSales: '3000.00', grossProfit: '1200.00', netProfit: '-18800.00', grossMargin: '40.0' },
  balances: { cash: '1575.00', cashAccounts: [{ id: 'a', code: '1000', name: 'Cash on hand', balance: '1575.00' }], receivables: '575.00', payables: '0.00', inventory: '4200.00' },
  dailySales: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(20 + i).padStart(2, '0')}`.replace(/-09-(3[1-9]|4\d)/, (_m, d: string) => `-10-${String(Number(d) - 30).padStart(2, '0')}`), netSales: i === 29 ? '3000.00' : '0.00', sales: i === 29 ? 3 : 0 })),
  topProducts: [{ variantId: 'v1', sku: 'SN-ECG-100', name: 'Edge Control Gel — 100 g', qty: '3.000', netSales: '3000.00' }],
  attention: { lowStock: 1, outOfStock: 0, expiringSoon: 0, ordersAwaitingPayment: 2, ordersToFulfil: 0, ordersOnHold: 0, returnsToApprove: 0, expensesToApprove: 1 },
};

describe('dashboard', () => {
  it('shows the headline figures, a table view of the chart, and only the queues this user works', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['dashboard.view', 'reports.financial', 'inventory.view', 'orders.view']) }),
      'GET /dashboard': () => json(200, { data: dashboard }),
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect((await screen.findByText('Net sales this month')).nextSibling).toHaveTextContent('₦3,000.00');
    expect(screen.getByText('40.0% margin')).toBeInTheDocument();

    const attention = screen.getByRole('heading', { name: 'Needs attention' }).closest('div')!.parentElement!;
    expect(within(attention).getByRole('link', { name: /online orders awaiting payment/ })).toHaveAttribute('href', '/orders');
    expect(within(attention).getByRole('link', { name: /reorder level/ })).toHaveAttribute('href', '/reports/stock?status=low');
    expect(within(attention).queryByText(/expenses to approve/)).toBeNull(); // no expenses.approve

    await user.click(screen.getByRole('button', { name: 'Show table' }));
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('₦3,000.00'); // newest day first
    expect(screen.getByText('Edge Control Gel — 100 g')).toBeInTheDocument();
  });

  it('switches to one store: its figures, no net profit, balances marked as business-wide', async () => {
    const user = userEvent.setup();
    const store = (id: string, name: string) => ({ id, code: id.toUpperCase(), name, type: 'STORE', isPosEnabled: true, isOnlineFulfilment: false, address: null, phone: null, isActive: true });
    const asked: string[] = [];
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['dashboard.view', 'reports.financial']) }),
      'GET /locations': () => json(200, { data: [store('main', 'Main Store'), store('ikeja', 'Ikeja Store')] }),
      'GET /dashboard': (url) => {
        asked.push(url);
        return url.includes('locationId=ikeja')
          ? json(200, { data: { ...dashboard, stores: { ids: ['ikeja'], label: 'Ikeja Store' }, monthToDate: { ...dashboard.monthToDate, netProfit: null } } })
          : json(200, { data: dashboard });
      },
    });
    renderApp('/');
    await user.selectOptions(await screen.findByLabelText('Store'), 'Ikeja Store');
    expect(await screen.findByText(/Ikeja Store · as at/)).toBeInTheDocument();
    expect(screen.getByText(/expenses are not split by store/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Balances (whole business)' })).toBeInTheDocument();
    expect(asked.at(-1)).toContain('locationId=ikeja');
  });

  it('keeps the system status page for staff without the dashboard', async () => {
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['pos.sell']) }),
      'GET /health': () => json(200, { data: { status: 'ok', service: 'rhoyards-api', version: '0.1.0', uptimeSeconds: 5, time: new Date().toISOString() } }),
    });
    renderApp('/');
    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
  });
});

describe('audit log', () => {
  it('lists changes newest first and shows the before and after of one', async () => {
    const user = userEvent.setup();
    const row: AuditLogRow = {
      id: 'l1',
      action: 'account.updated',
      entityType: 'account',
      entityId: 'acc-1',
      actor: { id: 'u1', fullName: 'Ada Accountant', email: 'ada@test.local' },
      before: { name: 'Cash on hand' },
      after: { name: 'Cash in tills' },
      ip: '127.0.0.1',
      requestId: 'req-1',
      createdAt: new Date().toISOString(),
    };
    let lastQuery = '';
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['audit.view']) }),
      'GET /audit-logs': (url) => {
        lastQuery = url;
        return json(200, { data: [row], meta: { page: 1, pageSize: 50, total: 1 } });
      },
    });
    renderApp('/audit');
    expect(await screen.findByText('account.updated')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Details of account.updated' }));
    expect(screen.getByText(/"Cash in tills"/)).toBeInTheDocument();
    expect(screen.getByText(/"Cash on hand"/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Action starts with'), 'account.');
    await screen.findByText('account.updated');
    await expect.poll(() => lastQuery).toContain('action=account.');
  });
});
