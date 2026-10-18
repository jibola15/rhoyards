import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { dec, sum, type PaymentInput, type SupplierPaymentDetail, type SupplierPaymentSummary, type purchaseListQuerySchema } from '@rhoyards/shared';
import { postJournal } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, notFound } from '../../lib/errors';
import { pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import { isoDate, money, supplierOrThrow, toDate } from './common';

const SOURCE = 'SUPPLIER_PAYMENT';

const include = {
  supplier: { select: { id: true, name: true } },
  account: { select: { id: true, code: true, name: true } },
  createdBy: { select: { fullName: true } },
  allocations: { include: { invoice: { select: { id: true, number: true, supplierRef: true } } } },
} satisfies Prisma.SupplierPaymentInclude;
type Row = Prisma.SupplierPaymentGetPayload<{ include: typeof include }>;

const summary = (p: Omit<Row, 'allocations'>): SupplierPaymentSummary => ({
  id: p.id,
  number: p.number,
  supplier: p.supplier,
  paymentDate: isoDate(p.paymentDate)!,
  amount: p.amount.toFixed(2),
  unallocated: p.unallocated.toFixed(2),
  account: p.account,
  reference: p.reference,
  createdBy: p.createdBy.fullName,
  createdAt: p.createdAt.toISOString(),
});

const toDetail = (p: Row): SupplierPaymentDetail => ({
  ...summary(p),
  note: p.note,
  journalEntryId: p.journalEntryId,
  allocations: p.allocations.map((a) => ({ invoiceId: a.invoice.id, number: a.invoice.number, supplierRef: a.invoice.supplierRef, amount: a.amount.toFixed(2) })),
});

export async function getSupplierPayment(id: string, db: Db = getPrisma()) {
  const p = await db.supplierPayment.findUnique({ where: { id }, include });
  if (!p) throw notFound('Supplier payment');
  return toDetail(p);
}

export async function listSupplierPayments(query: z.infer<typeof purchaseListQuerySchema>) {
  const where: Prisma.SupplierPaymentWhereInput = {
    ...(query.supplierId ? { supplierId: query.supplierId } : {}),
    ...(query.q
      ? {
          OR: [
            { number: { contains: query.q, mode: 'insensitive' } },
            { reference: { contains: query.q, mode: 'insensitive' } },
            { supplier: { name: { contains: query.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
    ...(query.from || query.to ? { paymentDate: { ...(query.from ? { gte: toDate(query.from) } : {}), ...(query.to ? { lte: toDate(query.to) } : {}) } } : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.supplierPayment.findMany({
      where,
      include: { supplier: { select: { id: true, name: true } }, account: { select: { id: true, code: true, name: true } }, createdBy: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(query),
    }),
    prisma.supplierPayment.count({ where }),
  ]);
  return { data: rows.map(summary), total };
}

/** Cash and bank accounts that payments can be made from or received into. */
export async function assertPaymentAccount(db: Db, accountId: string) {
  const a = await db.account.findUnique({ where: { id: accountId } });
  if (!a || a.subtype !== 'CASH' || !a.isPostable || !a.isActive) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Choose an active cash or bank account', { field: 'accountId' });
  }
  return a;
}

/**
 * Records a payment to a supplier, posts Dr Accounts payable / Cr Cash or Bank, and applies it to
 * the chosen invoices. Invoices are row-locked so an invoice can never be paid beyond its total.
 * Any amount not allocated stays as a credit with the supplier.
 */
export async function createSupplierPayment(input: PaymentInput, ctx: RequestContext): Promise<SupplierPaymentDetail> {
  return transaction(async (tx) => {
    await supplierOrThrow(tx, input.supplierId);
    const account = await assertPaymentAccount(tx, input.accountId);
    const amount = dec(input.amount);
    const allocated = sum(input.allocations.map((a) => a.amount));
    if (allocated.gt(amount)) {
      throw new AppError(400, 'VALIDATION_ERROR', `Allocations (${allocated.toFixed(2)}) exceed the payment amount`, { field: 'allocations' });
    }

    const invoiceIds = input.allocations.map((a) => a.invoiceId).sort();
    if (invoiceIds.length > 0) {
      await tx.$queryRaw`SELECT "id" FROM "supplier_invoices" WHERE "id" = ANY(${invoiceIds}::uuid[]) ORDER BY "id" FOR UPDATE`;
    }
    const invoices = new Map((await tx.supplierInvoice.findMany({ where: { id: { in: invoiceIds } } })).map((i) => [i.id, i]));
    for (const a of input.allocations) {
      const inv = invoices.get(a.invoiceId);
      if (!inv || inv.supplierId !== input.supplierId) {
        throw new AppError(400, 'VALIDATION_ERROR', 'An allocated invoice does not belong to this supplier', { field: 'allocations' });
      }
      if (inv.status !== 'POSTED' && inv.status !== 'PARTIALLY_PAID') {
        throw new AppError(422, 'BUSINESS_RULE', `Invoice ${inv.number} is ${inv.status.toLowerCase().replace('_', ' ')}`, { invoiceId: inv.id });
      }
      const outstanding = dec(inv.total.toString()).minus(inv.amountPaid.toString());
      if (dec(a.amount).gt(outstanding)) {
        throw new AppError(422, 'BUSINESS_RULE', `Invoice ${inv.number} has only ${outstanding.toFixed(2)} outstanding`, {
          invoiceId: inv.id,
          outstanding: outstanding.toFixed(2),
        });
      }
    }

    const id = randomUUID();
    const number = await nextDocumentNumber(tx, 'SUPPLIER_PAYMENT', 'SPAY-');
    const paymentDate = toDate(input.paymentDate);
    const journal = await postJournal(tx, {
      entryDate: paymentDate,
      sourceType: SOURCE,
      sourceId: id,
      postingKey: `${SOURCE}:${id}`,
      description: `Payment ${number} to supplier${input.reference ? ` (ref ${input.reference})` : ''}`,
      lines: [
        { accountKey: 'AP', debit: amount },
        { accountId: account.id, credit: amount },
      ],
      actorId: ctx.actorId!,
    });

    await tx.supplierPayment.create({
      data: {
        id,
        number,
        supplierId: input.supplierId,
        paymentDate,
        amount: money(amount),
        unallocated: money(amount.minus(allocated)),
        accountId: account.id,
        reference: input.reference ?? null,
        note: input.note ?? null,
        journalEntryId: journal.id,
        createdById: ctx.actorId!,
        allocations: { create: input.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: new Prisma.Decimal(a.amount) })) },
      },
    });
    for (const a of input.allocations) {
      const inv = invoices.get(a.invoiceId)!;
      const paid = dec(inv.amountPaid.toString()).plus(a.amount);
      await tx.supplierInvoice.update({
        where: { id: inv.id },
        data: { amountPaid: money(paid), status: paid.gte(inv.total.toString()) ? 'PAID' : 'PARTIALLY_PAID' },
      });
    }
    const detail = await getSupplierPayment(id, tx);
    await writeAudit(tx, ctx, { action: 'supplier_payment.created', entityType: 'supplier_payment', entityId: id, after: detail });
    return detail;
  });
}
