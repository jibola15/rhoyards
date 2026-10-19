import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { dec, sum } from '@rhoyards/shared';
import { getPrisma } from '../../src/lib/prisma';
import { releaseExpiredReservations } from '../../src/modules/orders/orders.service';
import { testGatewayEvent } from '../../src/modules/payments/webhooks';
import { isoDaysFromNow, mainLocationId, makeProduct } from '../helpers/catalog';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, signIn, testEnv } from '../helpers/test-app';

const app = buildTestApp();
const env = testEnv();
const prisma = () => getPrisma();
type Staff = Awaited<ReturnType<typeof signIn>>;
let owner: Staff;
let manager: Staff;
let cashier: Staff;
let accountant: Staff;
let gel: string; // 1,075 incl. VAT (net 1,000), first stock at cost 600
let serum: string; // expiry-tracked, 2,000
let till: string;
let shiftId: string;
let pm: Record<string, string>;
let acc: Record<string, string>; // account code → id
const today = new Date().toISOString().slice(0, 10);

const ok = async (p: request.Test, status = 200) => {
  const res = await p;
  if (res.status !== status) throw new Error(`Expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const send = (who: Staff, method: 'post' | 'put' | 'patch' | 'delete', path: string, body: object = {}, headers: Record<string, string> = {}) => {
  let req = who.agent[method](`/api/v1${path}`).set('X-CSRF-Token', who.csrf);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(body);
};
const get = (who: Staff, path: string) => who.agent.get(`/api/v1${path}`);
const sell = (body: object) => send(manager, 'post', '/pos/sales', { registerId: till, ...body }, { 'Idempotency-Key': randomUUID() });
const refund = (id: string, body: object = {}, key = randomUUID()) => send(manager, 'post', `/returns/${id}/refund`, body, { 'Idempotency-Key': key });
const journalOf = async (sourceId: string) =>
  (await prisma().journalLine.findMany({ where: { entry: { sourceId } }, include: { account: { select: { systemKey: true, code: true } } }, orderBy: [{ entry: { createdAt: 'asc' } }, { lineNo: 'asc' }] })).map((l) => [
    l.account.systemKey ?? l.account.code,
    l.debit.toFixed(2),
    l.credit.toFixed(2),
  ]);
const onHand = async (variantId: string) => (await prisma().productVariant.findUniqueOrThrow({ where: { id: variantId } })).stockQty.toFixed(3);
const stockIn = async (lines: object[]) => {
  const adj = await ok(send(manager, 'post', '/stock-adjustments', { locationId: await mainLocationId(), reason: 'OPENING_STOCK', lines }), 201);
  await ok(send(manager, 'post', `/stock-adjustments/${adj.id}/post`));
};
const gelLine = (qty: string) => ({ variantId: gel, qty, unitPrice: '1075.00' });

beforeAll(async () => {
  await resetDatabase();
  const users = await Promise.all(['OWNER', 'MANAGER', 'CASHIER', 'ACCOUNTANT'].map((r) => createStaff(r)));
  const [o, m0, c, a] = await Promise.all(users.map((u) => signIn(app, u.email, TEST_PASSWORD)));
  [owner, manager, cashier, accountant] = [o!, m0!, c!, a!];
  const m = users[1]!;
  gel = (await makeProduct(m.user.id, { name: 'Edge Control Gel', variants: [{ sellingPrice: '1075.00' }] })).variants[0]!.id;
  serum = (await makeProduct(m.user.id, { expiry: true, variants: [{ sellingPrice: '2000.00' }] })).variants[0]!.id;
  await stockIn([
    { variantId: gel, qtyChange: '10', unitCost: '600' },
    { variantId: serum, qtyChange: '2', unitCost: '900', lotNumber: 'EARLY', expiryDate: isoDaysFromNow(100) },
    { variantId: serum, qtyChange: '2', unitCost: '900', lotNumber: 'LATE', expiryDate: isoDaysFromNow(300) },
  ]);
  const ctx = await ok(get(manager, '/pos/context'));
  till = ctx.registers[0].id;
  pm = Object.fromEntries(ctx.paymentMethods.map((p: { code: string; id: string }) => [p.code, p.id]));
  shiftId = (await ok(send(manager, 'post', '/pos/shifts/open', { registerId: till, openingFloat: '5000' }), 201)).id;
  acc = Object.fromEntries((await prisma().account.findMany()).map((a) => [a.code, a.id]));
});

describe('sales returns: caps, approval and refund (acceptance #10)', () => {
  let saleA: { id: string; items: { id: string }[] };

  it('needs approval, cannot claim more than was sold, and refunds at the original cost', async () => {
    saleA = await ok(sell({ lines: [gelLine('3')], payments: [{ paymentMethodId: pm.CASH, amount: '3225.00' }] }), 201);
    const item = saleA.items[0]!.id;
    const ret = await ok(send(cashier, 'post', '/returns', { saleId: saleA.id, reason: 'Wrong shade', lines: [{ saleItemId: item, qty: '2', condition: 'RESALEABLE', restock: true }] }), 201);
    expect(ret).toMatchObject({ status: 'PENDING_APPROVAL', total: '2150.00' });
    expect((await send(cashier, 'post', `/returns/${ret.id}/approve`)).status).toBe(403);
    expect((await send(cashier, 'post', '/returns', { saleId: saleA.id, reason: 'Wrong size', approve: true, lines: [{ saleItemId: item, qty: '1', condition: 'RESALEABLE', restock: true }] })).status).toBe(403);
    // Two are claimed by the pending return; only one is left.
    const over = await send(cashier, 'post', '/returns', { saleId: saleA.id, reason: 'Again', lines: [{ saleItemId: item, qty: '2', condition: 'RESALEABLE', restock: true }] });
    expect(over.status).toBe(422);
    expect(over.body.error.details).toMatchObject({ returnable: '1.000' });
    expect((await refund(ret.id, { paymentMethodId: pm.CASH })).status).toBe(422); // not approved yet

    // New stock at a higher cost moves the average; the return must still go back in at 600.
    await stockIn([{ variantId: gel, qtyChange: '10', unitCost: '900' }]);
    await ok(send(manager, 'post', `/returns/${ret.id}/approve`));
    const key = randomUUID();
    const done = await ok(refund(ret.id, { paymentMethodId: pm.CASH }, key));
    expect(done).toMatchObject({ status: 'COMPLETED', paidOut: '2150.00', creditedToAccount: '0.00' });
    expect(await journalOf(ret.id)).toEqual([
      ['SALES_RETURNS', '2000.00', '0.00'],
      ['VAT_OUTPUT', '150.00', '0.00'],
      ['CASH_ON_HAND', '0.00', '2150.00'],
      ['INVENTORY', '1200.00', '0.00'],
      ['COGS', '0.00', '1200.00'],
    ]);
    expect(await onHand(gel)).toBe('19.000');

    // The same request replays the stored answer; a fresh one is refused because the return is done.
    const replay = await refund(ret.id, { paymentMethodId: pm.CASH }, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await refund(ret.id, { paymentMethodId: pm.CASH })).status).toBe(422);
    expect(await prisma().journalEntry.count({ where: { sourceId: ret.id } })).toBe(1);
  });

  it('takes exactly what is left of a line on the last return, and nothing after that', async () => {
    const item = saleA.items[0]!.id;
    const last = await ok(send(manager, 'post', '/returns', { saleId: saleA.id, reason: 'Broken lid', approve: true, lines: [{ saleItemId: item, qty: '1', condition: 'DAMAGED', restock: false }] }), 201);
    expect(last).toMatchObject({ status: 'APPROVED', net: '1000.00', tax: '75.00', total: '1075.00' });
    await ok(refund(last.id, { paymentMethodId: pm.CASH }));
    expect(await journalOf(last.id)).toEqual([
      ['SALES_RETURNS', '1000.00', '0.00'],
      ['VAT_OUTPUT', '75.00', '0.00'],
      ['CASH_ON_HAND', '0.00', '1075.00'],
    ]); // damaged: no stock back, the cost stays in COGS
    expect(await onHand(gel)).toBe('19.000');
    expect((await send(manager, 'post', '/returns', { saleId: saleA.id, reason: 'More', lines: [{ saleItemId: item, qty: '1', condition: 'RESALEABLE', restock: true }] })).status).toBe(422);
    expect((await prisma().saleItem.findUniqueOrThrow({ where: { id: item } })).qtyReturned.toFixed(3)).toBe('3.000');
    await expect(prisma().$executeRaw`UPDATE sale_items SET qty_returned = qty + 1 WHERE id = ${item}::uuid`).rejects.toThrow();
  });

  it('two people refunding one return at the same time pay out once', async () => {
    const sale = await ok(sell({ lines: [gelLine('1')], payments: [{ paymentMethodId: pm.CASH, amount: '1075.00' }] }), 201);
    const ret = await ok(send(manager, 'post', '/returns', { saleId: sale.id, reason: 'Changed mind', approve: true, lines: [{ saleItemId: sale.items[0].id, qty: '1', condition: 'RESALEABLE', restock: true }] }), 201);
    const results = await Promise.all([refund(ret.id, { paymentMethodId: pm.CASH }), refund(ret.id, { paymentMethodId: pm.CASH })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(await prisma().journalEntry.count({ where: { sourceId: ret.id } })).toBe(1);
  });

  it('cash refunded at the till comes out of the shift\'s expected cash', async () => {
    const shift = await ok(get(manager, `/pos/shifts/${shiftId}`));
    // Float 5,000 + cash sales 3,225 + 1,075 − refunds 2,150 + 1,075 + 1,075.
    expect(shift.expectedCash).toBe('5000.00');
  });

  it('puts batch items back into the lot they were sold from', async () => {
    const sale = await ok(sell({ lines: [{ variantId: serum, qty: '1', unitPrice: '2000.00' }], payments: [{ paymentMethodId: pm.CARD, amount: '2000.00' }] }), 201);
    const lot = async (n: string) => (await prisma().inventoryBatch.findFirstOrThrow({ where: { variantId: serum, lotNumber: n } })).qtyOnHand.toFixed(3);
    expect([await lot('EARLY'), await lot('LATE')]).toEqual(['1.000', '2.000']);
    const ret = await ok(send(manager, 'post', '/returns', { saleId: sale.id, reason: 'Allergy', approve: true, lines: [{ saleItemId: sale.items[0].id, qty: '1', condition: 'RESALEABLE', restock: true }] }), 201);
    await ok(refund(ret.id, { paymentMethodId: pm.CARD }));
    expect([await lot('EARLY'), await lot('LATE')]).toEqual(['2.000', '2.000']);
  });
});

describe('credit customers: returns and payments (accounts receivable)', () => {
  let customer: string;
  let creditSale: string;

  it('a return on an unpaid credit sale reduces what the customer owes before any cash goes out', async () => {
    customer = (await ok(send(manager, 'post', '/customers', { name: 'Glow Salon', allowCredit: true, creditLimit: '50000' }), 201)).id;
    const sale = await ok(sell({ customerId: customer, lines: [gelLine('2')], payments: [] }), 201);
    creditSale = sale.id;
    const ret = await ok(send(manager, 'post', '/returns', { saleId: sale.id, reason: 'Over-ordered', approve: true, lines: [{ saleItemId: sale.items[0].id, qty: '1', condition: 'RESALEABLE', restock: true }] }), 201);
    const done = await ok(refund(ret.id));
    expect(done).toMatchObject({ creditedToAccount: '1075.00', paidOut: '0.00', refundMethod: null });
    expect((await journalOf(ret.id)).find((l) => l[0] === 'AR')).toEqual(['AR', '0.00', '1075.00']);
    expect((await ok(get(manager, `/customers/${customer}`))).balance).toBe('1075.00');
  });

  it('records payments against sales, keeps any excess as credit, and the AR ledger agrees', async () => {
    const pay = (body: object) => send(accountant, 'post', '/customer-receipts', { customerId: customer, receiptDate: today, paymentMethodId: pm.TRANSFER, reference: 'TRF-1', ...body }, { 'Idempotency-Key': randomUUID() });
    expect((await pay({ amount: '2000.00', allocations: [{ saleId: creditSale, amount: '2000.00' }] })).status).toBe(422); // only 1,075 outstanding
    expect((await send(cashier, 'post', '/customer-receipts', {})).status).toBe(403);
    const first = await ok(pay({ amount: '500.00', allocations: [{ saleId: creditSale, amount: '500.00' }] }), 201);
    expect(first).toMatchObject({ number: expect.stringMatching(/^RCP-/), unallocated: '0.00' });
    expect(await journalOf(first.id)).toEqual([
      ['BANK_MAIN', '500.00', '0.00'],
      ['AR', '0.00', '500.00'],
    ]);
    await ok(pay({ amount: '1000.00' }), 201); // nothing to apply it to: credit on account

    const statement = await ok(get(manager, `/customers/${customer}/statement`));
    expect(statement).toMatchObject({ balance: '-425.00', unappliedCredit: '1000.00' });
    expect(statement.openSales).toEqual([expect.objectContaining({ id: creditSale, outstanding: '575.00' })]);
    expect(statement.lines.map((l: { type: string }) => l.type)).toEqual(['SALE', 'RETURN', 'RECEIPT', 'RECEIPT']);

    const aging = await ok(get(owner, '/reports/receivables-aging'));
    expect(aging.totals).toMatchObject({ days0to30: '575.00', unappliedCredits: '1000.00', balance: '-425.00' });
    expect(aging.ledgerBalance).toBe('-425.00');
  });
});

describe('online orders: refunds', () => {
  const shopper = async () => {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/store/auth/register').send({ name: 'Ada Obi', email: `ada.${randomUUID().slice(0, 8)}@shop.test`, phone: '08031112222', password: 'shopper-password' });
    return { agent, csrf: res.body.data.csrfToken as string };
  };
  const checkout = async (s: Awaited<ReturnType<typeof shopper>>, variantId: string, qty: string) => {
    const lagos = (await prisma().shippingMethod.findFirstOrThrow({ where: { name: 'Lagos delivery' } })).id;
    const res = await s.agent
      .post('/api/v1/store/checkout')
      .set('X-CSRF-Token', s.csrf)
      .set('Idempotency-Key', randomUUID())
      .send({ items: [{ variantId, qty }], shippingMethodId: lagos, provider: 'TEST', address: { recipient: 'Ada Obi', phone: '08031112222', line1: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos' } });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.data;
  };
  const pay = (reference: string, amount: string) => {
    const { raw, signature } = testGatewayEvent(env, { eventId: `evt_${randomUUID()}`, type: 'payment.succeeded', reference, amount });
    return request(app).post('/api/v1/webhooks/payments/test').set('Content-Type', 'application/json').set('X-Test-Signature', signature).send(raw.toString());
  };

  it('cancelling a paid order returns everything to stock and refunds through the gateway, delivery included', async () => {
    await prisma().product.updateMany({ data: { onlineVisible: true } });
    const order = await checkout(await shopper(), gel, '2');
    expect((await pay(order.payment.reference, order.total)).body.result).toBe('PAID');
    const before = await onHand(gel);
    expect((await send(cashier, 'post', `/orders/${order.id}/refund`, { reason: 'Customer cancelled' })).status).toBe(403);
    const refunded = await ok(send(manager, 'post', `/orders/${order.id}/refund`, { reason: 'Customer cancelled' }));
    expect(refunded).toMatchObject({ status: 'REFUNDED', returns: [expect.objectContaining({ status: 'COMPLETED', total: '4650.00' })] });
    expect(dec(await onHand(gel)).minus(before).toFixed(3)).toBe('2.000');
    const lines = await journalOf(refunded.returns[0].id);
    expect(lines).toEqual(
      expect.arrayContaining([
        ['SALES_RETURNS', '2000.00', '0.00'],
        ['SHIPPING_INCOME', '2325.58', '0.00'],
        ['VAT_OUTPUT', '324.42', '0.00'],
        ['GATEWAY_CLEARING', '0.00', '4650.00'],
      ]),
    );
    expect((await send(manager, 'post', `/orders/${order.id}/refund`, { reason: 'Again' })).status).toBe(422);
  });

  it('a deposit held for an order that could not be fulfilled is paid back and the order cancelled', async () => {
    const balm = (await makeProduct((await prisma().user.findFirstOrThrow({ where: { email: { contains: 'manager' } } })).id, { variants: [{ sellingPrice: '500.00' }] })).variants[0]!.id;
    await prisma().product.updateMany({ data: { onlineVisible: true } });
    await stockIn([{ variantId: balm, qtyChange: '1', unitCost: '200' }]);
    const order = await checkout(await shopper(), balm, '1');
    await prisma().onlineOrder.update({ where: { id: order.id }, data: { reservedUntil: new Date(Date.now() - 60_000) } });
    await releaseExpiredReservations();
    await ok(sell({ lines: [{ variantId: balm, qty: '1', unitPrice: '500.00' }], payments: [{ paymentMethodId: pm.CASH, amount: '500.00' }] }), 201);
    expect((await pay(order.payment.reference, order.total)).body.result).toBe('ON_HOLD');

    const done = await ok(send(manager, 'post', `/orders/${order.id}/refund-deposit`, {}));
    expect(done).toMatchObject({ status: 'CANCELLED', depositRefundJournalId: expect.any(String) });
    expect(await journalOf(order.id)).toEqual([
      ['GATEWAY_CLEARING', order.total, '0.00'],
      ['CUSTOMER_DEPOSITS', '0.00', order.total],
      ['CUSTOMER_DEPOSITS', order.total, '0.00'],
      ['GATEWAY_CLEARING', '0.00', order.total],
    ]);
    expect((await send(manager, 'post', `/orders/${order.id}/refund-deposit`, {})).status).toBe(422);
  });
});

describe('expenses', () => {
  let rent: string;
  let receipt: string;

  it('keeps receipts private and accepts only real photos or PDFs', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
    receipt = (await ok(manager.agent.post('/api/v1/files/documents').set('X-CSRF-Token', manager.csrf).attach('file', pdf, 'invoice.pdf'), 201)).id;
    const fake = await manager.agent.post('/api/v1/files/documents').set('X-CSRF-Token', manager.csrf).attach('file', Buffer.from('<html><script>alert(1)</script></html>'), 'invoice.pdf');
    expect(fake.status).toBe(400);
    const download = await get(manager, `/files/${receipt}`);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toMatch(/^attachment/);
    expect((await get(cashier, `/files/${receipt}`)).status).toBe(403);
    expect((await request(app).get(`/api/v1/files/${receipt}`)).status).toBe(401);
  });

  it('goes from draft to submitted to posted, splitting out recoverable VAT', async () => {
    rent = (await prisma().expenseCategory.findFirstOrThrow({ where: { name: 'Rent' } })).id;
    const vat = (await prisma().taxRate.findFirstOrThrow({ where: { code: 'VAT' } })).id;
    const body = { expenseDate: today, categoryId: rent, payee: 'Allen Properties', description: 'Shop rent, October', total: '10750.00', taxRateId: vat, paymentAccountId: acc['1010'], attachmentIds: [receipt] };
    expect((await send(cashier, 'post', '/expenses', body)).status).toBe(403);
    const draft = await ok(send(manager, 'post', '/expenses', body), 201);
    expect(draft).toMatchObject({ status: 'DRAFT', net: '10000.00', tax: '750.00', attachments: [expect.objectContaining({ id: receipt })] });
    expect((await send(accountant, 'post', `/expenses/${draft.id}/approve`)).status).toBe(422); // not submitted
    await ok(send(manager, 'post', `/expenses/${draft.id}/submit`));
    const posted = await ok(send(accountant, 'post', `/expenses/${draft.id}/approve`));
    expect(posted).toMatchObject({ status: 'POSTED', approvedBy: expect.any(String) });
    expect(await journalOf(draft.id)).toEqual([
      ['6000', '10000.00', '0.00'],
      ['VAT_INPUT', '750.00', '0.00'],
      ['BANK_MAIN', '0.00', '10750.00'],
    ]);
    expect((await send(manager, 'put', `/expenses/${draft.id}`, body)).status).toBe(422);
    await expect(prisma().$executeRaw`DELETE FROM expense_attachments WHERE expense_id = ${draft.id}::uuid`).rejects.toThrow(/posted expense/);
  });

  it('an approver can send a submission back to draft with a reason', async () => {
    const draft = await ok(send(manager, 'post', '/expenses', { expenseDate: today, categoryId: rent, payee: 'NEPA', description: 'Generator diesel', total: '20000.00', paymentAccountId: acc['1000'] }), 201);
    await ok(send(manager, 'post', `/expenses/${draft.id}/submit`));
    const back = await ok(send(accountant, 'post', `/expenses/${draft.id}/reject`, { reason: 'Wrong category: use utilities' }));
    expect(back).toMatchObject({ status: 'DRAFT', rejectedReason: 'Wrong category: use utilities' });
  });
});

describe('bank reconciliation and card settlement', () => {
  it('settles card takings into the bank net of charges', async () => {
    const entry = await ok(send(accountant, 'post', '/settlements', { settlementDate: today, clearingAccountId: acc['1020'], bankAccountId: acc['1010'], amount: '2000.00', fees: '30.00', reference: 'POS-SETTLE-1' }), 201);
    expect(entry.lines.map((l: { account: { code: string }; debit: string; credit: string }) => [l.account.code, l.debit, l.credit])).toEqual([
      ['1010', '1970.00', '0.00'],
      ['6050', '30.00', '0.00'],
      ['1020', '0.00', '2000.00'],
    ]);
    expect(entry.reversible).toBe(true);
  });

  it('completes only when the ticked lines match the statement, and then locks them', async () => {
    // Bank so far: receipts 500 + 1,000 − rent 10,750 + settlement 1,970.
    const statementBalance = '-7280.00';
    const rec = await ok(send(accountant, 'post', '/reconciliations', { accountId: acc['1010'], statementDate: today, statementBalance }), 201);
    expect(rec).toMatchObject({ openingBalance: '0.00', difference: statementBalance });
    expect(rec.lines).toHaveLength(4);
    expect((await send(accountant, 'post', '/reconciliations', { accountId: acc['1010'], statementDate: today, statementBalance: '0' })).status).toBe(409);

    const partial = await ok(send(accountant, 'put', `/reconciliations/${rec.id}/lines`, { cleared: rec.lines.slice(0, 2).map((l: { journalLineId: string }) => l.journalLineId) }));
    expect(partial.difference).not.toBe('0.00');
    expect((await send(accountant, 'post', `/reconciliations/${rec.id}/complete`)).status).toBe(422);

    await ok(send(accountant, 'put', `/reconciliations/${rec.id}/lines`, { cleared: rec.lines.map((l: { journalLineId: string }) => l.journalLineId) }));
    const done = await ok(send(accountant, 'post', `/reconciliations/${rec.id}/complete`));
    expect(done).toMatchObject({ status: 'COMPLETED', difference: '0.00', clearedBalance: statementBalance });
    expect((await send(accountant, 'put', `/reconciliations/${rec.id}/lines`, { cleared: [] })).status).toBe(422);
    await expect(prisma().$executeRaw`DELETE FROM bank_reconciliation_lines WHERE reconciliation_id = ${rec.id}::uuid`).rejects.toThrow(/completed reconciliation/);

    const next = await send(accountant, 'post', '/reconciliations', { accountId: acc['1010'], statementDate: isoDaysFromNow(-1), statementBalance: '0' });
    expect(next.status).toBe(400);
  });
});

describe('ledger stays reconciled', () => {
  it('stock = Inventory, AR = customer balances, every entry balances', async () => {
    expect((await ok(get(owner, '/inventory/valuation'))).difference).toBe('0.00');
    const customers = await ok(get(owner, '/customers?pageSize=100&includeInactive=true'));
    const tb = await ok(get(owner, '/reports/trial-balance'));
    const ar = tb.rows.find((r: { account: { code: string } }) => r.account.code === '1100');
    const arBalance = ar ? dec(ar.debit).minus(ar.credit) : dec(0);
    expect(sum(customers.map((c: { balance: string }) => c.balance)).toFixed(2)).toBe(arBalance.toFixed(2));
    expect(tb.totals.debit).toBe(tb.totals.credit);
    const unbalanced = await prisma().$queryRaw<unknown[]>`SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING SUM(debit) <> SUM(credit)`;
    expect(unbalanced).toEqual([]);
  });
});
