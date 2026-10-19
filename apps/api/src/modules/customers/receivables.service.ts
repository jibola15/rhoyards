import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  dec,
  sum,
  ZERO,
  type CustomerReceiptDetail,
  type CustomerReceiptInput,
  type CustomerStatement,
  type Decimal,
  type OpenCreditSale,
} from '@rhoyards/shared';
import { postJournal } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, businessRule, notFound } from '../../lib/errors';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';

/**
 * Accounts receivable sub-ledger. A credit sale leaves `balance_due` on the customer; customer receipts and returns
 * settle it (`sales.amount_settled`, the only field of a completed sale that may change). Money received but not
 * applied stays as a credit on the receipt (`unallocated`).
 *
 *   customer balance = Σ (balance_due − amount_settled) − Σ unallocated receipts
 *
 * Σ over customers = the AR ledger balance (tested).
 */

const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const outstanding = (s: { balanceDue: Prisma.Decimal; amountSettled: Prisma.Decimal }) => dec(s.balanceDue.toString()).minus(s.amountSettled.toString());

export async function customerBalances(db: Db, ids: string[]): Promise<Map<string, Decimal>> {
  if (ids.length === 0) return new Map();
  const [owed, credits] = await Promise.all([
    db.$queryRaw<{ customer_id: string; owed: Prisma.Decimal }[]>`
      SELECT customer_id, SUM(balance_due - amount_settled) AS owed FROM sales
      WHERE customer_id = ANY(${ids}::uuid[]) AND status = 'COMPLETED' AND balance_due > amount_settled
      GROUP BY customer_id`,
    db.customerReceipt.groupBy({ by: ['customerId'], where: { customerId: { in: ids }, unallocated: { gt: 0 } }, _sum: { unallocated: true } }),
  ]);
  const result = new Map<string, Decimal>();
  for (const r of owed) result.set(r.customer_id, dec(r.owed.toString()));
  for (const c of credits) result.set(c.customerId, (result.get(c.customerId) ?? ZERO).minus(c._sum.unallocated?.toString() ?? 0));
  return result;
}

export async function openCreditSales(db: Db, customerId: string): Promise<OpenCreditSale[]> {
  const rows = await db.$queryRaw<{ id: string; number: string; completed_at: Date; total: Prisma.Decimal; outstanding: Prisma.Decimal }[]>`
    SELECT id, number, completed_at, total, balance_due - amount_settled AS outstanding FROM sales
    WHERE customer_id = ${customerId}::uuid AND status = 'COMPLETED' AND balance_due > amount_settled
    ORDER BY completed_at, number`;
  return rows.map((r) => ({ id: r.id, number: r.number, date: isoDate(r.completed_at), total: r.total.toFixed(2), outstanding: r.outstanding.toFixed(2) }));
}

/** Locks the sales and settles part of what is owed on each (oldest first is the caller's choice). */
export async function settleSales(tx: Prisma.TransactionClient, settlements: { saleId: string; amount: Decimal }[]) {
  const ids = [...new Set(settlements.map((s) => s.saleId))].sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM sales WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
  for (const s of settlements) {
    const sale = await tx.sale.findUniqueOrThrow({ where: { id: s.saleId } });
    if (s.amount.gt(outstanding(sale))) {
      throw businessRule(`Sale ${sale.number} has only ${outstanding(sale).toFixed(2)} outstanding`, { saleId: sale.id });
    }
    await tx.sale.update({ where: { id: s.saleId }, data: { amountSettled: { increment: new Prisma.Decimal(s.amount.toFixed(2)) } } });
  }
}

const receiptInclude = {
  customer: { select: { id: true, name: true } },
  paymentMethod: { select: { id: true, name: true } },
  createdBy: { select: { fullName: true } },
  allocations: { include: { sale: { select: { number: true } } } },
} satisfies Prisma.CustomerReceiptInclude;

function toReceipt(r: Prisma.CustomerReceiptGetPayload<{ include: typeof receiptInclude }>): CustomerReceiptDetail {
  return {
    id: r.id,
    number: r.number,
    customer: r.customer,
    receiptDate: isoDate(r.receiptDate),
    method: r.paymentMethod,
    amount: r.amount.toFixed(2),
    unallocated: r.unallocated.toFixed(2),
    reference: r.reference,
    note: r.note,
    allocations: r.allocations.map((a) => ({ saleId: a.saleId, number: a.sale.number ?? '', amount: a.amount.toFixed(2) })),
    createdBy: r.createdBy.fullName,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function getCustomerReceipt(id: string, db: Db = getPrisma()) {
  const r = await db.customerReceipt.findUnique({ where: { id }, include: receiptInclude });
  if (!r) throw notFound('Receipt');
  return toReceipt(r);
}

/** Records money received from a customer: Dr payment account, Cr AR; applied to the chosen sales, the rest kept as credit. */
export async function createCustomerReceipt(input: CustomerReceiptInput, actorId: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw notFound('Customer');
    const method = await tx.paymentMethod.findUnique({ where: { id: input.paymentMethodId } });
    if (!method?.isActive) throw new AppError(400, 'VALIDATION_ERROR', 'Choose an active payment method', { field: 'paymentMethodId' });
    if (method.requiresReference && !input.reference) throw new AppError(400, 'VALIDATION_ERROR', `Enter the ${method.name} reference`, { field: 'reference' });

    const amount = dec(input.amount);
    const allocations = input.allocations.map((a) => ({ saleId: a.saleId, amount: dec(a.amount) }));
    const allocated = sum(allocations.map((a) => a.amount));
    if (allocated.gt(amount)) throw new AppError(400, 'VALIDATION_ERROR', 'Allocations add up to more than the amount received', { field: 'amount' });
    const sales = await tx.sale.findMany({ where: { id: { in: allocations.map((a) => a.saleId) } }, select: { id: true, customerId: true } });
    if (sales.length !== new Set(allocations.map((a) => a.saleId)).size || sales.some((s) => s.customerId !== customer.id)) {
      throw new AppError(400, 'VALIDATION_ERROR', "Payments can only be applied to this customer's own sales", { field: 'allocations' });
    }
    await settleSales(tx, allocations);

    const number = await nextDocumentNumber(tx, 'CUSTOMER_RECEIPT', 'RCP-');
    const id = randomUUID();
    const journal = await postJournal(tx, {
      entryDate: toDate(input.receiptDate),
      sourceType: 'CUSTOMER_RECEIPT',
      sourceId: id,
      postingKey: `CUSTOMER_RECEIPT:${id}`,
      description: `Payment ${number} from ${customer.name}`,
      lines: [
        { accountId: method.accountId, debit: amount },
        { accountKey: 'AR', credit: amount, memo: customer.name },
      ],
      actorId,
    });
    await tx.customerReceipt.create({
      data: {
        id,
        number,
        customerId: customer.id,
        receiptDate: toDate(input.receiptDate),
        paymentMethodId: method.id,
        amount: new Prisma.Decimal(amount.toFixed(2)),
        unallocated: new Prisma.Decimal(amount.minus(allocated).toFixed(2)),
        reference: input.reference ?? null,
        note: input.note ?? null,
        journalEntryId: journal.id,
        createdById: actorId,
        allocations: { create: allocations.map((a) => ({ saleId: a.saleId, amount: new Prisma.Decimal(a.amount.toFixed(2)) })) },
      },
    });
    const receipt = await getCustomerReceipt(id, tx);
    await writeAudit(tx, ctx, { action: 'customer_receipt.created', entityType: 'customer_receipt', entityId: id, after: receipt });
    return receipt;
  });
}

/** Sales on credit, receipts and return credits, with a running balance. */
export async function customerStatement(customerId: string): Promise<CustomerStatement> {
  const prisma = getPrisma();
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw notFound('Customer');
  const [sales, receipts, returns, openSales] = await Promise.all([
    prisma.sale.findMany({ where: { customerId, status: 'COMPLETED', balanceDue: { gt: 0 } }, select: { id: true, number: true, completedAt: true, balanceDue: true } }),
    prisma.customerReceipt.findMany({ where: { customerId }, select: { id: true, number: true, receiptDate: true, createdAt: true, amount: true } }),
    prisma.saleReturn.findMany({ where: { status: 'COMPLETED', creditedToAccount: { gt: 0 }, sale: { customerId } }, select: { id: true, number: true, completedAt: true, creditedToAccount: true } }),
    openCreditSales(prisma, customerId),
  ]);
  const items = [
    ...sales.map((s) => ({ at: s.completedAt!, type: 'SALE' as const, id: s.id, number: s.number!, debit: dec(s.balanceDue.toString()), credit: ZERO })),
    ...receipts.map((r) => ({ at: r.createdAt, date: r.receiptDate, type: 'RECEIPT' as const, id: r.id, number: r.number, debit: ZERO, credit: dec(r.amount.toString()) })),
    ...returns.map((r) => ({ at: r.completedAt!, type: 'RETURN' as const, id: r.id, number: r.number, debit: ZERO, credit: dec(r.creditedToAccount.toString()) })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  let balance = ZERO;
  const lines = items.map((i) => {
    balance = balance.plus(i.debit).minus(i.credit);
    return { date: isoDate('date' in i && i.date ? i.date : i.at), type: i.type, id: i.id, number: i.number, debit: i.debit.toFixed(2), credit: i.credit.toFixed(2), balance: balance.toFixed(2) };
  });
  const credit = await prisma.customerReceipt.aggregate({ where: { customerId }, _sum: { unallocated: true } });
  return {
    customer: { id: customer.id, code: customer.code, name: customer.name, creditLimit: customer.creditLimit.toFixed(2), allowCredit: customer.allowCredit },
    lines,
    balance: balance.toFixed(2),
    openSales,
    unappliedCredit: (credit._sum.unallocated ?? new Prisma.Decimal(0)).toFixed(2),
  };
}
