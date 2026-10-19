import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@rhoyards/shared';
import { getPrisma } from '../../src/lib/prisma';
import { isoDaysFromNow, mainLocationId, makeProduct } from '../helpers/catalog';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, signIn } from '../helpers/test-app';

const app = buildTestApp();
const prisma = () => getPrisma();
type Agent = Awaited<ReturnType<typeof signIn>>;
let cashier: Agent;
let manager: Agent;
let managerEmail: string;
let till1: string;
let till2: string;
let cash: string;
let card: string;
let transfer: string;
let gel: string; // non-batch, price 1,075 (VAT-inclusive), avg cost 600
let lipstick: string; // expiry-tracked

const send = (who: Agent, method: 'post' | 'patch', path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  let req = who.agent[method](path).set('X-CSRF-Token', who.csrf);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(body as object);
};
const sell = (who: Agent, body: Record<string, unknown>, key = randomUUID()) => send(who, 'post', '/api/v1/pos/sales', body, { 'Idempotency-Key': key });
const line = (variantId: string, qty: string, unitPrice = '1075.00', discount?: unknown) => ({ variantId, qty, unitPrice, ...(discount ? { discount } : {}) });
const ok = async (p: Promise<request.Response> | request.Test, status = 200) => {
  const res = await p;
  if (res.status !== status) throw new Error(`Expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const stock = async (id: string) => (await prisma().productVariant.findUniqueOrThrow({ where: { id } })).stockQty.toFixed(3);
const journal = async (sourceId: string) =>
  (
    await prisma().journalLine.findMany({ where: { entry: { sourceId } }, include: { account: { select: { systemKey: true } } }, orderBy: { lineNo: 'asc' } })
  ).map((l) => [l.account.systemKey, l.debit.toFixed(2), l.credit.toFixed(2)]);
const counts = async () => ({
  sales: await prisma().sale.count(),
  movements: await prisma().stockMovement.count(),
  journals: await prisma().journalEntry.count(),
});
let owner: Agent;
const ownerSettings = (section: string, value: unknown) => send(owner, 'patch', '/api/v1/settings', { [section]: value });

beforeAll(async () => {
  await resetDatabase();
  const [c, m, o] = await Promise.all([createStaff('CASHIER'), createStaff('MANAGER'), createStaff('OWNER')]);
  managerEmail = m.email;
  [cashier, manager, owner] = await Promise.all([signIn(app, c.email, TEST_PASSWORD), signIn(app, m.email, TEST_PASSWORD), signIn(app, o.email, TEST_PASSWORD)]);

  const ctx = await ok(cashier.agent.get('/api/v1/pos/context'));
  till1 = ctx.registers[0].id;
  till2 = (await ok(send(owner, 'post', '/api/v1/registers', { locationId: await mainLocationId(), name: 'Till 2' }), 201)).id;
  const methods = Object.fromEntries(ctx.paymentMethods.map((pm: { code: string; id: string }) => [pm.code, pm.id]));
  [cash, card, transfer] = [methods.CASH, methods.CARD, methods.TRANSFER];

  gel = (await makeProduct(m.user.id, { variants: [{ sellingPrice: '1075.00' }] })).variants[0]!.id;
  lipstick = (await makeProduct(m.user.id, { expiry: true, variants: [{ sellingPrice: '2000.00' }] })).variants[0]!.id;
  const opening = await ok(
    send(manager, 'post', '/api/v1/stock-adjustments', {
      locationId: await mainLocationId(),
      reason: 'OPENING_STOCK',
      lines: [
        { variantId: gel, qtyChange: '10', unitCost: '600' },
        { variantId: lipstick, qtyChange: '5', unitCost: '900', lotNumber: 'OLD', expiryDate: isoDaysFromNow(-2) },
        { variantId: lipstick, qtyChange: '2', unitCost: '900', lotNumber: 'NEW', expiryDate: isoDaysFromNow(200) },
      ],
    }),
    201,
  );
  await ok(send(manager, 'post', `/api/v1/stock-adjustments/${opening.id}/post`));
});

describe('shifts', () => {
  it('requires an open shift to sell, and allows one open shift per register', async () => {
    const res = await sell(cashier, { registerId: till1, lines: [line(gel, '1')], payments: [{ paymentMethodId: cash, amount: '1075.00' }] });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Open a shift/);

    const shift = await ok(send(cashier, 'post', '/api/v1/pos/shifts/open', { registerId: till1, openingFloat: '5000' }), 201);
    expect(shift).toMatchObject({ status: 'OPEN', openingFloat: '5000.00', expectedCash: '5000.00' });
    expect((await send(manager, 'post', '/api/v1/pos/shifts/open', { registerId: till1, openingFloat: '0' })).status).toBe(409);
    await ok(send(manager, 'post', '/api/v1/pos/shifts/open', { registerId: till2, openingFloat: '0' }), 201);
  });
});

describe('completing a sale', () => {
  it('reduces stock exactly once and posts revenue, VAT, cash and COGS (acceptance #3, #9)', async () => {
    const key = randomUUID();
    const body = { registerId: till1, lines: [line(gel, '2')], payments: [{ paymentMethodId: cash, amount: '2150.00', tendered: '3000.00' }] };
    const res = await sell(cashier, body, key);
    expect(res.status).toBe(201);
    const sale = res.body.data;
    expect(sale).toMatchObject({ status: 'COMPLETED', total: '2150.00', subtotal: '2000.00', taxTotal: '150.00', changeGiven: '850.00', costTotal: '1200.00' });
    expect(sale.number).toMatch(/^S-\d{6}$/);
    expect(await stock(gel)).toBe('8.000');
    expect(await journal(sale.id)).toEqual([
      ['CASH_ON_HAND', '2150.00', '0.00'],
      ['SALES_REVENUE', '0.00', '2000.00'],
      ['VAT_OUTPUT', '0.00', '150.00'],
      ['COGS', '1200.00', '0.00'],
      ['INVENTORY', '0.00', '1200.00'],
    ]);

    // A retried request (same key) returns the same sale and does not touch stock again.
    const replay = await sell(cashier, body, key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.id).toBe(sale.id);
    expect(await stock(gel)).toBe('8.000');
    expect(await prisma().stockMovement.count({ where: { sourceId: sale.id } })).toBe(1);
  });

  it('accepts split payments only when they add up (acceptance #6)', async () => {
    const base = { registerId: till1, lines: [line(gel, '1')] };
    expect((await sell(cashier, { ...base, payments: [{ paymentMethodId: card, amount: '575.00' }, { paymentMethodId: transfer, amount: '500.00' }] })).status).toBe(400); // no transfer ref
    expect((await sell(cashier, { ...base, payments: [{ paymentMethodId: card, amount: '2000.00' }] })).status).toBe(400); // overpaid
    const short = await sell(cashier, { ...base, payments: [{ paymentMethodId: card, amount: '1000.00' }] });
    expect(short.status).toBe(422);
    expect(short.body.error.message).toMatch(/75\.00 is still to be paid/);

    const sale = await ok(
      sell(cashier, { ...base, payments: [{ paymentMethodId: card, amount: '575.00' }, { paymentMethodId: transfer, amount: '500.00', reference: 'TRF-88' }] }),
      201,
    );
    expect(sale.payments.map((p: { amount: string }) => p.amount)).toEqual(['575.00', '500.00']);
    expect(sale.amountPaid).toBe(sale.total);
    expect(await journal(sale.id)).toEqual(
      expect.arrayContaining([
        ['CARD_CLEARING', '575.00', '0.00'],
        ['BANK_MAIN', '500.00', '0.00'],
      ]),
    );
  });

  it('leaves no partial sale, stock movement or journal when any step fails (acceptance #7)', async () => {
    const before = await counts();
    const res = await sell(cashier, { registerId: till1, lines: [line(gel, '1'), line(gel, '500')], payments: [{ paymentMethodId: cash, amount: '538575.00' }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await counts()).toEqual(before);
    expect(await stock(gel)).toBe('7.000');
  });

  it('two simultaneous sales cannot oversell the same stock (acceptance #5)', async () => {
    // 7 left; each sale wants 5.
    const body = (till: string) => ({ registerId: till, lines: [line(gel, '5')], payments: [{ paymentMethodId: cash, amount: '5375.00' }] });
    const results = await Promise.all([sell(cashier, body(till1)), sell(manager, body(till2))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await stock(gel)).toBe('2.000');
  });

  it('blocks expired lots when configured, and sells earliest-expiring first otherwise (acceptance #14)', async () => {
    const pay = (amount: string) => [{ paymentMethodId: cash, amount }];
    const blocked = await sell(cashier, { registerId: till1, lines: [line(lipstick, '3', '2000.00')], payments: pay('6000.00') });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/expired/);

    const fresh = await ok(sell(cashier, { registerId: till1, lines: [line(lipstick, '1', '2000.00')], payments: pay('2000.00') }), 201);
    const moved = await prisma().stockMovement.findFirstOrThrow({ where: { sourceId: fresh.id }, include: { batch: true } });
    expect(moved.batch?.lotNumber).toBe('NEW');

    await ok(ownerSettings('inventory', { ...DEFAULT_SETTINGS.inventory, blockExpiredSale: false }));
    try {
      const allowed = await ok(sell(cashier, { registerId: till1, lines: [line(lipstick, '1', '2000.00')], payments: pay('2000.00') }), 201);
      const m = await prisma().stockMovement.findFirstOrThrow({ where: { sourceId: allowed.id }, include: { batch: true } });
      expect(m.batch?.lotNumber).toBe('OLD');
    } finally {
      await ok(ownerSettings('inventory', DEFAULT_SETTINGS.inventory));
    }
  });

  it('adds VAT on top when prices exclude VAT', async () => {
    await ok(ownerSettings('pricing', { pricesIncludeTax: false }));
    try {
      const sale = await ok(sell(cashier, { registerId: till1, lines: [line(gel, '1')], payments: [{ paymentMethodId: cash, amount: '1155.63' }] }), 201);
      expect(sale).toMatchObject({ pricesIncludeTax: false, subtotal: '1075.00', taxTotal: '80.63', total: '1155.63' });
      expect(await journal(sale.id)).toEqual(
        expect.arrayContaining([
          ['SALES_REVENUE', '0.00', '1075.00'],
          ['VAT_OUTPUT', '0.00', '80.63'],
        ]),
      );
    } finally {
      await ok(ownerSettings('pricing', { pricesIncludeTax: true }));
    }
  });
});

describe('discounts and price overrides', () => {
  it('lets a cashier discount within the limit, requires a supervisor above it', async () => {
    // Restock so the remaining tests have stock.
    const adj = await ok(send(manager, 'post', '/api/v1/stock-adjustments', { locationId: await mainLocationId(), reason: 'STOCK_COUNT', lines: [{ variantId: gel, qtyChange: '20', unitCost: '600' }] }), 201);
    await ok(send(manager, 'post', `/api/v1/stock-adjustments/${adj.id}/post`));

    const small = await ok(sell(cashier, { registerId: till1, lines: [line(gel, '1', '1075.00', { type: 'percent', value: '5' })], payments: [{ paymentMethodId: cash, amount: '1021.25' }] }), 201);
    expect(small.discountTotal).toBe('53.75');

    const body = { registerId: till1, lines: [line(gel, '1', '1075.00', { type: 'percent', value: '20' })], payments: [{ paymentMethodId: cash, amount: '860.00' }] };
    const needs = await sell(cashier, body);
    expect(needs.status).toBe(403);
    expect(needs.body.error.details.approvalRequired).toBe(true);
    expect((await sell(cashier, { ...body, discountApproval: { email: managerEmail, password: 'wrong-password' } })).status).toBe(403);

    const approved = await ok(sell(cashier, { ...body, discountApproval: { email: managerEmail, password: TEST_PASSWORD } }), 201);
    expect(approved.discountApprovedBy).toMatch(/MANAGER/);
    expect(approved.total).toBe('860.00');
  });

  it('refuses price changes without the price-override permission', async () => {
    const res = await sell(cashier, { registerId: till1, lines: [line(gel, '1', '900.00')], payments: [{ paymentMethodId: cash, amount: '900.00' }] });
    expect(res.status).toBe(403);
    const ok2 = await sell(manager, { registerId: till2, lines: [line(gel, '1', '900.00')], payments: [{ paymentMethodId: cash, amount: '900.00' }] });
    expect(ok2.status).toBe(201);
    expect(ok2.body.data.items[0]).toMatchObject({ unitPrice: '900.00', listPrice: '1075.00' });
  });
});

describe('credit sales', () => {
  it('puts the unpaid balance on an approved customer account, within the limit', async () => {
    expect((await send(cashier, 'post', '/api/v1/customers', { name: 'Salon A', allowCredit: true, creditLimit: '1000' })).status).toBe(403);
    const customer = await ok(send(manager, 'post', '/api/v1/customers', { name: 'Salon A', phone: '0803 000 0000', allowCredit: true, creditLimit: '1000' }), 201);

    const body = { registerId: till2, customerId: customer.id, lines: [line(gel, '1')], payments: [] };
    expect((await sell(cashier, { ...body, registerId: till1 })).status).toBe(403); // cashier lacks pos.credit_sale
    const over = await sell(manager, body);
    expect(over.status).toBe(422);
    expect(over.body.error.message).toMatch(/Credit limit exceeded/);

    const sale = await ok(sell(manager, { ...body, payments: [{ paymentMethodId: cash, amount: '100.00' }] }), 201);
    expect(sale).toMatchObject({ amountPaid: '100.00', balanceDue: '975.00' });
    expect(await journal(sale.id)).toEqual(expect.arrayContaining([['AR', '975.00', '0.00']]));
    expect((await ok(manager.agent.get(`/api/v1/customers/${customer.id}`))).balance).toBe('975.00');
  });
});

describe('suspended sales', () => {
  it('parks a cart without touching stock and gives it back on resume', async () => {
    const before = await stock(gel);
    const parked = await ok(send(cashier, 'post', '/api/v1/pos/sales/suspend', { registerId: till1, lines: [line(gel, '3')], note: 'Customer fetching wallet' }), 201);
    expect(parked).toMatchObject({ status: 'SUSPENDED', number: null, total: '3225.00' });
    expect(await stock(gel)).toBe(before);
    const list = await ok(cashier.agent.get('/api/v1/pos/sales/suspended').query({ registerId: till1 }));
    expect(list.map((s: { id: string }) => s.id)).toContain(parked.id);

    const cart = await ok(send(cashier, 'post', `/api/v1/pos/sales/${parked.id}/resume`));
    expect(cart).toMatchObject({ registerId: till1, note: 'Customer fetching wallet', lines: [{ variantId: gel, qty: '3.000', unitPrice: '1075.00', discount: null }] });
    expect(await prisma().sale.findUnique({ where: { id: parked.id } })).toBeNull();
  });
});

describe('receipts, immutability and reconciliation', () => {
  it('produces receipt data with a VAT breakdown', async () => {
    const sale = await ok(sell(cashier, { registerId: till1, lines: [line(gel, '1')], payments: [{ paymentMethodId: cash, amount: '1075.00' }] }), 201);
    const receipt = await ok(cashier.agent.get(`/api/v1/sales/${sale.id}/receipt`));
    expect(receipt.business.name).toBe(DEFAULT_SETTINGS.business.name);
    expect(receipt.taxSummary).toEqual([{ rate: '7.5000', net: '1000.00', tax: '75.00' }]);
    // Another cashier's sale is not visible to a cashier.
    const other = await prisma().sale.findFirstOrThrow({ where: { cashierId: { not: sale.cashierId }, status: 'COMPLETED' } });
    expect((await cashier.agent.get(`/api/v1/sales/${other.id}`)).status).toBe(403);
  });

  it('keeps completed sales and their payments immutable', async () => {
    const sale = await prisma().sale.findFirstOrThrow({ where: { status: 'COMPLETED' }, include: { payments: true } });
    await expect(prisma().sale.update({ where: { id: sale.id }, data: { note: 'edited' } })).rejects.toThrow(/cannot be changed/);
    await expect(prisma().salePayment.update({ where: { id: sale.payments[0]!.id }, data: { amount: 1 } })).rejects.toThrow(/cannot be changed/);
  });

  it('ledger agrees with stock and customer balances', async () => {
    expect((await ok(manager.agent.get('/api/v1/inventory/valuation'))).difference).toBe('0.00');
    const [ar] = await prisma().$queryRaw<{ bal: string }[]>`
      SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS bal FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'POSTED'
      JOIN accounts a ON a.id = l.account_id AND a.system_key = 'AR'`;
    const [owed] = await prisma().$queryRaw<{ v: string }[]>`SELECT COALESCE(SUM(balance_due), 0)::text AS v FROM sales WHERE status = 'COMPLETED'`;
    expect(ar!.bal).toBe(owed!.v);
  });
});

describe('closing a shift', () => {
  it('compares counted cash with expected and posts the difference', async () => {
    const ctx = await ok(cashier.agent.get('/api/v1/pos/context'));
    const shift = ctx.myShift;
    const expected = new Prisma.Decimal(shift.expectedCash);
    expect(expected.gt(5000)).toBe(true);
    const cashSales = shift.byMethod.find((m: { kind: string }) => m.kind === 'CASH');
    expect(new Prisma.Decimal(shift.openingFloat).plus(cashSales.amount).toFixed(2)).toBe(expected.toFixed(2));

    const counted = expected.minus(100).toFixed(2);
    const closed = await ok(send(cashier, 'post', `/api/v1/pos/shifts/${shift.id}/close`, { countedCash: counted, note: 'Short by 100' }));
    expect(closed).toMatchObject({ status: 'CLOSED', countedCash: counted, variance: '-100.00' });
    expect(await journal(shift.id)).toEqual([
      ['CASH_OVER_SHORT', '100.00', '0.00'],
      ['CASH_ON_HAND', '0.00', '100.00'],
    ]);
    expect((await sell(cashier, { registerId: till1, lines: [line(gel, '1')], payments: [{ paymentMethodId: cash, amount: '1075.00' }] })).status).toBe(422);
    expect((await send(cashier, 'post', `/api/v1/pos/shifts/${shift.id}/close`, { countedCash: '0' })).status).toBe(422);
  });
});
