import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { OpenReceiptLine, PurchaseOrderDetail, SupplierInvoiceSummary, VariantLookup } from '@rhoyards/shared';
import { json, mockApi, renderApp, sessionFor } from '../../test/render';

const SUPPLIER = '11111111-0000-4000-8000-000000000001';
const MAIN = '22222222-0000-4000-8000-000000000001';
const BANK = '33333333-0000-4000-8000-000000000001';
const VAT = '44444444-0000-4000-8000-000000000001';
const PO_ID = '55555555-0000-4000-8000-000000000001';

const reference = {
  'GET /suppliers': () => json(200, { data: [{ id: SUPPLIER, code: 'SUP-000001', name: 'Glow Beauty Wholesale', paymentTermsDays: 30, isActive: true }], meta: { page: 1, pageSize: 100, total: 1 } }),
  'GET /locations': () => json(200, { data: [{ id: MAIN, code: 'MAIN', name: 'Main Store', type: 'STORE', isPosEnabled: true, isOnlineFulfilment: true, address: null, phone: null, isActive: true }] }),
  'GET /tax-rates': () => json(200, { data: [{ id: VAT, code: 'VAT', name: 'VAT', kind: 'STANDARD', rate: '7.5000', isActive: true }] }),
};

const variant: VariantLookup = {
  id: '66666666-0000-4000-8000-000000000001',
  sku: 'SN-ECG-100',
  name: '100 g',
  productId: 'p1',
  productName: 'Edge Control Gel',
  brandName: null,
  sellingPrice: '3500.00',
  avgCost: '1600.0000',
  isBatchTracked: false,
  isExpiryTracked: false,
  allowsFraction: false,
  unitCode: 'PC',
  status: 'ACTIVE',
  productStatus: 'ACTIVE',
  qtyOnHand: null,
  qtyAvailable: null,
  barcodes: ['2000000000097'],
  taxRateId: VAT,
  taxRate: '7.5000',
  standardCost: '1500.0000',
};

const approvedPo: PurchaseOrderDetail = {
  id: PO_ID,
  number: 'PO-000004',
  supplier: { id: SUPPLIER, name: 'Glow Beauty Wholesale' },
  location: { id: MAIN, name: 'Main Store' },
  status: 'DRAFT',
  orderDate: '2026-10-20',
  expectedDate: null,
  subtotal: '15000.00',
  taxTotal: '1125.00',
  total: '16125.00',
  createdBy: 'Test Owner',
  createdAt: new Date().toISOString(),
  note: null,
  approvedBy: null,
  approvedAt: null,
  endedBy: null,
  endedAt: null,
  lines: [
    {
      id: 'pl1',
      lineNo: 1,
      variant: { id: variant.id, sku: variant.sku, name: variant.name, productName: variant.productName, isBatchTracked: false, isExpiryTracked: false },
      qtyOrdered: '10.000',
      qtyReceived: '0.000',
      qtyOutstanding: '10.000',
      unitCost: '1500.0000',
      taxRateId: null,
      taxRate: '7.5000',
      netAmount: '15000.00',
    },
  ],
  receipts: [],
};

describe('purchase order editor', () => {
  it('prices lines with VAT and saves a draft', async () => {
    let body: { lines: unknown[] } | undefined;
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['purchasing.view', 'purchasing.manage', 'catalog.view']) }),
      ...reference,
      'GET /variants': () => json(200, { data: [], meta: { page: 1, pageSize: 10, total: 0 } }),
      'GET /variants/by-code/SN-ECG-100': () => json(200, { data: variant }),
      'POST /purchase-orders': (_u, init) => {
        body = JSON.parse(String(init.body));
        return json(201, { data: approvedPo });
      },
      [`GET /purchase-orders/${PO_ID}`]: () => json(200, { data: approvedPo }),
    });
    const user = userEvent.setup();
    const { router } = renderApp('/purchasing/orders/new');

    await screen.findByRole('option', { name: 'Glow Beauty Wholesale' });
    await user.selectOptions(screen.getByLabelText('Supplier'), SUPPLIER);
    await user.type(screen.getByRole('combobox', { name: 'Add product' }), 'SN-ECG-100{Enter}');
    expect(await screen.findByText('Edge Control Gel — 100 g')).toBeInTheDocument();
    expect(screen.getByLabelText('Unit cost (excl. VAT)')).toHaveValue('1500');
    await user.clear(screen.getByLabelText('Quantity'));
    await user.type(screen.getByLabelText('Quantity'), '10');

    // 10 × 1,500 = 15,000; VAT 7.5% = 1,125; total 16,125.
    expect(screen.getByText(/16,125\.00/)).toBeInTheDocument();
    expect(screen.getByText(/1,125\.00/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/purchasing/orders/${PO_ID}`));
    expect(body).toMatchObject({ supplierId: SUPPLIER, locationId: MAIN, lines: [{ variantId: variant.id, qty: '10', unitCost: '1500', taxRateId: null }] });
  });

  it('offers approval only to approvers, and "Receive goods" creates a draft receipt', async () => {
    const routes = (perms: string[], status: PurchaseOrderDetail['status']) => ({
      'GET /auth/me': () => json(200, { data: sessionFor(perms) }),
      ...reference,
      [`GET /purchase-orders/${PO_ID}`]: () => json(200, { data: { ...approvedPo, status } }),
      [`POST /purchase-orders/${PO_ID}/receipts`]: () => json(201, { data: { id: 'grn-1', number: 'GRN-000001' } }),
      'GET /goods-receipts/grn-1': () => json(404, { error: { code: 'NOT_FOUND', message: 'x' } }),
    });
    mockApi(routes(['purchasing.view', 'purchasing.manage'], 'DRAFT'));
    renderApp(`/purchasing/orders/${PO_ID}`);
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('creates a draft receipt from an approved order', async () => {
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['purchasing.view', 'purchasing.manage', 'purchasing.approve']) }),
      ...reference,
      [`GET /purchase-orders/${PO_ID}`]: () => json(200, { data: { ...approvedPo, status: 'APPROVED' } }),
      [`POST /purchase-orders/${PO_ID}/receipts`]: () => json(201, { data: { id: 'grn-1', number: 'GRN-000001' } }),
      'GET /goods-receipts/grn-1': () => json(404, { error: { code: 'NOT_FOUND', message: 'x' } }),
    });
    const user = userEvent.setup();
    const { router } = renderApp(`/purchasing/orders/${PO_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Receive goods' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/purchasing/receipts/grn-1'));
  });
});

describe('supplier payment form', () => {
  const invoices: SupplierInvoiceSummary[] = [
    { id: 'i1', number: 'SINV-000001', supplier: { id: SUPPLIER, name: 'Glow' }, supplierRef: 'A-1', invoiceDate: '2026-09-01', dueDate: '2026-10-01', status: 'POSTED', subtotal: '1000.00', taxTotal: '0.00', total: '1000.00', amountPaid: '0.00', outstanding: '1000.00', createdBy: 'x', createdAt: '' },
    { id: 'i2', number: 'SINV-000002', supplier: { id: SUPPLIER, name: 'Glow' }, supplierRef: 'A-2', invoiceDate: '2026-10-01', dueDate: '2026-10-31', status: 'POSTED', subtotal: '2000.00', taxTotal: '0.00', total: '2000.00', amountPaid: '0.00', outstanding: '2000.00', createdBy: 'x', createdAt: '' },
  ];

  it('allocates oldest first and sends an Idempotency-Key', async () => {
    let sent: { body: { allocations: unknown[]; amount: string }; key: string | undefined } | undefined;
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['purchasing.view', 'supplier_payments.manage']) }),
      ...reference,
      'GET /supplier-invoices': () => json(200, { data: invoices, meta: { page: 1, pageSize: 100, total: 2 } }),
      'GET /purchasing/accounts': () => json(200, { data: [{ id: BANK, code: '1010', name: 'Bank - main account', type: 'ASSET', subtype: 'CASH' }] }),
      'POST /supplier-payments': (_u, init) => {
        sent = { body: JSON.parse(String(init.body)), key: (init.headers as Record<string, string>)['Idempotency-Key'] };
        return json(201, { data: { id: 'pay-1', number: 'SPAY-000001', amount: '1500.00' } });
      },
      'GET /supplier-payments/pay-1': () => json(404, { error: { code: 'NOT_FOUND', message: 'x' } }),
    });
    const user = userEvent.setup();
    const { router } = renderApp(`/purchasing/payments/new?supplierId=${SUPPLIER}`);

    await screen.findByRole('option', { name: 'Bank - main account' });
    await user.selectOptions(screen.getByLabelText('Paid from'), BANK);
    await user.type(screen.getByLabelText('Amount (₦)'), '1500');
    await user.click(screen.getByRole('button', { name: 'Oldest first' }));
    const fields = screen.getAllByLabelText('Apply (₦)');
    expect(fields[0]).toHaveValue('1000.00');
    expect(fields[1]).toHaveValue('500.00');

    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/purchasing/payments/pay-1'));
    expect(sent?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent?.body).toMatchObject({
      supplierId: SUPPLIER,
      accountId: BANK,
      amount: '1500',
      allocations: [
        { invoiceId: 'i1', amount: '1000.00' },
        { invoiceId: 'i2', amount: '500.00' },
      ],
    });
  });

  it('rejects allocations larger than the payment', async () => {
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['purchasing.view', 'supplier_payments.manage']) }),
      ...reference,
      'GET /supplier-invoices': () => json(200, { data: invoices, meta: { page: 1, pageSize: 100, total: 2 } }),
      'GET /purchasing/accounts': () => json(200, { data: [{ id: BANK, code: '1010', name: 'Bank', type: 'ASSET', subtype: 'CASH' }] }),
    });
    const user = userEvent.setup();
    renderApp(`/purchasing/payments/new?supplierId=${SUPPLIER}`);
    await screen.findByRole('option', { name: 'Bank' });
    await user.selectOptions(screen.getByLabelText('Paid from'), BANK);
    await user.type(screen.getByLabelText('Amount (₦)'), '100');
    await user.type(screen.getAllByLabelText('Apply (₦)')[0]!, '1000');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(await screen.findByText(/more than the payment/)).toBeInTheDocument();
  });
});

describe('supplier invoice form', () => {
  it('lists received goods to match and totals only the ticked lines', async () => {
    const open: OpenReceiptLine[] = [
      {
        grnLineId: 'g1',
        receiptId: 'r1',
        receiptNumber: 'GRN-000001',
        receivedDate: '2026-10-20',
        variant: { id: variant.id, sku: variant.sku, name: variant.name, productName: variant.productName, isBatchTracked: false, isExpiryTracked: false },
        qtyInvoiceable: '6.000',
        unitCost: '100.0000',
        taxRateId: VAT,
        taxRate: '7.5000',
      },
      {
        grnLineId: 'g2',
        receiptId: 'r2',
        receiptNumber: 'GRN-000002',
        receivedDate: '2026-10-21',
        variant: { id: variant.id, sku: variant.sku, name: variant.name, productName: variant.productName, isBatchTracked: false, isExpiryTracked: false },
        qtyInvoiceable: '4.000',
        unitCost: '100.0000',
        taxRateId: VAT,
        taxRate: '7.5000',
      },
    ];
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['purchasing.view', 'supplier_invoices.manage']) }),
      ...reference,
      'GET /supplier-invoices/open-receipt-lines': () => json(200, { data: open }),
      'GET /purchasing/accounts': () => json(200, { data: [] }),
    });
    const user = userEvent.setup();
    renderApp(`/purchasing/invoices/new?supplierId=${SUPPLIER}`);
    // Wait for text only the form renders (a previous test's toast may also mention GRN-000001).
    expect(await screen.findByText(/6 to invoice/)).toBeInTheDocument();
    const totals = () => screen.getByText('Total').closest('dl')!;
    // Both ticked: 10 × 100 = 1,000 + VAT 75 = 1,075.
    expect(await within(totals()).findByText(/1,075\.00/)).toBeInTheDocument();
    // Untick the second receipt (4 units): 600 + VAT 45 = 645.
    await user.click(screen.getAllByRole('checkbox', { name: /Include/ })[1]!);
    expect(await within(totals()).findByText(/645\.00/)).toBeInTheDocument();
  });
});
