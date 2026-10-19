import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AccountRow, BalanceSheet, FiscalYearRow, JournalDetail } from '@rhoyards/shared';
import { json, mockApi, renderApp, sessionFor } from '../../test/render';

const account = (id: string, code: string, name: string, type: AccountRow['type'], extra: Partial<AccountRow> = {}): AccountRow => ({
  id,
  code,
  name,
  type,
  subtype: null,
  description: null,
  parentId: null,
  isPostable: true,
  isActive: true,
  systemKey: null,
  isControl: false,
  balance: '0.00',
  hasEntries: false,
  ...extra,
});
const accounts = [
  account('acc-bank', '1010', 'Bank - main account', 'ASSET', { subtype: 'CASH', systemKey: 'BANK_MAIN' }),
  account('acc-ar', '1100', 'Accounts receivable', 'ASSET', { systemKey: 'AR', isControl: true }),
  account('acc-rent', '6000', 'Rent', 'EXPENSE', { subtype: 'OPERATING_EXPENSE' }),
];
const ACCOUNTANT = ['accounting.view', 'journals.create', 'journals.post', 'journals.reverse', 'periods.manage', 'reports.financial'];
const me = (perms: string[]) => ({ 'GET /auth/me': () => json(200, { data: sessionFor(perms) }) });

describe('manual journal editor', () => {
  it('shows the difference, refuses an unbalanced entry, and saves a balanced draft', async () => {
    const user = userEvent.setup();
    let sent: { lines: { accountId: string; debit: string; credit: string }[] } | undefined;
    mockApi({
      ...me(ACCOUNTANT),
      'GET /accounting/accounts': () => json(200, { data: accounts }),
      'POST /accounting/journals': (_url, init) => {
        sent = JSON.parse(String(init.body));
        return json(201, { data: { id: 'j1' } as JournalDetail });
      },
      'GET /accounting/journals/j1': () => json(404, { error: { code: 'NOT_FOUND', message: 'gone' } }),
    });
    renderApp('/accounting/journals/new');

    const selects = await screen.findAllByLabelText('Account');
    const options = within(selects[0]!).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('6000 Rent');
    expect(options).not.toContain('1100 Accounts receivable'); // control account

    await user.type(screen.getByLabelText('Description'), 'October rent');
    await user.selectOptions(selects[0]!, 'acc-rent');
    await user.type(screen.getAllByLabelText('Debit')[0]!, '50000');
    await user.selectOptions(selects[1]!, 'acc-bank');
    await user.type(screen.getAllByLabelText('Credit')[1]!, '40000');
    expect(screen.getByText('Difference').nextSibling).toHaveTextContent('10,000.00');

    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(/Debits and credits differ by/)).toBeInTheDocument();
    expect(sent).toBeUndefined();

    await user.clear(screen.getAllByLabelText('Credit')[1]!);
    await user.type(screen.getAllByLabelText('Credit')[1]!, '50000');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(sent).toBeDefined());
    expect(sent!.lines).toEqual([
      { accountId: 'acc-rent', debit: '50000', credit: '', memo: '' },
      { accountId: 'acc-bank', debit: '', credit: '50000', memo: '' },
    ]);
  });
});

describe('accounting periods', () => {
  it('offers to close only the next period in order, and reopen only the latest closed one', async () => {
    const user = userEvent.setup();
    const period = (i: number, status: 'OPEN' | 'CLOSED') => ({
      id: `p${i}`,
      name: ['Jan', 'Feb', 'Mar'][i] + ' 2026',
      startDate: `2026-0${i + 1}-01`,
      endDate: `2026-0${i + 1}-28`,
      status,
      closedAt: status === 'CLOSED' ? new Date().toISOString() : null,
      closedBy: status === 'CLOSED' ? 'Ada' : null,
      draftJournals: i === 2 ? 1 : 0,
    });
    const year: FiscalYearRow = { id: 'fy', name: 'FY2026', startDate: '2026-01-01', endDate: '2026-12-31', status: 'OPEN', closingEntry: null, periods: [period(0, 'CLOSED'), period(1, 'OPEN'), period(2, 'OPEN')] };
    let closed: string | undefined;
    mockApi({
      ...me(ACCOUNTANT),
      'GET /accounting/fiscal-years': () => json(200, { data: [year] }),
      'POST /accounting/periods/p1/close': () => {
        closed = 'p1';
        return json(200, { data: [{ ...year, periods: [period(0, 'CLOSED'), period(1, 'CLOSED'), period(2, 'OPEN')] }] });
      },
      'GET /accounting/accounts': () => json(200, { data: accounts }),
      'GET /accounting/journals': () => json(200, { data: [], meta: { page: 1, pageSize: 25, total: 0 } }),
      'GET /accounting/opening-balances': () => json(200, { data: { current: null, accounts: [] } }),
    });
    renderApp('/accounting/periods');

    const rows = await screen.findAllByRole('row');
    const row = (name: string) => rows.find((r) => r.textContent?.includes(name))!;
    expect(within(row('Jan 2026')).getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    expect(within(row('Feb 2026')).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(within(row('Mar 2026')).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(within(row('Mar 2026')).getByText('1 draft')).toBeInTheDocument();

    await user.click(within(row('Feb 2026')).getByRole('button', { name: 'Close' }));
    await user.click(await screen.findByRole('button', { name: 'Close period' }));
    await waitFor(() => expect(closed).toBe('p1'));
  });
});

describe('financial statements', () => {
  it('shows a balance sheet to a manager, with losses in brackets, without the ledger menus', async () => {
    const ref = (id: string, code: string, name: string, type: AccountRow['type']) => ({ id, code, name, type });
    const bs: BalanceSheet = {
      asOf: '2026-10-19',
      assets: [{ key: 'CASH', label: 'Cash and bank', rows: [{ account: ref('acc-bank', '1010', 'Bank - main account', 'ASSET'), amount: '160000.00' }], total: '160000.00' }],
      totalAssets: '160000.00',
      liabilities: [],
      totalLiabilities: '0.00',
      equity: { key: 'equity', label: 'Equity', rows: [{ account: ref('acc-cap', '3000', "Owner's capital", 'EQUITY'), amount: '200000.00' }], total: '200000.00' },
      currentEarnings: '-40000.00',
      totalEquity: '160000.00',
      totalLiabilitiesAndEquity: '160000.00',
      balanced: true,
    };
    mockApi({ ...me(['reports.financial', 'dashboard.view']), 'GET /reports/balance-sheet': () => json(200, { data: bs }) });
    renderApp('/reports/balance-sheet');

    expect(await screen.findByText('Total assets')).toBeInTheDocument();
    expect(screen.getByText('(₦40,000.00)')).toBeInTheDocument();
    // Without accounting.view the account names are plain text, not ledger links.
    expect(screen.queryByRole('link', { name: /Owner's capital/ })).toBeNull();
    const nav = screen.getByRole('navigation', { name: /main/i });
    expect(within(nav).getByRole('link', { name: 'Balance sheet' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Journals' })).toBeNull();
  });
});
