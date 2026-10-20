import { Prisma, type DocumentStatus } from '@prisma/client';
import type { z } from 'zod';
import { dec, sum, ZERO, type GoodsReceiptDetail, type GoodsReceiptSummary, type GrnInput, type purchaseListQuerySchema } from '@rhoyards/shared';
import { openStockSession } from '../../engines/inventory/inventory.engine';
import { postJournal } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, businessRule, notFound } from '../../lib/errors';
import { pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import { assertActiveLocation, assertQuantityUnit, loadVariantsForStock } from '../inventory/stock-documents';
import {
  assertActiveSupplier,
  assertBatchFields,
  iso,
  isoDate,
  lockDoc,
  money,
  pd,
  qty,
  resolveTaxRates,
  toDate,
  variantRef,
  variantRefSelect,
} from './common';
import { refreshPurchaseOrderStatus } from './orders.service';

const SOURCE = 'GOODS_RECEIPT';

const include = {
  supplier: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  po: { select: { id: true, number: true } },
  createdBy: { select: { fullName: true } },
  postedBy: { select: { fullName: true } },
  lines: { orderBy: { lineNo: 'asc' }, include: { variant: { select: variantRefSelect } } },
} satisfies Prisma.GoodsReceiptInclude;
type Row = Prisma.GoodsReceiptGetPayload<{ include: typeof include }>;

function summary(g: Omit<Row, 'lines' | 'postedBy'>): GoodsReceiptSummary {
  return {
    id: g.id,
    number: g.number,
    supplier: g.supplier,
    location: g.location,
    po: g.po,
    status: g.status,
    receivedDate: isoDate(g.receivedDate)!,
    supplierRef: g.supplierRef,
    totalValue: g.totalValue.toFixed(2),
    createdBy: g.createdBy.fullName,
    createdAt: g.createdAt.toISOString(),
  };
}

function toDetail(g: Row): GoodsReceiptDetail {
  return {
    ...summary(g),
    note: g.note,
    journalEntryId: g.journalEntryId,
    postedBy: g.postedBy?.fullName ?? null,
    postedAt: iso(g.postedAt),
    lines: g.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      poLineId: l.poLineId,
      variant: variantRef(l.variant),
      qty: l.qty.toFixed(3),
      unitCost: l.unitCost.toFixed(4),
      taxRateId: l.taxRateId,
      taxRate: l.taxRate.toFixed(4),
      lotNumber: l.lotNumber,
      mfgDate: isoDate(l.mfgDate),
      expiryDate: isoDate(l.expiryDate),
      value: l.value.toFixed(2),
      qtyInvoiced: l.qtyInvoiced.toFixed(3),
      qtyReturned: l.qtyReturnedUninvoiced.plus(l.qtyReturnedInvoiced).toFixed(3),
      qtyInvoiceable: l.qty.minus(l.qtyInvoiced).minus(l.qtyReturnedUninvoiced).toFixed(3),
    })),
  };
}

export async function getGoodsReceipt(id: string, db: Db = getPrisma()) {
  const g = await db.goodsReceipt.findUnique({ where: { id }, include });
  if (!g) throw notFound('Goods receipt');
  return toDetail(g);
}

export async function listGoodsReceipts(query: z.infer<typeof purchaseListQuerySchema>, scope: string[] | null = null) {
  const where: Prisma.GoodsReceiptWhereInput = {
    ...(scope ? { locationId: { in: scope } } : {}),
    ...(query.supplierId ? { supplierId: query.supplierId } : {}),
    ...(query.status ? { status: query.status as DocumentStatus } : {}),
    ...(query.q
      ? {
          OR: [
            { number: { contains: query.q, mode: 'insensitive' } },
            { supplierRef: { contains: query.q, mode: 'insensitive' } },
            { supplier: { name: { contains: query.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
    ...(query.from || query.to ? { receivedDate: { ...(query.from ? { gte: toDate(query.from) } : {}), ...(query.to ? { lte: toDate(query.to) } : {}) } } : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.goodsReceipt.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
        po: { select: { id: true, number: true } },
        createdBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(query),
    }),
    prisma.goodsReceipt.count({ where }),
  ]);
  return { data: rows.map(summary), total };
}

async function buildLines(db: Db, input: GrnInput) {
  await assertActiveSupplier(db, input.supplierId);
  await assertActiveLocation(db, input.locationId);
  const variants = await loadVariantsForStock(db, input.lines.map((l) => l.variantId));

  let poLines = new Map<string, { variantId: string; taxRateId: string | null }>();
  if (input.poId) {
    const po = await db.purchaseOrder.findUnique({ where: { id: input.poId }, include: { lines: true } });
    if (!po) throw new AppError(400, 'VALIDATION_ERROR', 'Purchase order not found', { field: 'poId' });
    if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status)) throw businessRule(`Purchase order ${po.number} is not open for receiving`);
    if (po.supplierId !== input.supplierId || po.locationId !== input.locationId) {
      throw businessRule(`The receipt must use the order's supplier and delivery location`);
    }
    poLines = new Map(po.lines.map((l) => [l.id, { variantId: l.variantId, taxRateId: l.taxRateId }]));
  }

  const productTax = await db.productVariant.findMany({
    where: { id: { in: input.lines.map((l) => l.variantId) } },
    select: { id: true, product: { select: { taxRateId: true } } },
  });
  const taxByVariant = new Map(productTax.map((v) => [v.id, v.product.taxRateId]));
  const taxes = await resolveTaxRates(
    db,
    input.lines.map((l) => l.taxRateId),
    input.lines.map((l) => (l.poLineId ? poLines.get(l.poLineId)?.taxRateId : null) ?? taxByVariant.get(l.variantId) ?? null),
  );

  return input.lines.map((l, i) => {
    const n = i + 1;
    const v = variants.get(l.variantId)!;
    assertQuantityUnit(n, v.sku, v.product.unit.allowsFraction, v.product.unit.code, l.qty);
    assertBatchFields(n, v, l);
    if (input.poId) {
      const pl = l.poLineId ? poLines.get(l.poLineId) : undefined;
      if (!pl) throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: choose a line of the purchase order`, { line: n, field: 'poLineId' });
      if (pl.variantId !== l.variantId) throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: product does not match the order line`, { line: n });
    } else if (l.poLineId) {
      throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: no purchase order selected`, { line: n, field: 'poLineId' });
    }
    return {
      lineNo: n,
      poLineId: l.poLineId ?? null,
      variantId: l.variantId,
      qty: qty(l.qty),
      unitCost: pd(l.unitCost),
      taxRateId: taxes[i]!.taxRateId,
      taxRate: new Prisma.Decimal(taxes[i]!.rate.toFixed(4)),
      lotNumber: l.lotNumber ?? null,
      mfgDate: l.mfgDate ? toDate(l.mfgDate) : null,
      expiryDate: l.expiryDate ? toDate(l.expiryDate) : null,
    };
  });
}

export async function createGoodsReceipt(input: GrnInput, ctx: RequestContext) {
  return transaction(async (tx) => {
    const lines = await buildLines(tx, input);
    const number = await nextDocumentNumber(tx, 'GOODS_RECEIPT', 'GRN-');
    const g = await tx.goodsReceipt.create({
      data: {
        number,
        supplierId: input.supplierId,
        locationId: input.locationId,
        poId: input.poId ?? null,
        receivedDate: toDate(input.receivedDate),
        supplierRef: input.supplierRef ?? null,
        note: input.note ?? null,
        createdById: ctx.actorId!,
        lines: { create: lines },
      },
    });
    const detail = await getGoodsReceipt(g.id, tx);
    await writeAudit(tx, ctx, { action: 'goods_receipt.created', entityType: 'goods_receipt', entityId: g.id, after: detail });
    return detail;
  });
}

/** Creates a draft receipt for everything still outstanding on an approved order. */
export async function receiveFromPurchaseOrder(poId: string, receivedDate: string, ctx: RequestContext) {
  const po = await getPrisma().purchaseOrder.findUnique({ where: { id: poId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
  if (!po) throw notFound('Purchase order');
  const open = po.lines.filter((l) => l.qtyOrdered.gt(l.qtyReceived));
  if (open.length === 0) throw businessRule('Everything on this order has been received');
  return createGoodsReceipt(
    {
      supplierId: po.supplierId,
      locationId: po.locationId,
      poId: po.id,
      receivedDate,
      lines: open.map((l) => ({
        poLineId: l.id,
        variantId: l.variantId,
        qty: l.qtyOrdered.minus(l.qtyReceived).toFixed(3),
        unitCost: l.unitCost.toFixed(4),
        taxRateId: l.taxRateId,
      })),
    },
    ctx,
  );
}

export async function updateGoodsReceipt(id: string, input: GrnInput, ctx: RequestContext) {
  return transaction(async (tx) => {
    if ((await lockDoc(tx, 'goods_receipts', id)) !== 'DRAFT') throw businessRule('Only draft receipts can be edited');
    const before = await getGoodsReceipt(id, tx);
    const lines = await buildLines(tx, input);
    await tx.goodsReceiptLine.deleteMany({ where: { receiptId: id } });
    await tx.goodsReceipt.update({
      where: { id },
      data: {
        supplierId: input.supplierId,
        locationId: input.locationId,
        poId: input.poId ?? null,
        receivedDate: toDate(input.receivedDate),
        supplierRef: input.supplierRef ?? null,
        note: input.note ?? null,
        lines: { create: lines },
      },
    });
    const after = await getGoodsReceipt(id, tx);
    await writeAudit(tx, ctx, { action: 'goods_receipt.updated', entityType: 'goods_receipt', entityId: id, before, after });
    return after;
  });
}

/**
 * Posts a receipt: stock in at the agreed cost (moving average updated), order quantities received,
 * and Dr Inventory / Cr Goods received not invoiced — all in one transaction.
 */
export async function postGoodsReceipt(id: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    if ((await lockDoc(tx, 'goods_receipts', id)) !== 'DRAFT') throw businessRule('Only draft receipts can be posted');
    const g = await tx.goodsReceipt.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    await assertActiveLocation(tx, g.locationId);
    await loadVariantsForStock(tx, g.lines.map((l) => l.variantId));

    // Over-receipt check against the order, under row locks so two receipts cannot both take the last units.
    if (g.poId) {
      const poStatus = await lockDoc(tx, 'purchase_orders', g.poId);
      if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(poStatus)) throw businessRule('The purchase order is no longer open for receiving');
      const poLineIds = [...new Set(g.lines.map((l) => l.poLineId!))].sort();
      await tx.$queryRaw`SELECT "id" FROM "purchase_order_lines" WHERE "id" = ANY(${poLineIds}::uuid[]) ORDER BY "id" FOR UPDATE`;
      const poLines = new Map((await tx.purchaseOrderLine.findMany({ where: { id: { in: poLineIds } } })).map((l) => [l.id, l]));
      const incoming = new Map<string, ReturnType<typeof dec>>();
      for (const l of g.lines) incoming.set(l.poLineId!, (incoming.get(l.poLineId!) ?? ZERO).plus(l.qty.toString()));
      for (const [poLineId, q] of incoming) {
        const pl = poLines.get(poLineId)!;
        const outstanding = dec(pl.qtyOrdered.toString()).minus(pl.qtyReceived.toString());
        if (q.gt(outstanding)) {
          throw new AppError(409, 'CONFLICT', `Line ${pl.lineNo}: receiving ${q.toFixed(3)} but only ${outstanding.toFixed(3)} is outstanding on the order`, {
            poLineId,
            outstanding: outstanding.toFixed(3),
          });
        }
      }
      for (const [poLineId, q] of incoming) {
        await tx.purchaseOrderLine.update({ where: { id: poLineId }, data: { qtyReceived: { increment: qty(q) } } });
      }
    }

    const session = await openStockSession(tx, g.lines.map((l) => ({ variantId: l.variantId, locationId: g.locationId })), ctx.actorId!);
    const values = [];
    for (const line of g.lines) {
      const r = await session.receive({
        variantId: line.variantId,
        locationId: g.locationId,
        qty: dec(line.qty.toString()),
        unitCost: dec(line.unitCost.toString()),
        type: 'PURCHASE_RECEIPT',
        source: { type: SOURCE, id: g.id, lineId: line.id },
        batch: { lotNumber: line.lotNumber ?? undefined, mfgDate: line.mfgDate ?? undefined, expiryDate: line.expiryDate ?? undefined },
      });
      values.push(r.totalCost);
      // Written while the receipt is still DRAFT (the line guard freezes these columns afterwards).
      await tx.goodsReceiptLine.update({ where: { id: line.id }, data: { value: money(r.totalCost), lotNumber: r.lotNumber } });
    }
    const totalValue = sum(values);

    const journal = totalValue.gt(ZERO)
      ? await postJournal(tx, {
          entryDate: g.receivedDate,
          sourceType: SOURCE,
          sourceId: g.id,
          postingKey: `${SOURCE}:${g.id}`,
          description: `Goods received ${g.number}`,
          lines: [
            { accountKey: 'INVENTORY', debit: totalValue, locationId: g.locationId },
            { accountKey: 'GRNI', credit: totalValue, locationId: g.locationId },
          ],
          actorId: ctx.actorId!,
        })
      : null;

    await tx.goodsReceipt.update({
      where: { id },
      data: { status: 'POSTED', totalValue: money(totalValue), journalEntryId: journal?.id ?? null, postedById: ctx.actorId, postedAt: new Date() },
    });
    if (g.poId) await refreshPurchaseOrderStatus(tx, g.poId);
    await writeAudit(tx, ctx, { action: 'goods_receipt.posted', entityType: 'goods_receipt', entityId: id, after: { number: g.number, totalValue: totalValue.toFixed(2) } });
    return getGoodsReceipt(id, tx);
  });
}

export async function cancelGoodsReceipt(id: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    if ((await lockDoc(tx, 'goods_receipts', id)) !== 'DRAFT') throw businessRule('Only draft receipts can be cancelled');
    await tx.goodsReceipt.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: ctx.actorId, cancelledAt: new Date() } });
    await writeAudit(tx, ctx, { action: 'goods_receipt.cancelled', entityType: 'goods_receipt', entityId: id });
    return getGoodsReceipt(id, tx);
  });
}
