import type { Prisma } from '@prisma/client';
import { dec, sum, ZERO, type DashboardData } from '@rhoyards/shared';
import { businessDate, businessTimeZone, startOfBusinessDay } from '../../lib/business-date';
import { getPrisma } from '../../lib/prisma';
import { normalBalance, totalsByAccount } from '../accounting/common';
import { profitAndLoss } from '../accounting/reports.service';
import { getSettings } from '../settings/settings.service';
import { period, salesReport } from './operational.service';

/**
 * The management dashboard. Money figures come from the ledger through the same functions as the financial
 * statements (profit and loss, balances), so a number on the dashboard always equals the one in the reports.
 */

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
};

export async function getDashboard(): Promise<DashboardData> {
  const prisma = getPrisma();
  const today = isoDate(businessDate());
  const monthStart = `${today.slice(0, 7)}-01`;
  const seriesStart = addDays(today, -29);
  const dayStart = startOfBusinessDay(today);
  const dayEnd = startOfBusinessDay(addDays(today, 1));

  const [settings, accounts, totals, pl, todaySales, onlineToday, top] = await Promise.all([
    getSettings(prisma),
    prisma.account.findMany(),
    totalsByAccount(prisma, { to: new Date(`${today}T00:00:00Z`) }),
    profitAndLoss(monthStart, today),
    prisma.sale.aggregate({ where: { status: 'COMPLETED', completedAt: { gte: dayStart, lt: dayEnd } }, _count: { _all: true }, _sum: { total: true } }),
    prisma.onlineOrder.count({ where: { placedAt: { gte: dayStart, lt: dayEnd } } }),
    salesReport({ from: monthStart, to: today, groupBy: 'product' }),
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
    WHERE je.entry_date BETWEEN ${seriesStart}::date AND ${today}::date
    GROUP BY 1`;
  const counts = await prisma.$queryRaw<{ day: string; n: bigint }[]>`
    SELECT to_char((completed_at AT TIME ZONE ${businessTimeZone()})::date, 'YYYY-MM-DD') AS day, COUNT(*) AS n
    FROM sales WHERE status = 'COMPLETED' AND completed_at >= ${startOfBusinessDay(seriesStart)} AND completed_at < ${dayEnd}
    GROUP BY 1`;
  const netBy = new Map(series.map((s) => [isoDate(s.day), dec(s.net.toString())]));
  const countBy = new Map(counts.map((c) => [c.day, Number(c.n)]));
  const dailySales = Array.from({ length: 30 }, (_, i) => {
    const date = addDays(seriesStart, i);
    return { date, netSales: (netBy.get(date) ?? ZERO).toFixed(2), sales: countBy.get(date) ?? 0 };
  });

  const warnUntil = new Date(`${addDays(today, settings.inventory.expiryWarningDays)}T00:00:00Z`);
  const [lowStock, outOfStock, expiringSoon, awaiting, toFulfil, onHold, returns, expenses] = await Promise.all([
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.status = 'ACTIVE' AND v.archived_at IS NULL AND p.archived_at IS NULL
        AND v.reorder_level > 0 AND v.stock_qty > 0 AND v.stock_qty <= v.reorder_level`,
    prisma.productVariant.count({ where: { status: 'ACTIVE', archivedAt: null, product: { archivedAt: null, status: 'ACTIVE' }, stockQty: { lte: 0 } } }),
    prisma.inventoryBatch.count({ where: { qtyOnHand: { gt: 0 }, expiryDate: { not: null, lte: warnUntil } } }),
    prisma.onlineOrder.count({ where: { status: 'PENDING_PAYMENT' } }),
    prisma.onlineOrder.count({ where: { status: { in: ['PAID', 'PROCESSING', 'PACKED'] } } }),
    prisma.onlineOrder.count({ where: { status: 'ON_HOLD' } }),
    prisma.saleReturn.count({ where: { status: { in: ['PENDING_APPROVAL', 'APPROVED'] } } }),
    prisma.expense.count({ where: { status: 'SUBMITTED' } }),
  ]);

  const netSales = dec(pl.netSales);
  return {
    asOf: today,
    today: { salesCount: todaySales._count._all, salesTotal: dec(todaySales._sum.total?.toString() ?? 0).toFixed(2), onlineOrders: onlineToday },
    monthToDate: {
      from: period(monthStart, today).from,
      netSales: pl.netSales,
      grossProfit: pl.grossProfit,
      netProfit: pl.netProfit,
      grossMargin: netSales.isZero() ? null : dec(pl.grossProfit).dividedBy(netSales).times(100).toFixed(1),
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
      lowStock: Number(lowStock[0]?.n ?? 0),
      outOfStock,
      expiringSoon,
      ordersAwaitingPayment: awaiting,
      ordersToFulfil: toFulfil,
      ordersOnHold: onHold,
      returnsToApprove: returns,
      expensesToApprove: expenses,
    },
  };
}
