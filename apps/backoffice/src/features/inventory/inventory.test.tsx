import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AdjustmentDetail, VariantLookup } from '@rhoyards/shared';
import { json, mockApi, renderApp, sessionFor } from '../../test/render';

const MAIN = 'dddddddd-0000-4000-8000-000000000001';
const locations = [{ id: MAIN, code: 'MAIN', name: 'Main Store', type: 'STORE', isPosEnabled: true, isOnlineFulfilment: true, address: null, phone: null, isActive: true }];

const variant: VariantLookup = {
  id: 'eeeeeeee-0000-4000-8000-000000000001',
  sku: 'SN-ECG-100',
  name: '100 g',
  productId: 'p1',
  productName: 'Edge Control Gel',
  brandName: 'Shea Naturals',
  sellingPrice: '3500.00',
  avgCost: '1600.0000',
  isBatchTracked: false,
  isExpiryTracked: false,
  allowsFraction: false,
  unitCode: 'PC',
  status: 'ACTIVE',
  productStatus: 'ACTIVE',
  qtyOnHand: '40.000',
  qtyAvailable: '40.000',
  barcodes: ['2000000000097'],
};

const draft: AdjustmentDetail = {
  id: 'ffffffff-0000-4000-8000-000000000001',
  number: 'ADJ-000007',
  location: { id: MAIN, name: 'Main Store' },
  reason: 'DAMAGE',
  status: 'DRAFT',
  lineCount: 1,
  totalValue: null,
  createdBy: 'Test Owner',
  createdAt: new Date().toISOString(),
  postedAt: null,
  note: null,
  journalEntryId: null,
  postedBy: null,
  cancelledBy: null,
  cancelledAt: null,
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      variant: { id: variant.id, sku: variant.sku, name: variant.name, productName: variant.productName, isBatchTracked: false, isExpiryTracked: false },
      qtyChange: '-2.000',
      unitCost: null,
      lotNumber: null,
      mfgDate: null,
      expiryDate: null,
      note: null,
      postedValue: null,
    },
  ],
};

const allInventory = ['inventory.view', 'inventory.adjust', 'inventory.adjust.approve', 'catalog.view'];

describe('stock adjustment editor', () => {
  it('scans a barcode, forces removal for damage, and saves a negative quantity', async () => {
    let posted: { reason: string; lines: { variantId: string; qtyChange: string; unitCost?: string }[] } | undefined;
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(allInventory) }),
      'GET /locations': () => json(200, { data: locations }),
      'GET /variants': () => json(200, { data: [], meta: { page: 1, pageSize: 10, total: 0 } }),
      'GET /variants/by-code/2000000000097': () => json(200, { data: variant }),
      'POST /stock-adjustments': (_u, init) => {
        posted = JSON.parse(String(init.body));
        return json(201, { data: draft });
      },
      [`GET /stock-adjustments/${draft.id}`]: () => json(200, { data: draft }),
    });
    const user = userEvent.setup();
    const { router } = renderApp('/inventory/adjustments/new?reason=DAMAGE');

    const picker = await screen.findByRole('combobox', { name: 'Add product' });
    await user.type(picker, '2000000000097{Enter}');
    expect(await screen.findByText('Edge Control Gel — 100 g')).toBeInTheDocument();
    expect(screen.getByText(/40 on hand/)).toBeInTheDocument();
    expect(screen.getByLabelText('Change')).toBeDisabled();
    expect(screen.getByText('Valued at average cost when posted.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Quantity'), '2');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/inventory/adjustments/${draft.id}`));
    expect(posted).toMatchObject({ reason: 'DAMAGE', lines: [{ variantId: variant.id, qtyChange: '-2' }] });
    expect(posted!.lines[0]).not.toHaveProperty('unitCost');
  });

  it('requires a unit cost when adding stock', async () => {
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(allInventory) }),
      'GET /locations': () => json(200, { data: locations }),
      'GET /variants': () => json(200, { data: [], meta: { page: 1, pageSize: 10, total: 0 } }),
      'GET /variants/by-code/SN-ECG-100': () => json(200, { data: { ...variant, avgCost: '0.0000' } }),
    });
    const user = userEvent.setup();
    renderApp('/inventory/adjustments/new?reason=OPENING_STOCK');
    await user.type(await screen.findByRole('combobox', { name: 'Add product' }), 'SN-ECG-100{Enter}');
    await user.type(await screen.findByLabelText('Quantity'), '5');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Required when adding stock')).toBeInTheDocument();
  });

  it('posts a draft after confirmation', async () => {
    let postCalled = false;
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(allInventory) }),
      'GET /locations': () => json(200, { data: locations }),
      [`GET /stock-adjustments/${draft.id}`]: () => json(200, { data: draft }),
      [`POST /stock-adjustments/${draft.id}/post`]: () => {
        postCalled = true;
        return json(200, { data: { ...draft, status: 'POSTED', totalValue: '-3200.00', postedAt: new Date().toISOString(), postedBy: 'Test Owner' } });
      },
    });
    const user = userEvent.setup();
    renderApp(`/inventory/adjustments/${draft.id}`);
    await user.click(await screen.findByRole('button', { name: 'Post adjustment' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Post adjustment' }));
    expect(await screen.findByText('ADJ-000007 posted — stock and ledger updated')).toBeInTheDocument();
    expect(screen.getByText('Net value change')).toBeInTheDocument();
    expect(postCalled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('does not offer posting to users without the approval permission', async () => {
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['inventory.view', 'inventory.adjust']) }),
      'GET /locations': () => json(200, { data: locations }),
      [`GET /stock-adjustments/${draft.id}`]: () => json(200, { data: draft }),
    });
    renderApp(`/inventory/adjustments/${draft.id}`);
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post adjustment' })).not.toBeInTheDocument();
  });
});

describe('stock levels', () => {
  const stockRoutes = (difference: string) => ({
    'GET /auth/me': () => json(200, { data: sessionFor(allInventory) }),
    'GET /locations': () => json(200, { data: locations }),
    'GET /inventory/stock': () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } }),
    'GET /inventory/valuation': () =>
      json(200, { data: { stockLedgerValue: '778500.00', glInventoryBalance: difference === '0.00' ? '778500.00' : '778470.00', difference, stockQty: '149.000', inTransitQty: '0.000', variantsWithStock: 12 } }),
  });

  it('shows the stock ledger reconciled with the Inventory account', async () => {
    mockApi(stockRoutes('0.00'));
    renderApp('/inventory/stock');
    expect(await screen.findByText('Reconciled with ledger')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('warns when the stock ledger and the ledger disagree', async () => {
    mockApi(stockRoutes('30.00'));
    renderApp('/inventory/stock');
    expect(await screen.findByText('Differs from ledger')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('differ by');
  });
});
