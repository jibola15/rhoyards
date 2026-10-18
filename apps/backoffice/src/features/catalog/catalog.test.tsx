import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ProductSummary } from '@rhoyards/shared';
import { json, mockApi, renderApp, sessionFor } from '../../test/render';

const UNIT_PC = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const VAT = 'aaaaaaaa-0000-4000-8000-0000000000b1';

const product: ProductSummary = {
  id: 'cccccccc-0000-4000-8000-000000000001',
  name: 'Velvet Matte Lipstick',
  slug: 'velvet-matte-lipstick',
  status: 'ACTIVE',
  brand: { id: 'b1', name: 'Velvet Rose' },
  category: { id: 'c1', name: 'Lipstick' },
  variantCount: 3,
  priceMin: '8500.00',
  priceMax: '8500.00',
  stockQty: '33.000',
  onlineVisible: true,
  archived: false,
  imageUrl: null,
};

const reference = {
  'GET /brands': () => json(200, { data: [] }),
  'GET /categories': () => json(200, { data: [] }),
  'GET /units': () => json(200, { data: [{ id: UNIT_PC, code: 'PC', name: 'Piece', allowsFraction: false, isActive: true }] }),
  'GET /tax-rates': () => json(200, { data: [{ id: VAT, code: 'VAT', name: 'VAT (standard rate)', kind: 'STANDARD', rate: '7.5000', isActive: true }] }),
};

describe('ProductsPage', () => {
  it('lists products with price, stock and status', async () => {
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['catalog.view', 'catalog.manage']) }),
      'GET /products': () => json(200, { data: [product], meta: { page: 1, pageSize: 25, total: 1 } }),
      ...reference,
    });
    renderApp('/catalog/products');
    const row = (await screen.findByRole('link', { name: 'Velvet Matte Lipstick' })).closest('tr')!;
    expect(within(row).getByText('Velvet Rose')).toBeInTheDocument();
    expect(within(row).getByText('33')).toBeInTheDocument();
    expect(within(row).getByText('Online')).toBeInTheDocument();
    expect(within(row).getByText(/8,500\.00/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New product' })).toHaveAttribute('href', '/catalog/products/new');
  });

  it('hides product creation from view-only users', async () => {
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['catalog.view']) }),
      'GET /products': () => json(200, { data: [product], meta: { page: 1, pageSize: 25, total: 1 } }),
      ...reference,
    });
    renderApp('/catalog/products');
    await screen.findByRole('link', { name: 'Velvet Matte Lipstick' });
    expect(screen.queryByRole('link', { name: 'New product' })).not.toBeInTheDocument();
  });
});

describe('new product form', () => {
  it('validates, then sends product + variants with barcodes split and blanks as null', async () => {
    let body: Record<string, unknown> | undefined;
    mockApi({
      'GET /auth/me': () => json(200, { data: sessionFor(['catalog.view', 'catalog.manage']) }),
      ...reference,
      'POST /products': (_u, init) => {
        body = JSON.parse(String(init.body));
        return json(201, { data: { id: 'new-id' } });
      },
      'GET /products/new-id': () => json(404, { error: { code: 'NOT_FOUND', message: 'x' } }),
    });
    const user = userEvent.setup();
    const { router } = renderApp('/catalog/products/new');

    await user.click(await screen.findByRole('button', { name: 'Create product' }));
    expect(await screen.findByText('Product name is required')).toBeInTheDocument();
    expect(screen.getByText('Variant name is required')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Product name'), 'Hydrating Lip Oil');
    await user.click(screen.getByLabelText('Track expiry dates (FEFO)'));
    await user.type(screen.getByLabelText('Name'), 'Clear');
    await user.type(screen.getByLabelText('SKU'), 'hlo-clear');
    await user.type(screen.getByLabelText('Price (₦)'), '5500');
    await user.type(screen.getByLabelText('Barcode(s)'), '6150000000011, 6150000000028');
    await user.click(screen.getByRole('button', { name: 'Create product' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/catalog/products/new-id'));
    expect(body).toMatchObject({
      name: 'Hydrating Lip Oil',
      unitId: UNIT_PC,
      taxRateId: VAT,
      brandId: null,
      isExpiryTracked: true,
      isBatchTracked: true,
      variants: [
        {
          name: 'Clear',
          sku: 'HLO-CLEAR',
          sellingPrice: '5500',
          shade: null,
          compareAtPrice: null,
          barcodes: ['6150000000011', '6150000000028'],
        },
      ],
    });
  });
});
