import { randomUUID } from 'node:crypto';
import { dec, sum, ZERO, type AccountRef, type OpeningBalancesInput, type OpeningBalancesState } from '@rhoyards/shared';
import { postJournal, type JournalLineInput } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, businessRule } from '../../lib/errors';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { accountRef, isControlAccount, toDate } from './common';
import { getJournal } from './journals.service';

const SOURCE = 'OPENING_BALANCE';
const BALANCING_KEY = 'OPENING_BALANCE_EQUITY';

/**
 * Accounts that take an opening balance here. Control accounts are excluded: opening stock is entered as an
 * opening-stock adjustment (which values it per product), and customer/supplier balances belong to their ledgers.
 */
async function eligibleAccounts(db: Db): Promise<AccountRef[]> {
  const accounts = await db.account.findMany({ where: { isActive: true, isPostable: true }, orderBy: { code: 'asc' } });
  return accounts.filter((a) => !isControlAccount(a) && a.systemKey !== BALANCING_KEY).map(accountRef);
}

/** The opening-balance entry in force: posted and not reversed. */
async function currentEntry(db: Db) {
  return db.journalEntry.findFirst({ where: { sourceType: SOURCE, status: 'POSTED', reversedBy: { is: null }, reversalOfId: null }, orderBy: { postedAt: 'desc' } });
}

export async function openingBalancesState(): Promise<OpeningBalancesState> {
  const prisma = getPrisma();
  const [entry, accounts] = await Promise.all([currentEntry(prisma), eligibleAccounts(prisma)]);
  return { current: entry ? await getJournal(entry.id) : null, accounts };
}

/** Posts the opening balances in one entry; the difference goes to Opening balance equity. */
export async function postOpeningBalances(input: OpeningBalancesInput, actorId: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('opening_balances'))`;
    if (await currentEntry(tx)) throw businessRule('Opening balances have already been posted. Reverse that entry first to enter them again.');

    const eligible = new Set((await eligibleAccounts(tx)).map((a) => a.id));
    const seen = new Set<string>();
    const lines: JournalLineInput[] = [];
    input.lines.forEach((l, i) => {
      if (!eligible.has(l.accountId)) throw businessRule(`Line ${i + 1}: this account cannot take an opening balance here`, { line: i + 1 });
      if (seen.has(l.accountId)) throw new AppError(400, 'VALIDATION_ERROR', `Line ${i + 1}: the account appears twice`, { line: i + 1 });
      seen.add(l.accountId);
      const debit = dec(l.debit);
      const credit = dec(l.credit);
      if (debit.gt(0) && credit.gt(0)) throw new AppError(400, 'VALIDATION_ERROR', `Line ${i + 1}: enter either a debit or a credit`, { line: i + 1 });
      if (debit.gt(0)) lines.push({ accountId: l.accountId, debit, memo: 'Opening balance' });
      else if (credit.gt(0)) lines.push({ accountId: l.accountId, credit, memo: 'Opening balance' });
    });
    const difference = sum(lines.map((l) => dec(l.debit ?? 0))).minus(sum(lines.map((l) => dec(l.credit ?? 0))));
    if (!difference.isZero()) {
      lines.push(
        difference.gt(ZERO)
          ? { accountKey: BALANCING_KEY, credit: difference, memo: 'Balancing figure' }
          : { accountKey: BALANCING_KEY, debit: difference.neg(), memo: 'Balancing figure' },
      );
    }

    const id = randomUUID();
    const entry = await postJournal(tx, {
      entryDate: toDate(input.entryDate),
      sourceType: SOURCE,
      sourceId: id,
      postingKey: `${SOURCE}:${id}`,
      description: 'Opening balances',
      lines,
      actorId,
    });
    const detail = await getJournal(entry.id, tx);
    await writeAudit(tx, ctx, { action: 'opening_balances.posted', entityType: 'journal_entry', entityId: entry.id, after: detail });
    return detail;
  });
}
