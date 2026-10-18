import { Prisma } from '@prisma/client';
import { dec, exclusiveTax, roundMoney, type Decimal } from '@rhoyards/shared';
import { AppError, notFound } from '../../lib/errors';
import type { Db } from '../../lib/prisma';

export const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
export const isoDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const pd = (v: Decimal | string) => new Prisma.Decimal(typeof v === 'string' ? v : v.toFixed(4));
export const money = (v: Decimal) => new Prisma.Decimal(v.toFixed(2));
export const qty = (v: Decimal | string) => new Prisma.Decimal(typeof v === 'string' ? v : v.toFixed(3));

export const variantRefSelect = {
  id: true,
  sku: true,
  name: true,
  product: { select: { name: true, isBatchTracked: true, isExpiryTracked: true, taxRateId: true } },
} satisfies Prisma.ProductVariantSelect;

export function variantRef(v: Prisma.ProductVariantGetPayload<{ select: typeof variantRefSelect }>) {
  return {
    id: v.id,
    sku: v.sku,
    name: v.name,
    productName: v.product.name,
    isBatchTracked: v.product.isBatchTracked,
    isExpiryTracked: v.product.isExpiryTracked,
  };
}

export async function assertActiveSupplier(db: Db, supplierId: string) {
  const supplier = await db.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw new AppError(400, 'VALIDATION_ERROR', 'Supplier not found', { field: 'supplierId' });
  if (!supplier.isActive) throw new AppError(400, 'VALIDATION_ERROR', `${supplier.name} is inactive`, { field: 'supplierId' });
  return supplier;
}

export async function supplierOrThrow(db: Db, supplierId: string) {
  const supplier = await db.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw notFound('Supplier');
  return supplier;
}

/**
 * Resolves line tax rates. A missing taxRateId falls back to the given default (e.g. the product's rate).
 * Returns the id and the rate snapshot to store on the line.
 */
export async function resolveTaxRates(db: Db, requested: (string | null | undefined)[], defaults: (string | null)[]) {
  const ids = [...new Set([...requested, ...defaults].filter((x): x is string => Boolean(x)))];
  const rates = await db.taxRate.findMany({ where: { id: { in: ids } } });
  const byId = new Map(rates.map((r) => [r.id, r]));
  return requested.map((id, i) => {
    const chosen = id ?? defaults[i] ?? null;
    if (!chosen) return { taxRateId: null, rate: dec(0) };
    const r = byId.get(chosen);
    if (!r) throw new AppError(400, 'VALIDATION_ERROR', `Line ${i + 1}: tax rate not found`, { line: i + 1, field: 'taxRateId' });
    if (id && !r.isActive) throw new AppError(400, 'VALIDATION_ERROR', `Line ${i + 1}: tax rate ${r.name} is inactive`, { line: i + 1, field: 'taxRateId' });
    return { taxRateId: r.id, rate: dec(r.rate.toString()) };
  });
}

/** Net and VAT for a priced line (prices on purchase documents are exclusive of VAT). */
export function priceLine(quantity: string | Decimal, unitCost: string | Decimal, ratePercent: Decimal) {
  const net = roundMoney(dec(quantity).times(unitCost));
  return { net, tax: exclusiveTax(net, ratePercent) };
}

type LockTable = 'purchase_orders' | 'goods_receipts' | 'supplier_invoices' | 'purchase_returns';

/** Row-locks a purchasing document and returns its status (serialises approve/post/cancel requests). */
export async function lockDoc(tx: Prisma.TransactionClient, table: LockTable, id: string): Promise<string> {
  const sql = {
    purchase_orders: Prisma.sql`SELECT "status"::text FROM "purchase_orders" WHERE "id" = ${id}::uuid FOR UPDATE`,
    goods_receipts: Prisma.sql`SELECT "status"::text FROM "goods_receipts" WHERE "id" = ${id}::uuid FOR UPDATE`,
    supplier_invoices: Prisma.sql`SELECT "status"::text FROM "supplier_invoices" WHERE "id" = ${id}::uuid FOR UPDATE`,
    purchase_returns: Prisma.sql`SELECT "status"::text FROM "purchase_returns" WHERE "id" = ${id}::uuid FOR UPDATE`,
  }[table];
  const rows = await tx.$queryRaw<{ status: string }[]>(sql);
  if (!rows[0]) throw notFound('Document');
  return rows[0].status;
}

/** Locks goods-receipt lines (ordered by id, so concurrent invoice/return postings cannot deadlock). */
export async function lockGrnLines(tx: Prisma.TransactionClient, ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length === 0) return;
  await tx.$queryRaw`SELECT "id" FROM "goods_receipt_lines" WHERE "id" = ANY(${sorted}::uuid[]) ORDER BY "id" FOR UPDATE`;
}

/** Quantity of a receipt line still to be invoiced. */
export const invoiceable = (l: { qty: Prisma.Decimal; qtyInvoiced: Prisma.Decimal; qtyReturnedUninvoiced: Prisma.Decimal }) =>
  dec(l.qty.toString()).minus(l.qtyInvoiced.toString()).minus(l.qtyReturnedUninvoiced.toString());

/** Quantity of a receipt line that can still be returned to the supplier. */
export const returnable = (l: { qty: Prisma.Decimal; qtyReturnedUninvoiced: Prisma.Decimal; qtyReturnedInvoiced: Prisma.Decimal }) =>
  dec(l.qty.toString()).minus(l.qtyReturnedUninvoiced.toString()).minus(l.qtyReturnedInvoiced.toString());

export function assertBatchFields(
  n: number,
  v: { sku: string; product: { isBatchTracked: boolean; isExpiryTracked: boolean } },
  line: { lotNumber?: string | null | undefined; expiryDate?: string | null | undefined; mfgDate?: string | null | undefined },
) {
  if (!v.product.isBatchTracked) {
    if (line.lotNumber || line.expiryDate || line.mfgDate) {
      throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: ${v.sku} is not batch-tracked; remove the lot details`, { line: n, field: 'lotNumber' });
    }
    return;
  }
  if (v.product.isExpiryTracked && !line.expiryDate) {
    throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: ${v.sku} needs an expiry date`, { line: n, field: 'expiryDate' });
  }
  if (!line.lotNumber && !line.expiryDate) {
    throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: ${v.sku} needs a lot number`, { line: n, field: 'lotNumber' });
  }
  if (line.mfgDate && line.expiryDate && line.mfgDate > line.expiryDate) {
    throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: manufacture date is after the expiry date`, { line: n, field: 'mfgDate' });
  }
}
