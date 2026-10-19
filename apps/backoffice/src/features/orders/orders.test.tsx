import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { OrderDetail } from '@rhoyards/shared';
import { json, mockApi, renderApp, sessionFor } from '../../test/render';

const order = (over: Partial<OrderDetail> = {}): OrderDetail => ({
  id: 'o1',
  number: 'WEB-000007',
  status: 'PENDING_PAYMENT',
  placedAt: new Date().toISOString(),
  paidAt: null,
  reservedUntil: new Date(Date.now() + 3_600_000).toISOString(),
  items: [{ lineNo: 1, variantId: 'v1', sku: 'SN-ECG-100', description: 'Edge Control Gel — 100 g', qty: '2.000', unitPrice: '1075.00', net: '2000.00', tax: '150.00', total: '2150.00' }],
  itemsTotal: '2150.00',
  shipping: { name: 'Pick up in store', isPickup: true, fee: '0.00' },
  subtotal: '2000.00',
  taxTotal: '150.00',
  total: '2150.00',
  pricesIncludeTax: true,
  address: null,
  trackingReference: null,
  payment: { provider: 'MANUAL', reference: 'WEB-000007', status: 'INITIATED', instructions: 'Pay to…', redirectUrl: null },
  history: [{ from: null, to: 'PENDING_PAYMENT', at: new Date().toISOString(), by: 'Customer', note: null }],
  canCancel: true,
  customer: { id: 'c1', code: 'CUS-000001', name: 'Ada Obi', email: 'ada@shop.test', phone: '08031112222' },
  location: { id: 'l1', name: 'Main Store' },
  note: null,
  sale: null,
  payments: [{ id: 'pa1', provider: 'MANUAL', reference: 'WEB-000007', amount: '2150.00', status: 'INITIATED', verifiedAt: null, verifiedBy: null, createdAt: new Date().toISOString() }],
  depositJournalId: null,
  ...over,
});

describe('online order page', () => {
  it('lets a payments verifier confirm a bank transfer with the bank reference, then offers the next step', async () => {
    const user = userEvent.setup();
    let verified: unknown;
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['orders.view', 'orders.manage', 'payments.verify']) }),
      'GET /orders/o1': () => json(200, { data: order() }),
      'POST /orders/o1/verify-payment': (_u, init) => {
        verified = JSON.parse(String(init.body));
        return json(200, { data: order({ status: 'PAID', sale: { id: 's1', number: 'S-000042' }, reservedUntil: null, canCancel: false }), meta: { result: 'PAID' } });
      },
      'GET /orders': () => json(200, { data: [], meta: { page: 1, pageSize: 25, total: 0 } }),
    });
    renderApp('/orders/o1');

    await user.click(await screen.findByRole('button', { name: 'Confirm bank transfer' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Confirm payment' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Bank transaction reference'), 'GTB-778812');
    await user.click(confirm);
    await waitFor(() => expect(verified).toEqual({ reference: 'GTB-778812' }));
    expect(await screen.findByRole('link', { name: 'S-000042' })).toHaveAttribute('href', '/sales/s1');
    expect(screen.getByRole('button', { name: 'Start processing' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm bank transfer' })).toBeNull();
  });

  it('hides payment confirmation from staff without payments.verify', async () => {
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['orders.view', 'orders.manage']) }),
      'GET /orders/o1': () => json(200, { data: order() }),
    });
    renderApp('/orders/o1');
    expect(await screen.findByRole('button', { name: 'Cancel order' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm bank transfer' })).toBeNull();
  });
});
