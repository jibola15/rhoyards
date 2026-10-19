import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ReconciliationDetail, ReturnableSale, ReturnDetail } from '@rhoyards/shared';
import { json, mockApi, renderApp, sessionFor } from '../../test/render';

const returnable: ReturnableSale = {
  sale: { id: 's1', number: 'S-000010', channel: 'POS', customer: null, completedAt: new Date().toISOString(), outstanding: '0.00' },
  lines: [
    { saleItemId: 'i1', sku: 'SN-ECG-100', description: 'Edge Control Gel — 100 g', qty: '3.000', returnable: '3.000', unitPrice: '1075.00', lineTotal: '3225.00' },
    { saleItemId: 'i2', sku: 'LP-RED', description: 'Lipstick — Red', qty: '1.000', returnable: '0.000', unitPrice: '2000.00', lineTotal: '2000.00' },
  ],
  shippingRefundable: '0.00',
};
const detail = (over: Partial<ReturnDetail> = {}): ReturnDetail => ({
  id: 'r1',
  number: 'RET-000001',
  status: 'APPROVED',
  sale: { id: 's1', number: 'S-000010', channel: 'POS' },
  customer: null,
  total: '2150.00',
  requestedBy: 'Test Owner',
  requestedAt: new Date().toISOString(),
  completedAt: null,
  reason: 'Wrong shade',
  rejectedReason: null,
  approvedBy: 'Test Owner',
  approvedAt: new Date().toISOString(),
  completedBy: null,
  lines: [{ id: 'l1', saleItemId: 'i1', sku: 'SN-ECG-100', description: 'Edge Control Gel — 100 g', qty: '2.000', condition: 'DAMAGED', restock: false, net: '2000.00', tax: '150.00', total: '2150.00', unitCost: '600.0000' }],
  shippingNet: '0.00',
  shippingTax: '0.00',
  net: '2000.00',
  tax: '150.00',
  creditedToAccount: '0.00',
  paidOut: '0.00',
  refundMethod: null,
  refundReference: null,
  journalEntryId: null,
  ...over,
});
const STAFF = ['returns.create', 'returns.approve', 'refunds.process', 'sales.view', 'settings.view'];

describe('returns', () => {
  it('builds a return from what is left on the sale, never restocking damaged items', async () => {
    const user = userEvent.setup();
    let body: { lines: unknown[]; approve: boolean } | undefined;
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(STAFF) }),
      'GET /sales/s1/returnable': () => json(200, { data: returnable }),
      'POST /returns': (_u, init) => {
        body = JSON.parse(String(init.body));
        return json(201, { data: detail() });
      },
      'GET /returns/r1': () => json(200, { data: detail() }),
    });
    renderApp('/returns/new?saleId=s1');
    expect(await screen.findByLabelText('Quantity of Lipstick — Red to return')).toBeDisabled(); // nothing left
    await user.type(screen.getByLabelText('Quantity of Edge Control Gel — 100 g to return'), '2');
    await user.selectOptions(screen.getByLabelText('Condition of Edge Control Gel — 100 g'), 'DAMAGED');
    expect(screen.getByLabelText('Put Edge Control Gel — 100 g back in stock')).toBeDisabled();
    await user.type(screen.getByLabelText('Reason'), 'Lid broken');
    await user.click(screen.getByRole('button', { name: 'Create and approve return' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({ approve: true, lines: [{ saleItemId: 'i1', qty: '2', condition: 'DAMAGED', restock: false }] });
  });

  it('refunds an approved return once, with an idempotency key', async () => {
    const user = userEvent.setup();
    let headers: Record<string, string> | undefined;
    const refunded = detail({ status: 'COMPLETED', paidOut: '2150.00', completedAt: new Date().toISOString(), refundMethod: { id: 'pm-cash', name: 'Cash' } });
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(STAFF) }),
      'GET /returns/r1': () => json(200, { data: headers ? refunded : detail() }),
      'GET /payment-methods': () => json(200, { data: [{ id: 'pm-cash', code: 'CASH', name: 'Cash', kind: 'CASH', account: { id: 'a', code: '1000', name: 'Cash' }, requiresReference: false, availablePos: true, availableOnline: false, isActive: true, sortOrder: 0 }] }),
      'POST /returns/r1/refund': (_u, init) => {
        headers = init.headers as Record<string, string>;
        return json(200, { data: refunded });
      },
    });
    renderApp('/returns/r1');
    await user.click(await screen.findByRole('button', { name: 'Refund ₦2,150.00' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Pay back by'), 'pm-cash');
    await user.click(within(dialog).getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(headers?.['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/));
    expect(await screen.findByText('Paid back (Cash)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refund ₦2,150.00' })).toBeNull();
  });
});

describe('bank reconciliation', () => {
  it('shows the running difference as lines are ticked and completes only at nil', async () => {
    const user = userEvent.setup();
    const rec: ReconciliationDetail = {
      id: 'rc1',
      account: { id: 'a1', code: '1010', name: 'Bank - main account' },
      statementDate: '2026-10-31',
      statementBalance: '1500.00',
      status: 'IN_PROGRESS',
      completedAt: null,
      completedBy: null,
      openingBalance: '0.00',
      clearedBalance: '0.00',
      difference: '1500.00',
      lines: [
        { journalLineId: 'jl1', entryId: 'e1', number: 'JE-000001', date: '2026-10-02', description: 'Customer payment', memo: null, debit: '2000.00', credit: '0.00', cleared: false },
        { journalLineId: 'jl2', entryId: 'e2', number: 'JE-000002', date: '2026-10-05', description: 'Rent', memo: null, debit: '0.00', credit: '500.00', cleared: false },
      ],
    };
    let saved: unknown;
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['reconciliation.manage']) }),
      'GET /reconciliations/rc1': () => json(200, { data: rec }),
      'PUT /reconciliations/rc1/lines': (_u, init) => {
        saved = JSON.parse(String(init.body));
        return json(200, { data: { ...rec, lines: rec.lines.map((l) => ({ ...l, cleared: true })), clearedBalance: '1500.00', difference: '0.00' } });
      },
      'POST /reconciliations/rc1/complete': () => json(200, { data: { ...rec, status: 'COMPLETED', difference: '0.00', clearedBalance: '1500.00', completedAt: new Date().toISOString(), completedBy: 'Test Owner' } }),
      'GET /reconciliations': () => json(200, { data: [] }),
    });
    renderApp('/banking/reconciliations/rc1');
    const complete = await screen.findByRole('button', { name: 'Complete' });
    expect(complete).toBeDisabled();
    await user.click(screen.getByLabelText('Cleared: JE-000001 Customer payment'));
    expect(complete).toBeDisabled(); // 2,000 ticked against 1,500
    await user.click(screen.getByLabelText('Cleared: JE-000002 Rent'));
    expect(complete).toBeEnabled();
    await user.click(complete);
    await waitFor(() => expect(saved).toEqual({ cleared: ['jl1', 'jl2'] }));
    expect(await screen.findByText(/These lines are cleared for good/)).toBeInTheDocument();
  });
});
