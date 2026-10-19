import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { dec, sum, ZERO, type ReconciliationDetail, type ReconciliationSummary, type reconciliationStartSchema, type settlementSchema } from '@rhoyards/shared';
import { postJournal } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, businessRule, conflict, notFound } from '../../lib/errors';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { getJournal } from '../accounting/journals.service';

/**
 * Bank and cash reconciliation: tick the account's posted lines that appear on the statement. The reconciliation
 * completes only when opening balance + cleared lines = statement balance; a cleared line is cleared for good
 * (UNIQUE journal_line_id) and completed reconciliations are final (database guards).
 */

type Tx = Prisma.TransactionClient;
const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const ref = { select: { id: true, code: true, name: true } } as const;
const invalid = (message: string, field: string) => new AppError(400, 'VALIDATION_ERROR', message, { field });

async function cashAccount(db: Db, id: string, field: string) {
  const a = await db.account.findUnique({ where: { id } });
  if (!a || a.subtype !== 'CASH' || !a.isActive || !a.isPostable) throw invalid('Choose an active cash, bank or clearing account', field);
  return a;
}

const include = { account: ref, completedBy: { select: { fullName: true } } } satisfies Prisma.BankReconciliationInclude;
type Row = Prisma.BankReconciliationGetPayload<{ include: typeof include }>;

const toSummary = (r: Row): ReconciliationSummary => ({
  id: r.id,
  account: r.account,
  statementDate: isoDate(r.statementDate),
  statementBalance: r.statementBalance.toFixed(2),
  status: r.status,
  completedAt: r.completedAt?.toISOString() ?? null,
  completedBy: r.completedBy?.fullName ?? null,
});

export async function listReconciliations(accountId?: string): Promise<ReconciliationSummary[]> {
  const rows = await getPrisma().bankReconciliation.findMany({ where: accountId ? { accountId } : {}, include, orderBy: [{ statementDate: 'desc' }, { createdAt: 'desc' }], take: 200 });
  return rows.map(toSummary);
}

/** The lines on offer: posted lines of the account up to the statement date not cleared by another reconciliation. */
export async function getReconciliation(id: string, db: Db = getPrisma()): Promise<ReconciliationDetail> {
  const r = await db.bankReconciliation.findUnique({ where: { id }, include });
  if (!r) throw notFound('Reconciliation');
  const rows = await db.$queryRaw<{ id: string; entry_id: string; number: string; entry_date: Date; description: string; memo: string | null; debit: Prisma.Decimal; credit: Prisma.Decimal; cleared_here: boolean }[]>`
    SELECT jl.id, je.id AS entry_id, je.number, je.entry_date, je.description, jl.memo, jl.debit, jl.credit,
           (brl.reconciliation_id = ${id}::uuid) AS cleared_here
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
    LEFT JOIN bank_reconciliation_lines brl ON brl.journal_line_id = jl.id
    WHERE jl.account_id = ${r.accountId}::uuid
      AND (brl.id IS NULL OR brl.reconciliation_id = ${id}::uuid)
      AND (${r.status === 'COMPLETED'} = false OR brl.reconciliation_id = ${id}::uuid)
      AND je.entry_date <= ${isoDate(r.statementDate)}::date
    ORDER BY je.entry_date, je.number, jl.line_no`;
  const cleared = rows.filter((l) => l.cleared_here);
  const clearedBalance = dec(r.openingBalance.toString()).plus(sum(cleared.map((l) => dec(l.debit.toString()).minus(l.credit.toString()))));
  return {
    ...toSummary(r),
    openingBalance: r.openingBalance.toFixed(2),
    clearedBalance: clearedBalance.toFixed(2),
    difference: dec(r.statementBalance.toString()).minus(clearedBalance).toFixed(2),
    lines: rows.map((l) => ({
      journalLineId: l.id,
      entryId: l.entry_id,
      number: l.number,
      date: isoDate(l.entry_date),
      description: l.description,
      memo: l.memo,
      debit: l.debit.toFixed(2),
      credit: l.credit.toFixed(2),
      cleared: Boolean(l.cleared_here),
    })),
  };
}

export async function startReconciliation(input: z.infer<typeof reconciliationStartSchema>, actorId: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    const account = await cashAccount(tx, input.accountId, 'accountId');
    const last = await tx.bankReconciliation.findFirst({ where: { accountId: account.id, status: 'COMPLETED' }, orderBy: { statementDate: 'desc' } });
    if (last && toDate(input.statementDate) <= last.statementDate) {
      throw invalid(`The last reconciliation was to ${isoDate(last.statementDate)}; choose a later statement date`, 'statementDate');
    }
    const id = randomUUID();
    await tx.bankReconciliation
      .create({
        data: {
          id,
          accountId: account.id,
          statementDate: toDate(input.statementDate),
          statementBalance: new Prisma.Decimal(input.statementBalance),
          openingBalance: last?.statementBalance ?? new Prisma.Decimal(0),
          createdById: actorId,
        },
      })
      .catch((e: unknown) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('This account already has a reconciliation in progress');
        throw e;
      });
    await writeAudit(tx, ctx, { action: 'reconciliation.started', entityType: 'bank_reconciliation', entityId: id, after: input });
    return getReconciliation(id, tx);
  });
}

async function lockOpen(tx: Tx, id: string) {
  const [row] = await tx.$queryRaw<{ status: string; account_id: string; statement_date: Date }[]>`
    SELECT status::text, account_id, statement_date FROM bank_reconciliations WHERE id = ${id}::uuid FOR UPDATE`;
  if (!row) throw notFound('Reconciliation');
  if (row.status !== 'IN_PROGRESS') throw businessRule('This reconciliation is completed');
  return row;
}

/** Replaces the set of cleared lines (saved as the user ticks). */
export async function setClearedLines(id: string, lineIds: string[]) {
  return transaction(async (tx) => {
    const r = await lockOpen(tx, id);
    const ids = [...new Set(lineIds)];
    if (ids.length > 0) {
      const valid = await tx.$queryRaw<{ id: string }[]>`
        SELECT jl.id FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
        WHERE jl.id = ANY(${ids}::uuid[]) AND jl.account_id = ${r.account_id}::uuid AND je.entry_date <= ${isoDate(r.statement_date)}::date`;
      if (valid.length !== ids.length) throw invalid('Some lines do not belong to this account and statement period', 'cleared');
    }
    await tx.bankReconciliationLine.deleteMany({ where: { reconciliationId: id } });
    await tx.bankReconciliationLine.createMany({ data: ids.map((journalLineId) => ({ reconciliationId: id, journalLineId })) }).catch((e: unknown) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('A line was already cleared on another reconciliation');
      throw e;
    });
    return getReconciliation(id, tx);
  });
}

export async function completeReconciliation(id: string, actorId: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    await lockOpen(tx, id);
    const detail = await getReconciliation(id, tx);
    if (detail.difference !== '0.00') throw businessRule(`The cleared lines differ from the statement by ${detail.difference}. Tick the missing lines or post the missing entries (e.g. bank charges) first.`);
    await tx.bankReconciliation.update({ where: { id }, data: { status: 'COMPLETED', completedById: actorId, completedAt: new Date() } });
    await writeAudit(tx, ctx, { action: 'reconciliation.completed', entityType: 'bank_reconciliation', entityId: id, after: { statementBalance: detail.statementBalance } });
    return getReconciliation(id, tx);
  });
}

export async function deleteReconciliation(id: string, ctx: RequestContext) {
  await transaction(async (tx) => {
    await lockOpen(tx, id);
    await tx.bankReconciliation.delete({ where: { id } });
    await writeAudit(tx, ctx, { action: 'reconciliation.discarded', entityType: 'bank_reconciliation', entityId: id });
  });
}

/** Card or gateway money paid into the bank, less charges: Dr Bank, Dr Bank charges / Cr the clearing account. */
export async function recordSettlement(input: z.infer<typeof settlementSchema>, actorId: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    const clearing = await cashAccount(tx, input.clearingAccountId, 'clearingAccountId');
    const bank = await cashAccount(tx, input.bankAccountId, 'bankAccountId');
    if (clearing.id === bank.id) throw invalid('Choose two different accounts', 'bankAccountId');
    const amount = dec(input.amount);
    const fees = dec(input.fees);
    if (fees.gte(amount)) throw invalid('Charges must be less than the amount settled', 'fees');
    const id = randomUUID();
    const entry = await postJournal(tx, {
      entryDate: toDate(input.settlementDate),
      sourceType: 'SETTLEMENT',
      sourceId: id,
      postingKey: `SETTLEMENT:${id}`,
      description: `Settlement from ${clearing.name} to ${bank.name}${input.reference ? ` (${input.reference})` : ''}`,
      lines: [
        { accountId: bank.id, debit: amount.minus(fees), ...(input.reference ? { memo: input.reference } : {}) },
        ...(fees.gt(ZERO) ? [{ accountKey: 'BANK_CHARGES', debit: fees }] : []),
        { accountId: clearing.id, credit: amount },
      ],
      actorId,
    });
    await writeAudit(tx, ctx, { action: 'settlement.recorded', entityType: 'journal_entry', entityId: entry.id, after: input });
    return getJournal(entry.id, tx);
  });
}
