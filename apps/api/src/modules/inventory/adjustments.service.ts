import { Prisma, type AdjustmentReason, type StockMovementType } from '@prisma/client';
import type { z } from 'zod';
import {
  ADJUSTMENT_REASON_LABELS,
  dec,
  sum,
  ZERO,
  type AdjustmentDetail,
  type AdjustmentInput,
  type AdjustmentSummary,
  type documentListQuerySchema,
} from '@rhoyards/shared';
import { openStockSession } from '../../engines/inventory/inventory.engine';
import { postJournal, type JournalLineInput } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import type { AuthContext } from '../auth/auth.types';
import { getSettings } from '../settings/settings.service';
import {
  assertActiveLocation,
  assertAdjustmentBatchFields,
  assertStatus,
  dateOrNull,
  loadVariantsForStock,
  lockDocument,
} from './stock-documents';

const SOURCE = 'STOCK_ADJUSTMENT';

/** Ledger accounts used by each adjustment reason (docs/ACCOUNTING_RULES.md §5). */
const CREDIT_FOR_INCREASE: Record<AdjustmentReason, string> = {
  OPENING_STOCK: 'OPENING_BALANCE_EQUITY',
  STOCK_COUNT: 'INVENTORY_ADJUSTMENT',
  OTHER: 'INVENTORY_ADJUSTMENT',
  DAMAGE: 'INVENTORY_ADJUSTMENT',
  EXPIRY: 'INVENTORY_ADJUSTMENT',
  THEFT: 'INVENTORY_ADJUSTMENT',
};
const DEBIT_FOR_DECREASE: Record<AdjustmentReason, string> = {
  OPENING_STOCK: 'INVENTORY_ADJUSTMENT',
  STOCK_COUNT: 'INVENTORY_ADJUSTMENT',
  OTHER: 'INVENTORY_ADJUSTMENT',
  THEFT: 'INVENTORY_ADJUSTMENT',
  DAMAGE: 'STOCK_WRITE_OFF',
  EXPIRY: 'STOCK_WRITE_OFF',
};
const MOVEMENT_IN: Record<AdjustmentReason, StockMovementType> = {
  OPENING_STOCK: 'OPENING',
  STOCK_COUNT: 'ADJUSTMENT_IN',
  OTHER: 'ADJUSTMENT_IN',
  DAMAGE: 'ADJUSTMENT_IN',
  EXPIRY: 'ADJUSTMENT_IN',
  THEFT: 'ADJUSTMENT_IN',
};
const isWriteOff = (r: AdjustmentReason) => r === 'DAMAGE' || r === 'EXPIRY';

const include = {
  location: { select: { id: true, name: true } },
  createdBy: { select: { fullName: true } },
  postedBy: { select: { fullName: true } },
  cancelledBy: { select: { fullName: true } },
  lines: {
    orderBy: { lineNo: 'asc' },
    include: {
      variant: { select: { id: true, sku: true, name: true, product: { select: { name: true, isBatchTracked: true, isExpiryTracked: true } } } },
    },
  },
} satisfies Prisma.StockAdjustmentInclude;

type Row = Prisma.StockAdjustmentGetPayload<{ include: typeof include }>;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

async function postedValues(db: Db, ids: string[]) {
  const rows = await db.stockMovement.groupBy({
    by: ['sourceId', 'sourceLineId'],
    where: { sourceType: SOURCE, sourceId: { in: ids } },
    _sum: { totalCost: true },
  });
  return rows;
}

async function toDetail(db: Db, a: Row): Promise<AdjustmentDetail> {
  const values = a.status === 'POSTED' ? await postedValues(db, [a.id]) : [];
  const byLine = new Map(values.map((v) => [v.sourceLineId, v._sum.totalCost]));
  return {
    id: a.id,
    number: a.number,
    location: a.location,
    reason: a.reason,
    status: a.status,
    lineCount: a.lines.length,
    totalValue: a.status === 'POSTED' ? sum(values.map((v) => v._sum.totalCost?.toString() ?? '0')).toFixed(2) : null,
    createdBy: a.createdBy.fullName,
    createdAt: a.createdAt.toISOString(),
    postedAt: iso(a.postedAt),
    note: a.note,
    journalEntryId: a.journalEntryId,
    postedBy: a.postedBy?.fullName ?? null,
    cancelledBy: a.cancelledBy?.fullName ?? null,
    cancelledAt: iso(a.cancelledAt),
    lines: a.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      variant: {
        id: l.variant.id,
        sku: l.variant.sku,
        name: l.variant.name,
        productName: l.variant.product.name,
        isBatchTracked: l.variant.product.isBatchTracked,
        isExpiryTracked: l.variant.product.isExpiryTracked,
      },
      qtyChange: l.qtyChange.toFixed(3),
      unitCost: l.unitCost?.toFixed(4) ?? null,
      lotNumber: l.lotNumber,
      mfgDate: isoDate(l.mfgDate),
      expiryDate: isoDate(l.expiryDate),
      note: l.note,
      postedValue: a.status === 'POSTED' ? (byLine.get(l.id)?.toFixed(2) ?? '0.00') : null,
    })),
  };
}

export async function getAdjustment(id: string, db: Db = getPrisma()) {
  const a = await db.stockAdjustment.findUnique({ where: { id }, include });
  if (!a) throw notFound('Stock adjustment');
  return toDetail(db, a);
}

export async function listAdjustments(query: z.infer<typeof documentListQuerySchema>, scope: string[] | null = null) {
  const where: Prisma.StockAdjustmentWhereInput = {
    ...(scope ? { AND: [{ locationId: { in: scope } }] } : {}),
    ...(query.status ? { status: query.status as Prisma.EnumDocumentStatusFilter['equals'] } : {}),
    ...(query.locationId ? { locationId: query.locationId } : {}),
    ...(query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { note: { contains: query.q, mode: 'insensitive' } }] } : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.stockAdjustment.findMany({
      where,
      include: { location: { select: { id: true, name: true } }, createdBy: { select: { fullName: true } }, _count: { select: { lines: true } } },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(query),
    }),
    prisma.stockAdjustment.count({ where }),
  ]);
  const values = await postedValues(prisma, rows.filter((r) => r.status === 'POSTED').map((r) => r.id));
  const totals = new Map<string, string>();
  for (const v of values) totals.set(v.sourceId, dec(totals.get(v.sourceId) ?? 0).plus(v._sum.totalCost?.toString() ?? 0).toFixed(2));
  const data: AdjustmentSummary[] = rows.map((a) => ({
    id: a.id,
    number: a.number,
    location: a.location,
    reason: a.reason,
    status: a.status,
    lineCount: a._count.lines,
    totalValue: a.status === 'POSTED' ? (totals.get(a.id) ?? '0.00') : null,
    createdBy: a.createdBy.fullName,
    createdAt: a.createdAt.toISOString(),
    postedAt: iso(a.postedAt),
  }));
  return { data, total };
}

async function validate(db: Db, input: AdjustmentInput) {
  await assertActiveLocation(db, input.locationId);
  const variants = await loadVariantsForStock(db, input.lines.map((l) => l.variantId));
  assertAdjustmentBatchFields(input.lines, variants);
}

function lineData(input: AdjustmentInput) {
  return input.lines.map((l, i) => ({
    lineNo: i + 1,
    variantId: l.variantId,
    qtyChange: new Prisma.Decimal(l.qtyChange),
    unitCost: l.unitCost && !l.qtyChange.startsWith('-') ? new Prisma.Decimal(l.unitCost) : null,
    lotNumber: l.lotNumber ?? null,
    mfgDate: dateOrNull(l.mfgDate),
    expiryDate: dateOrNull(l.expiryDate),
    note: l.note ?? null,
  }));
}

export async function createAdjustment(input: AdjustmentInput, ctx: RequestContext) {
  return transaction(async (tx) => {
    await validate(tx, input);
    const number = await nextDocumentNumber(tx, 'STOCK_ADJUSTMENT', 'ADJ-');
    const created = await tx.stockAdjustment.create({
      data: {
        number,
        locationId: input.locationId,
        reason: input.reason,
        note: input.note ?? null,
        createdById: ctx.actorId!,
        lines: { create: lineData(input) },
      },
    });
    const detail = await getAdjustment(created.id, tx);
    await writeAudit(tx, ctx, { action: 'stock_adjustment.created', entityType: 'stock_adjustment', entityId: created.id, after: detail });
    return detail;
  });
}

export async function updateAdjustment(id: string, input: AdjustmentInput, ctx: RequestContext) {
  return transaction(async (tx) => {
    assertStatus(await lockDocument(tx, 'stock_adjustments', id), 'DRAFT', 'edit this adjustment');
    await validate(tx, input);
    const before = await getAdjustment(id, tx);
    await tx.stockAdjustmentLine.deleteMany({ where: { adjustmentId: id } });
    await tx.stockAdjustment.update({
      where: { id },
      data: { locationId: input.locationId, reason: input.reason, note: input.note ?? null, lines: { create: lineData(input) } },
    });
    const after = await getAdjustment(id, tx);
    await writeAudit(tx, ctx, { action: 'stock_adjustment.updated', entityType: 'stock_adjustment', entityId: id, before, after });
    return after;
  });
}

/**
 * Applies the adjustment to stock and the ledger in one transaction:
 * stock movements through the inventory engine, then a balanced journal for the value moved.
 */
export async function postAdjustment(id: string, actor: AuthContext, ctx: RequestContext) {
  return transaction(async (tx) => {
    assertStatus(await lockDocument(tx, 'stock_adjustments', id), 'DRAFT', 'post this adjustment');
    const adj = await tx.stockAdjustment.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    await assertActiveLocation(tx, adj.locationId);
    await loadVariantsForStock(tx, adj.lines.map((l) => l.variantId));
    const settings = await getSettings(tx);
    const allowNegative = settings.inventory.allowNegativeStock && actor.permissions.has('stock.negative.allow');

    const session = await openStockSession(
      tx,
      adj.lines.map((l) => ({ variantId: l.variantId, locationId: adj.locationId })),
      actor.user.id,
    );
    let increaseValue = ZERO;
    let decreaseValue = ZERO;
    for (const line of adj.lines) {
      const qty = dec(line.qtyChange.toString());
      const source = { type: SOURCE, id: adj.id, lineId: line.id };
      if (qty.isPositive()) {
        const r = await session.receive({
          variantId: line.variantId,
          locationId: adj.locationId,
          qty,
          unitCost: dec(line.unitCost?.toString() ?? '0'),
          type: MOVEMENT_IN[adj.reason],
          source,
          batch: { lotNumber: line.lotNumber ?? undefined, mfgDate: line.mfgDate ?? undefined, expiryDate: line.expiryDate ?? undefined },
          note: line.note ?? undefined,
        });
        increaseValue = increaseValue.plus(r.totalCost);
      } else {
        const r = await session.issue({
          variantId: line.variantId,
          locationId: adj.locationId,
          qty: qty.abs(),
          type: isWriteOff(adj.reason) ? 'WRITE_OFF' : 'ADJUSTMENT_OUT',
          source,
          lotNumber: line.lotNumber ?? undefined,
          allowNegative,
          // Adjustments correct reality, so expired lots may be counted out or written off.
          expired: 'allow',
          note: line.note ?? undefined,
        });
        decreaseValue = decreaseValue.plus(r.totalCost);
      }
    }

    const journalLines: JournalLineInput[] = [];
    if (increaseValue.gt(ZERO)) {
      journalLines.push(
        { accountKey: 'INVENTORY', debit: increaseValue, locationId: adj.locationId },
        { accountKey: CREDIT_FOR_INCREASE[adj.reason], credit: increaseValue, locationId: adj.locationId },
      );
    }
    if (decreaseValue.gt(ZERO)) {
      journalLines.push(
        { accountKey: DEBIT_FOR_DECREASE[adj.reason], debit: decreaseValue, locationId: adj.locationId },
        { accountKey: 'INVENTORY', credit: decreaseValue, locationId: adj.locationId },
      );
    }
    const journal = journalLines.length
      ? await postJournal(tx, {
          entryDate: new Date(),
          sourceType: SOURCE,
          sourceId: adj.id,
          postingKey: `${SOURCE}:${adj.id}`,
          description: `Stock adjustment ${adj.number} — ${ADJUSTMENT_REASON_LABELS[adj.reason]}`,
          lines: journalLines,
          actorId: actor.user.id,
        })
      : null;

    await tx.stockAdjustment.update({
      where: { id },
      data: { status: 'POSTED', postedById: actor.user.id, postedAt: new Date(), journalEntryId: journal?.id ?? null },
    });
    const after = await getAdjustment(id, tx);
    await writeAudit(tx, ctx, {
      action: 'stock_adjustment.posted',
      entityType: 'stock_adjustment',
      entityId: id,
      after: { number: after.number, totalValue: after.totalValue, journal: journal?.number ?? null },
    });
    return after;
  });
}

export async function cancelAdjustment(id: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    assertStatus(await lockDocument(tx, 'stock_adjustments', id), 'DRAFT', 'cancel this adjustment');
    await tx.stockAdjustment.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: ctx.actorId, cancelledAt: new Date() } });
    const after = await getAdjustment(id, tx);
    await writeAudit(tx, ctx, { action: 'stock_adjustment.cancelled', entityType: 'stock_adjustment', entityId: id });
    return after;
  });
}
