import { Prisma } from '@prisma/client';
import { dec, sum, ZERO, type DashboardData } from '@rhoyards/shared';
import { businessDate, businessTimeZone, startOfBusinessDay } from '../../lib/business-date';
import { getPrisma } from '../../lib/prisma';
import { normalBalance, totalsByAccount } from '../accounting/common';
import { profitAndLoss } from '../accounting/reports.service';
import { getSettings } from '../settings/settings.service';
import { period, salesReport, storeSql } from './operational.service';

/**
 * The management dashboard. Money figures come from the ledger through the same functions as the financial
 * statements (profit and loss, balances), so a number on the dashboard always equals the one in the reports.
 *
 * For some stores (`stores`), sales, stock and queues are theirs; month-to-date figures come from the sales report
 * (net profit is left out: expenses are not recorded per store); balances stay business-wide.
 */

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
};

export async function getDashboard(scope: { ids: string[]; label: string } | null = null): Promise<DashboardData> {
  const prisma = getPrisma();
  const stores = scope?.ids ?? null;
  const atStores = stores ? { locationId: { in: stores } } : {};
  const today = isoDate(businessDate());
  const monthStart = `${today.slice(0, 7)}-01`;
  const seriesStart = addDays(today, -29);
  const dayStart = startOfBusinessDay(today);
  const dayEnd = startOfBusinessDay(addDays(today, 1));

  const [settings, accounts, totals, pl, todaySales, onlineToday, top] = await Promise.all([
    getSettings(prisma),
    prisma.account.findMany(),
    totalsByAccount(prisma, { to: new Date(`${today}T00:00:00Z`) }),
    stores ? null : profitAndLoss(monthStart, today),
    prisma.sale.aggregate({ where: { status: 'COMPLETED', completedAt: { gte: dayStart, lt: dayEnd }, ...atStores }, _count: { _all: true }, _sum: { total: true } }),
    prisma.onlineOrder.count({ where: { placedAt: { gte: dayStart, lt: dayEnd }, ...atStores } }),
    salesReport({ from: monthStart, to: today, groupBy: 'product', stores }),
  ]);

  const bal = (key: string) => {
    const a = accounts.find((x) => x.systemKey === key);
    return a ? normalBalance(a.type, totals.get(a.id)) : ZERO;
  };
  const cashAccounts = accounts
    .filter((a) => a.subtype === 'CASH')
    .map((a) => ({ id: a.id, code: a.code, name: a.name, balance: normalBalance(a.type, totals.get(a.id)) }))
    .filter((a) => !a.balance.isZero())
    .sort((a, b) => a.code.localeCompare(b.code));

  // Net sales by day from the ledger: Σ(credit − debit) on revenue and returns/discount accounts, as in the P&L.
  const series = await prisma.$queryRaw<{ day: Date; net: Prisma.Decimal }[]>`
    SELECT je.entry_date AS day, SUM(jl.credit - jl.debit) AS net
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED' AND je.source_type <> 'YEAR_END'
    JOIN accounts a ON a.id = jl.account_id AND a.type = 'INCOME' AND a.subtype IN ('REVENUE', 'CONTRA_REVENUE')
    WHERE je.entry_date BETWEEN ${seriesStart}::date AND ${today}::date ${storeSql(Prisma.sql`jl.location_id`, stores)}
    GROUP BY 1`;
  const counts = await prisma.$queryRaw<{ day: string; n: bigint }[]>`
    SELECT to_char((completed_at AT TIME ZONE ${businessTimeZone()})::date, 'YYYY-MM-DD') AS day, COUNT(*) AS n
    FROM sales WHERE status = 'COMPLETED' AND completed_at >= ${startOfBusinessDay(seriesStart)} AND completed_at < ${dayEnd}
      ${storeSql(Prisma.sql`location_id`, stores)}
    GROUP BY 1`;
  const netBy = new Map(series.map((s) => [isoDate(s.day), dec(s.net.toString())]));
  const countBy = new Map(counts.map((c) => [c.day, Number(c.n)]));
  const dailySales = Array.from({ length: 30 }, (_, i) => {
    const date = addDays(seriesStart, i);
    return { date, netSales: (netBy.get(date) ?? ZERO).toFixed(2), sales: countBy.get(date) ?? 0 };
  });

  const warnUntil = new Date(`${addDays(today, settings.inventory.expiryWarningDays)}T00:00:00Z`);
  // Stock per variant: business-wide, or summed over the chosen stores (the reorder level applies to each store).
  const stockLevels = stores
    ? Prisma.sql`SELECT v.reorder_level, COALESCE(SUM(ib.qty_on_hand), 0) AS qty
        FROM product_variants v JOIN products p ON p.id = v.product_id
        LEFT JOIN inventory_balances ib ON ib.variant_id = v.id AND ib.location_id = ANY(${stores}::uuid[])
        WHERE v.status = 'ACTIVE' AND v.archived_at IS NULL AND p.archived_at IS NULL AND p.status = 'ACTIVE'
        GROUP BY v.id`
    : Prisma.sql`SELECT v.reorder_level, v.stock_qty AS qty
        FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE v.status = 'ACTIVE' AND v.archived_at IS NULL AND p.archived_at IS NULL AND p.status = 'ACTIVE'`;
  const [stockCounts, expiringSoon, awaiting, toFulfil, onHold, returns, expenses] = await Promise.all([
    prisma.$queryRaw<{ low: bigint; out: bigint }[]>`
      SELECT COUNT(*) FILTER (WHERE reorder_level > 0 AND qty > 0 AND qty <= reorder_level) AS low,
             COUNT(*) FILTER (WHERE qty <= 0) AS out
      FROM (${stockLevels}) x`,
    prisma.inventoryBatch.count({ where: { qtyOnHand: { gt: 0 }, expiryDate: { not: null, lte: warnUntil }, ...atStores } }),
    prisma.onlineOrder.count({ where: { status: 'PENDING_PAYMENT', ...atStores } }),
    prisma.onlineOrder.count({ where: { status: { in: ['PAID', 'PROCESSING', 'PACKED'] }, ...atStores } }),
    prisma.onlineOrder.count({ where: { status: 'ON_HOLD', ...atStores } }),
    prisma.saleReturn.count({ where: { status: { in: ['PENDING_APPROVAL', 'APPROVED'] }, ...(stores ? { sale: atStores } : {}) } }),
    prisma.expense.count({ where: { status: 'SUBMITTED' } }),
  ]);

  // One store: month to date from its sales (item revenue less returns, and their cost); no net profit.
  const month = pl ?? { netSales: top.totals.netSales, grossProfit: top.totals.grossProfit, netProfit: null };
  const netSales = dec(month.netSales);
  return {
    asOf: today,
    stores: scope,
    today: { salesCount: todaySales._count._all, salesTotal: dec(todaySales._sum.total?.toString() ?? 0).toFixed(2), onlineOrders: onlineToday },
    monthToDate: {
      from: period(monthStart, today).from,
      netSales: month.netSales,
      grossProfit: month.grossProfit,
      netProfit: month.netProfit,
      grossMargin: netSales.isZero() ? null : dec(month.grossProfit).dividedBy(netSales).times(100).toFixed(1),
    },
    balances: {
      cash: sum(cashAccounts.map((a) => a.balance)).toFixed(2),
      cashAccounts: cashAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name, balance: a.balance.toFixed(2) })),
      receivables: bal('AR').toFixed(2),
      payables: bal('AP').toFixed(2),
      inventory: bal('INVENTORY').toFixed(2),
    },
    dailySales,
    topProducts: top.rows.slice(0, 5).map((r) => ({ variantId: r.key, sku: r.code ?? '', name: r.label, qty: dec(r.qtySold).minus(r.qtyReturned).toFixed(3), netSales: r.netSales })),
    attention: {
      lowStock: Number(stockCounts[0]?.low ?? 0),
      outOfStock: Number(stockCounts[0]?.out ?? 0),
      expiringSoon,
      ordersAwaitingPayment: awaiting,
      ordersToFulfil: toFulfil,
      ordersOnHold: onHold,
      returnsToApprove: returns,
      expensesToApprove: expenses,
    },
  };
}
