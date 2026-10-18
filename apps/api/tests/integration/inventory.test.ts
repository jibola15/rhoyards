import { beforeAll, describe, expect, it } from 'vitest';
import { dec } from '@rhoyards/shared';
import { openStockSession } from '../../src/engines/inventory/inventory.engine';
import { getPrisma, transaction } from '../../src/lib/prisma';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { isoDaysFromNow, mainLocationId, makeProduct } from '../helpers/catalog';
import { buildTestApp, signIn } from '../helpers/test-app';

const app = buildTestApp();
const prisma = () => getPrisma();
let manager: Awaited<ReturnType<typeof signIn>>;
let officer: Awaited<ReturnType<typeof signIn>>;
let managerId: string;
let mainId: string;

beforeAll(async () => {
  await resetDatabase();
  const [m, o] = await Promise.all([createStaff('MANAGER'), createStaff('INVENTORY_OFFICER')]);
  managerId = m.user.id;
  [manager, officer] = await Promise.all([signIn(app, m.email, TEST_PASSWORD), signIn(app, o.email, TEST_PASSWORD)]);
  mainId = await mainLocationId();
});

const send = (method: 'post' | 'put', path: string, body: unknown, who = manager) =>
  who.agent[method](path).set('X-CSRF-Token', who.csrf).send(body as object);

/** Creates and posts an adjustment; returns the posted detail. */
async function adjust(reason: string, lines: Record<string, unknown>[], locationId = mainId) {
  const draft = await send('post', '/api/v1/stock-adjustments', { locationId, reason, lines });
  if (draft.status !== 201) throw new Error(`draft failed: ${JSON.stringify(draft.body)}`);
  return send('post', `/api/v1/stock-adjustments/${draft.body.data.id}/post`, {});
}

const variant = (id: string) => prisma().productVariant.findUniqueOrThrow({ where: { id } });
const journalLines = (sourceId: string) =>
  prisma().journalLine.findMany({
    where: { entry: { sourceId } },
    include: { account: { select: { systemKey: true } } },
    orderBy: { lineNo: 'asc' },
  });

describe('stock adjustments and moving weighted-average cost', () => {
  it('posts opening stock: stock, movements and journal (Dr Inventory / Cr Opening balance equity)', async () => {
    const p = await makeProduct(managerId);
    const v = p.variants[0]!;
    const res = await adjust('OPENING_STOCK', [{ variantId: v.id, qtyChange: '10', unitCost: '100' }]);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'POSTED', totalValue: '1000.00' });

    const after = await variant(v.id);
    expect(after.stockQty.toFixed(3)).toBe('10.000');
    expect(after.avgCost.toFixed(4)).toBe('100.0000');
    expect(after.stockValue.toFixed(2)).toBe('1000.00');

    const lines = await journalLines(res.body.data.id);
    expect(lines.map((l) => [l.account.systemKey, l.debit.toFixed(2), l.credit.toFixed(2)])).toEqual([
      ['INVENTORY', '1000.00', '0.00'],
      ['OPENING_BALANCE_EQUITY', '0.00', '1000.00'],
    ]);
    const movements = await prisma().stockMovement.findMany({ where: { variantId: v.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: 'OPENING' });
  });

  it('averages costs on receipt and issues at the average', async () => {
    const v = (await makeProduct(managerId)).variants[0]!;
    await adjust('OPENING_STOCK', [{ variantId: v.id, qtyChange: '10', unitCost: '100' }]);
    await adjust('STOCK_COUNT', [{ variantId: v.id, qtyChange: '10', unitCost: '130' }]);
    expect((await variant(v.id)).avgCost.toFixed(4)).toBe('115.0000');

    const out = await adjust('DAMAGE', [{ variantId: v.id, qtyChange: '-5' }]);
    expect(out.body.data.totalValue).toBe('-575.00');
    const lines = await journalLines(out.body.data.id);
    expect(lines.map((l) => [l.account.systemKey, l.debit.toFixed(2), l.credit.toFixed(2)])).toEqual([
      ['STOCK_WRITE_OFF', '575.00', '0.00'],
      ['INVENTORY', '0.00', '575.00'],
    ]);

    const remaining = await variant(v.id);
    expect(remaining.stockQty.toFixed(3)).toBe('15.000');
    expect(remaining.stockValue.toFixed(2)).toBe('1725.00');
  });

  it('releases exactly the remaining value when stock is emptied (no rounding residue)', async () => {
    const v = (await makeProduct(managerId)).variants[0]!;
    await adjust('OPENING_STOCK', [{ variantId: v.id, qtyChange: '3', unitCost: '33.3333' }]);
    expect((await variant(v.id)).stockValue.toFixed(2)).toBe('100.00');
    const first = await adjust('OTHER', [{ variantId: v.id, qtyChange: '-1' }]);
    expect(first.body.data.totalValue).toBe('-33.33');
    const rest = await adjust('OTHER', [{ variantId: v.id, qtyChange: '-2' }]);
    expect(rest.body.data.totalValue).toBe('-66.67');
    const empty = await variant(v.id);
    expect(empty.stockQty.toFixed(3)).toBe('0.000');
    expect(empty.stockValue.toFixed(2)).toBe('0.00');
  });

  it('blocks negative stock and leaves nothing behind when posting fails', async () => {
    const v = (await makeProduct(managerId)).variants[0]!;
    await adjust('OPENING_STOCK', [{ variantId: v.id, qtyChange: '2', unitCost: '50' }]);
    const before = await prisma().stockMovement.count();
    const journalsBefore = await prisma().journalEntry.count();

    const draft = await send('post', '/api/v1/stock-adjustments', {
      locationId: mainId,
      reason: 'THEFT',
      lines: [{ variantId: v.id, qtyChange: '-1' }, { variantId: v.id, qtyChange: '-5' }],
    });
    const res = await send('post', `/api/v1/stock-adjustments/${draft.body.data.id}/post`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');

    // The first line's issue was rolled back with the rest of the transaction.
    expect(await prisma().stockMovement.count()).toBe(before);
    expect(await prisma().journalEntry.count()).toBe(journalsBefore);
    expect((await variant(v.id)).stockQty.toFixed(3)).toBe('2.000');
    expect((await prisma().stockAdjustment.findUniqueOrThrow({ where: { id: draft.body.data.id } })).status).toBe('DRAFT');
  });

  it('allows negative stock only when enabled in settings AND the user holds the permission', async () => {
    const v = (await makeProduct(managerId)).variants[0]!;
    const accountant = await signIn(app, (await createStaff('OWNER')).email, TEST_PASSWORD);
    const settings = (await accountant.agent.get('/api/v1/settings')).body.data;
    await accountant.agent
      .patch('/api/v1/settings')
      .set('X-CSRF-Token', accountant.csrf)
      .send({ inventory: { ...settings.inventory, allowNegativeStock: true } });
    try {
      // Manager lacks stock.negative.allow → still blocked.
      const blocked = await adjust('OTHER', [{ variantId: v.id, qtyChange: '-1' }]);
      expect(blocked.status).toBe(409);
      // Owner has every permission → allowed.
      const draft = await send('post', '/api/v1/stock-adjustments', { locationId: mainId, reason: 'OTHER', lines: [{ variantId: v.id, qtyChange: '-1' }] }, accountant);
      const ok = await send('post', `/api/v1/stock-adjustments/${draft.body.data.id}/post`, {}, accountant);
      expect(ok.status).toBe(200);
      expect((await variant(v.id)).stockQty.toFixed(3)).toBe('-1.000');
    } finally {
      await accountant.agent.patch('/api/v1/settings').set('X-CSRF-Token', accountant.csrf).send({ inventory: settings.inventory });
    }
  });

  it('cannot be posted twice, and posted documents and movements are immutable', async () => {
    const v = (await makeProduct(managerId)).variants[0]!;
    const posted = await adjust('OPENING_STOCK', [{ variantId: v.id, qtyChange: '1', unitCost: '10' }]);
    const again = await send('post', `/api/v1/stock-adjustments/${posted.body.data.id}/post`, {});
    expect(again.status).toBe(422);
    expect(await prisma().journalEntry.count({ where: { sourceId: posted.body.data.id } })).toBe(1);

    await expect(prisma().stockAdjustment.update({ where: { id: posted.body.data.id }, data: { note: 'edited' } })).rejects.toThrow(/cannot be changed/);
    const movement = await prisma().stockMovement.findFirstOrThrow({ where: { variantId: v.id } });
    await expect(prisma().stockMovement.update({ where: { id: movement.id }, data: { note: 'x' } })).rejects.toThrow(/append-only/);
    await expect(prisma().stockMovement.delete({ where: { id: movement.id } })).rejects.toThrow(/append-only/);
  });

  it('separates duties: an inventory officer drafts, only an approver posts', async () => {
    const v = (await makeProduct(managerId)).variants[0]!;
    const draft = await send('post', '/api/v1/stock-adjustments', { locationId: mainId, reason: 'OPENING_STOCK', lines: [{ variantId: v.id, qtyChange: '1', unitCost: '1' }] }, officer);
    expect(draft.status).toBe(201);
    expect((await send('post', `/api/v1/stock-adjustments/${draft.body.data.id}/post`, {}, officer)).status).toBe(403);
    expect((await send('post', `/api/v1/stock-adjustments/${draft.body.data.id}/post`, {}, manager)).status).toBe(200);
  });

  it('validates adjustment lines', async () => {
    const v = (await makeProduct(managerId)).variants[0]!;
    const noCost = await send('post', '/api/v1/stock-adjustments', { locationId: mainId, reason: 'STOCK_COUNT', lines: [{ variantId: v.id, qtyChange: '1' }] });
    expect(noCost.status).toBe(400);
    const fraction = await send('post', '/api/v1/stock-adjustments', { locationId: mainId, reason: 'STOCK_COUNT', lines: [{ variantId: v.id, qtyChange: '1.5', unitCost: '1' }] });
    expect(fraction.status).toBe(400);
    const openingOut = await send('post', '/api/v1/stock-adjustments', { locationId: mainId, reason: 'OPENING_STOCK', lines: [{ variantId: v.id, qtyChange: '-1' }] });
    expect(openingOut.status).toBe(400);
  });
});

describe('batches, FEFO and expiry', () => {
  it('requires an expiry date for expiry-tracked products and picks the earliest expiry first', async () => {
    const v = (await makeProduct(managerId, { expiry: true })).variants[0]!;
    const missing = await send('post', '/api/v1/stock-adjustments', { locationId: mainId, reason: 'OPENING_STOCK', lines: [{ variantId: v.id, qtyChange: '5', unitCost: '10' }] });
    expect(missing.status).toBe(400);

    await adjust('OPENING_STOCK', [
      { variantId: v.id, qtyChange: '5', unitCost: '10', lotNumber: 'LATE', expiryDate: isoDaysFromNow(60) },
      { variantId: v.id, qtyChange: '5', unitCost: '10', lotNumber: 'SOON', expiryDate: isoDaysFromNow(10) },
    ]);
    await adjust('OTHER', [{ variantId: v.id, qtyChange: '-7' }]);

    const lots = await prisma().inventoryBatch.findMany({ where: { variantId: v.id }, orderBy: { lotNumber: 'asc' } });
    expect(lots.map((b) => [b.lotNumber, b.qtyOnHand.toFixed(3)])).toEqual([
      ['LATE', '3.000'],
      ['SOON', '0.000'],
    ]);
  });

  it('blocks expired lots from issue when the policy is "block" (acceptance #14, engine level)', async () => {
    const v = (await makeProduct(managerId, { expiry: true })).variants[0]!;
    await adjust('OPENING_STOCK', [
      { variantId: v.id, qtyChange: '5', unitCost: '10', lotNumber: 'OLD', expiryDate: isoDaysFromNow(-1) },
      { variantId: v.id, qtyChange: '3', unitCost: '10', lotNumber: 'NEW', expiryDate: isoDaysFromNow(90) },
    ]);

    const issue = (qty: string, expired: 'block' | 'allow') =>
      transaction(async (tx) => {
        const s = await openStockSession(tx, [{ variantId: v.id, locationId: mainId }], managerId);
        return s.issue({ variantId: v.id, locationId: mainId, qty: dec(qty), type: 'SALE', source: { type: 'TEST', id: v.id }, expired });
      });

    await expect(issue('4', 'block')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/expired/) });

    // A bare engine issue posts no journal (sales do that in Phase 5), so roll it back after checking it,
    // keeping the stock ledger and GL in agreement for the reconciliation test.
    const rollback = new Error('rollback');
    await expect(
      transaction(async (tx) => {
        const s = await openStockSession(tx, [{ variantId: v.id, locationId: mainId }], managerId);
        const ok = await s.issue({ variantId: v.id, locationId: mainId, qty: dec('3'), type: 'SALE', source: { type: 'TEST', id: v.id }, expired: 'block' });
        expect(ok.movements.map((m) => m.lotNumber)).toEqual(['NEW']);
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    // An explicit write-off (policy "allow") can take the expired lot.
    const writeOff = await adjust('EXPIRY', [{ variantId: v.id, qtyChange: '-5', lotNumber: 'OLD' }]);
    expect(writeOff.status).toBe(200);
    const lines = await journalLines(writeOff.body.data.id);
    expect(lines.map((l) => [l.account.systemKey, l.debit.toFixed(2), l.credit.toFixed(2)])).toEqual([
      ['STOCK_WRITE_OFF', '50.00', '0.00'],
      ['INVENTORY', '0.00', '50.00'],
    ]);

    const expiring = await manager.agent.get('/api/v1/inventory/batches').query({ variantId: v.id, expiringWithinDays: '30' });
    expect(expiring.body.data).toHaveLength(0);
  });

  it('lists lots expiring soon, flagging expired ones', async () => {
    const v = (await makeProduct(managerId, { expiry: true })).variants[0]!;
    await adjust('OPENING_STOCK', [
      { variantId: v.id, qtyChange: '1', unitCost: '1', expiryDate: isoDaysFromNow(-3) },
      { variantId: v.id, qtyChange: '1', unitCost: '1', expiryDate: isoDaysFromNow(20) },
      { variantId: v.id, qtyChange: '1', unitCost: '1', expiryDate: isoDaysFromNow(400) },
    ]);
    const res = await manager.agent.get('/api/v1/inventory/batches').query({ variantId: v.id, expiringWithinDays: '30' });
    expect(res.body.data.map((b: { isExpired: boolean; daysToExpiry: number }) => [b.isExpired, b.daysToExpiry])).toEqual([
      [true, -3],
      [false, 20],
    ]);
    expect(res.body.data[0].lotNumber).toBe(`EXP-${isoDaysFromNow(-3)}`);
  });
});

describe('concurrency', () => {
  it('two simultaneous decrements cannot oversell the same stock', async () => {
    const v = (await makeProduct(managerId)).variants[0]!;
    await adjust('OPENING_STOCK', [{ variantId: v.id, qtyChange: '10', unitCost: '20' }]);
    const drafts = await Promise.all(
      [1, 2].map(() => send('post', '/api/v1/stock-adjustments', { locationId: mainId, reason: 'OTHER', lines: [{ variantId: v.id, qtyChange: '-6' }] })),
    );
    const results = await Promise.all(drafts.map((d) => send('post', `/api/v1/stock-adjustments/${d.body.data.id}/post`, {})));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await variant(v.id)).stockQty.toFixed(3)).toBe('4.000');
  });
});

describe('transfers', () => {
  it('moves stock and lots between locations without changing value', async () => {
    const wh = await send('post', '/api/v1/locations', { code: 'WH-T', name: 'Back store', type: 'WAREHOUSE' });
    const v = (await makeProduct(managerId, { expiry: true })).variants[0]!;
    await adjust('OPENING_STOCK', [{ variantId: v.id, qtyChange: '8', unitCost: '25', lotNumber: 'L1', expiryDate: isoDaysFromNow(100) }]);
    const valueBefore = (await variant(v.id)).stockValue.toFixed(2);

    const draft = await send('post', '/api/v1/stock-transfers', { fromLocationId: mainId, toLocationId: wh.body.data.id, lines: [{ variantId: v.id, qty: '3' }] });
    expect(draft.status).toBe(201);
    const dispatched = await send('post', `/api/v1/stock-transfers/${draft.body.data.id}/dispatch`, {});
    expect(dispatched.body.data.status).toBe('DISPATCHED');
    expect(dispatched.body.data.lines[0].batches).toEqual([{ lotNumber: 'L1', expiryDate: isoDaysFromNow(100), qty: '3.000' }]);

    const inTransit = (await manager.agent.get('/api/v1/inventory/valuation')).body.data;
    expect(dec(inTransit.inTransitQty).toNumber()).toBe(3);

    const received = await send('post', `/api/v1/stock-transfers/${draft.body.data.id}/receive`, {});
    expect(received.body.data.status).toBe('RECEIVED');
    const balances = await prisma().inventoryBalance.findMany({ where: { variantId: v.id } });
    const at = (loc: string) => balances.find((b) => b.locationId === loc)!.qtyOnHand.toFixed(3);
    expect(at(mainId)).toBe('5.000');
    expect(at(wh.body.data.id)).toBe('3.000');
    const destLot = await prisma().inventoryBatch.findFirstOrThrow({ where: { variantId: v.id, locationId: wh.body.data.id } });
    expect(destLot.lotNumber).toBe('L1');
    expect((await variant(v.id)).stockValue.toFixed(2)).toBe(valueBefore);
    expect(await prisma().journalEntry.count({ where: { sourceId: draft.body.data.id } })).toBe(0);

    expect((await send('post', `/api/v1/stock-transfers/${draft.body.data.id}/receive`, {})).status).toBe(422);
  });
});

describe('reconciliation', () => {
  it('stock ledger, balances and the Inventory GL account all agree', async () => {
    const valuation = (await manager.agent.get('/api/v1/inventory/valuation')).body.data;
    expect(valuation.difference).toBe('0.00');
    expect(valuation.inTransitQty).toBe('0.000');

    // Per variant: Σ balances = stock_qty and Σ non-transfer movement value = stock_value.
    const mismatches = await prisma().$queryRaw<{ id: string }[]>`
      SELECT v.id FROM product_variants v
      LEFT JOIN (SELECT variant_id, SUM(qty_on_hand) q FROM inventory_balances GROUP BY variant_id) b ON b.variant_id = v.id
      LEFT JOIN (SELECT variant_id, SUM(total_cost) c FROM stock_movements WHERE type NOT IN ('TRANSFER_OUT','TRANSFER_IN') GROUP BY variant_id) m ON m.variant_id = v.id
      WHERE COALESCE(b.q, 0) <> v.stock_qty OR COALESCE(m.c, 0) <> v.stock_value`;
    expect(mismatches).toEqual([]);

    const stock = await manager.agent.get('/api/v1/inventory/stock').query({ pageSize: '100' });
    expect(stock.status).toBe(200);
    expect(stock.body.meta.total).toBeGreaterThan(0);
  });
});
