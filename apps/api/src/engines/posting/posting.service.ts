import { Prisma, type JournalEntry } from '@prisma/client';
import { roundMoney, sum, ZERO, type DecimalInput } from '@rhoyards/shared';
import { AppError, businessRule, conflict, notFound } from '../../lib/errors';
import { nextDocumentNumber } from '../../lib/sequences';

type Tx = Prisma.TransactionClient;

export interface JournalLineInput {
  /** Either an explicit account id or a system key such as "INVENTORY". */
  accountId?: string;
  accountKey?: string;
  debit?: DecimalInput;
  credit?: DecimalInput;
  memo?: string;
  locationId?: string;
}

export interface PostJournalInput {
  /** Accounting date (date part only is used). */
  entryDate: Date;
  sourceType: string;
  sourceId?: string;
  /** Idempotency key, e.g. "SALE:<id>". Posting the same key twice returns the original entry. */
  postingKey: string;
  description: string;
  lines: JournalLineInput[];
  actorId: string;
  /** Set only by reverseJournal. */
  reversalOfId?: string;
}

function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const invalid = (message: string, details?: unknown) => new AppError(400, 'VALIDATION_ERROR', message, details);

/** Normalises and validates lines: amounts rounded to 2 dp, exactly one positive side per line, totals equal. */
function normaliseLines(lines: JournalLineInput[]) {
  if (lines.length < 2) throw invalid('A journal entry needs at least two lines');
  const normalised = lines.map((line, i) => {
    const debit = roundMoney(line.debit ?? 0);
    const credit = roundMoney(line.credit ?? 0);
    if (debit.isNegative() || credit.isNegative()) throw invalid(`Line ${i + 1}: amounts cannot be negative`);
    if (debit.isZero() === credit.isZero()) {
      throw invalid(`Line ${i + 1}: enter either a debit or a credit amount`);
    }
    if (!line.accountId && !line.accountKey) throw invalid(`Line ${i + 1}: an account is required`);
    return { ...line, debit, credit };
  });
  const totalDebit = sum(normalised.map((l) => l.debit));
  const totalCredit = sum(normalised.map((l) => l.credit));
  if (!totalDebit.equals(totalCredit) || totalDebit.lte(ZERO)) {
    throw invalid('Journal entry is not balanced', {
      totalDebit: totalDebit.toFixed(2),
      totalCredit: totalCredit.toFixed(2),
    });
  }
  return normalised;
}

async function resolveAccounts(tx: Tx, lines: { accountId?: string; accountKey?: string }[]) {
  const keys = [...new Set(lines.flatMap((l) => (l.accountKey ? [l.accountKey] : [])))];
  const ids = [...new Set(lines.flatMap((l) => (l.accountId ? [l.accountId] : [])))];
  const accounts = await tx.account.findMany({
    where: { OR: [{ systemKey: { in: keys } }, { id: { in: ids } }] },
  });
  const byKey = new Map(accounts.filter((a) => a.systemKey).map((a) => [a.systemKey!, a]));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return lines.map((l, i) => {
    const account = l.accountId ? byId.get(l.accountId) : byKey.get(l.accountKey!);
    if (!account) throw invalid(`Line ${i + 1}: account ${l.accountId ?? l.accountKey} not found`);
    if (!account.isPostable || !account.isActive) {
      throw businessRule(`Account ${account.code} ${account.name} is not an active postable account`);
    }
    return account.id;
  });
}

async function openPeriodFor(tx: Tx, entryDate: Date) {
  const period = await tx.accountingPeriod.findFirst({
    where: { startDate: { lte: entryDate }, endDate: { gte: entryDate } },
  });
  if (!period) throw businessRule(`No accounting period covers ${entryDate.toISOString().slice(0, 10)}`);
  if (period.status !== 'OPEN') throw businessRule(`Accounting period ${period.name} is closed`);
  return period;
}

/**
 * Posts a balanced journal entry inside the caller's transaction. Idempotent per postingKey.
 * The database trigger re-validates balance, period and immutability as a second line of defence.
 */
export async function postJournal(tx: Tx, input: PostJournalInput): Promise<JournalEntry> {
  const existing = await tx.journalEntry.findUnique({ where: { postingKey: input.postingKey } });
  if (existing) return existing;

  const lines = normaliseLines(input.lines);
  const accountIds = await resolveAccounts(tx, lines);
  const entryDate = dateOnly(input.entryDate);
  const period = await openPeriodFor(tx, entryDate);
  const number = await nextDocumentNumber(tx, 'JOURNAL', 'JE-');

  const draft = await tx.journalEntry.create({
    data: {
      number,
      entryDate,
      periodId: period.id,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      postingKey: input.postingKey,
      description: input.description,
      reversalOfId: input.reversalOfId ?? null,
      createdById: input.actorId,
      lines: {
        create: lines.map((l, i) => ({
          lineNo: i + 1,
          accountId: accountIds[i]!,
          debit: new Prisma.Decimal(l.debit.toFixed(2)),
          credit: new Prisma.Decimal(l.credit.toFixed(2)),
          memo: l.memo ?? null,
          locationId: l.locationId ?? null,
        })),
      },
    },
  });

  return tx.journalEntry.update({
    where: { id: draft.id },
    data: { status: 'POSTED', postedById: input.actorId, postedAt: new Date() },
  });
}

/** Posts the mirror image of a posted entry. An entry can be reversed only once (reversal_of_id is UNIQUE). */
export async function reverseJournal(
  tx: Tx,
  entryId: string,
  opts: { entryDate: Date; reason: string; actorId: string },
): Promise<JournalEntry> {
  const original = await tx.journalEntry.findUnique({
    where: { id: entryId },
    include: { lines: { orderBy: { lineNo: 'asc' } }, reversedBy: { select: { id: true } } },
  });
  if (!original) throw notFound('Journal entry');
  if (original.status !== 'POSTED') throw businessRule('Only posted journal entries can be reversed');
  if (original.reversalOfId) throw businessRule('A reversal entry cannot itself be reversed');
  if (original.reversedBy) throw conflict('This journal entry has already been reversed');

  return postJournal(tx, {
    entryDate: opts.entryDate,
    sourceType: original.sourceType,
    ...(original.sourceId ? { sourceId: original.sourceId } : {}),
    postingKey: `REVERSAL:${original.id}`,
    reversalOfId: original.id,
    description: `Reversal of ${original.number}: ${opts.reason}`,
    actorId: opts.actorId,
    lines: original.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit.toString(),
      credit: l.debit.toString(),
      ...(l.memo ? { memo: l.memo } : {}),
      ...(l.locationId ? { locationId: l.locationId } : {}),
    })),
  });
}
