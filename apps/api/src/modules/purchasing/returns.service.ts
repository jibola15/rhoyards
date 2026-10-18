import type { Prisma} from '@prisma/client';
import { type DocumentStatus } from '@prisma/client';
import type { z } from 'zod';
import {
  dec,
  exclusiveTax,
  roundMoney,
  ZERO,
  type PurchaseReturnDetail,
  type PurchaseReturnInput,
  type PurchaseReturnSummary,
  type purchaseListQuerySchema,
} from '@rhoyards/shared';
import { openStockSession } from '../../engines/inventory/inventory.engine';
import { postJournal, type JournalLineInput } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, businessRule, conflict, notFound } from '../../lib/errors';
import { pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import { assertQuantityUnit } from '../inventory/stock-documents';
import { invoiceable, iso, isoDate, lockDoc, lockGrnLines, money, qty, returnable, toDate, variantRef, variantRefSelect } from './common';

const SOURCE = 'PURCHASE_RETURN';

const include = {
  supplier: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  receipt: { select: { id: true, number: true } },
  createdBy: { select: { fullName: true } },
  postedBy: { select: { fullName: true } },
  lines: { orderBy: { lineNo: 'asc' }, include: { variant: { select: variantRefSelect }, grnLine: { select: { lotNumber: true } } } },
} satisfies Prisma.PurchaseReturnInclude;
type Row = Prisma.PurchaseReturnGetPayload<{ include: typeof include }>;

const summary = (r: Omit<Row, 'lines' | 'postedBy'>): PurchaseReturnSummary => ({
  id: r.id,
  number: r.number,
  supplier: r.supplier,
  location: r.location,
  receipt: r.receipt,
  status: r.status,
  returnDate: isoDate(r.returnDate)!,
  creditTotal: r.creditTotal.toFixed(2),
  createdBy: r.createdBy.fullName,
  createdAt: r.createdAt.toISOString(),
});

const toDetail = (r: Row): PurchaseReturnDetail => ({
  ...summary(r),
  reason: r.reason,
  note: r.note,
  journalEntryId: r.journalEntryId,
  postedBy: r.postedBy?.fullName ?? null,
  postedAt: iso(r.postedAt),
  lines: r.lines.map((l) => ({
    id: l.id,
    lineNo: l.lineNo,
    grnLineId: l.grnLineId,
    variant: variantRef(l.variant),
    lotNumber: l.grnLine.lotNumber,
    qty: l.qty.toFixed(3),
    stockValue: l.stockValue.toFixed(2),
    creditValue: l.creditValue.toFixed(2),
  })),
});

export async function getPurchaseReturn(id: string, db: Db = getPrisma()) {
  const r = await db.purchaseReturn.findUnique({ where: { id }, include });
  if (!r) throw notFound('Purchase return');
  return toDetail(r);
}

export async function listPurchaseReturns(query: z.infer<typeof purchaseListQuerySchema>) {
  const where: Prisma.PurchaseReturnWhereInput = {
    ...(query.supplierId ? { supplierId: query.supplierId } : {}),
    ...(query.status ? { status: query.status as DocumentStatus } : {}),
    ...(query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { supplier: { name: { contains: query.q, mode: 'insensitive' } } }] } : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.purchaseReturn.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
        receipt: { select: { id: true, number: true } },
        createdBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(query),
    }),
    prisma.purchaseReturn.count({ where }),
  ]);
  return { data: rows.map(summary), total };
}

async function validate(db: Db, input: PurchaseReturnInput) {
  const receipt = await db.goodsReceipt.findUnique({
    where: { id: input.receiptId },
    include: { lines: { include: { variant: { select: { sku: true, product: { select: { unit: { select: { allowsFraction: true, code: true } } } } } } } } },
  });
  if (!receipt) throw new AppError(400, 'VALIDATION_ERROR', 'Goods receipt not found', { field: 'receiptId' });
  if (receipt.status !== 'POSTED') throw businessRule('Only posted goods receipts can be returned against');
  const byId = new Map(receipt.lines.map((l) => [l.id, l]));
  const rows = input.lines.map((l, i) => {
    const n = i + 1;
    const g = byId.get(l.grnLineId);
    if (!g) throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: not a line of ${receipt.number}`, { line: n, field: 'grnLineId' });
    assertQuantityUnit(n, g.variant.sku, g.variant.product.unit.allowsFraction, g.variant.product.unit.code, l.qty);
    const open = returnable(g);
    if (dec(l.qty).gt(open)) throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: only ${open.toFixed(3)} can still be returned`, { line: n, field: 'qty' });
    return { lineNo: n, grnLineId: g.id, variantId: g.variantId, qty: qty(l.qty) };
  });
  return { receipt, rows };
}

export async function createPurchaseReturn(input: PurchaseReturnInput, ctx: RequestContext) {
  return transaction(async (tx) => {
    const { receipt, rows } = await validate(tx, input);
    const number = await nextDocumentNumber(tx, 'PURCHASE_RETURN', 'PRET-');
    const r = await tx.purchaseReturn.create({
      data: {
        number,
        supplierId: receipt.supplierId,
        locationId: receipt.locationId,
        receiptId: receipt.id,
        returnDate: toDate(input.returnDate),
        reason: input.reason ?? null,
        note: input.note ?? null,
        createdById: ctx.actorId!,
        lines: { create: rows },
      },
    });
    const detail = await getPurchaseReturn(r.id, tx);
    await writeAudit(tx, ctx, { action: 'purchase_return.created', entityType: 'purchase_return', entityId: r.id, after: detail });
    return detail;
  });
}

export async function updatePurchaseReturn(id: string, input: PurchaseReturnInput, ctx: RequestContext) {
  return transaction(async (tx) => {
    if ((await lockDoc(tx, 'purchase_returns', id)) !== 'DRAFT') throw businessRule('Only draft returns can be edited');
    const { receipt, rows } = await validate(tx, input);
    await tx.purchaseReturnLine.deleteMany({ where: { returnId: id } });
    await tx.purchaseReturn.update({
      where: { id },
      data: {
        supplierId: receipt.supplierId,
        locationId: receipt.locationId,
        receiptId: receipt.id,
        returnDate: toDate(input.returnDate),
        reason: input.reason ?? null,
        note: input.note ?? null,
        lines: { create: rows },
      },
    });
    await writeAudit(tx, ctx, { action: 'purchase_return.updated', entityType: 'purchase_return', entityId: id });
    return getPurchaseReturn(id, tx);
  });
}

/**
 * Sends goods back to the supplier. Stock leaves at the moving average; the receipt line's lot is used.
 * Uninvoiced quantity clears GRNI at the receipt cost; quantity already invoiced raises a debit note
 * (Dr Accounts payable, Cr VAT input) at the invoiced price. The difference to stock value is price variance.
 */
export async function postPurchaseReturn(id: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    if ((await lockDoc(tx, 'purchase_returns', id)) !== 'DRAFT') throw businessRule('Only draft returns can be posted');
    const ret = await tx.purchaseReturn.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    await lockGrnLines(tx, ret.lines.map((l) => l.grnLineId));
    const grnLines = new Map((await tx.goodsReceiptLine.findMany({ where: { id: { in: ret.lines.map((l) => l.grnLineId) } } })).map((l) => [l.id, l]));

    const session = await openStockSession(tx, ret.lines.map((l) => ({ variantId: l.variantId, locationId: ret.locationId })), ctx.actorId!);
    let grni = ZERO;
    let apNet = ZERO;
    let apTax = ZERO;
    let stockOut = ZERO;
    let creditTotal = ZERO;
    for (const line of ret.lines) {
      const g = grnLines.get(line.grnLineId)!;
      const q = dec(line.qty.toString());
      if (q.gt(returnable(g))) throw conflict(`Line ${line.lineNo}: only ${returnable(g).toFixed(3)} can still be returned`, { line: line.lineNo });

      const issue = await session.issue({
        variantId: line.variantId,
        locationId: ret.locationId,
        qty: q,
        type: 'PURCHASE_RETURN',
        source: { type: SOURCE, id: ret.id, lineId: line.id },
        lotNumber: g.lotNumber ?? undefined,
        expired: 'allow',
      });

      // Return the not-yet-invoiced part first; the rest comes out of invoiced quantity.
      const uninvoicedOpen = invoiceable(g);
      const u = q.lt(uninvoicedOpen) ? q : uninvoicedOpen;
      const inv = q.minus(u);
      if (inv.gt(dec(g.qtyInvoiced.toString()).minus(g.qtyReturnedInvoiced.toString()))) {
        throw conflict(`Line ${line.lineNo}: return exceeds the quantity received`, { line: line.lineNo });
      }
      // Once every received unit is either invoiced or returned, the line's GRNI must be exactly zero.
      const completesGrni = u.gt(ZERO) && u.equals(uninvoicedOpen);
      const grniPart = u.isZero() ? ZERO : completesGrni ? dec(g.value.toString()).minus(g.grniCleared.toString()) : roundMoney(u.times(g.unitCost.toString()));
      const avgInvoicePrice = dec(g.qtyInvoiced.toString()).isZero() ? ZERO : dec(g.invoicedValue.toString()).dividedBy(g.qtyInvoiced.toString());
      const creditNet = roundMoney(inv.times(avgInvoicePrice));
      const creditTax = exclusiveTax(creditNet, g.taxRate.toString());

      grni = grni.plus(grniPart);
      apNet = apNet.plus(creditNet);
      apTax = apTax.plus(creditTax);
      stockOut = stockOut.plus(issue.totalCost);
      creditTotal = creditTotal.plus(creditNet).plus(creditTax);

      await tx.goodsReceiptLine.update({
        where: { id: g.id },
        data: {
          qtyReturnedUninvoiced: { increment: qty(u) },
          qtyReturnedInvoiced: { increment: qty(inv) },
          grniCleared: { increment: money(grniPart) },
        },
      });
      g.qtyReturnedUninvoiced = g.qtyReturnedUninvoiced.plus(u.toFixed(3));
      g.qtyReturnedInvoiced = g.qtyReturnedInvoiced.plus(inv.toFixed(3));
      g.grniCleared = g.grniCleared.plus(grniPart.toFixed(2));
      await tx.purchaseReturnLine.update({ where: { id: line.id }, data: { stockValue: money(issue.totalCost), creditValue: money(creditNet.plus(creditTax)) } });
    }

    // Balance: Dr GRNI + Dr AP (net + VAT) = Cr VAT input + Cr Inventory ± variance.
    const variance = grni.plus(apNet).minus(stockOut);
    const lines: JournalLineInput[] = [];
    if (grni.gt(ZERO)) lines.push({ accountKey: 'GRNI', debit: grni, locationId: ret.locationId });
    if (apNet.plus(apTax).gt(ZERO)) lines.push({ accountKey: 'AP', debit: apNet.plus(apTax), memo: `Debit note ${ret.number}` });
    if (apTax.gt(ZERO)) lines.push({ accountKey: 'VAT_INPUT', credit: apTax });
    if (stockOut.gt(ZERO)) lines.push({ accountKey: 'INVENTORY', credit: stockOut, locationId: ret.locationId });
    if (variance.gt(ZERO)) lines.push({ accountKey: 'PURCHASE_PRICE_VARIANCE', credit: variance });
    if (variance.lt(ZERO)) lines.push({ accountKey: 'PURCHASE_PRICE_VARIANCE', debit: variance.abs() });

    const journal =
      lines.length >= 2
        ? await postJournal(tx, {
            entryDate: ret.returnDate,
            sourceType: SOURCE,
            sourceId: ret.id,
            postingKey: `${SOURCE}:${ret.id}`,
            description: `Return to supplier ${ret.number}`,
            lines,
            actorId: ctx.actorId!,
          })
        : null;

    await tx.purchaseReturn.update({
      where: { id },
      data: { status: 'POSTED', creditTotal: money(creditTotal), journalEntryId: journal?.id ?? null, postedById: ctx.actorId, postedAt: new Date() },
    });
    await writeAudit(tx, ctx, { action: 'purchase_return.posted', entityType: 'purchase_return', entityId: id, after: { number: ret.number, creditTotal: creditTotal.toFixed(2) } });
    return getPurchaseReturn(id, tx);
  });
}

export async function cancelPurchaseReturn(id: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    if ((await lockDoc(tx, 'purchase_returns', id)) !== 'DRAFT') throw businessRule('Only draft returns can be cancelled');
    await tx.purchaseReturn.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: ctx.actorId, cancelledAt: new Date() } });
    await writeAudit(tx, ctx, { action: 'purchase_return.cancelled', entityType: 'purchase_return', entityId: id });
    return getPurchaseReturn(id, tx);
  });
}
