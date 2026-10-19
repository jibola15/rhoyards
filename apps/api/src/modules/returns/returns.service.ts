import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import {
  dec,
  Decimal,
  roundMoney,
  sum,
  ZERO,
  type ReturnableSale,
  type ReturnDetail,
  type ReturnInput,
  type ReturnSummary,
  type returnListQuerySchema,
} from '@rhoyards/shared';
import { openStockSession } from '../../engines/inventory/inventory.engine';
import { postJournal, type JournalLineInput } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { businessDate } from '../../lib/business-date';
import { AppError, businessRule, forbidden, notFound } from '../../lib/errors';
import { pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import type { AuthContext } from '../auth/auth.types';
import { settleSales } from '../customers/receivables.service';

/**
 * Sales returns (POS and online). Requested (returns.create) → approved (returns.approve) → completed by the refund
 * (refunds.process), which in one transaction: settles what the customer still owed on the sale first, pays the
 * rest back, puts resaleable items back into stock at their original cost, and posts the journal
 * (docs/ACCOUNTING_RULES.md §5e). A line can never be refunded beyond what was sold (quantity, amounts, cost).
 */

type Tx = Prisma.TransactionClient;
const SOURCE = 'SALE_RETURN';
const money = (v: Decimal) => new Prisma.Decimal(v.toFixed(2));
const invalid = (message: string, details?: unknown) => new AppError(400, 'VALIDATION_ERROR', message, details);
/** Return lines that still count against what can be returned (not rejected). */
const LIVE = ['PENDING_APPROVAL', 'APPROVED', 'COMPLETED'] as const;

// ── Read models ──────────────────────────────────────────────────────────

const include = {
  sale: { select: { id: true, number: true, channel: true, customer: { select: { id: true, name: true } } } },
  requestedBy: { select: { fullName: true } },
  approvedBy: { select: { fullName: true } },
  completedBy: { select: { fullName: true } },
  refundMethod: { select: { id: true, name: true } },
  items: { include: { saleItem: { select: { sku: true, description: true, lineNo: true } } } },
} satisfies Prisma.SaleReturnInclude;
type Row = Prisma.SaleReturnGetPayload<{ include: typeof include }>;

function toSummary(r: Pick<Row, 'id' | 'number' | 'status' | 'sale' | 'total' | 'requestedBy' | 'requestedAt' | 'completedAt'>): ReturnSummary {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    sale: { id: r.sale.id, number: r.sale.number ?? '', channel: r.sale.channel },
    customer: r.sale.customer,
    total: r.total.toFixed(2),
    requestedBy: r.requestedBy.fullName,
    requestedAt: r.requestedAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  };
}

function toDetail(r: Row): ReturnDetail {
  return {
    ...toSummary(r),
    reason: r.reason,
    rejectedReason: r.rejectedReason,
    approvedBy: r.approvedBy?.fullName ?? null,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    completedBy: r.completedBy?.fullName ?? null,
    lines: [...r.items]
      .sort((a, b) => a.saleItem.lineNo - b.saleItem.lineNo)
      .map((i) => ({
        id: i.id,
        saleItemId: i.saleItemId,
        sku: i.saleItem.sku,
        description: i.saleItem.description,
        qty: i.qty.toFixed(3),
        condition: i.condition,
        restock: i.restock,
        net: i.netAmount.toFixed(2),
        tax: i.taxAmount.toFixed(2),
        total: i.lineTotal.toFixed(2),
        unitCost: i.unitCost.toFixed(4),
      })),
    shippingNet: r.shippingNet.toFixed(2),
    shippingTax: r.shippingTax.toFixed(2),
    net: r.netAmount.toFixed(2),
    tax: r.taxAmount.toFixed(2),
    creditedToAccount: r.creditedToAccount.toFixed(2),
    paidOut: r.paidOut.toFixed(2),
    refundMethod: r.refundMethod,
    refundReference: r.refundReference,
    journalEntryId: r.journalEntryId,
  };
}

export async function getReturn(id: string, db: Db = getPrisma()): Promise<ReturnDetail> {
  const r = await db.saleReturn.findUnique({ where: { id }, include });
  if (!r) throw notFound('Return');
  return toDetail(r);
}

export async function listReturns(query: z.infer<typeof returnListQuerySchema>) {
  const where: Prisma.SaleReturnWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.saleId ? { saleId: query.saleId } : {}),
    ...(query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { sale: { number: { contains: query.q, mode: 'insensitive' } } }, { sale: { customer: { name: { contains: query.q, mode: 'insensitive' } } } }] } : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.saleReturn.findMany({ where, include: { sale: include.sale, requestedBy: include.requestedBy }, orderBy: { requestedAt: 'desc' }, ...pageArgs(query) }),
    prisma.saleReturn.count({ where }),
  ]);
  return { data: rows.map(toSummary), total };
}

// ── What is left to return ───────────────────────────────────────────────

/** Per sale item: quantity, amounts and cost already claimed by live returns (pending, approved or completed). */
async function claimed(db: Db, saleId: string) {
  const rows = await db.saleReturnItem.groupBy({
    by: ['saleItemId'],
    where: { saleReturn: { saleId, status: { in: [...LIVE] } } },
    _sum: { qty: true, netAmount: true, taxAmount: true, costAmount: true },
  });
  return new Map(
    rows.map((r) => [
      r.saleItemId,
      { qty: dec(r._sum.qty?.toString() ?? 0), net: dec(r._sum.netAmount?.toString() ?? 0), tax: dec(r._sum.taxAmount?.toString() ?? 0), cost: dec(r._sum.costAmount?.toString() ?? 0) },
    ]),
  );
}

async function shippingClaimed(db: Db, saleId: string) {
  return (await db.saleReturn.count({ where: { saleId, status: { in: [...LIVE] }, shippingNet: { gt: 0 } } })) > 0;
}

async function loadSale(db: Db, saleId: string) {
  const sale = await db.sale.findUnique({
    where: { id: saleId },
    include: { items: { orderBy: { lineNo: 'asc' } }, customer: { select: { id: true, name: true } }, onlineOrder: { select: { id: true, shippingTax: true, provider: true } } },
  });
  if (!sale || sale.status !== 'COMPLETED') throw notFound('Sale');
  return sale;
}

export async function returnableSale(saleId: string, prisma: Db = getPrisma()): Promise<ReturnableSale> {
  const sale = await loadSale(prisma, saleId);
  const used = await claimed(prisma, saleId);
  const shippingUsed = await shippingClaimed(prisma, saleId);
  return {
    sale: {
      id: sale.id,
      number: sale.number!,
      channel: sale.channel,
      customer: sale.customer,
      completedAt: sale.completedAt!.toISOString(),
      outstanding: dec(sale.balanceDue.toString()).minus(sale.amountSettled.toString()).toFixed(2),
    },
    lines: sale.items.map((i) => ({
      saleItemId: i.id,
      sku: i.sku,
      description: i.description,
      qty: i.qty.toFixed(3),
      returnable: dec(i.qty.toString()).minus(used.get(i.id)?.qty ?? ZERO).toFixed(3),
      unitPrice: i.unitPrice.toFixed(2),
      lineTotal: i.lineTotal.toFixed(2),
    })),
    shippingRefundable: !shippingUsed && sale.shippingAmount.gt(0) ? dec(sale.shippingAmount.toString()).plus(sale.onlineOrder?.shippingTax.toString() ?? 0).toFixed(2) : '0.00',
  };
}

// ── Request, approve, reject ─────────────────────────────────────────────

/**
 * Prices the lines: a share of each sale line pro rata, except that returning everything still on a line takes
 * exactly what is left of its amounts and cost, so repeated part-returns never refund a kobo more than was paid.
 */
export async function createReturn(input: ReturnInput, actor: AuthContext, ctx: RequestContext): Promise<ReturnDetail> {
  if (input.approve && !actor.permissions.has('returns.approve')) throw forbidden('Approving returns needs the returns.approve permission');
  return transaction((tx) => createReturnTx(tx, input, actor.user.id, ctx));
}

/** createReturn inside the caller's transaction (used when cancelling a paid online order). */
export async function createReturnTx(tx: Tx, input: ReturnInput, actorId: string, ctx: RequestContext): Promise<ReturnDetail> {
  {
    // Serialises returns of one sale, so two requests cannot both claim the same quantity.
    await tx.$queryRaw`SELECT id FROM sales WHERE id = ${input.saleId}::uuid FOR UPDATE`;
    const sale = await loadSale(tx, input.saleId);
    const used = await claimed(tx, sale.id);
    const items = new Map(sale.items.map((i) => [i.id, i]));
    if (new Set(input.lines.map((l) => l.saleItemId)).size !== input.lines.length) throw invalid('Each sold item can appear once in a return');

    const lines = input.lines.map((l, n) => {
      const item = items.get(l.saleItemId);
      if (!item) throw invalid(`Line ${n + 1}: this item is not on the sale`, { line: n + 1 });
      const sold = dec(item.qty.toString());
      const prior = used.get(item.id) ?? { qty: ZERO, net: ZERO, tax: ZERO, cost: ZERO };
      const left = sold.minus(prior.qty);
      const qty = dec(l.qty);
      if (qty.gt(left)) throw businessRule(`Line ${n + 1}: only ${left.toFixed(3)} of ${item.sku} can still be returned`, { line: n + 1, returnable: left.toFixed(3) });
      const all = qty.equals(left);
      const share = (total: Prisma.Decimal, used: Decimal) => (all ? dec(total.toString()).minus(used) : roundMoney(dec(total.toString()).times(qty).dividedBy(sold)));
      const net = share(item.netAmount, prior.net);
      const tax = share(item.taxAmount, prior.tax);
      const cost = share(item.costAmount, prior.cost);
      return { l, item, qty, net, tax, cost };
    });

    let shippingNet = ZERO;
    let shippingTax = ZERO;
    if (input.refundShipping) {
      if (sale.channel !== 'ONLINE' || sale.shippingAmount.lte(0)) throw invalid('This sale has no delivery charge to refund', { field: 'refundShipping' });
      if (await shippingClaimed(tx, sale.id)) throw businessRule('The delivery charge has already been refunded');
      shippingNet = dec(sale.shippingAmount.toString());
      shippingTax = dec(sale.onlineOrder?.shippingTax.toString() ?? 0);
    }
    const net = sum(lines.map((x) => x.net));
    const tax = sum(lines.map((x) => x.tax));
    const now = new Date();
    const id = randomUUID();
    await tx.saleReturn.create({
      data: {
        id,
        number: await nextDocumentNumber(tx, 'SALE_RETURN', 'RET-'),
        saleId: sale.id,
        reason: input.reason,
        netAmount: money(net),
        taxAmount: money(tax),
        shippingNet: money(shippingNet),
        shippingTax: money(shippingTax),
        total: money(net.plus(tax).plus(shippingNet).plus(shippingTax)),
        requestedById: actorId,
        ...(input.approve ? { status: 'APPROVED', approvedById: actorId, approvedAt: now } : {}),
        items: {
          create: lines.map((x) => ({
            saleItemId: x.item.id,
            qty: new Prisma.Decimal(x.qty.toFixed(3)),
            condition: x.l.condition,
            restock: x.l.restock,
            netAmount: money(x.net),
            taxAmount: money(x.tax),
            lineTotal: money(x.net.plus(x.tax)),
            unitCost: x.item.unitCost,
            costAmount: money(x.cost),
          })),
        },
      },
    });
    const detail = await getReturn(id, tx);
    await writeAudit(tx, ctx, { action: input.approve ? 'return.created_approved' : 'return.requested', entityType: 'sale_return', entityId: id, after: detail });
    return detail;
  }
}

async function lockReturn(tx: Tx, id: string) {
  const [row] = await tx.$queryRaw<{ status: string }[]>`SELECT status::text FROM sale_returns WHERE id = ${id}::uuid FOR UPDATE`;
  if (!row) throw notFound('Return');
  return row.status;
}

export async function approveReturn(id: string, actorId: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    if ((await lockReturn(tx, id)) !== 'PENDING_APPROVAL') throw businessRule('Only returns awaiting approval can be approved');
    await tx.saleReturn.update({ where: { id }, data: { status: 'APPROVED', approvedById: actorId, approvedAt: new Date() } });
    await writeAudit(tx, ctx, { action: 'return.approved', entityType: 'sale_return', entityId: id });
    return getReturn(id, tx);
  });
}

export async function rejectReturn(id: string, reason: string, actorId: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    const status = await lockReturn(tx, id);
    if (status !== 'PENDING_APPROVAL' && status !== 'APPROVED') throw businessRule('Only returns not yet refunded can be rejected');
    await tx.saleReturn.update({ where: { id }, data: { status: 'REJECTED', rejectedReason: reason, approvedById: actorId, approvedAt: new Date() } });
    await writeAudit(tx, ctx, { action: 'return.rejected', entityType: 'sale_return', entityId: id, after: { reason } });
    return getReturn(id, tx);
  });
}

// ── Refund (completion) ──────────────────────────────────────────────────

/**
 * Lots a restocked item goes back into: the lots its sale took from, latest expiry first, never more than was taken
 * from each (less what earlier returns already put back).
 */
async function restockLots(tx: Tx, saleId: string, saleItemId: string, qty: Decimal) {
  const taken = await tx.stockMovement.findMany({
    where: { sourceType: 'SALE', sourceId: saleId, sourceLineId: saleItemId, batchId: { not: null } },
    include: { batch: true },
  });
  if (taken.length === 0) return null;
  const priorReturnItems = await tx.saleReturnItem.findMany({ where: { saleItemId, saleReturn: { status: 'COMPLETED' } }, select: { id: true } });
  const back = await tx.stockMovement.groupBy({
    by: ['batchId'],
    where: { sourceType: SOURCE, sourceLineId: { in: priorReturnItems.map((r) => r.id) } },
    _sum: { qtyChange: true },
  });
  const returned = new Map(back.map((b) => [b.batchId, dec(b._sum.qtyChange?.toString() ?? 0)]));
  const lots = taken
    .map((m) => ({ batch: m.batch!, room: dec(m.qtyChange.toString()).neg().minus(returned.get(m.batchId) ?? ZERO) }))
    .sort((a, b) => (b.batch.expiryDate?.getTime() ?? Infinity) - (a.batch.expiryDate?.getTime() ?? Infinity));
  const parts: { lotNumber: string; expiryDate: Date | undefined; qty: Decimal }[] = [];
  let left = qty;
  for (const lot of lots) {
    if (left.lte(0)) break;
    const take = Decimal.min(left, lot.room);
    if (take.lte(0)) continue;
    parts.push({ lotNumber: lot.batch.lotNumber, expiryDate: lot.batch.expiryDate ?? undefined, qty: take });
    left = left.minus(take);
  }
  if (left.gt(0)) throw businessRule('The returned quantity does not match the lots the sale took from');
  return parts;
}

/**
 * Completes an approved return: refund, stock and ledger in one transaction. Idempotent per Idempotency-Key at the
 * route; a second completion of the same return finds it no longer APPROVED and is refused.
 */
type RefundInput = { paymentMethodId?: string | null | undefined; reference?: string | null | undefined };

export async function completeReturn(id: string, input: RefundInput, actorId: string, ctx: RequestContext) {
  return transaction((tx) => completeReturnTx(tx, id, input, actorId, ctx));
}

export async function completeReturnTx(tx: Tx, id: string, input: RefundInput, actorId: string, ctx: RequestContext): Promise<ReturnDetail> {
  {
    if ((await lockReturn(tx, id)) !== 'APPROVED') throw businessRule('Only approved returns can be refunded');
    const ret = await tx.saleReturn.findUniqueOrThrow({ where: { id }, include: { items: { include: { saleItem: true } } } });
    await tx.$queryRaw`SELECT id FROM sales WHERE id = ${ret.saleId}::uuid FOR UPDATE`;
    const sale = await loadSale(tx, ret.saleId);
    const total = dec(ret.total.toString());

    // What the customer still owes on this sale is reduced first; only the rest is paid back.
    const owed = dec(sale.balanceDue.toString()).minus(sale.amountSettled.toString());
    const credited = Decimal.min(owed, total);
    const paidOut = total.minus(credited);
    if (credited.gt(0)) await settleSales(tx, [{ saleId: sale.id, amount: credited }]);

    let method = null;
    if (paidOut.gt(0)) {
      const methodId =
        input.paymentMethodId ??
        (sale.onlineOrder?.provider
          ? (await tx.paymentMethod.findUnique({ where: { code: sale.onlineOrder.provider === 'TEST' ? 'ONLINE_CARD' : 'ONLINE_TRANSFER' } }))?.id
          : undefined);
      if (!methodId) throw invalid('Choose how the refund is paid', { field: 'paymentMethodId' });
      method = await tx.paymentMethod.findUnique({ where: { id: methodId } });
      if (!method?.isActive) throw invalid('Choose an active payment method', { field: 'paymentMethodId' });
      if (method.requiresReference && !input.reference && method.kind !== 'CARD') throw invalid(`Enter the ${method.name} reference`, { field: 'reference' });
    }
    // Cash handed back at a till comes out of that cashier's drawer.
    const shift = method?.kind === 'CASH' ? await tx.cashierShift.findFirst({ where: { cashierId: actorId, status: 'OPEN' } }) : null;

    // Stock: resaleable items back in at the original sale cost.
    const restocked = ret.items.filter((i) => i.restock);
    let costRestocked = ZERO;
    if (restocked.length > 0) {
      const session = await openStockSession(tx, restocked.map((i) => ({ variantId: i.saleItem.variantId, locationId: sale.locationId })), actorId);
      for (const i of restocked) {
        const unitCost = dec(i.unitCost.toString());
        const lots = await restockLots(tx, sale.id, i.saleItemId, dec(i.qty.toString()));
        for (const part of lots ?? [{ lotNumber: undefined, expiryDate: undefined, qty: dec(i.qty.toString()) }]) {
          const movement = await session.receive({
            variantId: i.saleItem.variantId,
            locationId: sale.locationId,
            qty: part.qty,
            unitCost,
            type: 'SALE_RETURN',
            source: { type: SOURCE, id: ret.id, lineId: i.id },
            batch: part.lotNumber ? { lotNumber: part.lotNumber, expiryDate: part.expiryDate } : undefined,
          });
          // The journal takes exactly the value the stock ledger recorded, so Inventory stays equal to it.
          costRestocked = costRestocked.plus(movement.totalCost);
        }
      }
    }
    for (const i of ret.items) await tx.saleItem.update({ where: { id: i.saleItemId }, data: { qtyReturned: { increment: i.qty } } });

    const lines: JournalLineInput[] = [];
    if (ret.netAmount.gt(0)) lines.push({ accountKey: 'SALES_RETURNS', debit: ret.netAmount.toString(), locationId: sale.locationId });
    if (ret.shippingNet.gt(0)) lines.push({ accountKey: 'SHIPPING_INCOME', debit: ret.shippingNet.toString(), locationId: sale.locationId });
    const vat = dec(ret.taxAmount.toString()).plus(ret.shippingTax.toString());
    if (vat.gt(0)) lines.push({ accountKey: 'VAT_OUTPUT', debit: vat });
    if (credited.gt(0)) lines.push({ accountKey: 'AR', credit: credited, memo: sale.customer?.name ?? '' });
    if (paidOut.gt(0)) lines.push({ accountId: method!.accountId, credit: paidOut, locationId: sale.locationId });
    if (costRestocked.gt(0)) {
      lines.push({ accountKey: 'INVENTORY', debit: costRestocked, locationId: sale.locationId }, { accountKey: 'COGS', credit: costRestocked, locationId: sale.locationId });
    }
    const journal = lines.length >= 2
      ? await postJournal(tx, { entryDate: businessDate(), sourceType: SOURCE, sourceId: ret.id, postingKey: `${SOURCE}:${ret.id}`, description: `Return ${ret.number} of sale ${sale.number}`, lines, actorId })
      : null;
    if (!journal) throw businessRule('Nothing to refund on this return');

    await tx.saleReturn.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        creditedToAccount: money(credited),
        paidOut: money(paidOut),
        costRestocked: money(costRestocked),
        refundMethodId: method?.id ?? null,
        refundReference: input.reference ?? null,
        shiftId: shift?.id ?? null,
        journalEntryId: journal.id,
        completedById: actorId,
        completedAt: new Date(),
      },
    });
    const detail = await getReturn(id, tx);
    await writeAudit(tx, ctx, { action: 'return.refunded', entityType: 'sale_return', entityId: id, after: { credited: credited.toFixed(2), paidOut: paidOut.toFixed(2), method: method?.code ?? null } });
    return detail;
  }
}
