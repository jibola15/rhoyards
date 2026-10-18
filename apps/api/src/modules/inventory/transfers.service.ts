import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { dec, type TransferDetail, type TransferInput, type TransferSummary, type documentListQuerySchema } from '@rhoyards/shared';
import { openStockSession } from '../../engines/inventory/inventory.engine';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import { assertActiveLocation, assertQuantityUnit, assertStatus, loadVariantsForStock, lockDocument } from './stock-documents';

const SOURCE = 'STOCK_TRANSFER';

interface BatchAllocation {
  lotNumber: string | null;
  expiryDate: string | null;
  mfgDate: string | null;
  qty: string;
}

const include = {
  fromLocation: { select: { id: true, name: true } },
  toLocation: { select: { id: true, name: true } },
  createdBy: { select: { fullName: true } },
  lines: { orderBy: { lineNo: 'asc' }, include: { variant: { select: { id: true, sku: true, name: true, product: { select: { name: true } } } } } },
} satisfies Prisma.StockTransferInclude;

type Row = Prisma.StockTransferGetPayload<{ include: typeof include }>;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toDetail(t: Row): TransferDetail {
  return {
    id: t.id,
    number: t.number,
    fromLocation: t.fromLocation,
    toLocation: t.toLocation,
    status: t.status,
    lineCount: t.lines.length,
    createdBy: t.createdBy.fullName,
    createdAt: t.createdAt.toISOString(),
    dispatchedAt: iso(t.dispatchedAt),
    receivedAt: iso(t.receivedAt),
    note: t.note,
    lines: t.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      variant: { id: l.variant.id, sku: l.variant.sku, name: l.variant.name, productName: l.variant.product.name },
      qty: l.qty.toFixed(3),
      batches: ((l.batchAllocations as BatchAllocation[] | null) ?? [])
        .filter((b) => b.lotNumber)
        .map((b) => ({ lotNumber: b.lotNumber!, expiryDate: b.expiryDate, qty: b.qty })),
    })),
  };
}

export async function getTransfer(id: string, db: Db = getPrisma()) {
  const t = await db.stockTransfer.findUnique({ where: { id }, include });
  if (!t) throw notFound('Stock transfer');
  return toDetail(t);
}

export async function listTransfers(query: z.infer<typeof documentListQuerySchema>) {
  const where: Prisma.StockTransferWhereInput = {
    ...(query.status ? { status: query.status as Prisma.EnumTransferStatusFilter['equals'] } : {}),
    ...(query.locationId ? { OR: [{ fromLocationId: query.locationId }, { toLocationId: query.locationId }] } : {}),
    ...(query.q ? { number: { contains: query.q, mode: 'insensitive' } } : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.stockTransfer.findMany({
      where,
      include: {
        fromLocation: { select: { id: true, name: true } },
        toLocation: { select: { id: true, name: true } },
        createdBy: { select: { fullName: true } },
        _count: { select: { lines: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(query),
    }),
    prisma.stockTransfer.count({ where }),
  ]);
  const data: TransferSummary[] = rows.map((t) => ({
    id: t.id,
    number: t.number,
    fromLocation: t.fromLocation,
    toLocation: t.toLocation,
    status: t.status,
    lineCount: t._count.lines,
    createdBy: t.createdBy.fullName,
    createdAt: t.createdAt.toISOString(),
    dispatchedAt: iso(t.dispatchedAt),
    receivedAt: iso(t.receivedAt),
  }));
  return { data, total };
}

async function validate(db: Db, input: TransferInput) {
  await assertActiveLocation(db, input.fromLocationId, 'fromLocationId');
  await assertActiveLocation(db, input.toLocationId, 'toLocationId');
  const variants = await loadVariantsForStock(db, input.lines.map((l) => l.variantId));
  input.lines.forEach((l, i) => {
    const v = variants.get(l.variantId)!;
    assertQuantityUnit(i + 1, v.sku, v.product.unit.allowsFraction, v.product.unit.code, l.qty);
  });
}

const lineData = (input: TransferInput) =>
  input.lines.map((l, i) => ({ lineNo: i + 1, variantId: l.variantId, qty: new Prisma.Decimal(l.qty) }));

export async function createTransfer(input: TransferInput, ctx: RequestContext) {
  return transaction(async (tx) => {
    await validate(tx, input);
    const number = await nextDocumentNumber(tx, 'STOCK_TRANSFER', 'TRF-');
    const t = await tx.stockTransfer.create({
      data: {
        number,
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        note: input.note ?? null,
        createdById: ctx.actorId!,
        lines: { create: lineData(input) },
      },
    });
    const detail = await getTransfer(t.id, tx);
    await writeAudit(tx, ctx, { action: 'stock_transfer.created', entityType: 'stock_transfer', entityId: t.id, after: detail });
    return detail;
  });
}

export async function updateTransfer(id: string, input: TransferInput, ctx: RequestContext) {
  return transaction(async (tx) => {
    assertStatus(await lockDocument(tx, 'stock_transfers', id), 'DRAFT', 'edit this transfer');
    await validate(tx, input);
    const before = await getTransfer(id, tx);
    await tx.stockTransferLine.deleteMany({ where: { transferId: id } });
    await tx.stockTransfer.update({
      where: { id },
      data: {
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        note: input.note ?? null,
        lines: { create: lineData(input) },
      },
    });
    const after = await getTransfer(id, tx);
    await writeAudit(tx, ctx, { action: 'stock_transfer.updated', entityType: 'stock_transfer', entityId: id, before, after });
    return after;
  });
}

/** Takes stock out of the source location (lots picked FEFO; expired lots are not shipped). */
export async function dispatchTransfer(id: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    assertStatus(await lockDocument(tx, 'stock_transfers', id), 'DRAFT', 'dispatch this transfer');
    const t = await tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    await assertActiveLocation(tx, t.fromLocationId, 'fromLocationId');
    await assertActiveLocation(tx, t.toLocationId, 'toLocationId');
    await loadVariantsForStock(tx, t.lines.map((l) => l.variantId));

    const session = await openStockSession(tx, t.lines.map((l) => ({ variantId: l.variantId, locationId: t.fromLocationId })), ctx.actorId!);
    for (const line of t.lines) {
      const taken = await session.transferOut({
        variantId: line.variantId,
        locationId: t.fromLocationId,
        qty: dec(line.qty.toString()),
        type: 'TRANSFER_OUT',
        source: { type: SOURCE, id: t.id, lineId: line.id },
        expired: 'block',
      });
      // Lines are written while the transfer is still DRAFT (the line trigger forbids it afterwards).
      const allocations: BatchAllocation[] = taken.map((p) => ({ ...p, qty: p.qty.toFixed(3) }));
      await tx.stockTransferLine.update({ where: { id: line.id }, data: { batchAllocations: allocations as unknown as Prisma.InputJsonValue } });
    }
    await tx.stockTransfer.update({ where: { id }, data: { status: 'DISPATCHED', dispatchedById: ctx.actorId, dispatchedAt: new Date() } });
    const after = await getTransfer(id, tx);
    await writeAudit(tx, ctx, { action: 'stock_transfer.dispatched', entityType: 'stock_transfer', entityId: id, after });
    return after;
  });
}

/** Puts the dispatched lots into the destination location. */
export async function receiveTransfer(id: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    assertStatus(await lockDocument(tx, 'stock_transfers', id), 'DISPATCHED', 'receive this transfer');
    const t = await tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    const session = await openStockSession(tx, t.lines.map((l) => ({ variantId: l.variantId, locationId: t.toLocationId })), ctx.actorId!);
    for (const line of t.lines) {
      const parts = ((line.batchAllocations as BatchAllocation[] | null) ?? []).map((p) => ({ ...p, qty: dec(p.qty) }));
      await session.transferIn({ variantId: line.variantId, locationId: t.toLocationId, parts, source: { type: SOURCE, id: t.id, lineId: line.id } });
    }
    await tx.stockTransfer.update({ where: { id }, data: { status: 'RECEIVED', receivedById: ctx.actorId, receivedAt: new Date() } });
    const after = await getTransfer(id, tx);
    await writeAudit(tx, ctx, { action: 'stock_transfer.received', entityType: 'stock_transfer', entityId: id });
    return after;
  });
}

export async function cancelTransfer(id: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    assertStatus(await lockDocument(tx, 'stock_transfers', id), 'DRAFT', 'cancel this transfer');
    await tx.stockTransfer.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: ctx.actorId, cancelledAt: new Date() } });
    await writeAudit(tx, ctx, { action: 'stock_transfer.cancelled', entityType: 'stock_transfer', entityId: id });
    return getTransfer(id, tx);
  });
}
