import { Prisma } from '@prisma/client';
import { dec, sum, ZERO, type CustomerItemsReport, type Decimal, type CustomerLedger, type CustomerLedgerLine, type ItemLedger } from '@rhoyards/shared';
import { businessDate } from '../../lib/business-date';
import { notFound } from '../../lib/errors';
import { getPrisma } from '../../lib/prisma';
import { references } from '../inventory/inventory.queries';
import { period, storeSql } from './operational.service';

/**
 * Detail reports: what each customer bought, one item's stock ledger and one customer's account ledger. Each has an
 * opening balance, the period's entries with a running balance, and a closing balance that agrees with the
 * stock and receivables sub-ledgers.
 */

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (d: { toFixed(n: number): string }) => d.toFixed(2);
const asDec = (v: { toString(): string } | null | undefined) => dec(v?.toString() ?? 0);

// ── Items bought per customer ─────────────────────────────────────────────

interface CustomerItemRaw {
  customer_id: string;
  customer: string;
  customer_code: string;
  variant_id: string;
  sku: string;
  product: string;
  qty_sold: Prisma.Decimal;
  qty_returned: Prisma.Decimal;
  net: Prisma.Decimal;
  total: Prisma.Decimal;
  last_at: Date | null;
}

/** Items sold to named customers (walk-in sales have none), less what they returned in the period. */
export async function customerItemsReport(q: { from?: string | undefined; to?: string | undefined; customerId?: string | undefined; stores: string[] | null }): Promise<CustomerItemsReport> {
  const p = period(q.from, q.to);
  const inStores = storeSql(Prisma.sql`s.location_id`, q.stores);
  const forCustomer = q.customerId ? Prisma.sql`AND s.customer_id = ${q.customerId}::uuid` : Prisma.sql`AND s.customer_id IS NOT NULL`;
  const raw = await getPrisma().$queryRaw<CustomerItemRaw[]>`
    WITH l AS (
      SELECT s.customer_id, si.variant_id, s.completed_at AS at, si.qty AS qty_sold, 0::numeric AS qty_returned,
             si.net_amount AS net, si.net_amount + si.tax_amount AS total
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'COMPLETED' AND s.completed_at >= ${p.startAt} AND s.completed_at < ${p.endAt} ${forCustomer} ${inStores}
      UNION ALL
      SELECT s.customer_id, si.variant_id, NULL, 0, ri.qty, -ri.net_amount, -(ri.net_amount + ri.tax_amount)
      FROM sale_return_items ri
      JOIN sale_returns r ON r.id = ri.return_id
      JOIN sale_items si ON si.id = ri.sale_item_id
      JOIN sales s ON s.id = r.sale_id
      WHERE r.status = 'COMPLETED' AND r.completed_at >= ${p.startAt} AND r.completed_at < ${p.endAt} ${forCustomer} ${inStores}
    )
    SELECT cu.id AS customer_id, cu.name AS customer, cu.code AS customer_code, v.id AS variant_id, v.sku,
           p.name || ' — ' || v.name AS product, SUM(l.qty_sold) AS qty_sold, SUM(l.qty_returned) AS qty_returned,
           SUM(l.net) AS net, SUM(l.total) AS total, MAX(l.at) AS last_at
    FROM l
    JOIN customers cu ON cu.id = l.customer_id
    JOIN product_variants v ON v.id = l.variant_id
    JOIN products p ON p.id = v.product_id
    GROUP BY cu.id, v.id, p.name
    ORDER BY cu.name, cu.id, SUM(l.net) DESC, 6`;

  const rows = raw.map((r) => ({
    customerId: r.customer_id,
    customer: r.customer,
    customerCode: r.customer_code,
    variantId: r.variant_id,
    sku: r.sku,
    product: r.product,
    qtySold: asDec(r.qty_sold),
    qtyReturned: asDec(r.qty_returned),
    net: asDec(r.net),
    total: asDec(r.total),
    lastBought: r.last_at ? isoDate(businessDate(r.last_at)) : null,
  }));
  const customers = [...new Map(rows.map((r) => [r.customerId, r])).values()].map((c) => {
    const mine = rows.filter((r) => r.customerId === c.customerId);
    return {
      customerId: c.customerId,
      customer: c.customer,
      customerCode: c.customerCode,
      qtySold: sum(mine.map((r) => r.qtySold.minus(r.qtyReturned))).toFixed(3),
      netSales: fmt(sum(mine.map((r) => r.net))),
      total: fmt(sum(mine.map((r) => r.total))),
    };
  });
  return {
    from: p.from,
    to: p.to,
    rows: rows.map((r) => ({ ...r, qtySold: r.qtySold.toFixed(3), qtyReturned: r.qtyReturned.toFixed(3), netSales: fmt(r.net), total: fmt(r.total) })),
    customers,
    totals: {
      qtySold: sum(rows.map((r) => r.qtySold)).toFixed(3),
      qtyReturned: sum(rows.map((r) => r.qtyReturned)).toFixed(3),
      netSales: fmt(sum(rows.map((r) => r.net))),
      total: fmt(sum(rows.map((r) => r.total))),
    },
  };
}

// ── Item ledger ───────────────────────────────────────────────────────────

/** Moving stock between stores does not change what the business holds, so the business-wide ledger leaves it out. */
const TRANSFERS = ['TRANSFER_OUT', 'TRANSFER_IN'] as const;

/**
 * Every stock movement of one item in the period with a running quantity: at one store, or business-wide
 * (stock in transit between stores still counts, as it does in the item's stock quantity).
 */
export async function itemLedger(q: { variantId: string; from?: string | undefined; to?: string | undefined; locationId?: string | undefined }): Promise<ItemLedger> {
  const prisma = getPrisma();
  const p = period(q.from, q.to);
  const [variant, location] = await Promise.all([
    prisma.productVariant.findUnique({ where: { id: q.variantId }, include: { product: { select: { name: true } } } }),
    q.locationId ? prisma.location.findUnique({ where: { id: q.locationId }, select: { id: true, name: true } }) : null,
  ]);
  if (!variant) throw notFound('Product');
  if (q.locationId && !location) throw notFound('Store');

  const scope: Prisma.StockMovementWhereInput = { variantId: variant.id, ...(location ? { locationId: location.id } : { type: { notIn: [...TRANSFERS] } }) };
  const [before, movements] = await Promise.all([
    prisma.stockMovement.aggregate({ where: { ...scope, createdAt: { lt: p.startAt } }, _sum: { qtyChange: true, totalCost: true } }),
    prisma.stockMovement.findMany({
      where: { ...scope, createdAt: { gte: p.startAt, lt: p.endAt } },
      include: { location: { select: { name: true } }, batch: { select: { lotNumber: true } }, createdBy: { select: { fullName: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const refs = await references(movements);
  const openingQty = asDec(before._sum.qtyChange);
  const openingValue = asDec(before._sum.totalCost);
  let qty = openingQty;
  const lines = movements.map((m) => {
    const change = asDec(m.qtyChange);
    qty = qty.plus(change);
    return {
      id: m.id,
      at: m.createdAt.toISOString(),
      type: m.type,
      location: m.location.name,
      lotNumber: m.batch?.lotNumber ?? null,
      qtyIn: (change.gt(0) ? change : ZERO).toFixed(3),
      qtyOut: (change.lt(0) ? change.negated() : ZERO).toFixed(3),
      balance: qty.toFixed(3),
      unitCost: m.unitCost.toFixed(4),
      value: m.totalCost.toFixed(2),
      sourceType: m.sourceType,
      sourceId: m.sourceId,
      reference: refs.get(m.sourceId) ?? null,
      by: m.createdBy.fullName,
    };
  });
  const moved = sum(movements.map((m) => asDec(m.totalCost)));
  return {
    from: p.from,
    to: p.to,
    item: { variantId: variant.id, sku: variant.sku, product: variant.product.name, variant: variant.name, avgCost: variant.avgCost.toFixed(4) },
    store: location,
    opening: { qty: openingQty.toFixed(3), value: fmt(openingValue) },
    lines,
    totals: { qtyIn: sum(lines.map((l) => l.qtyIn)).toFixed(3), qtyOut: sum(lines.map((l) => l.qtyOut)).toFixed(3), value: fmt(moved) },
    closing: { qty: qty.toFixed(3), value: fmt(openingValue.plus(moved)) },
  };
}

// ── Customer ledger ───────────────────────────────────────────────────────

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One customer's account: every sale (its value, less what was paid at the till), payments on account, and returns
 * (their value, less any refund paid out). The running balance is what the customer owes — the receivables
 * sub-ledger figure — so cash sales show but leave it unchanged.
 */
export async function customerLedger(q: { customerId: string; from?: string | undefined; to?: string | undefined }): Promise<CustomerLedger> {
  const prisma = getPrisma();
  const p = period(q.from, q.to);
  const customer = await prisma.customer.findUnique({ where: { id: q.customerId } });
  if (!customer) throw notFound('Customer');
  const fromDay = new Date(`${p.from}T00:00:00Z`);
  const toDay = new Date(`${p.to}T00:00:00Z`);
  const saleWhere = { customerId: customer.id, status: 'COMPLETED' } as const;
  const returnWhere = { status: 'COMPLETED', sale: { customerId: customer.id } } as const;

  const [salesBefore, receiptsBefore, returnsBefore, sales, receipts, returns] = await Promise.all([
    prisma.sale.aggregate({ where: { ...saleWhere, completedAt: { lt: p.startAt } }, _sum: { balanceDue: true } }),
    prisma.customerReceipt.aggregate({ where: { customerId: customer.id, receiptDate: { lt: fromDay } }, _sum: { amount: true } }),
    prisma.saleReturn.aggregate({ where: { ...returnWhere, completedAt: { lt: p.startAt } }, _sum: { creditedToAccount: true } }),
    prisma.sale.findMany({
      where: { ...saleWhere, completedAt: { gte: p.startAt, lt: p.endAt } },
      select: { id: true, number: true, channel: true, completedAt: true, total: true, balanceDue: true, location: { select: { name: true } }, _count: { select: { items: true } } },
    }),
    prisma.customerReceipt.findMany({
      where: { customerId: customer.id, receiptDate: { gte: fromDay, lte: toDay } },
      select: { id: true, number: true, receiptDate: true, createdAt: true, amount: true, reference: true, paymentMethod: { select: { name: true } } },
    }),
    prisma.saleReturn.findMany({
      where: { ...returnWhere, completedAt: { gte: p.startAt, lt: p.endAt } },
      select: { id: true, number: true, completedAt: true, total: true, paidOut: true, sale: { select: { number: true, location: { select: { name: true } } } } },
    }),
  ]);

  const opening = asDec(salesBefore._sum.balanceDue).minus(asDec(receiptsBefore._sum.amount)).minus(asDec(returnsBefore._sum.creditedToAccount));
  type Entry = Omit<CustomerLedgerLine, 'debit' | 'credit' | 'balance'> & { at: Date; debit: Decimal; credit: Decimal };
  const entries: Entry[] = [
    ...sales.map((s) => {
      const total = asDec(s.total);
      const due = asDec(s.balanceDue);
      const how = due.isZero() ? 'paid' : due.equals(total) ? 'on account' : 'part on account';
      return {
        at: s.completedAt!,
        date: isoDate(businessDate(s.completedAt!)),
        type: 'SALE' as const,
        id: s.id,
        number: s.number ?? '',
        location: s.location.name,
        description: `${s.channel === 'ONLINE' ? 'Online order' : 'Sale'}, ${plural(s._count.items, 'item')} — ${how}`,
        debit: total,
        credit: total.minus(due),
      };
    }),
    ...receipts.map((r) => ({
      at: r.createdAt,
      date: isoDate(r.receiptDate),
      type: 'RECEIPT' as const,
      id: r.id,
      number: r.number,
      location: null,
      description: `Payment, ${r.paymentMethod.name}${r.reference ? ` (${r.reference})` : ''}`,
      debit: ZERO,
      credit: asDec(r.amount),
    })),
    ...returns.map((r) => ({
      at: r.completedAt!,
      date: isoDate(businessDate(r.completedAt!)),
      type: 'RETURN' as const,
      id: r.id,
      number: r.number,
      location: r.sale.location.name,
      description: `Return from sale ${r.sale.number ?? ''}${r.paidOut.gt(0) ? ' — refunded' : ''}`,
      debit: asDec(r.paidOut),
      credit: asDec(r.total),
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.at.getTime() - b.at.getTime());

  let balance = opening;
  const lines: CustomerLedgerLine[] = entries.map(({ at: _at, ...e }) => {
    balance = balance.plus(e.debit).minus(e.credit);
    return { ...e, debit: fmt(e.debit), credit: fmt(e.credit), balance: fmt(balance) };
  });
  const of = (type: Entry['type'], side: 'debit' | 'credit') => fmt(sum(entries.filter((e) => e.type === type).map((e) => e[side])));
  return {
    from: p.from,
    to: p.to,
    customer: { id: customer.id, code: customer.code, name: customer.name, phone: customer.phone, creditLimit: fmt(customer.creditLimit), allowCredit: customer.allowCredit },
    openingBalance: fmt(opening),
    lines,
    totals: {
      purchases: of('SALE', 'debit'),
      payments: fmt(sum(entries.filter((e) => e.type !== 'RETURN').map((e) => e.credit))),
      returns: of('RETURN', 'credit'),
      refunds: of('RETURN', 'debit'),
    },
    closingBalance: fmt(balance),
  };
}
