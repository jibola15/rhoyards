import type { Account, Prisma } from '@prisma/client';
import { CONTROL_ACCOUNT_KEYS, dec, isDebitNormal, ZERO, type AccountRef, type AccountTypeCode, type Decimal } from '@rhoyards/shared';
import { businessDate } from '../../lib/business-date';
import type { Db } from '../../lib/prisma';

export const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const todayIso = () => isoDate(businessDate());
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

export const accountRef = (a: Pick<Account, 'id' | 'code' | 'name' | 'type'>): AccountRef => ({ id: a.id, code: a.code, name: a.name, type: a.type });

export const isControlAccount = (a: Pick<Account, 'systemKey'>) => (CONTROL_ACCOUNT_KEYS as readonly string[]).includes(a.systemKey ?? '');

export interface Totals {
  debit: Decimal;
  credit: Decimal;
}

/** debit − credit, or credit − debit for credit-normal accounts. */
export const normalBalance = (type: AccountTypeCode, t: Totals | undefined) =>
  t ? (isDebitNormal(type) ? t.debit.minus(t.credit) : t.credit.minus(t.debit)) : ZERO;

/** Posted debit and credit totals per account, optionally within dates and limited to, or without, some source types. */
export async function totalsByAccount(
  db: Db,
  opts: { from?: Date; to?: Date; excludeSources?: string[]; onlySources?: string[] } = {},
): Promise<Map<string, Totals>> {
  const entry: Prisma.JournalEntryWhereInput = {
    status: 'POSTED',
    ...(opts.from || opts.to ? { entryDate: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } : {}),
    ...(opts.excludeSources?.length ? { sourceType: { notIn: opts.excludeSources } } : {}),
    ...(opts.onlySources ? { sourceType: { in: opts.onlySources } } : {}),
  };
  const rows = await db.journalLine.groupBy({ by: ['accountId'], where: { entry }, _sum: { debit: true, credit: true } });
  return new Map(rows.map((r) => [r.accountId, { debit: dec(r._sum.debit?.toString() ?? 0), credit: dec(r._sum.credit?.toString() ?? 0) }]));
}
