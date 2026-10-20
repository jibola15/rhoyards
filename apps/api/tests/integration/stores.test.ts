import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { getPrisma } from '../../src/lib/prisma';
import { makeProduct, mainLocationId } from '../helpers/catalog';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, signIn } from '../helpers/test-app';

/** A business with two stores; a manager who runs only the second one. */
const app = buildTestApp();
const prisma = () => getPrisma();
type Agent = Awaited<ReturnType<typeof signIn>>;

let owner: Agent;
let ikejaManager: Agent;
let main: string;
let ikeja: string;
let gel: string;

const send = (who: Agent, method: 'post' | 'put' | 'patch', path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  let req = who.agent[method](path).set('X-CSRF-Token', who.csrf);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(body as object);
};
const ok = async (p: Promise<request.Response> | request.Test, status = 200) => {
  const res = await p;
  if (res.status !== status) throw new Error(`Expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const adjust = (who: Agent, locationId: string, qty = '10') =>
  send(who, 'post', '/api/v1/stock-adjustments', { locationId, reason: 'OPENING_STOCK', lines: [{ variantId: gel, qtyChange: qty, unitCost: '600' }] });

beforeAll(async () => {
  await resetDatabase();
  main = await mainLocationId();
  ikeja = (await prisma().location.create({ data: { code: 'IKEJA', name: 'Ikeja Store', type: 'STORE', isPosEnabled: true, address: '12 Allen Avenue, Ikeja', phone: '0801 111 2222' } })).id;
  const [o, m] = await Promise.all([createStaff('OWNER'), createStaff('MANAGER')]);
  await prisma().userLocation.create({ data: { userId: m.user.id, locationId: ikeja } });
  [owner, ikejaManager] = await Promise.all([signIn(app, o.email, TEST_PASSWORD), signIn(app, m.email, TEST_PASSWORD)]);
  gel = (await makeProduct(o.user.id, { variants: [{ sellingPrice: '1075.00', reorderLevel: '5' }] })).variants[0]!.id;
  for (const store of [main, ikeja]) {
    const adj = await ok(adjust(owner, store), 201);
    await ok(send(owner, 'post', `/api/v1/stock-adjustments/${adj.id}/post`));
  }
});

describe('staff assigned to a store work only there', () => {
  it('adjusts stock only at their own store, and lists only its documents', async () => {
    const elsewhere = await adjust(ikejaManager, main, '1');
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body.error.message).toMatch(/store you are not assigned to/);
    const own = await ok(adjust(ikejaManager, ikeja, '1'), 201);
    await ok(send(ikejaManager, 'post', `/api/v1/stock-adjustments/${own.id}/post`));

    const mainDoc = await prisma().stockAdjustment.findFirstOrThrow({ where: { locationId: main } });
    expect((await ikejaManager.agent.get(`/api/v1/stock-adjustments/${mainDoc.id}`)).status).toBe(403);
    expect((await send(ikejaManager, 'post', `/api/v1/stock-adjustments/${mainDoc.id}/cancel`)).status).toBe(403);

    const list = await ikejaManager.agent.get('/api/v1/stock-adjustments');
    expect(list.body.data.length).toBeGreaterThan(0);
    expect(list.body.data.every((a: { location: { id: string } }) => a.location.id === ikeja)).toBe(true);
    // The owner sees every store.
    expect((await owner.agent.get('/api/v1/stock-adjustments')).body.meta.total).toBe(3);
  });

  it('sends transfers only from their store, receives them at it, and still sees stock everywhere', async () => {
    expect((await send(ikejaManager, 'post', '/api/v1/stock-transfers', { fromLocationId: main, toLocationId: ikeja, lines: [{ variantId: gel, qty: '2' }] })).status).toBe(403);

    const transfer = await ok(send(owner, 'post', '/api/v1/stock-transfers', { fromLocationId: main, toLocationId: ikeja, lines: [{ variantId: gel, qty: '2' }] }), 201);
    expect((await send(ikejaManager, 'post', `/api/v1/stock-transfers/${transfer.id}/dispatch`)).status).toBe(403);
    await ok(send(owner, 'post', `/api/v1/stock-transfers/${transfer.id}/dispatch`));
    expect((await ikejaManager.agent.get(`/api/v1/stock-transfers/${transfer.id}`)).status).toBe(200);
    await ok(send(ikejaManager, 'post', `/api/v1/stock-transfers/${transfer.id}/receive`));

    const mainStock = await ok(ikejaManager.agent.get('/api/v1/inventory/stock').query({ locationId: main }));
    expect(mainStock.find((r: { variantId: string }) => r.variantId === gel).qtyOnHand).toBe('8.000');
  });

  it('receives goods and runs purchase orders only for their store', async () => {
    const supplier = await prisma().supplier.create({ data: { code: 'SUP-ST', name: 'Store Supplier' } });
    const po = { supplierId: supplier.id, orderDate: '2026-10-19', lines: [{ variantId: gel, qty: '1', unitCost: '600' }] };
    expect((await send(ikejaManager, 'post', '/api/v1/purchase-orders', { ...po, locationId: main })).status).toBe(403);
    const mine = await send(ikejaManager, 'post', '/api/v1/purchase-orders', { ...po, locationId: ikeja });
    expect(mine.status).toBe(201);
    const theirs = await ok(send(owner, 'post', '/api/v1/purchase-orders', { ...po, locationId: main }), 201);
    expect((await ikejaManager.agent.get(`/api/v1/purchase-orders/${theirs.id}`)).status).toBe(403);
    const list = await ikejaManager.agent.get('/api/v1/purchase-orders');
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([mine.body.data.id]);
  });
});

describe('reports and the dashboard by store', () => {
  let saleAtIkeja = '';

  beforeAll(async () => {
    const till = await ok(send(owner, 'post', '/api/v1/registers', { locationId: ikeja, name: 'Ikeja Till' }), 201);
    await ok(send(owner, 'post', '/api/v1/pos/shifts/open', { registerId: till.id, openingFloat: '0' }), 201);
    const methods = await ok(owner.agent.get('/api/v1/pos/context'));
    const cash = methods.paymentMethods.find((m: { code: string }) => m.code === 'CASH').id;
    const sale = await ok(
      send(owner, 'post', '/api/v1/pos/sales', { registerId: till.id, lines: [{ variantId: gel, qty: '2', unitPrice: '1075.00' }], payments: [{ paymentMethodId: cash, amount: '2150.00' }] }, { 'Idempotency-Key': randomUUID() }),
      201,
    );
    saleAtIkeja = sale.id;
  });

  it('prints the store’s own address on its receipts', async () => {
    const receipt = await ok(owner.agent.get(`/api/v1/sales/${saleAtIkeja}/receipt`));
    expect(receipt.store).toEqual({ name: 'Ikeja Store', address: '12 Allen Avenue, Ikeja', phone: '0801 111 2222' });
  });

  it('filters the sales and stock reports by store; staff see only their stores’ sales', async () => {
    const atIkeja = await ok(owner.agent.get('/api/v1/reports/sales').query({ locationId: ikeja }));
    const atMain = await ok(owner.agent.get('/api/v1/reports/sales').query({ locationId: main }));
    expect(atIkeja.totals.netSales).toBe('2000.00');
    expect(atMain.totals.netSales).toBe('0.00');

    expect((await ikejaManager.agent.get('/api/v1/reports/sales').query({ locationId: main })).status).toBe(403);
    expect((await ok(ikejaManager.agent.get('/api/v1/reports/sales'))).totals.netSales).toBe('2000.00');

    // Stock can be looked up at any store: Main had 10, sent 2 to Ikeja; Ikeja 10 + 1 + 2 − 2 sold.
    const stockAt = async (store: string) =>
      (await ok(ikejaManager.agent.get('/api/v1/reports/stock').query({ locationId: store }))).rows.find((r: { variantId: string }) => r.variantId === gel);
    expect((await stockAt(main)).onHand).toBe('8.000');
    const ikejaRow = await stockAt(ikeja);
    expect(ikejaRow).toMatchObject({ onHand: '11.000', value: '6600.00', soldInPeriod: '2.000' });
  });

  it('shows one store on the dashboard, without a net profit (expenses are not per store)', async () => {
    const all = await ok(owner.agent.get('/api/v1/dashboard'));
    expect(all.stores).toBeNull();
    expect(all.profit.netProfit).not.toBeNull();

    const one = await ok(owner.agent.get('/api/v1/dashboard').query({ locationId: ikeja }));
    expect(one.stores).toEqual({ ids: [ikeja], label: 'Ikeja Store' });
    expect(one.sales.count).toBe(1);
    expect(one.profit).toMatchObject({ netSales: '2000.00', netProfit: null });
    expect((await ok(owner.agent.get('/api/v1/dashboard').query({ locationId: main }))).sales.count).toBe(0);

    // A manager assigned to Ikeja gets Ikeja's dashboard without asking, and cannot ask for another store.
    expect((await ok(ikejaManager.agent.get('/api/v1/dashboard'))).stores.ids).toEqual([ikeja]);
    expect((await ikejaManager.agent.get('/api/v1/dashboard').query({ locationId: main })).status).toBe(403);
  });
});

describe('the online shop', () => {
  it('sells from one store at a time', async () => {
    await ok(send(owner, 'patch', `/api/v1/locations/${main}`, { isOnlineFulfilment: true }));
    await ok(send(owner, 'patch', `/api/v1/locations/${ikeja}`, { isOnlineFulfilment: true }));
    const online = await prisma().location.findMany({ where: { isOnlineFulfilment: true } });
    expect(online.map((l) => l.id)).toEqual([ikeja]);
  });
});
