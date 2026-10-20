import { Prisma } from '@prisma/client';
import { DASHBOARD_PERIOD_LABELS, dashboardPeriodRange, dec, sum, ZERO, type DashboardData, type DashboardPeriod } from '@rhoyards/shared';
import { businessDate, businessTimeZone, startOfBusinessDay } from '../../lib/business-date';
import { getPrisma } from '../../lib/prisma';
import { normalBalance, totalsByAccount } from '../accounting/common';
import { profitAndLoss } from '../accounting/reports.service';
import { getSettings } from '../settings/settings.service';
import { salesReport, storeSql } from './operational.service';

/**
 * The management dashboard. Money figures come from the ledger through the same functions as the financial
 * statements (profit and loss, balances), so a number on the dashboard always equals the one in the reports.
 *
 * Sales, profit, the chart and best sellers cover the chosen period; balances and the attention queues are as of now.
 * For some stores (`stores`), sales, stock and queues are theirs; profit comes from the sales report (net profit is
 * left out: expenses are not recorded per store); balances stay business-wide.
 */

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
};
const addMonths = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return isoDate(d);
};

/** Periods longer than this many days are charted by month. */
const MAX_DAILY_POINTS = 92;

export async function getDashboard(
  scope: { ids: string[]; label: string } | null = null,
  periodKey: DashboardPeriod = 'this_month',
): Promise<DashboardData> {
  const prisma = getPrisma();
  const stores = scope?.ids ?? null;
  const atStores = stores ? { locationId: { in: stores } } : {};
  const today = isoDate(businessDate());
  const { from, to } = dashboardPeriodRange(periodKey, today);
  const startAt = startOfBusinessDay(from);
  const endAt = startOfBusinessDay(addDays(to, 1));

  const [settings, accounts, totals, pl, periodSales, onlineOrders, top] = await Promise.all([
    getSettings(prisma),
    prisma.account.findMany(),
    totalsByAccount(prisma, { to: new Date(`${today}T00:00:00Z`) }),
    stores ? null : profitAndLoss(from, to),
    prisma.sale.aggregate({ where: { status: 'COMPLETED', completedAt: { gte: startAt, lt: endAt }, ...atStores }, _count: { _all: true }, _sum: { total: true } }),
    prisma.onlineOrder.count({ where: { placedAt: { gte: startAt, lt: endAt }, ...atStores } }),
    salesReport({ from, to, groupBy: 'product', stores }),
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

  // The chart: the period, or the week up to a single day; by month when the period is long.
  const chartFrom = from === to ? addDays(to, -6) : from;
  const days = Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${chartFrom}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  const bucket: 'day' | 'month' = days > MAX_DAILY_POINTS ? 'month' : 'day';
  const unit = bucket === 'month' ? Prisma.sql`'month'` : Prisma.sql`'day'`;
  // Net sales from the ledger: credit minus debit on revenue and returns/discount accounts, as in the P&L.
  const series = await prisma.$queryRaw<{ day: string; net: Prisma.Decimal }[]>`
    SELECT to_char(date_trunc(${unit}, je.entry_date), 'YYYY-MM-DD') AS day, SUM(jl.credit - jl.debit) AS net
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED' AND je.source_type <> 'YEAR_END'
    JOIN accounts a ON a.id = jl.account_id AND a.type = 'INCOME' AND a.subtype IN ('REVENUE', 'CONTRA_REVENUE')
    WHERE je.entry_date BETWEEN ${chartFrom}::date AND ${to}::date ${storeSql(Prisma.sql`jl.location_id`, stores)}
    GROUP BY 1`;
  const counts = await prisma.$queryRaw<{ day: string; n: bigint }[]>`
    SELECT to_char(date_trunc(${unit}, (completed_at AT TIME ZONE ${businessTimeZone()})::date), 'YYYY-MM-DD') AS day, COUNT(*) AS n
    FROM sales WHERE status = 'COMPLETED' AND completed_at >= ${startOfBusinessDay(chartFrom)} AND completed_at < ${endAt}
      ${storeSql(Prisma.sql`location_id`, stores)}
    GROUP BY 1`;
  const netBy = new Map(series.map((r) => [r.day, dec(r.net.toString())]));
  const countBy = new Map(counts.map((c) => [c.day, Number(c.n)]));
  const pointDates: string[] = [];
  if (bucket === 'day') {
    for (let i = 0; i < days; i += 1) pointDates.push(addDays(chartFrom, i));
  } else {
    for (let d = `${chartFrom.slice(0, 7)}-01`; d <= to; d = addMonths(d, 1)) pointDates.push(d);
  }
  const points = pointDates.map((date) => ({ date, netSales: (netBy.get(date) ?? ZERO).toFixed(2), sales: countBy.get(date) ?? 0 }));

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

  // One store: from its sales (item revenue less returns, and their cost); no net profit.
  const profit = pl ?? { netSales: top.totals.netSales, grossProfit: top.totals.grossProfit, netProfit: null };
  const netSales = dec(profit.netSales);
  return {
    asOf: today,
    period: { key: periodKey, label: DASHBOARD_PERIOD_LABELS[periodKey], from, to },
    stores: scope,
    sales: { count: periodSales._count._all, total: dec(periodSales._sum.total?.toString() ?? 0).toFixed(2), onlineOrders },
    profit: {
      netSales: profit.netSales,
      grossProfit: profit.grossProfit,
      netProfit: profit.netProfit,
      grossMargin: netSales.isZero() ? null : dec(profit.grossProfit).dividedBy(netSales).times(100).toFixed(1),
    },
    balances: {
      cash: sum(cashAccounts.map((a) => a.balance)).toFixed(2),
      cashAccounts: cashAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name, balance: a.balance.toFixed(2) })),
      receivables: bal('AR').toFixed(2),
      payables: bal('AP').toFixed(2),
      inventory: bal('INVENTORY').toFixed(2),
    },
    series: { bucket, from: chartFrom, to, points },
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
