import { Prisma } from '@prisma/client';
import { dec, ZERO, type AccountOption, type PayablesAgingRow, type StatementLine, type SupplierStatement } from '@rhoyards/shared';
import { getPrisma } from '../../lib/prisma';
import { isoDate, supplierOrThrow, toDate } from './common';

/**
 * What we owe a supplier = posted invoices − payments − posted return credits.
 * The sum over all suppliers equals the Accounts payable ledger balance (tested).
 */
const OWED_STATUSES = ['POSTED', 'PARTIALLY_PAID', 'PAID'] as const;

interface Item {
  date: Date;
  createdAt: Date;
  type: StatementLine['type'];
  id: string;
  number: string;
  reference: string | null;
  credit: Prisma.Decimal;
  debit: Prisma.Decimal;
}

async function supplierItems(supplierId: string, until?: Date): Promise<Item[]> {
  const prisma = getPrisma();
  const dateFilter = until ? { lte: until } : undefined;
  const [invoices, payments, returns] = await Promise.all([
    prisma.supplierInvoice.findMany({
      where: { supplierId, status: { in: [...OWED_STATUSES] }, ...(dateFilter ? { invoiceDate: dateFilter } : {}) },
      select: { id: true, number: true, supplierRef: true, invoiceDate: true, createdAt: true, total: true },
    }),
    prisma.supplierPayment.findMany({
      where: { supplierId, ...(dateFilter ? { paymentDate: dateFilter } : {}) },
      select: { id: true, number: true, reference: true, paymentDate: true, createdAt: true, amount: true },
    }),
    prisma.purchaseReturn.findMany({
      where: { supplierId, status: 'POSTED', creditTotal: { gt: 0 }, ...(dateFilter ? { returnDate: dateFilter } : {}) },
      select: { id: true, number: true, returnDate: true, createdAt: true, creditTotal: true },
    }),
  ]);
  const zero = new Prisma.Decimal(0);
  return [
    ...invoices.map((i) => ({ date: i.invoiceDate, createdAt: i.createdAt, type: 'INVOICE' as const, id: i.id, number: i.number, reference: i.supplierRef, credit: i.total, debit: zero })),
    ...payments.map((p) => ({ date: p.paymentDate, createdAt: p.createdAt, type: 'PAYMENT' as const, id: p.id, number: p.number, reference: p.reference, credit: zero, debit: p.amount })),
    ...returns.map((r) => ({ date: r.returnDate, createdAt: r.createdAt, type: 'RETURN' as const, id: r.id, number: r.number, reference: null, credit: zero, debit: r.creditTotal })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
}

export async function supplierStatement(supplierId: string, from?: string, to?: string): Promise<SupplierStatement> {
  const supplier = await supplierOrThrow(getPrisma(), supplierId);
  const items = await supplierItems(supplierId, to ? toDate(to) : undefined);
  const fromDate = from ? toDate(from) : null;
  let opening = ZERO;
  let balance = ZERO;
  const lines: StatementLine[] = [];
  for (const item of items) {
    const delta = dec(item.credit.toString()).minus(item.debit.toString());
    if (fromDate && item.date < fromDate) {
      opening = opening.plus(delta);
      balance = opening;
      continue;
    }
    balance = balance.plus(delta);
    lines.push({
      date: isoDate(item.date)!,
      type: item.type,
      id: item.id,
      number: item.number,
      reference: item.reference,
      credit: item.credit.toFixed(2),
      debit: item.debit.toFixed(2),
      balance: balance.toFixed(2),
    });
  }
  return {
    supplier: { id: supplier.id, name: supplier.name, code: supplier.code, paymentTermsDays: supplier.paymentTermsDays },
    from: from ?? null,
    to: to ?? null,
    openingBalance: opening.toFixed(2),
    lines,
    closingBalance: balance.toFixed(2),
  };
}

/** Outstanding invoices by days past due, per supplier, with unapplied credits netted off. */
export async function payablesAging(asOfIso?: string): Promise<{ asOf: string; rows: PayablesAgingRow[]; totals: Omit<PayablesAgingRow, 'supplier'> }> {
  const asOf = asOfIso ? toDate(asOfIso) : toDate(new Date().toISOString().slice(0, 10));
  const prisma = getPrisma();
  const [invoices, payments, returns] = await Promise.all([
    prisma.supplierInvoice.findMany({
      where: { status: { in: ['POSTED', 'PARTIALLY_PAID'] }, invoiceDate: { lte: asOf } },
      select: { supplierId: true, dueDate: true, total: true, amountPaid: true },
    }),
    prisma.supplierPayment.groupBy({ by: ['supplierId'], where: { paymentDate: { lte: asOf }, unallocated: { gt: 0 } }, _sum: { unallocated: true } }),
    prisma.purchaseReturn.groupBy({ by: ['supplierId'], where: { status: 'POSTED', returnDate: { lte: asOf } }, _sum: { creditTotal: true } }),
  ]);
  const ids = [...new Set([...invoices.map((i) => i.supplierId), ...payments.map((p) => p.supplierId), ...returns.map((r) => r.supplierId)])];
  const suppliers = new Map((await prisma.supplier.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, code: true } })).map((s) => [s.id, s]));

  type Buckets = { current: ReturnType<typeof dec>; d30: ReturnType<typeof dec>; d60: ReturnType<typeof dec>; d90: ReturnType<typeof dec>; over: ReturnType<typeof dec>; credits: ReturnType<typeof dec> };
  const empty = (): Buckets => ({ current: ZERO, d30: ZERO, d60: ZERO, d90: ZERO, over: ZERO, credits: ZERO });
  const bySupplier = new Map<string, Buckets>();
  const get = (id: string) => bySupplier.get(id) ?? (bySupplier.set(id, empty()), bySupplier.get(id)!);

  for (const i of invoices) {
    const b = get(i.supplierId);
    const open = dec(i.total.toString()).minus(i.amountPaid.toString());
    const days = Math.floor((asOf.getTime() - i.dueDate.getTime()) / 86_400_000);
    if (days <= 0) b.current = b.current.plus(open);
    else if (days <= 30) b.d30 = b.d30.plus(open);
    else if (days <= 60) b.d60 = b.d60.plus(open);
    else if (days <= 90) b.d90 = b.d90.plus(open);
    else b.over = b.over.plus(open);
  }
  for (const p of payments) get(p.supplierId).credits = get(p.supplierId).credits.plus(p._sum.unallocated?.toString() ?? 0);
  for (const r of returns) get(r.supplierId).credits = get(r.supplierId).credits.plus(r._sum.creditTotal?.toString() ?? 0);

  const fmt = (b: Buckets) => ({
    current: b.current.toFixed(2),
    days1to30: b.d30.toFixed(2),
    days31to60: b.d60.toFixed(2),
    days61to90: b.d90.toFixed(2),
    over90: b.over.toFixed(2),
    unappliedCredits: b.credits.toFixed(2),
    balance: b.current.plus(b.d30).plus(b.d60).plus(b.d90).plus(b.over).minus(b.credits).toFixed(2),
  });
  const rows = [...bySupplier.entries()]
    .map(([id, b]) => ({ supplier: suppliers.get(id)!, ...fmt(b) }))
    .filter((r) => r.balance !== '0.00' || r.unappliedCredits !== '0.00')
    .sort((a, b) => a.supplier.name.localeCompare(b.supplier.name));
  const total = [...bySupplier.values()].reduce(
    (t, b) => ({ current: t.current.plus(b.current), d30: t.d30.plus(b.d30), d60: t.d60.plus(b.d60), d90: t.d90.plus(b.d90), over: t.over.plus(b.over), credits: t.credits.plus(b.credits) }),
    empty(),
  );
  return { asOf: isoDate(asOf)!, rows, totals: fmt(total) };
}

/** Accounts offered on purchasing forms. */
export async function accountOptions(kind: 'payment' | 'expense'): Promise<AccountOption[]> {
  const where: Prisma.AccountWhereInput =
    kind === 'payment'
      ? { subtype: 'CASH', isActive: true, isPostable: true }
      : {
          isActive: true,
          isPostable: true,
          OR: [
            { type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' },
            { type: 'ASSET', subtype: 'CURRENT_ASSET', systemKey: null },
          ],
        };
  const rows = await getPrisma().account.findMany({ where, orderBy: { code: 'asc' } });
  return rows.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype }));
}
