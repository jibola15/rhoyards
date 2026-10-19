import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CartQuote, StoreInfo, StoreOrder, StoreProductCard, StoreProductDetail, StoreSession } from '@rhoyards/shared';
import { cart } from './lib/cart';
import { json, mockApi, renderStore, unauthenticated } from './test/render';

const GEL = '66666666-0000-4000-8000-000000000001';
const LAGOS = '55555555-0000-4000-8000-000000000002';
const PICKUP = '55555555-0000-4000-8000-000000000001';

const info: StoreInfo = {
  name: 'Rhoyards',
  phone: '0800 000 0000',
  email: 'hello@rhoyards.test',
  address: 'Ikeja',
  currency: { code: 'NGN', symbol: '₦' },
  pricesIncludeTax: true,
  onlineEnabled: true,
  providers: [
    { code: 'MANUAL', name: 'Bank transfer', description: 'Pay by transfer' },
    { code: 'TEST', name: 'Card (test gateway)', description: 'Sandbox' },
  ],
};
const card: StoreProductCard = { id: 'p1', slug: 'edge-control-gel', name: 'Edge Control Gel', brand: 'Sleek', imageUrl: null, minPrice: '1075.00', maxPrice: '1075.00', compareAtPrice: null, inStock: true };
const detail: StoreProductDetail = {
  id: 'p1',
  slug: 'edge-control-gel',
  name: 'Edge Control Gel',
  description: 'Strong hold.',
  brand: { name: 'Sleek', slug: 'sleek' },
  category: null,
  images: [],
  pricesIncludeTax: true,
  variants: [{ id: GEL, sku: 'SN-ECG-100', name: '100 g', shade: null, colour: null, size: null, volume: null, price: '1075.00', compareAtPrice: null, stock: 'LOW', maxQty: 4 }],
};
const option = (id: string, name: string, fee: string, isPickup = false) => ({ id, name, description: null, fee, freeOver: null, states: [], isPickup, isActive: true, sortOrder: 0, feeForCart: fee });
const quote = (qty: string, shipping?: { id: string; fee: string; pickup?: boolean }): CartQuote => ({
  lines: [{ variantId: GEL, sku: 'SN-ECG-100', name: '100 g', productName: 'Edge Control Gel', slug: 'edge-control-gel', imageUrl: null, qty: `${qty}.000`, unitPrice: '1075.00', net: '2000.00', tax: '150.00', total: (1075 * Number(qty)).toFixed(2), available: '4.000', problem: null }],
  itemsTotal: (1075 * Number(qty)).toFixed(2),
  shipping: shipping ? { methodId: shipping.id, name: 'Lagos delivery', fee: shipping.fee, isPickup: Boolean(shipping.pickup) } : null,
  shippingOptions: [option(PICKUP, 'Pick up in store', '0.00', true), option(LAGOS, 'Lagos delivery', '2500.00')],
  subtotal: '4325.58',
  taxTotal: '324.42',
  total: (1075 * Number(qty) + Number(shipping?.fee ?? 0)).toFixed(2),
  pricesIncludeTax: true,
  ok: Boolean(shipping),
});
const session: StoreSession = { customer: { id: 'c1', name: 'Ada Obi', email: 'ada@shop.test', phone: '08031112222' }, csrfToken: 'csrf-customer', expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
const guest = { 'GET /auth/me': unauthenticated, 'GET /info': () => json(200, { data: info }) };

describe('storefront', () => {
  it('shows the store name and the newest products on the home page', async () => {
    mockApi({ ...guest, 'GET /catalog/products': () => json(200, { data: [card], meta: { page: 1, pageSize: 8, total: 1 } }) });
    renderStore('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Rhoyards' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Edge Control Gel/ })).toHaveAttribute('href', '/products/edge-control-gel');
    expect(screen.getByRole('contentinfo')).toHaveTextContent('hello@rhoyards.test');
  });

  it('renders a not-found page for unknown paths', async () => {
    mockApi(guest);
    renderStore('/missing');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('adds a product to the cart, prices it on the server, and asks a guest to sign in at checkout', async () => {
    const quoted: unknown[] = [];
    mockApi({
      ...guest,
      'GET /catalog/products/edge-control-gel': () => json(200, { data: detail }),
      'POST /cart/quote': (_u, init) => {
        quoted.push(JSON.parse(String(init.body)));
        return json(200, { data: quote('2') });
      },
    });
    const { router } = renderStore('/products/edge-control-gel');
    expect(await screen.findByText('Only a few left')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
    expect(screen.getByRole('link', { name: 'Cart, 2 items' })).toBeInTheDocument();

    await router.navigate('/cart');
    expect(await screen.findByText('₦2,150.00', { selector: 'dd' })).toBeInTheDocument();
    expect(quoted[0]).toEqual({ items: [{ variantId: GEL, qty: '2' }] });

    fireEvent.click(screen.getByRole('link', { name: 'Checkout' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('?next=/checkout');
  });

  it('places an order with delivery, payment choice and an idempotency key, then empties the cart', async () => {
    cart.add(GEL, 2);
    let placed: { headers: Record<string, string>; body: Record<string, unknown> } | undefined;
    const order = { id: 'o1', number: 'WEB-000001', status: 'PENDING_PAYMENT', payment: { provider: 'TEST', reference: 'TST-1', status: 'INITIATED', instructions: null, redirectUrl: '/pay/test/TST-1' } } as StoreOrder;
    mockApi({
      'GET /auth/me': () => json(200, { data: session }),
      'GET /info': () => json(200, { data: info }),
      'GET /addresses': () => json(200, { data: [] }),
      'POST /cart/quote': (_u, init) => {
        const body = JSON.parse(String(init.body)) as { shippingMethodId?: string };
        return json(200, { data: quote('2', body.shippingMethodId ? { id: LAGOS, fee: '2500.00' } : undefined) });
      },
      'POST /checkout': (_u, init) => {
        placed = { headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
        return json(201, { data: order });
      },
      'GET /test-gateway/TST-1': () => json(200, { data: { reference: 'TST-1', orderNumber: 'WEB-000001', amount: '4650.00', status: 'INITIATED' } }),
    });
    const { router } = renderStore('/checkout');
    const place = await screen.findByRole('button', { name: 'Place order' });
    await waitFor(() => expect(place).toBeEnabled());

    fireEvent.click(place);
    expect(await screen.findByText('Choose a delivery option')).toBeInTheDocument();
    expect(placed).toBeUndefined();

    expect(screen.getByLabelText('Recipient')).toHaveValue('Ada Obi');
    fireEvent.change(screen.getByLabelText('Street address'), { target: { value: '12 Allen Avenue' } });
    fireEvent.change(screen.getByLabelText('City / town'), { target: { value: 'Ikeja' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Lagos' } });
    fireEvent.click(await screen.findByRole('radio', { name: /Lagos delivery/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Card \(test gateway\)/ }));
    const summary = screen.getByRole('complementary', { name: 'Order summary' });
    await waitFor(() => expect(within(summary).getByText('₦4,650.00')).toBeInTheDocument());

    fireEvent.click(place);
    await waitFor(() => expect(placed).toBeDefined());
    expect(placed!.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(placed!.headers['X-CSRF-Token']).toBe('csrf-customer');
    expect(placed!.body).toMatchObject({
      items: [{ variantId: GEL, qty: '2' }],
      shippingMethodId: LAGOS,
      provider: 'TEST',
      address: { recipient: 'Ada Obi', line1: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos', phone: '08031112222' },
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/pay/test/TST-1'));
    expect(await screen.findByRole('button', { name: 'Pay ₦4,650.00' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cart, 0 items' })).toBeInTheDocument();
  });
});
