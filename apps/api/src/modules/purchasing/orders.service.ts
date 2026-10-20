import { Prisma, type PurchaseOrderStatus } from '@prisma/client';
import type { z } from 'zod';
import { dec, sum, ZERO, type PoInput, type PurchaseOrderDetail, type PurchaseOrderSummary, type purchaseListQuerySchema } from '@rhoyards/shared';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { businessRule, notFound } from '../../lib/errors';
import { pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import { assertActiveLocation, assertQuantityUnit, loadVariantsForStock } from '../inventory/stock-documents';
import {
  assertActiveSupplier,
  iso,
  isoDate,
  lockDoc,
  money,
  pd,
  priceLine,
  qty,
  resolveTaxRates,
  toDate,
  variantRef,
  variantRefSelect,
} from './common';

const include = {
  supplier: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  createdBy: { select: { fullName: true } },
  approvedBy: { select: { fullName: true } },
  endedBy: { select: { fullName: true } },
  lines: { orderBy: { lineNo: 'asc' }, include: { variant: { select: variantRefSelect } } },
  receipts: { orderBy: { createdAt: 'asc' }, select: { id: true, number: true, status: true, receivedDate: true, totalValue: true } },
} satisfies Prisma.PurchaseOrderInclude;
type Row = Prisma.PurchaseOrderGetPayload<{ include: typeof include }>;

function summary(p: Omit<Row, 'lines' | 'receipts' | 'approvedBy' | 'endedBy'>): PurchaseOrderSummary {
  return {
    id: p.id,
    number: p.number,
    supplier: p.supplier,
    location: p.location,
    status: p.status,
    orderDate: isoDate(p.orderDate)!,
    expectedDate: isoDate(p.expectedDate),
    subtotal: p.subtotal.toFixed(2),
    taxTotal: p.taxTotal.toFixed(2),
    total: p.total.toFixed(2),
    createdBy: p.createdBy.fullName,
    createdAt: p.createdAt.toISOString(),
  };
}

function toDetail(p: Row): PurchaseOrderDetail {
  return {
    ...summary(p),
    note: p.note,
    approvedBy: p.approvedBy?.fullName ?? null,
    approvedAt: iso(p.approvedAt),
    endedBy: p.endedBy?.fullName ?? null,
    endedAt: iso(p.endedAt),
    lines: p.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      variant: variantRef(l.variant),
      qtyOrdered: l.qtyOrdered.toFixed(3),
      qtyReceived: l.qtyReceived.toFixed(3),
      qtyOutstanding: l.qtyOrdered.minus(l.qtyReceived).toFixed(3),
      unitCost: l.unitCost.toFixed(4),
      taxRateId: l.taxRateId,
      taxRate: l.taxRate.toFixed(4),
      netAmount: l.netAmount.toFixed(2),
    })),
    receipts: p.receipts.map((r) => ({ id: r.id, number: r.number, status: r.status, receivedDate: isoDate(r.receivedDate)!, totalValue: r.totalValue.toFixed(2) })),
  };
}

export async function getPurchaseOrder(id: string, db: Db = getPrisma()) {
  const p = await db.purchaseOrder.findUnique({ where: { id }, include });
  if (!p) throw notFound('Purchase order');
  return toDetail(p);
}

export async function listPurchaseOrders(query: z.infer<typeof purchaseListQuerySchema>, scope: string[] | null = null) {
  const where: Prisma.PurchaseOrderWhereInput = {
    ...(scope ? { locationId: { in: scope } } : {}),
    ...(query.supplierId ? { supplierId: query.supplierId } : {}),
    ...(query.status ? { status: query.status as PurchaseOrderStatus } : {}),
    ...(query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { supplier: { name: { contains: query.q, mode: 'insensitive' } } }] } : {}),
    ...(query.from || query.to ? { orderDate: { ...(query.from ? { gte: toDate(query.from) } : {}), ...(query.to ? { lte: toDate(query.to) } : {}) } } : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: { supplier: { select: { id: true, name: true } }, location: { select: { id: true, name: true } }, createdBy: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(query),
    }),
    prisma.purchaseOrder.count({ where }),
  ]);
  return { data: rows.map(summary), total };
}

async function buildLines(db: Db, input: PoInput) {
  await assertActiveSupplier(db, input.supplierId);
  await assertActiveLocation(db, input.locationId);
  const variants = await loadVariantsForStock(db, input.lines.map((l) => l.variantId));
  const productTax = await db.productVariant.findMany({
    where: { id: { in: input.lines.map((l) => l.variantId) } },
    select: { id: true, product: { select: { taxRateId: true } } },
  });
  const taxByVariant = new Map(productTax.map((v) => [v.id, v.product.taxRateId]));
  const taxes = await resolveTaxRates(
    db,
    input.lines.map((l) => l.taxRateId),
    input.lines.map((l) => taxByVariant.get(l.variantId) ?? null),
  );
  const lines = input.lines.map((l, i) => {
    const v = variants.get(l.variantId)!;
    assertQuantityUnit(i + 1, v.sku, v.product.unit.allowsFraction, v.product.unit.code, l.qty);
    const { net, tax } = priceLine(l.qty, l.unitCost, taxes[i]!.rate);
    return {
      row: {
        lineNo: i + 1,
        variantId: l.variantId,
        qtyOrdered: qty(l.qty),
        unitCost: pd(l.unitCost),
        taxRateId: taxes[i]!.taxRateId,
        taxRate: new Prisma.Decimal(taxes[i]!.rate.toFixed(4)),
        netAmount: money(net),
      },
      net,
      tax,
    };
  });
  const subtotal = sum(lines.map((l) => l.net));
  const taxTotal = sum(lines.map((l) => l.tax));
  return { lines: lines.map((l) => l.row), subtotal, taxTotal, total: subtotal.plus(taxTotal) };
}

export async function createPurchaseOrder(input: PoInput, ctx: RequestContext) {
  return transaction(async (tx) => {
    const built = await buildLines(tx, input);
    const number = await nextDocumentNumber(tx, 'PURCHASE_ORDER', 'PO-');
    const po = await tx.purchaseOrder.create({
      data: {
        number,
        supplierId: input.supplierId,
        locationId: input.locationId,
        orderDate: toDate(input.orderDate),
        expectedDate: input.expectedDate ? toDate(input.expectedDate) : null,
        note: input.note ?? null,
        subtotal: money(built.subtotal),
        taxTotal: money(built.taxTotal),
        total: money(built.total),
        createdById: ctx.actorId!,
        lines: { create: built.lines },
      },
    });
    const detail = await getPurchaseOrder(po.id, tx);
    await writeAudit(tx, ctx, { action: 'purchase_order.created', entityType: 'purchase_order', entityId: po.id, after: detail });
    return detail;
  });
}

export async function updatePurchaseOrder(id: string, input: PoInput, ctx: RequestContext) {
  return transaction(async (tx) => {
    if ((await lockDoc(tx, 'purchase_orders', id)) !== 'DRAFT') throw businessRule('Only draft purchase orders can be edited');
    const before = await getPurchaseOrder(id, tx);
    const built = await buildLines(tx, input);
    await tx.purchaseOrderLine.deleteMany({ where: { poId: id } });
    await tx.purchaseOrder.update({
      where: { id },
      data: {
        supplierId: input.supplierId,
        locationId: input.locationId,
        orderDate: toDate(input.orderDate),
        expectedDate: input.expectedDate ? toDate(input.expectedDate) : null,
        note: input.note ?? null,
        subtotal: money(built.subtotal),
        taxTotal: money(built.taxTotal),
        total: money(built.total),
        lines: { create: built.lines },
      },
    });
    const after = await getPurchaseOrder(id, tx);
    await writeAudit(tx, ctx, { action: 'purchase_order.updated', entityType: 'purchase_order', entityId: id, before, after });
    return after;
  });
}

export async function approvePurchaseOrder(id: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    if ((await lockDoc(tx, 'purchase_orders', id)) !== 'DRAFT') throw businessRule('Only draft purchase orders can be approved');
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
    await assertActiveSupplier(tx, po.supplierId);
    await tx.purchaseOrder.update({ where: { id }, data: { status: 'APPROVED', approvedById: ctx.actorId, approvedAt: new Date() } });
    await writeAudit(tx, ctx, { action: 'purchase_order.approved', entityType: 'purchase_order', entityId: id, after: { total: po.total.toFixed(2) } });
    return getPurchaseOrder(id, tx);
  });
}

async function assertNoDraftReceipts(db: Db, poId: string) {
  const drafts = await db.goodsReceipt.count({ where: { poId, status: 'DRAFT' } });
  if (drafts > 0) throw businessRule('Post or cancel the draft goods receipts for this order first');
}

/** Cancel: only before anything is received. Close: stop waiting for the rest of a partly received order. */
export async function endPurchaseOrder(id: string, action: 'cancel' | 'close', ctx: RequestContext) {
  return transaction(async (tx) => {
    const status = await lockDoc(tx, 'purchase_orders', id);
    await assertNoDraftReceipts(tx, id);
    const received = await tx.purchaseOrderLine.aggregate({ where: { poId: id }, _sum: { qtyReceived: true } });
    const anyReceived = dec(received._sum.qtyReceived?.toString() ?? 0).gt(ZERO);
    if (action === 'cancel') {
      if (!['DRAFT', 'APPROVED'].includes(status) || anyReceived) throw businessRule('Only orders with nothing received can be cancelled — close it instead');
    } else if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(status)) {
      throw businessRule(`A ${status.toLowerCase().replace('_', ' ')} order cannot be closed`);
    }
    await tx.purchaseOrder.update({
      where: { id },
      data: { status: action === 'cancel' ? 'CANCELLED' : 'CLOSED', endedById: ctx.actorId, endedAt: new Date() },
    });
    await writeAudit(tx, ctx, { action: `purchase_order.${action === 'cancel' ? 'cancelled' : 'closed'}`, entityType: 'purchase_order', entityId: id });
    return getPurchaseOrder(id, tx);
  });
}

/** Recomputes the order's status from its lines after a receipt is posted. */
export async function refreshPurchaseOrderStatus(tx: Prisma.TransactionClient, poId: string) {
  const lines = await tx.purchaseOrderLine.findMany({ where: { poId }, select: { qtyOrdered: true, qtyReceived: true } });
  const complete = lines.every((l) => l.qtyReceived.gte(l.qtyOrdered));
  const any = lines.some((l) => l.qtyReceived.gt(0));
  await tx.purchaseOrder.update({ where: { id: poId }, data: { status: complete ? 'RECEIVED' : any ? 'PARTIALLY_RECEIVED' : 'APPROVED' } });
}
