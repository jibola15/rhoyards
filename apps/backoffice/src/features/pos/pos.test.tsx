import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PaymentMethodSummary, PosContext, SaleDetail, ShiftSummary, VariantLookup } from '@rhoyards/shared';
import { json, mockApi, renderApp, sessionFor } from '../../test/render';
import { allocatePayments } from './payments';

const MAIN = '22222222-0000-4000-8000-000000000001';
const TILL = '77777777-0000-4000-8000-000000000001';
const account = { id: 'a1', code: '1000', name: 'Cash on hand' };
const methods: PaymentMethodSummary[] = [
  { id: 'pm-cash', code: 'CASH', name: 'Cash', kind: 'CASH', account, requiresReference: false, availablePos: true, availableOnline: false, isActive: true, sortOrder: 0 },
  { id: 'pm-card', code: 'CARD', name: 'Card', kind: 'CARD', account, requiresReference: false, availablePos: true, availableOnline: false, isActive: true, sortOrder: 1 },
  { id: 'pm-trf', code: 'TRANSFER', name: 'Bank transfer', kind: 'BANK_TRANSFER', account, requiresReference: true, availablePos: true, availableOnline: false, isActive: true, sortOrder: 2 },
];

const shift: ShiftSummary = {
  id: 'shift-1',
  number: 'SH-000001',
  status: 'OPEN',
  register: { id: TILL, name: 'Till 1', locationId: MAIN, locationName: 'Main Store' },
  cashier: { id: '00000000-0000-4000-8000-000000000001', name: 'Test Owner' },
  openedAt: new Date().toISOString(),
  closedAt: null,
  closedBy: null,
  openingFloat: '5000.00',
  salesCount: 0,
  salesTotal: '0.00',
  discountTotal: '0.00',
  taxTotal: '0.00',
  creditTotal: '0.00',
  byMethod: [],
  expectedCash: '5000.00',
  countedCash: null,
  variance: null,
  closeNote: null,
};

const context = (myShift: ShiftSummary | null, pricesIncludeTax = true): PosContext => ({
  registers: [{ id: TILL, name: 'Till 1', location: { id: MAIN, name: 'Main Store' }, isActive: true, openShift: null }],
  myShift,
  paymentMethods: methods,
  pricing: { pricesIncludeTax, vatRegistered: true, maxDiscountPercent: '10' },
  inventory: { blockExpiredSale: true, allowNegativeStock: false },
  currency: { code: 'NGN', symbol: '₦' },
});

const gel: VariantLookup = {
  id: '66666666-0000-4000-8000-000000000001',
  sku: 'SN-ECG-100',
  name: '100 g',
  productId: 'p1',
  productName: 'Edge Control Gel',
  brandName: null,
  sellingPrice: '1075.00',
  avgCost: '600.0000',
  isBatchTracked: false,
  isExpiryTracked: false,
  allowsFraction: false,
  unitCode: 'PC',
  status: 'ACTIVE',
  productStatus: 'ACTIVE',
  qtyOnHand: '10.000',
  qtyAvailable: '10.000',
  barcodes: ['2000000000097'],
  taxRateId: 'vat',
  taxRate: '7.5000',
  standardCost: null,
};

const completed = { id: 'sale-1', number: 'S-000001', total: '2150.00', changeGiven: '850.00', balanceDue: '0.00', customer: null } as SaleDetail;
const SELLER = ['pos.sell', 'pos.discount', 'pos.shift.manage', 'catalog.view', 'customers.view'];

const tillRoutes = (extra: Record<string, Parameters<typeof mockApi>[0][string]> = {}, perms = SELLER) => ({
  'GET /auth/me': () => json(200, { data: sessionFor(perms) }),
  'GET /pos/context': () => json(200, { data: context(shift) }),
  'GET /pos/sales/suspended': () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } }),
  'GET /variants': () => json(200, { data: [], meta: { page: 1, pageSize: 10, total: 0 } }),
  'GET /variants/by-code/2000000000097': () => json(200, { data: gel }),
  ...extra,
});

async function scanTwice(user: ReturnType<typeof userEvent.setup>) {
  const scanner = await screen.findByRole('combobox', { name: 'Scan or search a product' });
  await user.type(scanner, '2000000000097{Enter}');
  await screen.findByText('Edge Control Gel — 100 g');
  await user.type(scanner, '2000000000097{Enter}');
  await waitFor(() => expect(screen.getByLabelText('Quantity of Edge Control Gel — 100 g')).toHaveValue('2'));
}

describe('point of sale', () => {
  it('asks the cashier to open a shift first', async () => {
    let opened: unknown;
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(SELLER) }),
      'GET /pos/context': () => json(200, { data: context(null) }),
      'POST /pos/shifts/open': (_u, init) => {
        opened = JSON.parse(String(init.body));
        return json(201, { data: shift });
      },
    });
    const user = userEvent.setup();
    renderApp('/pos');
    const float = await screen.findByLabelText(/Opening cash float/);
    await user.clear(float);
    await user.type(float, '5000');
    await user.click(screen.getByRole('button', { name: 'Open shift' }));
    await waitFor(() => expect(opened).toEqual({ registerId: TILL, openingFloat: '5000' }));
  });

  it('rings up a scanned item, takes cash with change, and sends an idempotency key', async () => {
    const posts: { body: { lines: unknown[]; payments: unknown[] }; key: string | null }[] = [];
    mockApi(
      tillRoutes({
        'POST /pos/sales': (_u, init) => {
          posts.push({ body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('Idempotency-Key') });
          // The first attempt fails as if the connection dropped; the retry succeeds.
          return posts.length === 1 ? json(503, { error: { code: 'UNAVAILABLE', message: 'Service unavailable' } }) : json(201, { data: completed });
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/pos');
    await scanTwice(user);

    // VAT-inclusive: 2 × 1,075 = 2,150 of which VAT 150.
    expect(screen.getByTestId('cart-total')).toHaveTextContent('2,150.00');
    expect(screen.getByText('VAT included').nextElementSibling).toHaveTextContent('150.00');

    await user.click(screen.getByRole('button', { name: /^Pay/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Take payment' });
    const received = within(dialog).getByLabelText('Cash received');
    await user.clear(received);
    await user.type(received, '3000');
    expect(within(dialog).getByText('Change due').nextElementSibling).toHaveTextContent('850.00');

    await user.click(within(dialog).getByRole('button', { name: 'Complete sale' }));
    expect(await within(dialog).findByText('Service unavailable')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Complete sale' }));

    expect(await screen.findByText('Sale S-000001 complete')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Change: ₦850.00');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts[1]!.key).toBe(posts[0]!.key);
    expect(posts[1]!.body).toMatchObject({
      registerId: TILL,
      customerId: null,
      lines: [{ variantId: gel.id, qty: '2', unitPrice: '1075.00', discount: null }],
      payments: [{ paymentMethodId: 'pm-cash', amount: '2150.00', tendered: '3000.00', reference: null }],
    });
  });

  it('asks for a supervisor when the discount is over the limit', async () => {
    const bodies: { discountApproval?: unknown }[] = [];
    mockApi(
      tillRoutes({
        'POST /pos/sales': (_u, init) => {
          const body = JSON.parse(String(init.body));
          bodies.push(body);
          return body.discountApproval
            ? json(201, { data: { ...completed, changeGiven: '0.00' } })
            : json(403, { error: { code: 'FORBIDDEN', message: 'This discount needs a supervisor’s approval', details: { approvalRequired: true } } });
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/pos');
    await scanTwice(user);
    await user.click(screen.getByRole('button', { name: 'Discount Edge Control Gel — 100 g' }));
    await user.type(screen.getByLabelText('Percent'), '20');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    // 20% off 2,150 = 430 → 1,720.
    expect(screen.getByTestId('cart-total')).toHaveTextContent('1,720.00');

    await user.click(screen.getByRole('button', { name: /^Pay/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Take payment' });
    await user.click(within(dialog).getByRole('button', { name: 'Complete sale' }));
    await user.type(await within(dialog).findByLabelText('Supervisor email'), 'manager@test.local');
    await user.type(within(dialog).getByLabelText('Supervisor password'), 'secret-pass');
    await user.click(within(dialog).getByRole('button', { name: 'Complete sale' }));
    expect(await screen.findByText('Sale S-000001 complete')).toBeInTheDocument();
    expect(bodies[1]).toMatchObject({ discountApproval: { email: 'manager@test.local', password: 'secret-pass' }, lines: [{ discount: { type: 'percent', value: '20' } }] });
  });

  it('shows the Sales menu to staff with either sales permission', async () => {
    mockApi({ 'GET /auth/me': () => json(200, { data: sessionFor(['sales.view']) }), 'GET /sales': () => json(200, { data: [], meta: { page: 1, pageSize: 25, total: 0 } }) });
    renderApp('/sales');
    expect(await screen.findByRole('heading', { name: 'Sales' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Point of sale' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Shifts' })).toBeInTheDocument();
  });
});

describe('allocatePayments', () => {
  it('applies card first, cash covers the rest, and extra cash is change', () => {
    const r = allocatePayments('10000.00', [
      { methodId: 'pm-cash', value: '5000', reference: '' },
      { methodId: 'pm-card', value: '6000', reference: '' },
    ], methods);
    expect(r.applied.map((a) => [a.amount.toFixed(2), a.tendered])).toEqual([
      ['4000.00', '5000.00'],
      ['6000.00', null],
    ]);
    expect(r.change.toFixed(2)).toBe('1000.00');
    expect(r.remaining.toFixed(2)).toBe('0.00');
  });

  it('flags card/transfer amounts above the total and reports what is left', () => {
    expect(allocatePayments('100.00', [{ methodId: 'pm-card', value: '150', reference: '' }], methods).overpaid).toBe(true);
    const short = allocatePayments('100.00', [{ methodId: 'pm-trf', value: '40', reference: 'x' }], methods);
    expect(short.remaining.toFixed(2)).toBe('60.00');
    expect(short.change.toFixed(2)).toBe('0.00');
  });
});
