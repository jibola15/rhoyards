import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from '../helpers/test-app';
import { getPrisma } from '../../src/lib/prisma';
import { releaseExpiredReservations } from '../../src/modules/orders/orders.service';
import { testGatewayEvent } from '../../src/modules/payments/webhooks';
import { mainLocationId, makeProduct } from '../helpers/catalog';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, signIn } from '../helpers/test-app';

const app = buildTestApp();
const env = testEnv();
const prisma = () => getPrisma();
type Staff = Awaited<ReturnType<typeof signIn>>;
type Shopper = { agent: ReturnType<typeof request.agent>; csrf: string; email: string };
let manager: Staff;
let cashier: Staff;
let gel: string; // 1,075 incl. VAT (net 1,000), cost 600
let hidden: string;
let gelSlug: string;
let pickup: string;
let lagos: string;
let nationwide: string;
let posRegister: string;
let posCash: string;

const ok = async (p: request.Test, status = 200) => {
  const res = await p;
  if (res.status !== status) throw new Error(`Expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const staff = (who: Staff, method: 'post' | 'patch', path: string, body: object = {}, headers: Record<string, string> = {}) => {
  let req = who.agent[method](`/api/v1${path}`).set('X-CSRF-Token', who.csrf);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(body);
};
const shop = (who: Shopper, method: 'get' | 'post' | 'delete', path: string, body?: object, headers: Record<string, string> = {}) => {
  let req = who.agent[method](`/api/v1/store${path}`).set('X-CSRF-Token', who.csrf);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return body ? req.send(body) : req;
};
async function shopper(name: string): Promise<Shopper> {
  const agent = request.agent(app);
  const email = `${name.toLowerCase()}.${randomUUID().slice(0, 8)}@shop.test`;
  const res = await agent.post('/api/v1/store/auth/register').send({ name, email, phone: '0803 111 2222', password: 'shopper-password' });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return { agent, csrf: res.body.data.csrfToken, email };
}
const address = { recipient: 'Ada Obi', phone: '08031112222', line1: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos' };
const checkout = (who: Shopper, body: object, key = randomUUID()) =>
  shop(who, 'post', '/checkout', { shippingMethodId: lagos, address, provider: 'TEST', ...body }, { 'Idempotency-Key': key });
const balance = async (variantId: string) => {
  const b = await prisma().inventoryBalance.findFirstOrThrow({ where: { variantId, locationId: await mainLocationId() } });
  return { onHand: b.qtyOnHand.toFixed(3), reserved: b.qtyReserved.toFixed(3) };
};
const posSale = (qty: string) =>
  staff(manager, 'post', '/pos/sales', { registerId: posRegister, lines: [{ variantId: gel, qty, unitPrice: '1075.00' }], payments: [{ paymentMethodId: posCash, amount: (1075 * Number(qty)).toFixed(2) }] }, { 'Idempotency-Key': randomUUID() });
const webhook = (raw: Buffer, signature: string) =>
  request(app).post('/api/v1/webhooks/payments/test').set('Content-Type', 'application/json').set('X-Test-Signature', signature).send(raw.toString());
const pay = (reference: string, amount: string, eventId = `evt_${randomUUID()}`) => {
  const { raw, signature } = testGatewayEvent(env, { eventId, type: 'payment.succeeded', reference, amount });
  return webhook(raw, signature);
};
const journalOf = async (sourceId: string) =>
  (await prisma().journalLine.findMany({ where: { entry: { sourceId } }, include: { account: { select: { systemKey: true } } }, orderBy: { lineNo: 'asc' } })).map((l) => [
    l.account.systemKey,
    l.debit.toFixed(2),
    l.credit.toFixed(2),
  ]);
const restock = async (qty: string) => {
  const adj = await ok(staff(manager, 'post', '/stock-adjustments', { locationId: await mainLocationId(), reason: 'OPENING_STOCK', lines: [{ variantId: gel, qtyChange: qty, unitCost: '600' }] }), 201);
  await ok(staff(manager, 'post', `/stock-adjustments/${adj.id}/post`));
};

beforeAll(async () => {
  await resetDatabase();
  const [m, c] = await Promise.all([createStaff('MANAGER'), createStaff('CASHIER')]);
  [manager, cashier] = await Promise.all([signIn(app, m.email, TEST_PASSWORD), signIn(app, c.email, TEST_PASSWORD)]);

  const product = await makeProduct(m.user.id, { name: 'Edge Control Gel', variants: [{ sellingPrice: '1075.00' }] });
  gel = product.variants[0]!.id;
  gelSlug = (await prisma().product.update({ where: { id: product.id }, data: { onlineVisible: true } })).slug;
  hidden = (await makeProduct(m.user.id, { name: 'Staff only serum' })).variants[0]!.id;
  await restock('5');

  const methods = await prisma().shippingMethod.findMany();
  [pickup, lagos, nationwide] = ['Pick up in store', 'Lagos delivery', 'Nationwide delivery'].map((n) => methods.find((x) => x.name === n)!.id) as [string, string, string];
  const ctx = await ok(manager.agent.get('/api/v1/pos/context'));
  posRegister = ctx.registers[0].id;
  posCash = ctx.paymentMethods.find((p: { code: string }) => p.code === 'CASH').id;
  await ok(staff(manager, 'post', '/pos/shifts/open', { registerId: posRegister, openingFloat: '0' }), 201);
});

describe('catalogue', () => {
  it('shows only online-visible products, with stock levels and server prices', async () => {
    const list = await ok(request(app).get('/api/v1/store/catalog/products?q=gel'));
    expect(list.map((p: { name: string }) => p.name)).toEqual(['Edge Control Gel']);
    expect(list[0]).toMatchObject({ minPrice: '1075.00', inStock: true });
    const detail = await ok(request(app).get(`/api/v1/store/catalog/products/${gelSlug}`));
    expect(detail.variants[0]).toMatchObject({ id: gel, price: '1075.00', stock: 'LOW', maxQty: 5 });
    const hiddenSlug = (await prisma().productVariant.findUniqueOrThrow({ where: { id: hidden }, include: { product: true } })).product.slug;
    expect((await request(app).get(`/api/v1/store/catalog/products/${hiddenSlug}`)).status).toBe(404);
  });
});

describe('customer accounts', () => {
  it('keeps customer and staff sessions apart', async () => {
    const ada = await shopper('Ada');
    expect((await ada.agent.get('/api/v1/store/auth/me')).body.data.customer.email).toBe(ada.email);
    expect((await ada.agent.get('/api/v1/auth/me')).status).toBe(401); // a customer cookie is not a staff session
    expect((await manager.agent.get('/api/v1/store/auth/me')).status).toBe(401); // and vice versa
    const dup = await request(app).post('/api/v1/store/auth/register').send({ name: 'Ada', email: ada.email, phone: '0803 111 2222', password: 'another-password' });
    expect(dup.status).toBe(409);
    expect((await request(app).post('/api/v1/store/auth/login').send({ email: ada.email, password: 'wrong-password' })).status).toBe(401);
    expect((await request(app).post('/api/v1/store/auth/login').send({ email: ada.email, password: 'shopper-password' })).status).toBe(200);
    // State-changing requests need the customer's CSRF token.
    expect((await ada.agent.post('/api/v1/store/checkout').set('Idempotency-Key', randomUUID()).send({})).status).toBe(403);
  });
});

describe('cart quote', () => {
  it('prices items and delivery from the database and offers delivery options for the state', async () => {
    const quote = await ok(request(app).post('/api/v1/store/cart/quote').send({ items: [{ variantId: gel, qty: '2' }], shippingMethodId: lagos, state: 'Lagos' }));
    expect(quote).toMatchObject({ itemsTotal: '2150.00', shipping: { fee: '2500.00' }, total: '4650.00', ok: true });
    // VAT-inclusive: items 2,000 + 150 VAT; delivery 2,325.58 + 174.42 VAT.
    expect(quote).toMatchObject({ subtotal: '4325.58', taxTotal: '324.42' });
    const kano = await ok(request(app).post('/api/v1/store/cart/quote').send({ items: [{ variantId: gel, qty: '1' }], state: 'Kano' }));
    expect(kano.shippingOptions.map((o: { id: string }) => o.id).sort()).toEqual([nationwide, pickup].sort());
    const tooMany = await ok(request(app).post('/api/v1/store/cart/quote').send({ items: [{ variantId: gel, qty: '9' }, { variantId: hidden, qty: '1' }] }));
    expect(tooMany.lines.map((l: { problem: string }) => l.problem)).toEqual(['INSUFFICIENT', 'UNAVAILABLE']);
    expect(tooMany.ok).toBe(false);
  });
});

describe('one stock pool for the shop and the till (acceptance #4)', () => {
  it('reserves stock at checkout so the POS cannot sell it, and frees it on cancellation', async () => {
    const ada = await shopper('Ada');
    const order = await ok(checkout(ada, { items: [{ variantId: gel, qty: '3' }] }), 201);
    expect(order).toMatchObject({ status: 'PENDING_PAYMENT', total: '5725.00', canCancel: true });
    expect(order.payment).toMatchObject({ provider: 'TEST', status: 'INITIATED', redirectUrl: expect.stringMatching(/^\/pay\/test\/TST-/) });
    expect(await balance(gel)).toEqual({ onHand: '5.000', reserved: '3.000' });

    const pos = await posSale('3');
    expect(pos.status).toBe(409);
    expect(pos.body.error.code).toBe('INSUFFICIENT_STOCK');
    await ok(posSale('2'), 201);
    expect(await balance(gel)).toEqual({ onHand: '3.000', reserved: '3.000' });

    const bola = await shopper('Bola');
    expect((await checkout(bola, { items: [{ variantId: gel, qty: '1' }] })).status).toBe(409);

    await ok(shop(ada, 'post', `/orders/${order.number}/cancel`));
    expect(await balance(gel)).toEqual({ onHand: '3.000', reserved: '0.000' });
    expect((await ok(shop(ada, 'get', `/orders/${order.number}`))).status).toBe('CANCELLED');
  });

  it('two shoppers racing for the last units cannot both reserve them', async () => {
    const [a, b] = await Promise.all([shopper('Chi'), shopper('Dayo')]);
    const results = await Promise.all([checkout(a, { items: [{ variantId: gel, qty: '2' }] }), checkout(b, { items: [{ variantId: gel, qty: '2' }] })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await balance(gel)).toEqual({ onHand: '3.000', reserved: '2.000' });
    const winner = results.find((r) => r.status === 201)!.body.data;
    await ok(shop(results[0]!.status === 201 ? a : b, 'post', `/orders/${winner.number}/cancel`));
  });
});

describe('payment webhooks (acceptance #12)', () => {
  it('a verified payment creates one sale, posts revenue, delivery, VAT and cost, and ignores duplicates', async () => {
    const eze = await shopper('Eze');
    const order = await ok(checkout(eze, { items: [{ variantId: gel, qty: '2' }] }), 201);
    const reference = order.payment.reference;

    const forged = testGatewayEvent({ ...env, PAYMENT_TEST_SECRET: 'not-the-real-secret-at-all' }, { eventId: 'evt_forged', type: 'payment.succeeded', reference, amount: order.total });
    expect((await webhook(forged.raw, forged.signature)).status).toBe(401);
    expect((await pay(reference, '1.00')).body.result).toBe('AMOUNT_MISMATCH');
    expect((await ok(shop(eze, 'get', `/orders/${order.number}`))).status).toBe('PENDING_PAYMENT');

    const first = await pay(reference, order.total, 'evt_real_1');
    expect(first.body).toEqual({ received: true, result: 'PAID' });
    const again = await pay(reference, order.total, 'evt_real_1');
    expect(again.body).toMatchObject({ received: true, duplicate: true, result: 'PAID' });
    expect((await pay(reference, order.total, 'evt_real_2')).body.result).toBe('ALREADY_PAID');

    const dbOrder = await prisma().onlineOrder.findUniqueOrThrow({ where: { id: order.id }, include: { sale: true } });
    expect(dbOrder.status).toBe('PAID');
    expect(await prisma().sale.count({ where: { onlineOrder: { id: order.id } } })).toBe(1);
    expect(await balance(gel)).toEqual({ onHand: '1.000', reserved: '0.000' });
    expect(dbOrder.sale).toMatchObject({ channel: 'ONLINE', status: 'COMPLETED', registerId: null, shiftId: null });
    expect(await journalOf(dbOrder.saleId!)).toEqual([
      ['GATEWAY_CLEARING', '4650.00', '0.00'],
      ['SALES_REVENUE', '0.00', '2000.00'],
      ['SHIPPING_INCOME', '0.00', '2325.58'],
      ['VAT_OUTPUT', '0.00', '324.42'],
      ['COGS', '1200.00', '0.00'],
      ['INVENTORY', '0.00', '1200.00'],
    ]);
    expect(await prisma().paymentWebhookEvent.count({ where: { signatureValid: false } })).toBe(1);
    await expect(prisma().$executeRaw`UPDATE payment_webhook_events SET payload = '{}' WHERE event_id = 'evt_real_1'`).rejects.toThrow(/cannot be altered/);
  });
});

describe('declined card payment', () => {
  it('records the decline and lets the customer start a new attempt on the same order', async () => {
    const jo = await shopper('Jo');
    const order = await ok(checkout(jo, { items: [{ variantId: gel, qty: '1' }] }), 201);
    const declined = testGatewayEvent(env, { eventId: `evt_${randomUUID()}`, type: 'payment.failed', reference: order.payment.reference, amount: order.total });
    expect((await webhook(declined.raw, declined.signature)).body.result).toBe('FAILED');
    const after = await ok(shop(jo, 'get', `/orders/${order.number}`));
    expect(after).toMatchObject({ status: 'PENDING_PAYMENT', payment: { status: 'FAILED', redirectUrl: null } });

    const retried = await ok(shop(jo, 'post', `/orders/${order.number}/pay`));
    expect(retried.payment).toMatchObject({ status: 'INITIATED', redirectUrl: expect.stringMatching(/^\/pay\/test\/TST-/) });
    expect(retried.payment.reference).not.toBe(order.payment.reference);
    expect((await shop(jo, 'post', `/orders/${order.number}/pay`)).status).toBe(422);
    await ok(shop(jo, 'post', `/orders/${order.number}/cancel`));
  });
});

describe('bank transfer and fulfilment', () => {
  it('staff with payments.verify confirm the transfer; the order then moves through fulfilment in order', async () => {
    await restock('4'); // 5 on hand
    const femi = await shopper('Femi');
    const order = await ok(checkout(femi, { items: [{ variantId: gel, qty: '1' }], provider: 'MANUAL', shippingMethodId: pickup, address: undefined }), 201);
    expect(order.payment.reference).toBe(order.number);
    expect(order.payment.instructions).toMatch(new RegExp(`Reference: ${order.number}`));
    expect(order.address).toBeNull();

    expect((await staff(cashier, 'post', `/orders/${order.id}/verify-payment`, { reference: 'GTB-778812' })).status).toBe(403);
    const paid = await ok(staff(manager, 'post', `/orders/${order.id}/verify-payment`, { reference: 'GTB-778812' }));
    expect(paid).toMatchObject({ status: 'PAID', sale: { number: expect.stringMatching(/^S-/) } });
    expect((await journalOf(paid.sale.id))[0]).toEqual(['BANK_MAIN', '1075.00', '0.00']);
    expect((await prisma().salePayment.findFirstOrThrow({ where: { saleId: paid.sale.id } })).reference).toBe('GTB-778812');

    expect((await staff(manager, 'post', `/orders/${order.id}/status`, { to: 'SHIPPED' })).status).toBe(422);
    for (const to of ['PROCESSING', 'PACKED']) await ok(staff(manager, 'post', `/orders/${order.id}/status`, { to }));
    expect((await staff(manager, 'post', `/orders/${order.id}/status`, { to: 'SHIPPED' })).body.error.message).toMatch(/pickup/);
    const done = await ok(staff(manager, 'post', `/orders/${order.id}/status`, { to: 'DELIVERED', note: 'Collected' }));
    expect(done.history.map((h: { to: string }) => h.to)).toEqual(['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'PACKED', 'DELIVERED']);
    expect((await staff(manager, 'post', `/orders/${order.id}/cancel`, { reason: 'Too late' })).status).toBe(422);
  });

  it('customers only ever see their own orders', async () => {
    const [gina, hassan] = await Promise.all([shopper('Gina'), shopper('Hassan')]);
    const order = await ok(checkout(gina, { items: [{ variantId: gel, qty: '1' }] }), 201);
    expect((await shop(hassan, 'get', `/orders/${order.number}`)).status).toBe(404);
    expect((await shop(hassan, 'post', `/orders/${order.number}/cancel`)).status).toBe(404);
    expect(await ok(shop(hassan, 'get', '/orders'))).toEqual([]);
    await ok(shop(gina, 'post', `/orders/${order.number}/cancel`));
  });
});

describe('reservation expiry and late payment', () => {
  it('frees stock when the hold runs out; a late payment completes the order if stock is there, or holds it as a deposit', async () => {
    const ike = await shopper('Ike');
    const lucky = await ok(checkout(ike, { items: [{ variantId: gel, qty: '2' }] }), 201);
    const unlucky = await ok(checkout(ike, { items: [{ variantId: gel, qty: '2' }] }), 201);
    expect(await balance(gel)).toEqual({ onHand: '4.000', reserved: '4.000' });

    await prisma().onlineOrder.updateMany({ where: { id: { in: [lucky.id, unlucky.id] } }, data: { reservedUntil: new Date(Date.now() - 60_000) } });
    expect(await releaseExpiredReservations()).toBe(2);
    expect(await balance(gel)).toEqual({ onHand: '4.000', reserved: '0.000' });
    expect((await ok(shop(ike, 'get', `/orders/${lucky.number}`))).status).toBe('PENDING_PAYMENT');

    // The till sells two meanwhile; two remain for the first late payment, none for the second.
    await ok(posSale('2'), 201);
    expect((await pay(lucky.payment.reference, lucky.total)).body.result).toBe('PAID');
    expect((await pay(unlucky.payment.reference, unlucky.total)).body.result).toBe('ON_HOLD');

    const held = await prisma().onlineOrder.findUniqueOrThrow({ where: { id: unlucky.id } });
    expect(held).toMatchObject({ status: 'ON_HOLD', saleId: null });
    expect(await journalOf(unlucky.id)).toEqual([
      ['GATEWAY_CLEARING', unlucky.total, '0.00'],
      ['CUSTOMER_DEPOSITS', '0.00', unlucky.total],
    ]);

    expect((await staff(manager, 'post', `/orders/${unlucky.id}/retry-fulfilment`)).status).toBe(422);
    await restock('2');
    const done = await ok(staff(manager, 'post', `/orders/${unlucky.id}/retry-fulfilment`));
    expect(done.status).toBe('PAID');
    expect((await journalOf(done.sale.id))[0]).toEqual(['CUSTOMER_DEPOSITS', unlucky.total, '0.00']);
    expect(await balance(gel)).toEqual({ onHand: '0.000', reserved: '0.000' });
  });
});

describe('ledger stays reconciled', () => {
  it('stock value equals Inventory, every entry balances, and the trial balance balances', async () => {
    expect((await ok(manager.agent.get('/api/v1/inventory/valuation'))).difference).toBe('0.00');
    const unbalanced = await prisma().$queryRaw<unknown[]>`
      SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING SUM(debit) <> SUM(credit)`;
    expect(unbalanced).toEqual([]);
    const owner = await createStaff('OWNER');
    const o = await signIn(app, owner.email, TEST_PASSWORD);
    const tb = await ok(o.agent.get('/api/v1/reports/trial-balance'));
    expect(tb.totals.debit).toBe(tb.totals.credit);
  });
});
