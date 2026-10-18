import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { getPrisma } from '../../src/lib/prisma';
import { isoDaysFromNow, mainLocationId, makeProduct } from '../helpers/catalog';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, signIn } from '../helpers/test-app';

const app = buildTestApp();
const prisma = () => getPrisma();
type Agent = Awaited<ReturnType<typeof signIn>>;
let manager: Agent;
let officer: Agent;
let cashier: Agent;
let mainId: string;
let supplierId: string;
let variantId: string;
let lotVariantId: string;
let bankId: string;
let transportId: string;
let vatId: string;
const today = new Date().toISOString().slice(0, 10);

const send = (who: Agent, method: 'post' | 'put', path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  let req = who.agent[method](path).set('X-CSRF-Token', who.csrf);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(body as object);
};
const ok = async (p: Promise<request.Response> | request.Test, status = 200) => {
  const res = await p;
  if (res.status !== status) throw new Error(`Expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const journal = async (sourceId: string) =>
  (
    await prisma().journalLine.findMany({
      where: { entry: { sourceId } },
      include: { account: { select: { systemKey: true, code: true } } },
      orderBy: { lineNo: 'asc' },
    })
  ).map((l) => [l.account.systemKey ?? l.account.code, l.debit.toFixed(2), l.credit.toFixed(2)]);
const variant = (id: string) => prisma().productVariant.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  await resetDatabase();
  const [m, o, c] = await Promise.all([createStaff('MANAGER'), createStaff('INVENTORY_OFFICER'), createStaff('CASHIER')]);
  [manager, officer, cashier] = await Promise.all([signIn(app, m.email, TEST_PASSWORD), signIn(app, o.email, TEST_PASSWORD), signIn(app, c.email, TEST_PASSWORD)]);
  mainId = await mainLocationId();
  supplierId = (await ok(send(manager, 'post', '/api/v1/suppliers', { name: 'Glow Beauty Wholesale', paymentTermsDays: 30 }), 201)).id;
  variantId = (await makeProduct(m.user.id)).variants[0]!.id;
  lotVariantId = (await makeProduct(m.user.id, { expiry: true })).variants[0]!.id;
  bankId = (await prisma().account.findUniqueOrThrow({ where: { systemKey: 'BANK_MAIN' } })).id;
  transportId = (await prisma().account.findUniqueOrThrow({ where: { code: '6040' } })).id;
  vatId = (await prisma().taxRate.findUniqueOrThrow({ where: { code: 'VAT' } })).id;
});

let poId: string;
let grn1: { id: string; lineId: string };
let grn2: { id: string; lineId: string };
let invoiceId: string;

describe('purchase orders', () => {
  it('creates a priced order with VAT, approved only by an approver and then locked', async () => {
    const po = await ok(
      send(officer, 'post', '/api/v1/purchase-orders', { supplierId, locationId: mainId, orderDate: today, lines: [{ variantId, qty: '10', unitCost: '100' }] }),
      201,
    );
    expect(po).toMatchObject({ status: 'DRAFT', subtotal: '1000.00', taxTotal: '75.00', total: '1075.00' });
    expect(po.number).toMatch(/^PO-\d{6}$/);
    poId = po.id;

    expect((await send(officer, 'post', `/api/v1/purchase-orders/${poId}/approve`)).status).toBe(403);
    expect((await ok(send(manager, 'post', `/api/v1/purchase-orders/${poId}/approve`))).status).toBe('APPROVED');
    const edit = await send(manager, 'put', `/api/v1/purchase-orders/${poId}`, { supplierId, locationId: mainId, orderDate: today, lines: [{ variantId, qty: '1', unitCost: '1' }] });
    expect(edit.status).toBe(422);
    await expect(prisma().purchaseOrderLine.updateMany({ where: { poId }, data: { unitCost: 1 } })).rejects.toThrow(/cannot be changed/);
  });
});

describe('goods receipts', () => {
  it('receives part of an order: stock up, order partly received, Dr Inventory / Cr GRNI (acceptance #2)', async () => {
    const draft = await ok(send(officer, 'post', `/api/v1/purchase-orders/${poId}/receipts`, { receivedDate: today }), 201);
    expect(draft.lines[0]).toMatchObject({ qty: '10.000', unitCost: '100.0000' });
    const edited = await ok(
      send(officer, 'put', `/api/v1/goods-receipts/${draft.id}`, {
        supplierId,
        locationId: mainId,
        poId,
        receivedDate: today,
        supplierRef: 'WAYBILL-1',
        lines: [{ poLineId: draft.lines[0].poLineId, variantId, qty: '6', unitCost: '100' }],
      }),
    );
    const posted = await ok(send(officer, 'post', `/api/v1/goods-receipts/${edited.id}/post`));
    expect(posted).toMatchObject({ status: 'POSTED', totalValue: '600.00' });
    grn1 = { id: posted.id, lineId: posted.lines[0].id };

    const v = await variant(variantId);
    expect(v.stockQty.toFixed(3)).toBe('6.000');
    expect(v.avgCost.toFixed(4)).toBe('100.0000');
    expect(await journal(posted.id)).toEqual([
      ['INVENTORY', '600.00', '0.00'],
      ['GRNI', '0.00', '600.00'],
    ]);
    const po = await ok(manager.agent.get(`/api/v1/purchase-orders/${poId}`));
    expect(po.status).toBe('PARTIALLY_RECEIVED');
    expect(po.lines[0]).toMatchObject({ qtyReceived: '6.000', qtyOutstanding: '4.000' });
  });

  it('blocks receiving more than is outstanding, then completes the order', async () => {
    const po = await ok(manager.agent.get(`/api/v1/purchase-orders/${poId}`));
    const body = (q: string) => ({ supplierId, locationId: mainId, poId, receivedDate: today, lines: [{ poLineId: po.lines[0].id, variantId, qty: q, unitCost: '100' }] });
    const over = await ok(send(officer, 'post', '/api/v1/goods-receipts', body('5')), 201);
    const rejected = await send(officer, 'post', `/api/v1/goods-receipts/${over.id}/post`);
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.message).toMatch(/only 4\.000 is outstanding/);
    await ok(send(officer, 'post', `/api/v1/goods-receipts/${over.id}/cancel`));

    const rest = await ok(send(officer, 'post', '/api/v1/goods-receipts', body('4')), 201);
    const posted = await ok(send(officer, 'post', `/api/v1/goods-receipts/${rest.id}/post`));
    grn2 = { id: posted.id, lineId: posted.lines[0].id };
    expect((await ok(manager.agent.get(`/api/v1/purchase-orders/${poId}`))).status).toBe('RECEIVED');
    expect((await variant(variantId)).stockQty.toFixed(3)).toBe('10.000');
  });

  it('requires lot details for expiry-tracked goods and creates the lot on receipt', async () => {
    const base = { supplierId, locationId: mainId, receivedDate: today };
    const missing = await send(officer, 'post', '/api/v1/goods-receipts', { ...base, lines: [{ variantId: lotVariantId, qty: '12', unitCost: '50' }] });
    expect(missing.status).toBe(400);
    const g = await ok(
      send(officer, 'post', '/api/v1/goods-receipts', { ...base, lines: [{ variantId: lotVariantId, qty: '12', unitCost: '50', lotNumber: 'GB-777', expiryDate: isoDaysFromNow(365) }] }),
      201,
    );
    await ok(send(officer, 'post', `/api/v1/goods-receipts/${g.id}/post`));
    const lot = await prisma().inventoryBatch.findFirstOrThrow({ where: { variantId: lotVariantId } });
    expect(lot).toMatchObject({ lotNumber: 'GB-777' });
    expect(lot.qtyOnHand.toFixed(3)).toBe('12.000');
  });
});

describe('supplier invoices', () => {
  it('matches received goods, books the price difference and VAT, and credits payables', async () => {
    const open = await ok(manager.agent.get('/api/v1/supplier-invoices/open-receipt-lines').query({ supplierId }));
    expect(open.map((l: { grnLineId: string; qtyInvoiceable: string }) => [l.grnLineId, l.qtyInvoiceable])).toEqual(
      expect.arrayContaining([
        [grn1.lineId, '6.000'],
        [grn2.lineId, '4.000'],
      ]),
    );

    const inv = await ok(
      send(manager, 'post', '/api/v1/supplier-invoices', {
        supplierId,
        supplierRef: 'GBW-1001',
        invoiceDate: today,
        lines: [
          { grnLineId: grn1.lineId, qty: '6', unitCost: '105' },
          // Expense lines carry VAT only when a rate is given.
          { accountId: transportId, description: 'Delivery', qty: '1', unitCost: '2000', taxRateId: vatId },
        ],
      }),
      201,
    );
    expect(inv).toMatchObject({ subtotal: '2630.00', taxTotal: '197.25', total: '2827.25', status: 'DRAFT' });
    const posted = await ok(send(manager, 'post', `/api/v1/supplier-invoices/${inv.id}/post`));
    expect(posted).toMatchObject({ status: 'POSTED', outstanding: '2827.25' });
    invoiceId = inv.id;

    expect(await journal(inv.id)).toEqual([
      ['GRNI', '600.00', '0.00'],
      ['PURCHASE_PRICE_VARIANCE', '30.00', '0.00'],
      ['6040', '2000.00', '0.00'],
      ['VAT_INPUT', '197.25', '0.00'],
      ['AP', '0.00', '2827.25'],
    ]);
    const line = await prisma().goodsReceiptLine.findUniqueOrThrow({ where: { id: grn1.lineId } });
    expect(line.qtyInvoiced.toFixed(3)).toBe('6.000');
    expect(line.grniCleared.toFixed(2)).toBe('600.00');
  });

  it('refuses the same supplier invoice twice and invoicing goods already invoiced', async () => {
    const dup = await send(manager, 'post', '/api/v1/supplier-invoices', {
      supplierId,
      supplierRef: 'gbw-1001',
      invoiceDate: today,
      lines: [{ grnLineId: grn2.lineId, qty: '1', unitCost: '100' }],
    });
    expect(dup.status).toBe(409);
    const again = await send(manager, 'post', '/api/v1/supplier-invoices', {
      supplierId,
      supplierRef: 'GBW-1002',
      invoiceDate: today,
      lines: [{ grnLineId: grn1.lineId, qty: '1', unitCost: '105' }],
    });
    expect(again.status).toBe(400);
    expect(again.body.error.message).toMatch(/only 0\.000 is still to be invoiced/);
  });

  it('posting two drafts for the same goods cannot double-invoice them', async () => {
    const body = (ref: string) => ({ supplierId, supplierRef: ref, invoiceDate: today, lines: [{ grnLineId: grn2.lineId, qty: '4', unitCost: '100' }] });
    const [a, b] = await Promise.all([ok(send(manager, 'post', '/api/v1/supplier-invoices', body('RACE-A')), 201), ok(send(manager, 'post', '/api/v1/supplier-invoices', body('RACE-B')), 201)]);
    const results = await Promise.all([a, b].map((d) => send(manager, 'post', `/api/v1/supplier-invoices/${d.id}/post`)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const line = await prisma().goodsReceiptLine.findUniqueOrThrow({ where: { id: grn2.lineId } });
    expect(line.qtyInvoiced.toFixed(3)).toBe('4.000');
    // Cancel the loser's draft so later tests see a clean ledger.
    const loser = [a, b][results.findIndex((r) => r.status === 409)]!;
    await ok(send(manager, 'post', `/api/v1/supplier-invoices/${loser.id}/cancel`));
  });
});

describe('supplier payments', () => {
  it('records partial payments idempotently and settles the invoice', async () => {
    const key = randomUUID();
    const body = { supplierId, paymentDate: today, amount: '1000.00', accountId: bankId, reference: 'TRF-0001', allocations: [{ invoiceId, amount: '1000.00' }] };

    expect((await send(manager, 'post', '/api/v1/supplier-payments', body)).status).toBe(400); // no key
    const first = await send(manager, 'post', '/api/v1/supplier-payments', body, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    const replay = await send(manager, 'post', '/api/v1/supplier-payments', body, { 'Idempotency-Key': key });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.id).toBe(first.body.data.id);
    const reused = await send(manager, 'post', '/api/v1/supplier-payments', { ...body, amount: '1.00', allocations: [] }, { 'Idempotency-Key': key });
    expect(reused.status).toBe(409);
    expect(await prisma().supplierPayment.count({ where: { supplierId } })).toBe(1);

    expect(await journal(first.body.data.id)).toEqual([
      ['AP', '1000.00', '0.00'],
      ['BANK_MAIN', '0.00', '1000.00'],
    ]);
    expect((await ok(manager.agent.get(`/api/v1/supplier-invoices/${invoiceId}`))).status).toBe('PARTIALLY_PAID');

    const over = await send(manager, 'post', '/api/v1/supplier-payments', { ...body, amount: '5000', allocations: [{ invoiceId, amount: '5000' }] }, { 'Idempotency-Key': randomUUID() });
    expect(over.status).toBe(422);

    await ok(send(manager, 'post', '/api/v1/supplier-payments', { ...body, amount: '1827.25', allocations: [{ invoiceId, amount: '1827.25' }] }, { 'Idempotency-Key': randomUUID() }), 201);
    const inv = await ok(manager.agent.get(`/api/v1/supplier-invoices/${invoiceId}`));
    expect(inv).toMatchObject({ status: 'PAID', outstanding: '0.00' });
    expect(inv.payments).toHaveLength(2);
  });

  it('two concurrent payments cannot both settle the same balance', async () => {
    const inv = await ok(
      send(manager, 'post', '/api/v1/supplier-invoices', {
        supplierId,
        supplierRef: 'GBW-RACE-PAY',
        invoiceDate: today,
        lines: [{ accountId: transportId, description: 'Courier', qty: '1', unitCost: '500', taxRateId: vatId }],
      }),
      201,
    );
    await ok(send(manager, 'post', `/api/v1/supplier-invoices/${inv.id}/post`));
    const pay = () =>
      send(manager, 'post', '/api/v1/supplier-payments', { supplierId, paymentDate: today, amount: '537.50', accountId: bankId, allocations: [{ invoiceId: inv.id, amount: '537.50' }] }, { 'Idempotency-Key': randomUUID() });
    const results = await Promise.all([pay(), pay()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect((await prisma().supplierInvoice.findUniqueOrThrow({ where: { id: inv.id } })).amountPaid.toFixed(2)).toBe('537.50');
  });

  it('keeps payments immutable', async () => {
    const p = await prisma().supplierPayment.findFirstOrThrow({ where: { supplierId } });
    await expect(prisma().supplierPayment.update({ where: { id: p.id }, data: { amount: 1 } })).rejects.toThrow(/append-only/);
  });
});

describe('purchase returns', () => {
  it('returns uninvoiced goods against GRNI', async () => {
    // GRN 2's goods were invoiced by the race test; receive a fresh, uninvoiced batch to return.
    const g = await ok(send(officer, 'post', '/api/v1/goods-receipts', { supplierId, locationId: mainId, receivedDate: today, lines: [{ variantId, qty: '2', unitCost: '100' }] }), 201);
    const posted = await ok(send(officer, 'post', `/api/v1/goods-receipts/${g.id}/post`));
    const draft = await ok(send(officer, 'post', '/api/v1/purchase-returns', { receiptId: posted.id, returnDate: today, reason: 'Damaged on arrival', lines: [{ grnLineId: posted.lines[0].id, qty: '1' }] }), 201);
    const ret = await ok(send(officer, 'post', `/api/v1/purchase-returns/${draft.id}/post`));
    expect(ret).toMatchObject({ status: 'POSTED', creditTotal: '0.00' });
    expect(await journal(ret.id)).toEqual([
      ['GRNI', '100.00', '0.00'],
      ['INVENTORY', '0.00', '100.00'],
    ]);
  });

  it('returns invoiced goods with a debit note, reversing VAT input and the price difference', async () => {
    const draft = await ok(send(officer, 'post', '/api/v1/purchase-returns', { receiptId: grn1.id, returnDate: today, lines: [{ grnLineId: grn1.lineId, qty: '1' }] }), 201);
    const ret = await ok(send(officer, 'post', `/api/v1/purchase-returns/${draft.id}/post`));
    // Invoiced at 105 + 7.5% VAT (7.88); stock leaves at the 100 average; 5 back to price variance.
    expect(ret.creditTotal).toBe('112.88');
    expect(await journal(ret.id)).toEqual([
      ['AP', '112.88', '0.00'],
      ['VAT_INPUT', '0.00', '7.88'],
      ['INVENTORY', '0.00', '100.00'],
      ['PURCHASE_PRICE_VARIANCE', '0.00', '5.00'],
    ]);
    const tooMany = await send(officer, 'post', '/api/v1/purchase-returns', { receiptId: grn1.id, returnDate: today, lines: [{ grnLineId: grn1.lineId, qty: '6' }] });
    expect(tooMany.status).toBe(400);
  });
});

describe('statements, ageing and reconciliation', () => {
  it('produces a statement with a running balance and ages what is owed', async () => {
    const st = await ok(manager.agent.get(`/api/v1/suppliers/${supplierId}/statement`));
    expect(st.lines.map((l: { type: string }) => l.type)).toEqual(expect.arrayContaining(['INVOICE', 'PAYMENT', 'RETURN']));
    expect(st.lines.at(-1).balance).toBe(st.closingBalance);
    // Invoices 2,827.25 + 537.50 + 400 (race winner, 4 @ 100 + VAT 30 = 430) − payments 2,827.25 + 537.50 − debit note 112.88.
    expect(st.closingBalance).toBe('317.12');

    const aging = await ok(manager.agent.get('/api/v1/reports/payables-aging'));
    const row = aging.rows.find((r: { supplier: { id: string } }) => r.supplier.id === supplierId);
    expect(row).toMatchObject({ current: '430.00', unappliedCredits: '112.88', balance: '317.12' });
  });

  it('Accounts payable, GRNI and Inventory each equal their subledgers', async () => {
    const gl = async (key: string) => {
      const [r] = await prisma().$queryRaw<{ bal: string }[]>`
        SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS bal FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'POSTED'
        JOIN accounts a ON a.id = l.account_id AND a.system_key = ${key}`;
      return r!.bal;
    };
    const st = await ok(manager.agent.get(`/api/v1/suppliers/${supplierId}/statement`));
    expect(await gl('AP')).toBe(st.closingBalance);

    const [grni] = await prisma().$queryRaw<{ v: string }[]>`
      SELECT COALESCE(SUM(l.value - l.grni_cleared), 0)::text AS v FROM goods_receipt_lines l
      JOIN goods_receipts g ON g.id = l.receipt_id AND g.status = 'POSTED'`;
    expect(await gl('GRNI')).toBe(grni!.v);

    const valuation = await ok(manager.agent.get('/api/v1/inventory/valuation'));
    expect(valuation.difference).toBe('0.00');
  });
});

describe('access control', () => {
  it('restricts purchasing functions by role', async () => {
    expect((await cashier.agent.get('/api/v1/purchase-orders')).status).toBe(403);
    expect((await send(officer, 'post', '/api/v1/supplier-invoices', { supplierId, supplierRef: 'X', invoiceDate: today, lines: [] })).status).toBe(403);
    expect(
      (await send(officer, 'post', '/api/v1/supplier-payments', { supplierId, paymentDate: today, amount: '1', accountId: bankId }, { 'Idempotency-Key': randomUUID() })).status,
    ).toBe(403);
  });
});
