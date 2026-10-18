import { Prisma, type SupplierInvoiceStatus } from '@prisma/client';
import type { z } from 'zod';
import {
  dec,
  roundMoney,
  sum,
  ZERO,
  type Decimal,
  type InvoiceInput,
  type OpenReceiptLine,
  type SupplierInvoiceDetail,
  type SupplierInvoiceSummary,
  type purchaseListQuerySchema,
} from '@rhoyards/shared';
import { postJournal, type JournalLineInput } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, businessRule, conflict, notFound } from '../../lib/errors';
import { pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import {
  assertActiveSupplier,
  invoiceable,
  iso,
  isoDate,
  lockDoc,
  lockGrnLines,
  money,
  pd,
  priceLine,
  qty,
  resolveTaxRates,
  toDate,
  variantRef,
  variantRefSelect,
} from './common';

const SOURCE = 'SUPPLIER_INVOICE';
/** Control accounts that must only be moved by their own documents, never by an invoice line. */
const RESTRICTED_KEYS = new Set(['AP', 'AR', 'GRNI', 'INVENTORY', 'VAT_INPUT', 'VAT_OUTPUT', 'CUSTOMER_DEPOSITS', 'OPENING_BALANCE_EQUITY', 'RETAINED_EARNINGS']);

const include = {
  supplier: { select: { id: true, name: true } },
  createdBy: { select: { fullName: true } },
  postedBy: { select: { fullName: true } },
  lines: {
    orderBy: { lineNo: 'asc' },
    include: {
      variant: { select: variantRefSelect },
      account: { select: { id: true, code: true, name: true } },
      grnLine: { select: { receipt: { select: { number: true } } } },
    },
  },
  allocations: { include: { payment: { select: { id: true, number: true, paymentDate: true } } } },
} satisfies Prisma.SupplierInvoiceInclude;
type Row = Prisma.SupplierInvoiceGetPayload<{ include: typeof include }>;

function summary(i: Omit<Row, 'lines' | 'allocations' | 'postedBy'>): SupplierInvoiceSummary {
  return {
    id: i.id,
    number: i.number,
    supplier: i.supplier,
    supplierRef: i.supplierRef,
    invoiceDate: isoDate(i.invoiceDate)!,
    dueDate: isoDate(i.dueDate)!,
    status: i.status,
    subtotal: i.subtotal.toFixed(2),
    taxTotal: i.taxTotal.toFixed(2),
    total: i.total.toFixed(2),
    amountPaid: i.amountPaid.toFixed(2),
    outstanding: i.status === 'DRAFT' || i.status === 'CANCELLED' ? '0.00' : i.total.minus(i.amountPaid).toFixed(2),
    createdBy: i.createdBy.fullName,
    createdAt: i.createdAt.toISOString(),
  };
}

function toDetail(i: Row): SupplierInvoiceDetail {
  return {
    ...summary(i),
    note: i.note,
    journalEntryId: i.journalEntryId,
    postedBy: i.postedBy?.fullName ?? null,
    postedAt: iso(i.postedAt),
    lines: i.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      grnLineId: l.grnLineId,
      receiptNumber: l.grnLine?.receipt.number ?? null,
      variant: l.variant ? variantRef(l.variant) : null,
      account: l.account,
      description: l.description,
      qty: l.qty.toFixed(3),
      unitCost: l.unitCost.toFixed(4),
      taxRateId: l.taxRateId,
      taxRate: l.taxRate.toFixed(4),
      netAmount: l.netAmount.toFixed(2),
      taxAmount: l.taxAmount.toFixed(2),
    })),
    payments: i.allocations.map((a) => ({
      paymentId: a.payment.id,
      number: a.payment.number,
      paymentDate: isoDate(a.payment.paymentDate)!,
      amount: a.amount.toFixed(2),
    })),
  };
}

export async function getSupplierInvoice(id: string, db: Db = getPrisma()) {
  const i = await db.supplierInvoice.findUnique({ where: { id }, include });
  if (!i) throw notFound('Supplier invoice');
  return toDetail(i);
}

export async function listSupplierInvoices(query: z.infer<typeof purchaseListQuerySchema> & { openOnly?: boolean }) {
  const where: Prisma.SupplierInvoiceWhereInput = {
    ...(query.supplierId ? { supplierId: query.supplierId } : {}),
    ...(query.status ? { status: query.status as SupplierInvoiceStatus } : {}),
    ...(query.openOnly ? { status: { in: ['POSTED', 'PARTIALLY_PAID'] } } : {}),
    ...(query.q
      ? {
          OR: [
            { number: { contains: query.q, mode: 'insensitive' } },
            { supplierRef: { contains: query.q, mode: 'insensitive' } },
            { supplier: { name: { contains: query.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
    ...(query.from || query.to ? { invoiceDate: { ...(query.from ? { gte: toDate(query.from) } : {}), ...(query.to ? { lte: toDate(query.to) } : {}) } } : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.supplierInvoice.findMany({
      where,
      include: { supplier: { select: { id: true, name: true } }, createdBy: { select: { fullName: true } } },
      orderBy: query.openOnly ? [{ dueDate: 'asc' }] : [{ createdAt: 'desc' }],
      ...pageArgs(query),
    }),
    prisma.supplierInvoice.count({ where }),
  ]);
  return { data: rows.map(summary), total };
}

/** Received goods from this supplier that are not yet fully invoiced. */
export async function openReceiptLines(supplierId: string): Promise<OpenReceiptLine[]> {
  const rows = await getPrisma().goodsReceiptLine.findMany({
    where: { receipt: { supplierId, status: 'POSTED' } },
    include: { receipt: { select: { id: true, number: true, receivedDate: true } }, variant: { select: variantRefSelect } },
    orderBy: [{ receipt: { receivedDate: 'asc' } }, { lineNo: 'asc' }],
  });
  return rows
    .filter((l) => invoiceable(l).gt(ZERO))
    .map((l) => ({
      grnLineId: l.id,
      receiptId: l.receipt.id,
      receiptNumber: l.receipt.number,
      receivedDate: isoDate(l.receipt.receivedDate)!,
      variant: variantRef(l.variant),
      qtyInvoiceable: invoiceable(l).toFixed(3),
      unitCost: l.unitCost.toFixed(4),
      taxRateId: l.taxRateId,
      taxRate: l.taxRate.toFixed(4),
    }));
}

async function buildLines(db: Db, input: InvoiceInput) {
  const supplier = await assertActiveSupplier(db, input.supplierId);
  const grnIds = input.lines.flatMap((l) => (l.grnLineId ? [l.grnLineId] : []));
  const grnLines = new Map(
    (
      await db.goodsReceiptLine.findMany({
        where: { id: { in: grnIds } },
        include: { receipt: { select: { supplierId: true, status: true } }, variant: { select: { name: true, product: { select: { name: true } } } } },
      })
    ).map((l) => [l.id, l]),
  );
  const accountIds = input.lines.flatMap((l) => (l.accountId ? [l.accountId] : []));
  const accounts = new Map((await db.account.findMany({ where: { id: { in: accountIds } } })).map((a) => [a.id, a]));

  const taxes = await resolveTaxRates(
    db,
    input.lines.map((l) => l.taxRateId),
    input.lines.map((l) => (l.grnLineId ? (grnLines.get(l.grnLineId)?.taxRateId ?? null) : null)),
  );

  const lines = input.lines.map((l, i) => {
    const n = i + 1;
    let description = l.description ?? '';
    let variantId: string | null = null;
    if (l.grnLineId) {
      const g = grnLines.get(l.grnLineId);
      if (!g || g.receipt.supplierId !== input.supplierId || g.receipt.status !== 'POSTED') {
        throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: choose goods received from this supplier`, { line: n, field: 'grnLineId' });
      }
      const open = invoiceable(g);
      if (dec(l.qty).gt(open)) {
        throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: only ${open.toFixed(3)} is still to be invoiced`, { line: n, field: 'qty' });
      }
      variantId = g.variantId;
      description ||= `${g.variant.product.name} — ${g.variant.name}`;
    } else {
      const a = accounts.get(l.accountId!);
      if (!a || !a.isActive || !a.isPostable || !['EXPENSE', 'ASSET'].includes(a.type) || (a.systemKey && RESTRICTED_KEYS.has(a.systemKey)) || a.subtype === 'CASH') {
        throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: choose an expense or prepayment account`, { line: n, field: 'accountId' });
      }
      if (!description) throw new AppError(400, 'VALIDATION_ERROR', `Line ${n}: describe what was charged`, { line: n, field: 'description' });
    }
    const { net, tax } = priceLine(l.qty, l.unitCost, taxes[i]!.rate);
    return {
      row: {
        lineNo: n,
        grnLineId: l.grnLineId ?? null,
        variantId,
        accountId: l.accountId ?? null,
        description,
        qty: qty(l.qty),
        unitCost: pd(l.unitCost),
        taxRateId: taxes[i]!.taxRateId,
        taxRate: new Prisma.Decimal(taxes[i]!.rate.toFixed(4)),
        netAmount: money(net),
        taxAmount: money(tax),
      },
      net,
      tax,
    };
  });
  const subtotal = sum(lines.map((l) => l.net));
  const taxTotal = sum(lines.map((l) => l.tax));
  const invoiceDate = toDate(input.invoiceDate);
  const dueDate = input.dueDate ? toDate(input.dueDate) : new Date(invoiceDate.getTime() + supplier.paymentTermsDays * 86_400_000);
  if (dueDate < invoiceDate) throw new AppError(400, 'VALIDATION_ERROR', 'Due date cannot be before the invoice date', { field: 'dueDate' });
  return { rows: lines.map((l) => l.row), subtotal, taxTotal, total: subtotal.plus(taxTotal), invoiceDate, dueDate };
}

async function assertRefFree(db: Db, supplierId: string, supplierRef: string, exceptId?: string) {
  const clash = await db.supplierInvoice.findFirst({
    where: { supplierId, supplierRef: { equals: supplierRef, mode: 'insensitive' }, status: { not: 'CANCELLED' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
  if (clash) throw conflict(`Invoice ${supplierRef} from this supplier is already recorded as ${clash.number}`, { field: 'supplierRef' });
}

export async function createSupplierInvoice(input: InvoiceInput, ctx: RequestContext) {
  return transaction(async (tx) => {
    await assertRefFree(tx, input.supplierId, input.supplierRef);
    const built = await buildLines(tx, input);
    const number = await nextDocumentNumber(tx, 'SUPPLIER_INVOICE', 'SINV-');
    const inv = await tx.supplierInvoice.create({
      data: {
        number,
        supplierId: input.supplierId,
        supplierRef: input.supplierRef,
        invoiceDate: built.invoiceDate,
        dueDate: built.dueDate,
        note: input.note ?? null,
        subtotal: money(built.subtotal),
        taxTotal: money(built.taxTotal),
        total: money(built.total),
        createdById: ctx.actorId!,
        lines: { create: built.rows },
      },
    });
    const detail = await getSupplierInvoice(inv.id, tx);
    await writeAudit(tx, ctx, { action: 'supplier_invoice.created', entityType: 'supplier_invoice', entityId: inv.id, after: detail });
    return detail;
  });
}

export async function updateSupplierInvoice(id: string, input: InvoiceInput, ctx: RequestContext) {
  return transaction(async (tx) => {
    if ((await lockDoc(tx, 'supplier_invoices', id)) !== 'DRAFT') throw businessRule('Only draft invoices can be edited');
    await assertRefFree(tx, input.supplierId, input.supplierRef, id);
    const before = await getSupplierInvoice(id, tx);
    const built = await buildLines(tx, input);
    await tx.supplierInvoiceLine.deleteMany({ where: { invoiceId: id } });
    await tx.supplierInvoice.update({
      where: { id },
      data: {
        supplierId: input.supplierId,
        supplierRef: input.supplierRef,
        invoiceDate: built.invoiceDate,
        dueDate: built.dueDate,
        note: input.note ?? null,
        subtotal: money(built.subtotal),
        taxTotal: money(built.taxTotal),
        total: money(built.total),
        lines: { create: built.rows },
      },
    });
    const after = await getSupplierInvoice(id, tx);
    await writeAudit(tx, ctx, { action: 'supplier_invoice.updated', entityType: 'supplier_invoice', entityId: id, before, after });
    return after;
  });
}

/**
 * Posts the invoice (three-way match against goods received):
 *   Dr GRNI (received value of the matched quantity), ± Purchase price variance (invoice vs receipt price),
 *   Dr expense/prepayment lines, Dr VAT input / Cr Accounts payable (invoice total).
 * Matched quantities are recorded on the receipt lines under row locks, so goods cannot be invoiced twice.
 */
export async function postSupplierInvoice(id: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    if ((await lockDoc(tx, 'supplier_invoices', id)) !== 'DRAFT') throw businessRule('Only draft invoices can be posted');
    const inv = await tx.supplierInvoice.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    await assertActiveSupplier(tx, inv.supplierId);

    const grnLineIds = inv.lines.flatMap((l) => (l.grnLineId ? [l.grnLineId] : []));
    await lockGrnLines(tx, grnLineIds);
    const grnLines = new Map((await tx.goodsReceiptLine.findMany({ where: { id: { in: grnLineIds } } })).map((l) => [l.id, l]));

    let grniCleared = ZERO;
    let variance = ZERO;
    const expenseByAccount = new Map<string, Decimal>();
    for (const line of inv.lines) {
      const net = dec(line.netAmount.toString());
      if (!line.grnLineId) {
        expenseByAccount.set(line.accountId!, (expenseByAccount.get(line.accountId!) ?? ZERO).plus(net));
        continue;
      }
      const g = grnLines.get(line.grnLineId)!;
      const q = dec(line.qty.toString());
      const open = invoiceable(g);
      if (q.gt(open)) throw conflict(`Line ${line.lineNo}: only ${open.toFixed(3)} of these goods is still to be invoiced`, { line: line.lineNo });
      // The invoice that completes the line clears exactly the GRNI still outstanding (no rounding residue).
      const completes = q.equals(open);
      const cleared = completes
        ? dec(g.value.toString()).minus(g.grniCleared.toString())
        : roundMoney(q.times(g.unitCost.toString()));
      grniCleared = grniCleared.plus(cleared);
      variance = variance.plus(net.minus(cleared));
      await tx.goodsReceiptLine.update({
        where: { id: g.id },
        data: {
          qtyInvoiced: { increment: qty(q) },
          invoicedValue: { increment: money(net) },
          grniCleared: { increment: money(cleared) },
        },
      });
      // Keep the in-memory row current in case the same receipt line appears twice on the invoice.
      g.qtyInvoiced = g.qtyInvoiced.plus(q.toFixed(3));
      g.grniCleared = g.grniCleared.plus(cleared.toFixed(2));
    }
    const taxTotal = dec(inv.taxTotal.toString());
    const total = dec(inv.total.toString());

    const lines: JournalLineInput[] = [];
    if (grniCleared.gt(ZERO)) lines.push({ accountKey: 'GRNI', debit: grniCleared });
    if (variance.gt(ZERO)) lines.push({ accountKey: 'PURCHASE_PRICE_VARIANCE', debit: variance, memo: 'Invoice above receipt price' });
    if (variance.lt(ZERO)) lines.push({ accountKey: 'PURCHASE_PRICE_VARIANCE', credit: variance.abs(), memo: 'Invoice below receipt price' });
    for (const [accountId, amount] of expenseByAccount) if (amount.gt(ZERO)) lines.push({ accountId, debit: amount });
    if (taxTotal.gt(ZERO)) lines.push({ accountKey: 'VAT_INPUT', debit: taxTotal });
    if (total.gt(ZERO)) lines.push({ accountKey: 'AP', credit: total, memo: `Invoice ${inv.supplierRef}` });

    const journal =
      lines.length >= 2
        ? await postJournal(tx, {
            entryDate: inv.invoiceDate,
            sourceType: SOURCE,
            sourceId: inv.id,
            postingKey: `${SOURCE}:${inv.id}`,
            description: `Supplier invoice ${inv.supplierRef} (${inv.number})`,
            lines,
            actorId: ctx.actorId!,
          })
        : null;

    await tx.supplierInvoice.update({
      where: { id },
      data: { status: total.isZero() ? 'PAID' : 'POSTED', journalEntryId: journal?.id ?? null, postedById: ctx.actorId, postedAt: new Date() },
    });
    await writeAudit(tx, ctx, {
      action: 'supplier_invoice.posted',
      entityType: 'supplier_invoice',
      entityId: id,
      after: { number: inv.number, total: total.toFixed(2), variance: variance.toFixed(2) },
    });
    return getSupplierInvoice(id, tx);
  });
}

export async function cancelSupplierInvoice(id: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    if ((await lockDoc(tx, 'supplier_invoices', id)) !== 'DRAFT') throw businessRule('Only draft invoices can be cancelled');
    await tx.supplierInvoice.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: ctx.actorId, cancelledAt: new Date() } });
    await writeAudit(tx, ctx, { action: 'supplier_invoice.cancelled', entityType: 'supplier_invoice', entityId: id });
    return getSupplierInvoice(id, tx);
  });
}
