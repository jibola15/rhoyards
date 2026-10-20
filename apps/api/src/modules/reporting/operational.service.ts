import { Prisma } from '@prisma/client';
import {
  dec,
  sum,
  ZERO,
  type Decimal,
  type ExpensesReport,
  type PaymentsReport,
  type SalesGroup,
  type SalesReport,
  type SalesReportRow,
  type StockReport,
  type StockReportRow,
} from '@rhoyards/shared';
import { businessDate, businessTimeZone, startOfBusinessDay } from '../../lib/business-date';
import { getPrisma, type Db } from '../../lib/prisma';

/**
 * Operational reports. Sales figures are item revenue (net of VAT and discounts) less completed returns, so they
 * agree with the ledger's Sales revenue less Sales returns; delivery charges are not items and are left out.
 */

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const todayIso = () => isoDate(businessDate());
const fmt = (d: Decimal) => d.toFixed(2);
const pct = (part: Decimal, whole: Decimal) => (whole.isZero() ? null : part.dividedBy(whole).times(100).toFixed(1));

/** SQL condition limiting rows to some stores (`col` is a trusted column reference); nothing for all stores. */
export const storeSql = (col: Prisma.Sql, stores: string[] | null | undefined) =>
  stores ? Prisma.sql`AND ${col} = ANY(${stores}::uuid[])` : Prisma.empty;

/** A business-date range as [start, end) instants; defaults to the month to date. */
export function period(from?: string, to?: string) {
  const end = to ?? todayIso();
  const start = from ?? `${end.slice(0, 7)}-01`;
  const next = new Date(`${end}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { from: start, to: end, startAt: startOfBusinessDay(start), endAt: startOfBusinessDay(isoDate(next)) };
}

// ── Sales ────────────────────────────────────────────────────────────────

/** Key and label SQL per grouping (fixed list: nothing from the request reaches the SQL text). */
/** Built per call: the business time zone is configured at start-up, after this module loads. */
const groups = (): Record<SalesGroup, { key: Prisma.Sql; label: Prisma.Sql; join: Prisma.Sql; code?: Prisma.Sql }> => ({
  day: {
    key: Prisma.sql`to_char((l.at AT TIME ZONE ${businessTimeZone()})::date, 'YYYY-MM-DD')`,
    label: Prisma.sql`to_char((l.at AT TIME ZONE ${businessTimeZone()})::date, 'YYYY-MM-DD')`,
    join: Prisma.empty,
  },
  product: {
    key: Prisma.sql`v.id::text`,
    label: Prisma.sql`p.name || ' — ' || v.name`,
    code: Prisma.sql`v.sku`,
    join: Prisma.sql`JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id`,
  },
  category: {
    key: Prisma.sql`COALESCE(c.id::text, '-')`,
    label: Prisma.sql`COALESCE(c.name, 'Uncategorised')`,
    join: Prisma.sql`JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN categories c ON c.id = p.category_id`,
  },
  brand: {
    key: Prisma.sql`COALESCE(b.id::text, '-')`,
    label: Prisma.sql`COALESCE(b.name, 'No brand')`,
    join: Prisma.sql`JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN brands b ON b.id = p.brand_id`,
  },
  cashier: { key: Prisma.sql`u.id::text`, label: Prisma.sql`u.full_name`, join: Prisma.sql`JOIN users u ON u.id = l.cashier_id` },
  channel: { key: Prisma.sql`l.channel::text`, label: Prisma.sql`CASE l.channel::text WHEN 'POS' THEN 'Shop (POS)' ELSE 'Online' END`, join: Prisma.empty },
  location: { key: Prisma.sql`loc.id::text`, label: Prisma.sql`loc.name`, join: Prisma.sql`JOIN locations loc ON loc.id = l.location_id` },
});

interface SalesRowRaw {
  key: string;
  label: string;
  code: string | null;
  sales: bigint;
  qty_sold: Prisma.Decimal;
  qty_returned: Prisma.Decimal;
  net: Prisma.Decimal;
  tax: Prisma.Decimal;
  cost: Prisma.Decimal;
}

export async function salesReport(
  q: { from?: string | undefined; to?: string | undefined; groupBy: SalesGroup; stores?: string[] | null },
  db: Db = getPrisma(),
): Promise<SalesReport> {
  const p = period(q.from, q.to);
  const g = groups()[q.groupBy];
  const inStores = storeSql(Prisma.sql`s.location_id`, q.stores);
  // Sold lines count when the sale completed; returns count (negatively) when they were refunded.
  // A returned item's cost leaves cost of sales only when it went back to stock.
  const raw = await db.$queryRaw<SalesRowRaw[]>`
    WITH l AS (
      SELECT s.id AS sale_id, s.completed_at AS at, s.channel, s.location_id, s.cashier_id, si.variant_id,
             si.qty AS qty_sold, 0::numeric AS qty_returned, si.net_amount AS net, si.tax_amount AS tax, si.cost_amount AS cost
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'COMPLETED' AND s.completed_at >= ${p.startAt} AND s.completed_at < ${p.endAt} ${inStores}
      UNION ALL
      SELECT NULL, r.completed_at, s.channel, s.location_id, s.cashier_id, si.variant_id,
             0, ri.qty, -ri.net_amount, -ri.tax_amount, CASE WHEN ri.restock THEN -ri.cost_amount ELSE 0 END
      FROM sale_return_items ri
      JOIN sale_returns r ON r.id = ri.return_id
      JOIN sale_items si ON si.id = ri.sale_item_id
      JOIN sales s ON s.id = r.sale_id
      WHERE r.status = 'COMPLETED' AND r.completed_at >= ${p.startAt} AND r.completed_at < ${p.endAt} ${inStores}
    )
    SELECT ${g.key} AS key, ${g.label} AS label, ${g.code ?? Prisma.sql`NULL::text`} AS code, COUNT(DISTINCT l.sale_id) AS sales,
           SUM(l.qty_sold) AS qty_sold, SUM(l.qty_returned) AS qty_returned, SUM(l.net) AS net, SUM(l.tax) AS tax, SUM(l.cost) AS cost
    FROM l ${g.join}
    GROUP BY 1, 2, 3
    ORDER BY ${q.groupBy === 'day' ? Prisma.sql`1` : Prisma.sql`SUM(l.net) DESC, 2`}`;

  const toRow = (r: { key: string; label: string; code: string | null; sales: number; qtySold: Decimal; qtyReturned: Decimal; net: Decimal; tax: Decimal; cost: Decimal }): SalesReportRow => ({
    key: r.key,
    label: r.label,
    code: r.code,
    sales: r.sales,
    qtySold: r.qtySold.toFixed(3),
    qtyReturned: r.qtyReturned.toFixed(3),
    netSales: fmt(r.net),
    tax: fmt(r.tax),
    cost: fmt(r.cost),
    grossProfit: fmt(r.net.minus(r.cost)),
    margin: pct(r.net.minus(r.cost), r.net),
  });
  const rows = raw.map((r) => ({
    key: r.key,
    label: r.label,
    code: r.code,
    sales: Number(r.sales),
    qtySold: dec(r.qty_sold.toString()),
    qtyReturned: dec(r.qty_returned.toString()),
    net: dec(r.net.toString()),
    tax: dec(r.tax.toString()),
    cost: dec(r.cost.toString()),
  }));
  const [salesCount] = await db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM sales s WHERE s.status = 'COMPLETED' AND s.completed_at >= ${p.startAt} AND s.completed_at < ${p.endAt} ${inStores}`;
  const { key: _k, label: _l, code: _c, ...totals } = toRow({
    key: '',
    label: '',
    code: null,
    sales: Number(salesCount?.n ?? 0),
    qtySold: sum(rows.map((r) => r.qtySold)),
    qtyReturned: sum(rows.map((r) => r.qtyReturned)),
    net: sum(rows.map((r) => r.net)),
    tax: sum(rows.map((r) => r.tax)),
    cost: sum(rows.map((r) => r.cost)),
  });
  return { from: p.from, to: p.to, groupBy: q.groupBy, rows: rows.map(toRow), totals };
}

// ── Payments ─────────────────────────────────────────────────────────────

/**
 * Money taken and paid back by payment method: sale payments, customer receipts and refunds. For some stores,
 * customer receipts (account payments, not taken at a store) are left out.
 */
export async function paymentsReport(from?: string, to?: string, stores: string[] | null = null): Promise<PaymentsReport> {
  const prisma = getPrisma();
  const p = period(from, to);
  const [methods, sales, receipts, refunds] = await Promise.all([
    prisma.paymentMethod.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.$queryRaw<{ id: string; amount: Prisma.Decimal }[]>`
      SELECT sp.payment_method_id AS id, SUM(sp.amount) AS amount FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
      WHERE s.status = 'COMPLETED' AND s.completed_at >= ${p.startAt} AND s.completed_at < ${p.endAt} ${storeSql(Prisma.sql`s.location_id`, stores)} GROUP BY 1`,
    stores
      ? Promise.resolve([] as { paymentMethodId: string; _sum: { amount: Prisma.Decimal | null } }[])
      : prisma.customerReceipt.groupBy({ by: ['paymentMethodId'], where: { receiptDate: { gte: new Date(`${p.from}T00:00:00Z`), lte: new Date(`${p.to}T00:00:00Z`) } }, _sum: { amount: true } }),
    prisma.saleReturn.groupBy({
      by: ['refundMethodId'],
      where: { status: 'COMPLETED', refundMethodId: { not: null }, completedAt: { gte: p.startAt, lt: p.endAt }, ...(stores ? { sale: { locationId: { in: stores } } } : {}) },
      _sum: { paidOut: true },
    }),
  ]);
  const amount = (v: { toString(): string } | null | undefined) => dec(v?.toString() ?? 0);
  const rows = methods
    .map((m) => {
      const s = amount(sales.find((x) => x.id === m.id)?.amount);
      const r = amount(receipts.find((x) => x.paymentMethodId === m.id)?._sum.amount);
      const f = amount(refunds.find((x) => x.refundMethodId === m.id)?._sum.paidOut);
      return { m, s, r, f };
    })
    .filter((x) => !x.s.isZero() || !x.r.isZero() || !x.f.isZero());
  const t = { s: sum(rows.map((x) => x.s)), r: sum(rows.map((x) => x.r)), f: sum(rows.map((x) => x.f)) };
  return {
    from: p.from,
    to: p.to,
    rows: rows.map(({ m, s, r, f }) => ({ methodId: m.id, method: m.name, kind: m.kind, sales: fmt(s), receipts: fmt(r), refunds: fmt(f), net: fmt(s.plus(r).minus(f)) })),
    totals: { sales: fmt(t.s), receipts: fmt(t.r), refunds: fmt(t.f), net: fmt(t.s.plus(t.r).minus(t.f)) },
  };
}

// ── Expenses ─────────────────────────────────────────────────────────────

export async function expensesReport(from?: string, to?: string): Promise<ExpensesReport> {
  const prisma = getPrisma();
  const p = period(from, to);
  const [grouped, categories] = await Promise.all([
    prisma.expense.groupBy({
      by: ['categoryId'],
      where: { status: 'POSTED', expenseDate: { gte: new Date(`${p.from}T00:00:00Z`), lte: new Date(`${p.to}T00:00:00Z`) } },
      _sum: { netAmount: true, taxAmount: true, total: true },
      _count: { _all: true },
    }),
    prisma.expenseCategory.findMany(),
  ]);
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const rows = grouped
    .map((g) => ({ categoryId: g.categoryId, category: names.get(g.categoryId) ?? '', count: g._count._all, net: dec(g._sum.netAmount?.toString() ?? 0), tax: dec(g._sum.taxAmount?.toString() ?? 0), total: dec(g._sum.total?.toString() ?? 0) }))
    .sort((a, b) => b.total.comparedTo(a.total));
  return {
    from: p.from,
    to: p.to,
    rows: rows.map((r) => ({ ...r, net: fmt(r.net), tax: fmt(r.tax), total: fmt(r.total) })),
    totals: { count: rows.reduce((n, r) => n + r.count, 0), net: fmt(sum(rows.map((r) => r.net))), tax: fmt(sum(rows.map((r) => r.tax))), total: fmt(sum(rows.map((r) => r.total))) },
  };
}

// ── Stock ────────────────────────────────────────────────────────────────

/**
 * Stock on hand and value with the rate of sale: low, out-of-stock and slow-moving lines. For some stores, quantities
 * and sales are theirs, valued at the business-wide average cost; the reorder level applies to each store.
 */
export async function stockReport(q: { days: number; status: 'all' | 'low' | 'out' | 'slow'; stores?: string[] | null }): Promise<StockReport> {
  const prisma = getPrisma();
  const since = new Date(Date.now() - q.days * 86_400_000);
  const stores = q.stores ?? null;
  const [variants, sold, balances] = await Promise.all([
    prisma.productVariant.findMany({ where: { archivedAt: null, status: 'ACTIVE', product: { archivedAt: null } }, include: { product: { select: { name: true } } }, orderBy: [{ product: { name: 'asc' } }, { name: 'asc' }] }),
    prisma.$queryRaw<{ variant_id: string; qty: Prisma.Decimal }[]>`
      SELECT si.variant_id, SUM(si.qty) AS qty FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'COMPLETED' AND s.completed_at >= ${since} ${storeSql(Prisma.sql`s.location_id`, stores)} GROUP BY 1`,
    prisma.inventoryBalance.groupBy({ by: ['variantId'], where: stores ? { locationId: { in: stores } } : {}, _sum: { qtyReserved: true, qtyOnHand: true } }),
  ]);
  const soldBy = new Map(sold.map((s) => [s.variant_id, dec(s.qty.toString())]));
  const reservedBy = new Map(balances.map((r) => [r.variantId, dec(r._sum.qtyReserved?.toString() ?? 0)]));
  const onHandBy = new Map(balances.map((r) => [r.variantId, dec(r._sum.qtyOnHand?.toString() ?? 0)]));
  const all: StockReportRow[] = variants.map((v) => {
    const onHand = stores ? (onHandBy.get(v.id) ?? ZERO) : dec(v.stockQty.toString());
    const qtySold = soldBy.get(v.id) ?? ZERO;
    const reorder = dec(v.reorderLevel.toString());
    const perDay = qtySold.dividedBy(q.days);
    const status: StockReportRow['status'] = onHand.lte(0) ? 'OUT' : reorder.gt(0) && onHand.lte(reorder) ? 'LOW' : qtySold.isZero() ? 'SLOW' : 'OK';
    return {
      variantId: v.id,
      sku: v.sku,
      product: v.product.name,
      variant: v.name,
      onHand: onHand.toFixed(3),
      reserved: (reservedBy.get(v.id) ?? ZERO).toFixed(3),
      avgCost: v.avgCost.toFixed(4),
      value: stores ? onHand.times(v.avgCost.toString()).toFixed(2) : v.stockValue.toFixed(2),
      reorderLevel: reorder.toFixed(3),
      soldInPeriod: qtySold.toFixed(3),
      daysOfCover: perDay.isZero() || onHand.lte(0) ? null : Math.floor(onHand.dividedBy(perDay).toNumber()),
      status,
    };
  });
  const rows = q.status === 'all' ? all : all.filter((r) => r.status === q.status.toUpperCase());
  return { days: q.days, rows, totals: { onHand: sum(rows.map((r) => r.onHand)).toFixed(3), value: fmt(sum(rows.map((r) => r.value))) } };
}
