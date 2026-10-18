import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { dec, roundMoney, type BatchRow, type MovementRow, type StockRow, type batchQuerySchema, type movementQuerySchema, type stockQuerySchema } from '@rhoyards/shared';
import { pageArgs } from '../../lib/pagination';
import { getPrisma } from '../../lib/prisma';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

interface StockSqlRow {
  variant_id: string;
  sku: string;
  variant_name: string;
  product_id: string;
  product_name: string;
  brand_name: string | null;
  category_name: string | null;
  unit_code: string;
  qty_on_hand: string;
  qty_reserved: string;
  reorder_level: string;
  avg_cost: string;
  total: bigint;
}

/**
 * Stock by variant, optionally at one location. "Low stock" means available (on hand − reserved)
 * at or below a non-zero reorder level.
 */
export async function listStock(query: z.infer<typeof stockQuerySchema>) {
  const { skip, take } = pageArgs(query);
  const location = query.locationId ?? null;
  const filters: Prisma.Sql[] = [Prisma.sql`v.archived_at IS NULL`, Prisma.sql`p.archived_at IS NULL`];
  if (query.q) {
    const pattern = like(query.q);
    filters.push(Prisma.sql`(v.sku ILIKE ${pattern} OR v.name ILIKE ${pattern} OR p.name ILIKE ${pattern}
      OR EXISTS (SELECT 1 FROM variant_barcodes vb WHERE vb.variant_id = v.id AND vb.barcode = ${query.q}))`);
  }
  if (query.brandId) filters.push(Prisma.sql`p.brand_id = ${query.brandId}::uuid`);
  if (query.categoryId) filters.push(Prisma.sql`p.category_id = ${query.categoryId}::uuid`);

  const rows = await getPrisma().$queryRaw<StockSqlRow[]>`
    SELECT v.id AS variant_id, v.sku, v.name AS variant_name, p.id AS product_id, p.name AS product_name,
           b.name AS brand_name, c.name AS category_name, u.code AS unit_code,
           COALESCE(SUM(ib.qty_on_hand), 0)::text AS qty_on_hand,
           COALESCE(SUM(ib.qty_reserved), 0)::text AS qty_reserved,
           v.reorder_level::text AS reorder_level, v.avg_cost::text AS avg_cost,
           COUNT(*) OVER () AS total
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    JOIN units u ON u.id = p.unit_id
    LEFT JOIN brands b ON b.id = p.brand_id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory_balances ib ON ib.variant_id = v.id AND (${location}::uuid IS NULL OR ib.location_id = ${location}::uuid)
    WHERE ${Prisma.join(filters, ' AND ')}
    GROUP BY v.id, p.id, b.name, c.name, u.code
    HAVING ${query.lowStock ? Prisma.sql`v.reorder_level > 0 AND COALESCE(SUM(ib.qty_on_hand), 0) - COALESCE(SUM(ib.qty_reserved), 0) <= v.reorder_level` : Prisma.sql`TRUE`}
    ORDER BY p.name, v.name
    LIMIT ${take} OFFSET ${skip}`;

  const data: StockRow[] = rows.map((r) => {
    const onHand = dec(r.qty_on_hand);
    const available = onHand.minus(r.qty_reserved);
    const reorder = dec(r.reorder_level);
    return {
      variantId: r.variant_id,
      sku: r.sku,
      variantName: r.variant_name,
      productId: r.product_id,
      productName: r.product_name,
      brandName: r.brand_name,
      categoryName: r.category_name,
      unitCode: r.unit_code,
      qtyOnHand: onHand.toFixed(3),
      qtyReserved: dec(r.qty_reserved).toFixed(3),
      qtyAvailable: available.toFixed(3),
      reorderLevel: reorder.toFixed(3),
      avgCost: dec(r.avg_cost).toFixed(4),
      stockValue: roundMoney(onHand.times(r.avg_cost)).toFixed(2),
      isLowStock: reorder.gt(0) && available.lte(reorder),
    };
  });
  return { data, total: Number(rows[0]?.total ?? 0) };
}

/** Resolves document numbers for the movement ledger's "reference" column. */
async function references(rows: { sourceType: string; sourceId: string }[]) {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.sourceType === type).map((r) => r.sourceId))];
  const prisma = getPrisma();
  const [adjustments, transfers] = await Promise.all([
    prisma.stockAdjustment.findMany({ where: { id: { in: ids('STOCK_ADJUSTMENT') } }, select: { id: true, number: true } }),
    prisma.stockTransfer.findMany({ where: { id: { in: ids('STOCK_TRANSFER') } }, select: { id: true, number: true } }),
  ]);
  return new Map([...adjustments, ...transfers].map((d) => [d.id, d.number]));
}

export async function listMovements(query: z.infer<typeof movementQuerySchema>) {
  const where: Prisma.StockMovementWhereInput = {
    ...(query.variantId ? { variantId: query.variantId } : {}),
    ...(query.locationId ? { locationId: query.locationId } : {}),
    ...(query.type ? { type: query.type as Prisma.EnumStockMovementTypeFilter['equals'] } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(`${query.from}T00:00:00Z`) } : {}),
            ...(query.to ? { lt: new Date(new Date(`${query.to}T00:00:00Z`).getTime() + 86_400_000) } : {}),
          },
        }
      : {}),
    ...(query.q ? { variant: { OR: [{ sku: { contains: query.q, mode: 'insensitive' } }, { product: { name: { contains: query.q, mode: 'insensitive' } } }] } } : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      include: {
        variant: { select: { sku: true, name: true, product: { select: { name: true } } } },
        location: { select: { id: true, code: true, name: true } },
        batch: { select: { lotNumber: true } },
        createdBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(query),
    }),
    prisma.stockMovement.count({ where }),
  ]);
  const refs = await references(rows);
  const data: MovementRow[] = rows.map((m) => ({
    id: m.id,
    createdAt: m.createdAt.toISOString(),
    type: m.type,
    variantId: m.variantId,
    sku: m.variant.sku,
    productName: m.variant.product.name,
    variantName: m.variant.name,
    location: m.location,
    lotNumber: m.batch?.lotNumber ?? null,
    qtyChange: m.qtyChange.toFixed(3),
    unitCost: m.unitCost.toFixed(4),
    totalCost: m.totalCost.toFixed(2),
    qtyAfter: m.qtyAfter.toFixed(3),
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    reference: refs.get(m.sourceId) ?? null,
    createdBy: m.createdBy.fullName,
    note: m.note,
  }));
  return { data, total };
}

export async function listBatches(query: z.infer<typeof batchQuerySchema>, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const where: Prisma.InventoryBatchWhereInput = {
    qtyOnHand: { gt: 0 },
    ...(query.variantId ? { variantId: query.variantId } : {}),
    ...(query.locationId ? { locationId: query.locationId } : {}),
    ...(query.expiringWithinDays !== undefined
      ? { expiryDate: { not: null, lte: new Date(today.getTime() + query.expiringWithinDays * 86_400_000) } }
      : {}),
    ...(query.q ? { OR: [{ lotNumber: { contains: query.q, mode: 'insensitive' } }, { variant: { sku: { contains: query.q, mode: 'insensitive' } } }] } : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.inventoryBatch.findMany({
      where,
      include: {
        variant: { select: { sku: true, name: true, product: { select: { name: true } } } },
        location: { select: { id: true, code: true, name: true } },
      },
      orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { receivedAt: 'asc' }],
      ...pageArgs(query),
    }),
    prisma.inventoryBatch.count({ where }),
  ]);
  const data: BatchRow[] = rows.map((b) => {
    const days = b.expiryDate ? Math.round((b.expiryDate.getTime() - today.getTime()) / 86_400_000) : null;
    return {
      id: b.id,
      variantId: b.variantId,
      sku: b.variant.sku,
      productName: b.variant.product.name,
      variantName: b.variant.name,
      location: b.location,
      lotNumber: b.lotNumber,
      mfgDate: b.mfgDate?.toISOString().slice(0, 10) ?? null,
      expiryDate: b.expiryDate?.toISOString().slice(0, 10) ?? null,
      qtyOnHand: b.qtyOnHand.toFixed(3),
      daysToExpiry: days,
      isExpired: days !== null && days < 0,
    };
  });
  return { data, total };
}

/**
 * Reconciles the stock ledger with the general ledger: Σ variant stock value must equal the
 * balance of the Inventory account. A non-zero difference indicates a posting error.
 */
export async function inventoryValuation() {
  const prisma = getPrisma();
  const [stock] = await prisma.$queryRaw<{ value: string; qty: string; variants: bigint }[]>`
    SELECT COALESCE(SUM(stock_value), 0)::text AS value, COALESCE(SUM(stock_qty), 0)::text AS qty,
           COUNT(*) FILTER (WHERE stock_qty <> 0) AS variants
    FROM product_variants`;
  const [gl] = await prisma.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS balance
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'POSTED'
    JOIN accounts a ON a.id = l.account_id AND a.system_key = 'INVENTORY'`;
  const [located] = await prisma.$queryRaw<{ qty: string }[]>`SELECT COALESCE(SUM(qty_on_hand), 0)::text AS qty FROM inventory_balances`;
  const stockValue = dec(stock?.value ?? 0);
  const glBalance = dec(gl?.balance ?? 0);
  return {
    stockLedgerValue: stockValue.toFixed(2),
    glInventoryBalance: glBalance.toFixed(2),
    difference: stockValue.minus(glBalance).toFixed(2),
    stockQty: dec(stock?.qty ?? 0).toFixed(3),
    /** Quantity dispatched on transfers but not yet received. */
    inTransitQty: dec(stock?.qty ?? 0).minus(located?.qty ?? 0).toFixed(3),
    variantsWithStock: Number(stock?.variants ?? 0),
  };
}
