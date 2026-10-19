import type { Prisma } from '@prisma/client';
import { ZERO, type FiscalYearRow, type JournalDetail } from '@rhoyards/shared';
import { postJournal, type JournalLineInput } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { businessDate } from '../../lib/business-date';
import { businessRule, notFound } from '../../lib/errors';
import { ensureFiscalYear } from '../../lib/fiscal-calendar';
import { getPrisma, transaction } from '../../lib/prisma';
import { getSettings } from '../settings/settings.service';
import { addDays, isoDate, totalsByAccount } from './common';
import { getJournal } from './journals.service';

type Tx = Prisma.TransactionClient;
const YEAR_END = 'YEAR_END';
const yearEndKey = (fiscalYearId: string) => `${YEAR_END}:${fiscalYearId}`;

export async function listFiscalYears(): Promise<FiscalYearRow[]> {
  const prisma = getPrisma();
  const years = await prisma.fiscalYear.findMany({ orderBy: { startDate: 'desc' }, include: { periods: { orderBy: { startDate: 'asc' } } } });
  const closerIds = [...new Set(years.flatMap((y) => y.periods.flatMap((p) => (p.closedById ? [p.closedById] : []))))];
  const [closers, drafts, closings] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: closerIds } }, select: { id: true, fullName: true } }),
    prisma.journalEntry.groupBy({ by: ['periodId'], where: { status: 'DRAFT' }, _count: { _all: true } }),
    prisma.journalEntry.findMany({ where: { postingKey: { in: years.map((y) => yearEndKey(y.id)) } }, select: { id: true, number: true, postingKey: true } }),
  ]);
  const names = new Map(closers.map((u) => [u.id, u.fullName]));
  const draftCounts = new Map(drafts.map((d) => [d.periodId, d._count._all]));
  const closingByKey = new Map(closings.map((c) => [c.postingKey, { id: c.id, number: c.number }]));
  return years.map((y) => ({
    id: y.id,
    name: y.name,
    startDate: isoDate(y.startDate),
    endDate: isoDate(y.endDate),
    status: y.status,
    closingEntry: closingByKey.get(yearEndKey(y.id)) ?? null,
    periods: y.periods.map((p) => ({
      id: p.id,
      name: p.name,
      startDate: isoDate(p.startDate),
      endDate: isoDate(p.endDate),
      status: p.status,
      closedAt: p.closedAt?.toISOString() ?? null,
      closedBy: p.closedById ? (names.get(p.closedById) ?? null) : null,
      draftJournals: draftCounts.get(p.id) ?? 0,
    })),
  }));
}

/** Adds the fiscal year after the latest one (or the current year when there is none). One year ahead at most. */
export async function createNextFiscalYear(ctx: RequestContext) {
  return transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('fiscal_years'))`;
    const latest = await tx.fiscalYear.findFirst({ orderBy: { startDate: 'desc' } });
    const today = businessDate();
    let year: number;
    let month: number;
    if (latest) {
      if (latest.startDate > today) throw businessRule(`${latest.name} has not started yet; add the following year once it has`);
      const next = addDays(latest.endDate, 1);
      [year, month] = [next.getUTCFullYear(), next.getUTCMonth() + 1];
    } else {
      month = (await getSettings(tx)).fiscal.yearStartMonth;
      year = today.getUTCMonth() + 1 >= month ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
    }
    const fy = await ensureFiscalYear(tx, year, month);
    await writeAudit(tx, ctx, { action: 'fiscal_year.created', entityType: 'fiscal_year', entityId: fy.id, after: { name: fy.name } });
    return fy;
  });
}

async function lockPeriod(tx: Tx, id: string) {
  const [p] = await tx.$queryRaw<{ id: string; name: string; status: string; start_date: Date; end_date: Date; fiscal_year_id: string }[]>`
    SELECT id, name, status::text, start_date, end_date, fiscal_year_id FROM accounting_periods WHERE id = ${id}::uuid FOR UPDATE`;
  if (!p) throw notFound('Accounting period');
  return p;
}

/** Periods close in date order, only once they have ended, and only with no manual drafts left in them. */
async function assertClosable(tx: Tx, p: Awaited<ReturnType<typeof lockPeriod>>) {
  if (p.status !== 'OPEN') throw businessRule(`${p.name} is already closed`);
  if (p.end_date >= businessDate()) throw businessRule(`${p.name} has not ended yet`);
  const earlierOpen = await tx.accountingPeriod.findFirst({ where: { startDate: { lt: p.start_date }, status: 'OPEN' }, orderBy: { startDate: 'asc' } });
  if (earlierOpen) throw businessRule(`Close ${earlierOpen.name} first: periods close in order`);
  const drafts = await tx.journalEntry.count({ where: { status: 'DRAFT', entryDate: { gte: p.start_date, lte: p.end_date } } });
  if (drafts > 0) throw businessRule(`${p.name} has ${drafts} draft journal${drafts === 1 ? '' : 's'}. Post or delete ${drafts === 1 ? 'it' : 'them'} first.`);
}

export async function closePeriod(id: string, actorId: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    const p = await lockPeriod(tx, id);
    await assertClosable(tx, p);
    await tx.accountingPeriod.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date(), closedById: actorId } });
    await writeAudit(tx, ctx, { action: 'period.closed', entityType: 'accounting_period', entityId: id, after: { name: p.name } });
  });
}

/** Reopens the most recently closed period of an open fiscal year (later periods must be reopened first). */
export async function reopenPeriod(id: string, reason: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    const p = await lockPeriod(tx, id);
    if (p.status !== 'CLOSED') throw businessRule(`${p.name} is already open`);
    const fy = await tx.fiscalYear.findUniqueOrThrow({ where: { id: p.fiscal_year_id } });
    if (fy.status === 'CLOSED') throw businessRule(`${fy.name} has been closed for the year; its periods cannot be reopened`);
    const laterClosed = await tx.accountingPeriod.findFirst({ where: { startDate: { gt: p.start_date }, status: 'CLOSED' }, orderBy: { startDate: 'desc' } });
    if (laterClosed) throw businessRule(`Reopen ${laterClosed.name} first: only the latest closed period can be reopened`);
    await tx.accountingPeriod.update({ where: { id }, data: { status: 'OPEN', closedAt: null, closedById: null } });
    await writeAudit(tx, ctx, { action: 'period.reopened', entityType: 'accounting_period', entityId: id, after: { name: p.name, reason } });
  });
}

/**
 * Year-end close: income and expense balances for the year move to Retained earnings in one entry dated the
 * last day of the year, then the last period and the year are closed for good. The next year is created if missing.
 */
export async function closeFiscalYear(id: string, actorId: string, ctx: RequestContext): Promise<{ closingEntry: JournalDetail | null }> {
  return transaction(async (tx) => {
    const [fy] = await tx.$queryRaw<{ id: string; name: string; status: string; start_date: Date; end_date: Date }[]>`
      SELECT id, name, status::text, start_date, end_date FROM fiscal_years WHERE id = ${id}::uuid FOR UPDATE`;
    if (!fy) throw notFound('Fiscal year');
    if (fy.status === 'CLOSED') throw businessRule(`${fy.name} is already closed`);
    const earlierOpen = await tx.fiscalYear.findFirst({ where: { startDate: { lt: fy.start_date }, status: 'OPEN' } });
    if (earlierOpen) throw businessRule(`Close ${earlierOpen.name} first`);

    const periods = await tx.accountingPeriod.findMany({ where: { fiscalYearId: id }, orderBy: { startDate: 'asc' } });
    const last = periods.at(-1)!;
    const stillOpen = periods.filter((p) => p.id !== last.id && p.status === 'OPEN');
    if (stillOpen.length > 0) throw businessRule(`Close every period before ${last.name} first (${stillOpen.map((p) => p.name).join(', ')})`);
    const lastLocked = await lockPeriod(tx, last.id);
    await assertClosable(tx, lastLocked);

    const next = addDays(fy.end_date, 1);
    await ensureFiscalYear(tx, next.getUTCFullYear(), next.getUTCMonth() + 1);

    const [accounts, totals] = await Promise.all([
      tx.account.findMany({ where: { type: { in: ['INCOME', 'EXPENSE'] } } }),
      totalsByAccount(tx, { from: fy.start_date, to: fy.end_date }),
    ]);
    const lines: JournalLineInput[] = [];
    let profit = ZERO;
    for (const a of accounts) {
      const t = totals.get(a.id);
      const net = t ? t.debit.minus(t.credit) : ZERO; // debit-positive
      if (net.isZero()) continue;
      profit = profit.minus(net);
      lines.push(net.gt(0) ? { accountId: a.id, credit: net } : { accountId: a.id, debit: net.neg() });
    }
    let entry = null;
    if (lines.length > 0) {
      if (!profit.isZero()) lines.push(profit.gt(0) ? { accountKey: 'RETAINED_EARNINGS', credit: profit } : { accountKey: 'RETAINED_EARNINGS', debit: profit.neg() });
      entry = await postJournal(tx, {
        entryDate: fy.end_date,
        sourceType: YEAR_END,
        sourceId: id,
        postingKey: yearEndKey(id),
        description: `Year-end close ${fy.name}: profit to retained earnings`,
        lines,
        actorId,
      });
    }

    const now = new Date();
    await tx.accountingPeriod.update({ where: { id: last.id }, data: { status: 'CLOSED', closedAt: now, closedById: actorId } });
    await tx.fiscalYear.update({ where: { id }, data: { status: 'CLOSED', closedAt: now, closedById: actorId } });
    await writeAudit(tx, ctx, {
      action: 'fiscal_year.closed',
      entityType: 'fiscal_year',
      entityId: id,
      after: { name: fy.name, profit: profit.toFixed(2), closingEntryId: entry?.id ?? null },
    });
    return { closingEntry: entry ? await getJournal(entry.id, tx) : null };
  });
}
