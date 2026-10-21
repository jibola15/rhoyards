import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { dec, sum, type CustomerItemsReport, type CustomerLedger, type DashboardData, type ItemLedger, type SalesReport, type StockReport } from '@rhoyards/shared';
import { businessDate } from '../../src/lib/business-date';
import { toCsv } from '../../src/lib/csv';
import { getPrisma } from '../../src/lib/prisma';
import { mainLocationId, makeProduct } from '../helpers/catalog';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, signIn } from '../helpers/test-app';

const app = buildTestApp();
const prisma = () => getPrisma();
type Staff = Awaited<ReturnType<typeof signIn>>;
let owner: Staff;
let manager: Staff;
let cashier: Staff;
let stockKeeper: Staff;
let gel: string;
let salon: string;
const today = businessDate().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 7)}-01`;

const ok = async (p: request.Test, status = 200) => {
  const res = await p;
  if (res.status !== status) throw new Error(`Expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const send = (who: Staff, path: string, body: object = {}, headers: Record<string, string> = {}) => {
  let req = who.agent.post(`/api/v1${path}`).set('X-CSRF-Token', who.csrf);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(body);
};
const get = (who: Staff, path: string) => who.agent.get(`/api/v1${path}`);

beforeAll(async () => {
  await resetDatabase();
  const users = await Promise.all(['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY_OFFICER'].map((r) => createStaff(r)));
  const [o, m, c, s] = await Promise.all(users.map((u) => signIn(app, u.email, TEST_PASSWORD)));
  [owner, manager, cashier, stockKeeper] = [o!, m!, c!, s!];
  gel = (await makeProduct(users[1]!.user.id, { name: 'Edge Control Gel', variants: [{ sellingPrice: '1075.00', reorderLevel: '8' }] })).variants[0]!.id;
  const adj = await ok(send(manager, '/stock-adjustments', { locationId: await mainLocationId(), reason: 'OPENING_STOCK', lines: [{ variantId: gel, qtyChange: '10', unitCost: '600' }] }), 201);
  await ok(send(manager, `/stock-adjustments/${adj.id}/post`));

  // Today's trading: cash, card and credit sales, a return, a customer payment and a bank-paid expense.
  const ctx = await ok(get(manager, '/pos/context'));
  const till = ctx.registers[0].id;
  const pm = Object.fromEntries(ctx.paymentMethods.map((p: { code: string; id: string }) => [p.code, p.id]));
  await ok(send(manager, '/pos/shifts/open', { registerId: till, openingFloat: '0' }), 201);
  const sell = (body: object) => ok(send(manager, '/pos/sales', { registerId: till, ...body }, { 'Idempotency-Key': randomUUID() }), 201);
  const line = (qty: string) => [{ variantId: gel, qty, unitPrice: '1075.00' }];
  const cashSale = await sell({ lines: line('2'), payments: [{ paymentMethodId: pm.CASH, amount: '2150.00' }] });
  await sell({ lines: line('1'), payments: [{ paymentMethodId: pm.CARD, amount: '1075.00' }] });
  const customer = await ok(send(manager, '/customers', { name: 'Glow Salon', allowCredit: true, creditLimit: '10000' }), 201);
  salon = customer.id;
  const credit = await sell({ customerId: customer.id, lines: line('1'), payments: [] });
  const ret = await ok(send(manager, '/returns', { saleId: cashSale.id, reason: 'Wrong one', approve: true, lines: [{ saleItemId: cashSale.items[0].id, qty: '1', condition: 'RESALEABLE', restock: true }] }), 201);
  await ok(send(manager, `/returns/${ret.id}/refund`, { paymentMethodId: pm.CASH }, { 'Idempotency-Key': randomUUID() }));
  await ok(send(owner, '/customer-receipts', { customerId: customer.id, receiptDate: today, paymentMethodId: pm.TRANSFER, amount: '500.00', reference: 'TRF-9', allocations: [{ saleId: credit.id, amount: '500.00' }] }, { 'Idempotency-Key': randomUUID() }), 201);
  const rent = (await prisma().expenseCategory.findFirstOrThrow({ where: { name: 'Rent' } })).id;
  const bank = (await prisma().account.findFirstOrThrow({ where: { code: '1010' } })).id;
  const exp = await ok(send(manager, '/expenses', { expenseDate: today, categoryId: rent, payee: 'Landlord', description: 'Rent', total: '20000.00', paymentAccountId: bank }), 201);
  await ok(send(manager, `/expenses/${exp.id}/submit`));
  await ok(send(owner, `/expenses/${exp.id}/approve`));
  const waiting = await ok(send(manager, '/expenses', { expenseDate: today, categoryId: rent, payee: 'Landlord', description: 'Service charge', total: '5000.00', paymentAccountId: bank }), 201);
  await ok(send(manager, `/expenses/${waiting.id}/submit`));
});

describe('dashboard figures equal the ledger and the reports', () => {
  let d: DashboardData;

  it('this month (the default): sales and profit are the profit-and-loss figures', async () => {
    d = await ok(get(owner, '/dashboard'));
    expect(d.period).toEqual({ key: 'this_month', label: 'This month', from: monthStart, to: today });
    const pl = await ok(get(owner, `/reports/profit-and-loss?from=${monthStart}&to=${today}`));
    expect(d.profit).toMatchObject({ netSales: pl.netSales, grossProfit: pl.grossProfit, netProfit: pl.netProfit });
    // 4 gels at 1,000 net, one returned; cost 600 each, the returned one restocked.
    expect(d.profit).toMatchObject({ netSales: '3000.00', grossProfit: '1200.00', grossMargin: '40.0' });
    const todayOnly = await ok(get(owner, `/reports/profit-and-loss?from=${today}&to=${today}`));
    expect(d.series.bucket).toBe('day');
    expect(d.series.points.at(-1)).toEqual({ date: today, netSales: todayOnly.netSales, sales: 3 });
    expect(d.sales).toEqual({ count: 3, total: '4300.00', onlineOrders: 0 });
  });

  it('follows the chosen period: today, last month, this year by month', async () => {
    const t = await ok(get(owner, '/dashboard?period=today'));
    expect(t.period).toMatchObject({ key: 'today', from: today, to: today });
    expect(t.sales.count).toBe(3);
    // One day is charted with the six days before it.
    expect(t.series.points).toHaveLength(7);
    expect(t.series.points.at(-1).date).toBe(today);

    const last = await ok(get(owner, '/dashboard?period=last_month'));
    expect(last.period.to < monthStart).toBe(true);
    expect(last.sales).toEqual({ count: 0, total: '0.00', onlineOrders: 0 });
    expect(last.profit.netSales).toBe('0.00');
    expect(last.topProducts).toEqual([]);
    expect(last.series.points.every((p: { sales: number }) => p.sales === 0)).toBe(true);
    // Balances and queues do not depend on the period.
    expect(last.balances).toEqual(d.balances);
    expect(last.attention).toEqual(d.attention);

    const year = await ok(get(owner, '/dashboard?period=this_year'));
    expect(year.period.from).toBe(`${today.slice(0, 4)}-01-01`);
    expect(year.profit.netSales).toBe('3000.00');
    if (year.series.points.length > 3) expect(year.series.bucket).toBe('month');
    expect(year.series.points.at(-1)).toMatchObject({ sales: 3 });

    expect((await get(owner, '/dashboard?period=next_week')).status).toBe(400);
  });

  it('cash, receivables, payables and stock are the balance-sheet and sub-ledger figures', async () => {
    const bs = await ok(get(owner, '/reports/balance-sheet'));
    const cashSection = bs.assets.find((s: { key: string }) => s.key === 'CASH');
    expect(d.balances.cash).toBe(cashSection.total);
    expect(d.balances.cash).toBe('-17350.00'); // till 2,150 − 1,075 refunded; card 1,075; bank 500 − 20,000 rent
    const aging = await ok(get(owner, '/reports/receivables-aging'));
    expect(d.balances.receivables).toBe(aging.ledgerBalance);
    expect(d.balances.receivables).toBe('575.00');
    const valuation = await ok(get(owner, '/inventory/valuation'));
    expect(valuation.difference).toBe('0.00');
    expect(d.balances.inventory).toBe('4200.00'); // 7 on hand at 600
    expect(d.balances.payables).toBe('0.00');
  });

  it('lists what needs attention and the best sellers', async () => {
    expect(d.attention).toMatchObject({ lowStock: 1, outOfStock: 0, expensesToApprove: 1, returnsToApprove: 0, ordersToFulfil: 0 });
    expect(d.topProducts).toEqual([expect.objectContaining({ variantId: gel, name: expect.stringContaining('Edge Control Gel'), qty: '3.000', netSales: '3000.00' })]);
  });
});

describe('operational reports', () => {
  it('sales agree with the ledger however they are grouped', async () => {
    for (const groupBy of ['day', 'product', 'category', 'brand', 'cashier', 'channel', 'location', 'customer']) {
      const r: SalesReport = await ok(get(owner, `/reports/sales?groupBy=${groupBy}`));
      expect(r.totals).toMatchObject({ netSales: '3000.00', qtySold: '4.000', qtyReturned: '1.000', sales: 3 });
      expect(sum(r.rows.map((x) => x.netSales)).toFixed(2)).toBe('3000.00');
    }
    const byProduct: SalesReport = await ok(get(owner, '/reports/sales?groupBy=product'));
    expect(byProduct.rows[0]).toMatchObject({ code: expect.stringMatching(/^T-/), cost: '1800.00', grossProfit: '1200.00', margin: '40.0' });
  });

  it('payments by method net sales, customer payments and refunds', async () => {
    const r = await ok(get(owner, '/reports/payments'));
    const by = Object.fromEntries(r.rows.map((x: { method: string; net: string; refunds: string; receipts: string }) => [x.method, x]));
    expect(by.Cash).toMatchObject({ sales: '2150.00', refunds: '1075.00', net: '1075.00' });
    expect(by['Bank transfer']).toMatchObject({ receipts: '500.00', net: '500.00' });
    expect(r.totals.net).toBe('2650.00');
  });

  it('expenses by category count only posted expenses', async () => {
    const r = await ok(get(owner, '/reports/expenses'));
    expect(r.rows).toEqual([expect.objectContaining({ category: 'Rent', count: 1, total: '20000.00' })]);
  });

  it('stock shows value and rate of sale, and filters to low stock', async () => {
    const r = await ok(get(stockKeeper, '/reports/stock?status=low'));
    expect(r.rows).toEqual([expect.objectContaining({ variantId: gel, onHand: '7.000', value: '4200.00', soldInPeriod: '4.000', status: 'LOW', daysOfCover: 157 })]);
    expect(dec(r.totals.value).toFixed(2)).toBe('4200.00');
  });

  it('downloads CSV, safe to open in a spreadsheet', async () => {
    const res = await get(owner, '/reports/sales?groupBy=product&format=csv');
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="sales-by-product-/);
    const text = res.text.replace(/^\uFEFF/, '');
    expect(text.split('\r\n')[0]).toBe('Product,SKU,Sales,Qty sold,Qty returned,Net sales,VAT,Cost,Gross profit,Margin %');
    expect(text).toContain('Edge Control Gel');
    expect(toCsv([{ header: 'v', value: (r: string) => r }], ['=HYPERLINK("x")', '-12.50', '@sum', 'a,b'])).toBe(`v\r\n"'=HYPERLINK(""x"")"\r\n-12.50\r\n'@sum\r\n"a,b"\r\n`);
  });

  it('sales by customer put walk-in sales together', async () => {
    const r: SalesReport = await ok(get(owner, '/reports/sales?groupBy=customer'));
    expect(r.rows.map((x) => [x.label, x.netSales])).toEqual([
      ['Walk-in customers', '2000.00'],
      ['Glow Salon', '1000.00'],
    ]);
  });

  it('stock shows each store’s quantity, adding up to the total', async () => {
    const r: StockReport = await ok(get(owner, '/reports/stock'));
    const row = r.rows.find((x) => x.variantId === gel)!;
    expect(row.byStore).toHaveLength(r.stores.length);
    expect(sum(row.byStore).toFixed(3)).toBe('7.000');
    expect(r.stores.map((st) => st.id)).toContain(await mainLocationId());
    const one: StockReport = await ok(get(owner, `/reports/stock?locationId=${await mainLocationId()}`));
    expect(one.stores).toEqual([]);
  });

  it('items per customer leave out walk-in sales', async () => {
    const r: CustomerItemsReport = await ok(get(owner, '/reports/customer-items'));
    expect(r.rows).toEqual([expect.objectContaining({ customerId: salon, customer: 'Glow Salon', variantId: gel, qtySold: '1.000', qtyReturned: '0.000', netSales: '1000.00', total: '1075.00', lastBought: today })]);
    expect(r.customers).toEqual([expect.objectContaining({ customerId: salon, netSales: '1000.00' })]);
    const csv = await get(owner, `/reports/customer-items?customerId=${salon}&format=csv`);
    expect(csv.text).toContain('Glow Salon');
  });

  it('item ledger runs from opening to closing stock, business-wide and at a store', async () => {
    const r: ItemLedger = await ok(get(stockKeeper, `/reports/item-ledger?variantId=${gel}`));
    expect(r.opening).toEqual({ qty: '0.000', value: '0.00' });
    expect(r.lines.map((l) => l.balance)).toEqual(['10.000', '8.000', '7.000', '6.000', '7.000']);
    expect(r.lines.filter((l) => l.type === 'SALE').map((l) => l.reference)).toEqual([expect.stringMatching(/\S/), expect.stringMatching(/\S/), expect.stringMatching(/\S/)]);
    expect(r.totals).toMatchObject({ qtyIn: '11.000', qtyOut: '4.000' });
    expect(r.closing).toEqual({ qty: '7.000', value: '4200.00' });
    const variant = await prisma().productVariant.findUniqueOrThrow({ where: { id: gel } });
    expect(r.closing.value).toBe(variant.stockValue.toFixed(2));
    const atStore: ItemLedger = await ok(get(stockKeeper, `/reports/item-ledger?variantId=${gel}&locationId=${await mainLocationId()}`));
    expect(atStore.closing.qty).toBe('7.000');
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const later: ItemLedger = await ok(get(stockKeeper, `/reports/item-ledger?variantId=${gel}&from=${tomorrow.toISOString().slice(0, 10)}&to=${tomorrow.toISOString().slice(0, 10)}`));
    expect(later).toMatchObject({ opening: { qty: '7.000', value: '4200.00' }, lines: [], closing: { qty: '7.000' } });
  });

  it('customer ledger balance is what the customer owes', async () => {
    const r: CustomerLedger = await ok(get(manager, `/reports/customer-ledger?customerId=${salon}`));
    expect(r.openingBalance).toBe('0.00');
    expect(r.lines.map((l) => [l.type, l.debit, l.credit, l.balance])).toEqual([
      ['SALE', '1075.00', '0.00', '1075.00'],
      ['RECEIPT', '0.00', '500.00', '575.00'],
    ]);
    expect(r.totals).toEqual({ purchases: '1075.00', payments: '500.00', returns: '0.00', refunds: '0.00' });
    const statement = await ok(get(manager, `/customers/${salon}/statement`));
    expect(r.closingBalance).toBe(statement.balance);
    const csv = (await get(manager, `/reports/customer-ledger?customerId=${salon}&format=csv`)).text.replace(/^﻿/, '').split('\r\n');
    expect(csv[0]).toBe('Date,Type,Number,Store,Description,Debit,Credit,Balance');
    expect(csv[1]).toContain('Opening balance');
    expect(csv.at(-2)).toContain('575.00');
  });

  it('is visible only to the right roles', async () => {
    expect((await get(cashier, '/reports/customer-items')).status).toBe(403);
    expect((await get(stockKeeper, `/reports/customer-ledger?customerId=${salon}`)).status).toBe(403);
    expect((await get(owner, `/reports/item-ledger?variantId=${randomUUID()}`)).status).toBe(404);
    expect((await get(cashier, '/dashboard')).status).toBe(403);
    expect((await get(stockKeeper, '/reports/sales')).status).toBe(403);
    expect((await get(cashier, '/reports/stock')).status).toBe(200); // cashiers see stock levels
    expect((await get(manager, '/reports/payments')).status).toBe(200);
  });
});
