import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import {
  REVERSIBLE_SOURCES,
  type JournalDetail,
  type JournalInput,
  type JournalSummary,
  type journalListQuerySchema,
  type reverseJournalSchema,
} from '@rhoyards/shared';
import { normaliseLines, openPeriodFor, reverseJournal } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, businessRule, notFound } from '../../lib/errors';
import { pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import { accountRef, isControlAccount, isoDate, toDate } from './common';

type Tx = Prisma.TransactionClient;
const SOURCE = 'MANUAL';
const invalid = (message: string, details?: unknown) => new AppError(400, 'VALIDATION_ERROR', message, details);

const ref = { select: { id: true, number: true } } as const;
const summaryInclude = {
  reversalOf: ref,
  reversedBy: ref,
  createdBy: { select: { fullName: true } },
} satisfies Prisma.JournalEntryInclude;
const detailInclude = {
  ...summaryInclude,
  postedBy: { select: { fullName: true } },
  period: { select: { id: true, name: true, status: true } },
  lines: { orderBy: { lineNo: 'asc' }, include: { account: true, location: { select: { name: true } } } },
} satisfies Prisma.JournalEntryInclude;

type SummaryRow = Prisma.JournalEntryGetPayload<{ include: typeof summaryInclude }>;
type DetailRow = Prisma.JournalEntryGetPayload<{ include: typeof detailInclude }>;

function toSummary(e: SummaryRow): JournalSummary {
  return {
    id: e.id,
    number: e.number,
    entryDate: isoDate(e.entryDate),
    description: e.description,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    status: e.status,
    total: e.totalDebit.toFixed(2),
    reversalOf: e.reversalOf,
    reversedBy: e.reversedBy,
    createdBy: e.createdBy.fullName,
    createdAt: e.createdAt.toISOString(),
    postedAt: e.postedAt?.toISOString() ?? null,
  };
}

function toDetail(e: DetailRow): JournalDetail {
  const totalDebit = e.lines.reduce((s, l) => s.plus(l.debit), new Prisma.Decimal(0));
  const totalCredit = e.lines.reduce((s, l) => s.plus(l.credit), new Prisma.Decimal(0));
  return {
    ...toSummary(e),
    // Drafts carry no totals until posted; show what the lines add up to.
    total: totalDebit.toFixed(2),
    period: e.period,
    postedBy: e.postedBy?.fullName ?? null,
    lines: e.lines.map((l) => ({
      lineNo: l.lineNo,
      account: accountRef(l.account),
      debit: l.debit.toFixed(2),
      credit: l.credit.toFixed(2),
      memo: l.memo,
      location: l.location?.name ?? null,
    })),
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    reversible: e.status === 'POSTED' && !e.reversalOfId && !e.reversedBy && (REVERSIBLE_SOURCES as readonly string[]).includes(e.sourceType),
  };
}

export async function listJournals(query: z.infer<typeof journalListQuerySchema>) {
  const where: Prisma.JournalEntryWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.sourceType ? { sourceType: query.sourceType } : {}),
    ...(query.accountId ? { lines: { some: { accountId: query.accountId } } } : {}),
    ...(query.from || query.to
      ? { entryDate: { ...(query.from ? { gte: toDate(query.from) } : {}), ...(query.to ? { lte: toDate(query.to) } : {}) } }
      : {}),
    ...(query.q
      ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }] }
      : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.journalEntry.findMany({ where, include: summaryInclude, orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }], ...pageArgs(query) }),
    prisma.journalEntry.count({ where }),
  ]);
  return { data: rows.map(toSummary), total };
}

export async function getJournal(id: string, db: Db = getPrisma()): Promise<JournalDetail> {
  const e = await db.journalEntry.findUnique({ where: { id }, include: detailInclude });
  if (!e) throw notFound('Journal entry');
  return toDetail(e);
}

/**
 * Checks manual lines: balanced, and every account active, postable and not a control account
 * (control accounts must keep agreeing with their sub-ledgers).
 */
export async function validateManualLines(db: Db, lines: JournalInput['lines']) {
  const normalised = normaliseLines(lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, ...(l.memo ? { memo: l.memo } : {}) })));
  const accounts = new Map((await db.account.findMany({ where: { id: { in: lines.map((l) => l.accountId) } } })).map((a) => [a.id, a]));
  lines.forEach((l, i) => {
    const a = accounts.get(l.accountId);
    if (!a) throw invalid(`Line ${i + 1}: account not found`, { line: i + 1 });
    if (!a.isActive || !a.isPostable) throw businessRule(`Line ${i + 1}: ${a.code} ${a.name} is not an active postable account`, { line: i + 1 });
    if (isControlAccount(a)) {
      throw businessRule(`Line ${i + 1}: ${a.code} ${a.name} is kept by its own ledger (customers, suppliers or stock) and cannot take manual entries`, { line: i + 1 });
    }
  });
  return normalised;
}

/** Drafts may be dated in any existing period (it must be open by the time they are posted). */
async function periodFor(db: Db, date: Date) {
  const period = await db.accountingPeriod.findFirst({ where: { startDate: { lte: date }, endDate: { gte: date } } });
  if (!period) throw businessRule(`No accounting period covers ${isoDate(date)}. Add the fiscal year first.`, { field: 'entryDate' });
  return period;
}

const lineRows = (lines: ReturnType<typeof normaliseLines>) =>
  lines.map((l, i) => ({
    lineNo: i + 1,
    accountId: l.accountId!,
    debit: new Prisma.Decimal(l.debit.toFixed(2)),
    credit: new Prisma.Decimal(l.credit.toFixed(2)),
    memo: l.memo ?? null,
  }));

export async function createJournal(input: JournalInput, actorId: string, ctx: RequestContext): Promise<JournalDetail> {
  return transaction(async (tx) => {
    const lines = await validateManualLines(tx, input.lines);
    const entryDate = toDate(input.entryDate);
    const period = await periodFor(tx, entryDate);
    const e = await tx.journalEntry.create({
      data: {
        entryDate,
        periodId: period.id,
        sourceType: SOURCE,
        description: input.description,
        createdById: actorId,
        lines: { create: lineRows(lines) },
      },
    });
    const detail = await getJournal(e.id, tx);
    await writeAudit(tx, ctx, { action: 'journal.draft_created', entityType: 'journal_entry', entityId: e.id, after: detail });
    return detail;
  });
}

/** Locks a manual draft for change; anything else is refused. */
async function lockDraft(tx: Tx, id: string) {
  const [row] = await tx.$queryRaw<{ status: string; source_type: string }[]>`
    SELECT status::text, source_type FROM journal_entries WHERE id = ${id}::uuid FOR UPDATE`;
  if (!row) throw notFound('Journal entry');
  if (row.source_type !== SOURCE) throw businessRule('Only manual journals can be edited here');
  if (row.status !== 'DRAFT') throw businessRule('Posted journals cannot be changed. Reverse it and post a correcting entry.');
}

export async function updateJournal(id: string, input: JournalInput, ctx: RequestContext): Promise<JournalDetail> {
  return transaction(async (tx) => {
    await lockDraft(tx, id);
    const before = await getJournal(id, tx);
    const lines = await validateManualLines(tx, input.lines);
    const entryDate = toDate(input.entryDate);
    const period = await periodFor(tx, entryDate);
    await tx.journalLine.deleteMany({ where: { entryId: id } });
    await tx.journalEntry.update({
      where: { id },
      data: { entryDate, periodId: period.id, description: input.description, lines: { create: lineRows(lines) } },
    });
    const after = await getJournal(id, tx);
    await writeAudit(tx, ctx, { action: 'journal.draft_updated', entityType: 'journal_entry', entityId: id, before, after });
    return after;
  });
}

export async function deleteJournal(id: string, ctx: RequestContext): Promise<void> {
  await transaction(async (tx) => {
    await lockDraft(tx, id);
    const before = await getJournal(id, tx);
    await tx.journalLine.deleteMany({ where: { entryId: id } });
    await tx.journalEntry.delete({ where: { id } });
    await writeAudit(tx, ctx, { action: 'journal.draft_deleted', entityType: 'journal_entry', entityId: id, before });
  });
}

/** Posts a manual draft: re-validated, numbered and locked for good (the database trigger checks it again). */
export async function postJournalDraft(id: string, actorId: string, ctx: RequestContext): Promise<JournalDetail> {
  return transaction(async (tx) => {
    await lockDraft(tx, id);
    const draft = await getJournal(id, tx);
    await validateManualLines(
      tx,
      draft.lines.map((l) => ({ accountId: l.account.id, debit: l.debit, credit: l.credit, memo: l.memo })),
    );
    const period = await openPeriodFor(tx, toDate(draft.entryDate));
    const number = await nextDocumentNumber(tx, 'JOURNAL', 'JE-');
    await tx.journalEntry.update({
      where: { id },
      data: { number, periodId: period.id, postingKey: `${SOURCE}:${id}`, status: 'POSTED', postedById: actorId, postedAt: new Date() },
    });
    const posted = await getJournal(id, tx);
    await writeAudit(tx, ctx, { action: 'journal.posted', entityType: 'journal_entry', entityId: id, after: posted });
    return posted;
  });
}

export async function reverseLedgerEntry(id: string, input: z.infer<typeof reverseJournalSchema>, actorId: string, ctx: RequestContext): Promise<JournalDetail> {
  return transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ source_type: string; entry_date: Date }[]>`
      SELECT source_type, entry_date FROM journal_entries WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw notFound('Journal entry');
    if (!(REVERSIBLE_SOURCES as readonly string[]).includes(row.source_type)) {
      throw businessRule('This entry was made by a document (sale, invoice, payment…). Correct it through that document instead.');
    }
    if (input.entryDate < isoDate(row.entry_date)) throw invalid('The reversal cannot be dated before the original entry', { field: 'entryDate' });
    const reversal = await reverseJournal(tx, id, { entryDate: toDate(input.entryDate), reason: input.reason, actorId });
    const detail = await getJournal(reversal.id, tx);
    await writeAudit(tx, ctx, { action: 'journal.reversed', entityType: 'journal_entry', entityId: id, after: { reversalId: reversal.id, reason: input.reason } });
    return detail;
  });
}
