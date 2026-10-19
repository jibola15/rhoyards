import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import {
  dec,
  roundMoney,
  ZERO,
  type ExpenseCategoryRow,
  type ExpenseDetail,
  type ExpenseInput,
  type ExpenseSummary,
  type expenseCategorySchema,
  type expenseListQuerySchema,
} from '@rhoyards/shared';
import { postJournal } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, businessRule, conflict, forbidden, notFound } from '../../lib/errors';
import { pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import type { AuthContext } from '../auth/auth.types';
import { fileUrl } from '../files/files.service';

/**
 * Paid expenses (rent, utilities, transport…): draft → submitted → posted by an approver. Posting books
 * Dr expense account (+ Dr VAT input when a VAT invoice was received) / Cr the cash or bank account paid from.
 * Bills to be paid later are entered as supplier invoices instead, so they appear on the supplier's account.
 */

type Tx = Prisma.TransactionClient;
const SOURCE = 'EXPENSE';
const invalid = (message: string, field: string) => new AppError(400, 'VALIDATION_ERROR', message, { field });
const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const ref = { select: { id: true, code: true, name: true } } as const;

// ── Categories ───────────────────────────────────────────────────────────

const toCategory = (c: Prisma.ExpenseCategoryGetPayload<{ include: { account: typeof ref } }>): ExpenseCategoryRow => ({
  id: c.id,
  name: c.name,
  account: c.account,
  isActive: c.isActive,
});

export async function listExpenseCategories(): Promise<ExpenseCategoryRow[]> {
  const rows = await getPrisma().expenseCategory.findMany({ include: { account: ref }, orderBy: { name: 'asc' } });
  return rows.map(toCategory);
}

async function assertExpenseAccount(db: Db, accountId: string) {
  const a = await db.account.findUnique({ where: { id: accountId } });
  if (!a || a.type !== 'EXPENSE' || !a.isActive || !a.isPostable) throw invalid('Choose an active expense account', 'accountId');
}

export async function saveExpenseCategory(id: string | null, input: z.infer<typeof expenseCategorySchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    await assertExpenseAccount(tx, input.accountId);
    const data = { name: input.name, accountId: input.accountId, isActive: input.isActive };
    const c = await (id ? tx.expenseCategory.update({ where: { id }, data, include: { account: ref } }) : tx.expenseCategory.create({ data, include: { account: ref } })).catch((e: unknown) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('A category with this name already exists', { field: 'name' });
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw notFound('Category');
      throw e;
    });
    await writeAudit(tx, ctx, { action: id ? 'expense_category.updated' : 'expense_category.created', entityType: 'expense_category', entityId: c.id, after: toCategory(c) });
    return toCategory(c);
  });
}

// ── Expenses ─────────────────────────────────────────────────────────────

const include = {
  category: { select: { id: true, name: true } },
  account: ref,
  paymentAccount: ref,
  taxRate: { select: { id: true, name: true, rate: true } },
  createdBy: { select: { fullName: true } },
  approvedBy: { select: { fullName: true } },
  attachments: { include: { file: { select: { id: true, originalName: true, mimeType: true } } } },
} satisfies Prisma.ExpenseInclude;
type Row = Prisma.ExpenseGetPayload<{ include: typeof include }>;

function toSummary(e: Pick<Row, 'id' | 'number' | 'expenseDate' | 'category' | 'payee' | 'description' | 'total' | 'status' | 'createdBy'>): ExpenseSummary {
  return {
    id: e.id,
    number: e.number,
    expenseDate: isoDate(e.expenseDate),
    category: e.category.name,
    payee: e.payee,
    description: e.description,
    total: e.total.toFixed(2),
    status: e.status,
    createdBy: e.createdBy.fullName,
  };
}

function toDetail(e: Row): ExpenseDetail {
  return {
    ...toSummary(e),
    createdById: e.createdById,
    categoryId: e.categoryId,
    account: e.account,
    paymentAccount: e.paymentAccount,
    taxRate: e.taxRate ? { id: e.taxRate.id, name: e.taxRate.name, rate: e.taxRate.rate.toFixed(4) } : null,
    net: e.netAmount.toFixed(2),
    tax: e.taxAmount.toFixed(2),
    reference: e.reference,
    rejectedReason: e.rejectedReason,
    submittedAt: e.submittedAt?.toISOString() ?? null,
    approvedBy: e.approvedBy?.fullName ?? null,
    postedAt: e.postedAt?.toISOString() ?? null,
    journalEntryId: e.journalEntryId,
    attachments: e.attachments.map((a) => ({ id: a.file.id, url: fileUrl(a.file.id), name: a.file.originalName, mimeType: a.file.mimeType })),
  };
}

export async function getExpense(id: string, db: Db = getPrisma()) {
  const e = await db.expense.findUnique({ where: { id }, include });
  if (!e) throw notFound('Expense');
  return toDetail(e);
}

export async function listExpenses(query: z.infer<typeof expenseListQuerySchema>) {
  const where: Prisma.ExpenseWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.from || query.to ? { expenseDate: { ...(query.from ? { gte: toDate(query.from) } : {}), ...(query.to ? { lte: toDate(query.to) } : {}) } } : {}),
    ...(query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { payee: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }] } : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.expense.findMany({ where, include: { category: include.category, createdBy: include.createdBy }, orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }], ...pageArgs(query) }),
    prisma.expense.count({ where }),
  ]);
  return { data: rows.map(toSummary), total };
}

/** Validates the references and splits the amount paid into net and recoverable VAT. */
async function resolve(db: Db, input: ExpenseInput) {
  const category = await db.expenseCategory.findUnique({ where: { id: input.categoryId } });
  if (!category?.isActive) throw invalid('Choose an active category', 'categoryId');
  const payFrom = await db.account.findUnique({ where: { id: input.paymentAccountId } });
  if (!payFrom || payFrom.subtype !== 'CASH' || !payFrom.isActive || !payFrom.isPostable) throw invalid('Choose the cash or bank account it was paid from', 'paymentAccountId');
  const total = dec(input.total);
  let tax = ZERO;
  if (input.taxRateId) {
    const rate = await db.taxRate.findUnique({ where: { id: input.taxRateId } });
    if (!rate?.isActive) throw invalid('Choose an active VAT rate', 'taxRateId');
    tax = roundMoney(total.times(rate.rate.toString()).dividedBy(dec(100).plus(rate.rate.toString())));
  }
  if (input.attachmentIds.length > 0) {
    const files = await db.file.count({ where: { id: { in: input.attachmentIds }, visibility: 'PRIVATE' } });
    if (files !== new Set(input.attachmentIds).size) throw invalid('Attach receipts uploaded for expenses', 'attachmentIds');
  }
  return {
    expenseDate: toDate(input.expenseDate),
    categoryId: category.id,
    accountId: category.accountId,
    payee: input.payee,
    description: input.description,
    netAmount: new Prisma.Decimal(total.minus(tax).toFixed(2)),
    taxRateId: input.taxRateId ?? null,
    taxAmount: new Prisma.Decimal(tax.toFixed(2)),
    total: new Prisma.Decimal(total.toFixed(2)),
    paymentAccountId: payFrom.id,
    reference: input.reference ?? null,
  };
}

export async function createExpense(input: ExpenseInput, actorId: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    const data = await resolve(tx, input);
    const e = await tx.expense.create({
      data: {
        ...data,
        number: await nextDocumentNumber(tx, 'EXPENSE', 'EXP-'),
        createdById: actorId,
        attachments: { create: [...new Set(input.attachmentIds)].map((fileId) => ({ fileId })) },
      },
    });
    const detail = await getExpense(e.id, tx);
    await writeAudit(tx, ctx, { action: 'expense.created', entityType: 'expense', entityId: e.id, after: detail });
    return detail;
  });
}

/** Drafts are edited by whoever recorded them, or by an approver. */
async function lockDraft(tx: Tx, id: string, actor: AuthContext) {
  const [row] = await tx.$queryRaw<{ status: string; created_by_id: string }[]>`SELECT status::text, created_by_id FROM expenses WHERE id = ${id}::uuid FOR UPDATE`;
  if (!row) throw notFound('Expense');
  if (row.status !== 'DRAFT') throw businessRule('Only draft expenses can be changed');
  if (row.created_by_id !== actor.user.id && !actor.permissions.has('expenses.approve')) throw forbidden('Only the person who recorded this expense can change it');
}

export async function updateExpense(id: string, input: ExpenseInput, actor: AuthContext, ctx: RequestContext) {
  return transaction(async (tx) => {
    await lockDraft(tx, id, actor);
    const before = await getExpense(id, tx);
    const data = await resolve(tx, input);
    await tx.expenseAttachment.deleteMany({ where: { expenseId: id } });
    await tx.expense.update({ where: { id }, data: { ...data, rejectedReason: null, attachments: { create: [...new Set(input.attachmentIds)].map((fileId) => ({ fileId })) } } });
    const after = await getExpense(id, tx);
    await writeAudit(tx, ctx, { action: 'expense.updated', entityType: 'expense', entityId: id, before, after });
    return after;
  });
}

export async function deleteExpense(id: string, actor: AuthContext, ctx: RequestContext) {
  await transaction(async (tx) => {
    await lockDraft(tx, id, actor);
    const before = await getExpense(id, tx);
    await tx.expense.delete({ where: { id } });
    await writeAudit(tx, ctx, { action: 'expense.deleted', entityType: 'expense', entityId: id, before });
  });
}

export async function submitExpense(id: string, actor: AuthContext, ctx: RequestContext) {
  return transaction(async (tx) => {
    await lockDraft(tx, id, actor);
    await tx.expense.update({ where: { id }, data: { status: 'SUBMITTED', submittedAt: new Date(), rejectedReason: null } });
    await writeAudit(tx, ctx, { action: 'expense.submitted', entityType: 'expense', entityId: id });
    return getExpense(id, tx);
  });
}

async function lockSubmitted(tx: Tx, id: string) {
  const [row] = await tx.$queryRaw<{ status: string }[]>`SELECT status::text FROM expenses WHERE id = ${id}::uuid FOR UPDATE`;
  if (!row) throw notFound('Expense');
  if (row.status !== 'SUBMITTED') throw businessRule('Only submitted expenses can be approved or sent back');
}

/** Approves and posts in one step: Dr expense (+ VAT input) / Cr the account it was paid from. */
export async function approveExpense(id: string, actorId: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    await lockSubmitted(tx, id);
    const e = await tx.expense.findUniqueOrThrow({ where: { id } });
    const journal = await postJournal(tx, {
      entryDate: e.expenseDate,
      sourceType: SOURCE,
      sourceId: e.id,
      postingKey: `${SOURCE}:${e.id}`,
      description: `Expense ${e.number}: ${e.description} (${e.payee})`,
      lines: [
        { accountId: e.accountId, debit: e.netAmount.toString() },
        ...(e.taxAmount.gt(0) ? [{ accountKey: 'VAT_INPUT', debit: e.taxAmount.toString() }] : []),
        { accountId: e.paymentAccountId, credit: e.total.toString(), ...(e.reference ? { memo: e.reference } : {}) },
      ],
      actorId,
    });
    await tx.expense.update({ where: { id }, data: { status: 'POSTED', approvedById: actorId, postedAt: new Date(), journalEntryId: journal.id } });
    await writeAudit(tx, ctx, { action: 'expense.posted', entityType: 'expense', entityId: id, after: { journalId: journal.id } });
    return getExpense(id, tx);
  });
}

/** Sends a submitted expense back to draft with the reason, for the recorder to fix and resubmit. */
export async function rejectExpense(id: string, reason: string, actorId: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    await lockSubmitted(tx, id);
    await tx.expense.update({ where: { id }, data: { status: 'DRAFT', rejectedReason: reason, submittedAt: null } });
    await writeAudit(tx, ctx, { action: 'expense.sent_back', entityType: 'expense', entityId: id, after: { reason, by: actorId } });
    return getExpense(id, tx);
  });
}
