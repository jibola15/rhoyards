import type { Prisma } from '@prisma/client';
import { dec, type AdjustmentLineInput } from '@rhoyards/shared';
import { AppError, businessRule } from '../../lib/errors';
import type { Db } from '../../lib/prisma';

/** Shared validation for documents that list variants and quantities at a location. */

export async function assertActiveLocation(db: Db, locationId: string, field = 'locationId') {
  const location = await db.location.findUnique({ where: { id: locationId } });
  if (!location?.isActive) throw new AppError(400, 'VALIDATION_ERROR', 'Choose an active location', { field });
  return location;
}

const variantForStock = {
  id: true,
  sku: true,
  archivedAt: true,
  product: { select: { archivedAt: true, isBatchTracked: true, isExpiryTracked: true, unit: { select: { allowsFraction: true, code: true } } } },
} satisfies Prisma.ProductVariantSelect;

export async function loadVariantsForStock(db: Db, variantIds: string[]) {
  const unique = [...new Set(variantIds)];
  const rows = await db.productVariant.findMany({ where: { id: { in: unique } }, select: variantForStock });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [i, id] of variantIds.entries()) {
    const v = byId.get(id);
    if (!v) throw new AppError(400, 'VALIDATION_ERROR', `Line ${i + 1}: product not found`, { line: i + 1, field: 'variantId' });
    if (v.archivedAt || v.product.archivedAt) {
      throw new AppError(400, 'VALIDATION_ERROR', `Line ${i + 1}: ${v.sku} is archived`, { line: i + 1, field: 'variantId' });
    }
  }
  return byId;
}

export function assertQuantityUnit(line: number, sku: string, allowsFraction: boolean, unitCode: string, qty: string) {
  if (!allowsFraction && !dec(qty).isInteger()) {
    throw new AppError(400, 'VALIDATION_ERROR', `Line ${line}: ${sku} is counted in whole ${unitCode}`, { line, field: 'qty' });
  }
}

/** Batch details are required for increases of batch-tracked items and meaningless otherwise. */
export function assertAdjustmentBatchFields(
  lines: AdjustmentLineInput[],
  variants: Awaited<ReturnType<typeof loadVariantsForStock>>,
) {
  lines.forEach((line, i) => {
    const v = variants.get(line.variantId)!;
    const n = i + 1;
    assertQuantityUnit(n, v.sku, v.product.unit.allowsFraction, v.product.unit.code, line.qtyChange.replace('-', ''));
    const increase = !line.qtyChange.startsWith('-');
    if (!v.product.isBatchTracked) {
      if (line.lotNumber || line.expiryDate || line.mfgDate) {
        throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: ${v.sku} is not batch-tracked; remove the lot details`, { line: n, field: 'lotNumber' });
      }
      return;
    }
    if (increase && v.product.isExpiryTracked && !line.expiryDate) {
      throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: ${v.sku} needs an expiry date`, { line: n, field: 'expiryDate' });
    }
    if (increase && !line.lotNumber && !line.expiryDate) {
      throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: ${v.sku} needs a lot number`, { line: n, field: 'lotNumber' });
    }
    if (line.mfgDate && line.expiryDate && line.mfgDate > line.expiryDate) {
      throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: manufacture date is after the expiry date`, { line: n, field: 'mfgDate' });
    }
  });
}

/** Takes a row lock on a document and returns its status, so concurrent post/cancel requests serialise. */
export async function lockDocument(tx: Prisma.TransactionClient, table: 'stock_adjustments' | 'stock_transfers', id: string) {
  const rows =
    table === 'stock_adjustments'
      ? await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text FROM "stock_adjustments" WHERE "id" = ${id}::uuid FOR UPDATE`
      : await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text FROM "stock_transfers" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Document not found');
  return rows[0].status;
}

export function assertStatus(actual: string, expected: string, action: string) {
  if (actual !== expected) throw businessRule(`Cannot ${action}: the document is ${actual.toLowerCase()}`);
}

export const dateOrNull = (d: string | undefined) => (d ? new Date(`${d}T00:00:00Z`) : null);
