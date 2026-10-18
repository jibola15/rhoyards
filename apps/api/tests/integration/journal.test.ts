import { beforeAll, describe, expect, it } from 'vitest';
import { postJournal, reverseJournal, type PostJournalInput } from '../../src/engines/posting/posting.service';
import { getPrisma, transaction } from '../../src/lib/prisma';
import { nextDocumentNumber } from '../../src/lib/sequences';
import { createStaff, resetDatabase } from '../helpers/db';

const prisma = () => getPrisma();
let actorId: string;
const today = new Date();

beforeAll(async () => {
  await resetDatabase();
  actorId = (await createStaff('ACCOUNTANT')).user.id;
});

let keyCounter = 0;
const saleJournal = (overrides: Partial<PostJournalInput> = {}): PostJournalInput => ({
  entryDate: today,
  sourceType: 'TEST',
  postingKey: `TEST:${++keyCounter}`,
  description: 'Cash sale',
  actorId,
  lines: [
    { accountKey: 'CASH_ON_HAND', debit: '10750.00' },
    { accountKey: 'SALES_REVENUE', credit: '10000.00' },
    { accountKey: 'VAT_OUTPUT', credit: '750.00' },
  ],
  ...overrides,
});

describe('posting engine', () => {
  it('posts a balanced entry with a sequential number and totals', async () => {
    const entry = await transaction((tx) => postJournal(tx, saleJournal()));
    expect(entry.status).toBe('POSTED');
    expect(entry.number).toMatch(/^JE-\d{6}$/);
    expect(entry.totalDebit.toFixed(2)).toBe('10750.00');
    expect(entry.totalCredit.toFixed(2)).toBe('10750.00');
    expect(await prisma().journalLine.count({ where: { entryId: entry.id } })).toBe(3);
  });

  it('rejects unbalanced, one-sided and empty lines before touching the database', async () => {
    await expect(
      transaction((tx) =>
        postJournal(tx, saleJournal({ lines: [{ accountKey: 'CASH_ON_HAND', debit: '100' }, { accountKey: 'SALES_REVENUE', credit: '99.99' }] })),
      ),
    ).rejects.toMatchObject({ status: 400, message: 'Journal entry is not balanced' });

    await expect(
      transaction((tx) =>
        postJournal(tx, saleJournal({ lines: [{ accountKey: 'CASH_ON_HAND', debit: '100', credit: '100' }, { accountKey: 'SALES_REVENUE', credit: '0' }] })),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('does not post the same posting key twice', async () => {
    const input = saleJournal();
    const first = await transaction((tx) => postJournal(tx, input));
    const second = await transaction((tx) => postJournal(tx, input));
    expect(second.id).toBe(first.id);
    expect(await prisma().journalEntry.count({ where: { postingKey: input.postingKey } })).toBe(1);
  });

  it('rolls back the whole entry when the surrounding transaction fails', async () => {
    const input = saleJournal();
    await expect(
      transaction(async (tx) => {
        await postJournal(tx, input);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await prisma().journalEntry.count({ where: { postingKey: input.postingKey } })).toBe(0);
  });

  it('reverses an entry exactly once', async () => {
    const original = await transaction((tx) => postJournal(tx, saleJournal()));
    const reversal = await transaction((tx) => reverseJournal(tx, original.id, { entryDate: today, reason: 'Keyed in error', actorId }));
    expect(reversal.reversalOfId).toBe(original.id);

    const lines = await prisma().journalLine.findMany({ where: { entryId: reversal.id }, orderBy: { lineNo: 'asc' } });
    expect(lines.map((l) => [l.debit.toFixed(2), l.credit.toFixed(2)])).toEqual([
      ['0.00', '10750.00'],
      ['10000.00', '0.00'],
      ['750.00', '0.00'],
    ]);

    await expect(
      transaction((tx) => reverseJournal(tx, original.id, { entryDate: today, reason: 'again', actorId })),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      transaction((tx) => reverseJournal(tx, reversal.id, { entryDate: today, reason: 'undo', actorId })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses to post into a closed period', async () => {
    const period = await prisma().accountingPeriod.findFirstOrThrow({
      where: { startDate: { lte: today }, endDate: { gte: today } },
    });
    await prisma().accountingPeriod.update({ where: { id: period.id }, data: { status: 'CLOSED' } });
    try {
      await expect(transaction((tx) => postJournal(tx, saleJournal()))).rejects.toMatchObject({ status: 422 });
    } finally {
      await prisma().accountingPeriod.update({ where: { id: period.id }, data: { status: 'OPEN' } });
    }
  });

  it('issues unique sequence numbers under concurrency', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 8 }, () => transaction((tx) => nextDocumentNumber(tx, 'TEST_SEQ', 'T-'))),
    );
    expect(new Set(numbers).size).toBe(8);
    expect(numbers.sort()[0]).toBe('T-000001');
  });
});

describe('database guards (independent of application code)', () => {
  async function draftWithLines(lines: { key: string; debit?: string; credit?: string }[]) {
    const [period, accounts] = await Promise.all([
      prisma().accountingPeriod.findFirstOrThrow({ where: { startDate: { lte: today }, endDate: { gte: today } } }),
      prisma().account.findMany({ where: { systemKey: { in: lines.map((l) => l.key) } } }),
    ]);
    const idFor = (key: string) => accounts.find((a) => a.systemKey === key)!.id;
    return prisma().journalEntry.create({
      data: {
        entryDate: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())),
        periodId: period.id,
        sourceType: 'RAW',
        description: 'raw',
        createdById: actorId,
        lines: {
          create: lines.map((l, i) => ({ lineNo: i + 1, accountId: idFor(l.key), debit: l.debit ?? '0', credit: l.credit ?? '0' })),
        },
      },
    });
  }

  it('rejects posting an unbalanced entry even when written directly', async () => {
    const draft = await draftWithLines([
      { key: 'CASH_ON_HAND', debit: '100' },
      { key: 'SALES_REVENUE', credit: '90' },
    ]);
    await expect(prisma().journalEntry.update({ where: { id: draft.id }, data: { status: 'POSTED' } })).rejects.toThrow(/unbalanced/);
  });

  it('rejects inserting a journal entry directly as POSTED', async () => {
    const period = await prisma().accountingPeriod.findFirstOrThrow();
    await expect(
      prisma().journalEntry.create({
        data: { entryDate: period.startDate, periodId: period.id, sourceType: 'RAW', description: 'x', createdById: actorId, status: 'POSTED' },
      }),
    ).rejects.toThrow(/DRAFT/);
  });

  it('rejects lines with both or neither side set', async () => {
    await expect(draftWithLines([{ key: 'CASH_ON_HAND', debit: '5', credit: '5' }, { key: 'SALES_REVENUE' }])).rejects.toThrow(
      /journal_lines_amounts_chk/,
    );
  });

  it('makes posted entries and their lines immutable', async () => {
    const entry = await transaction((tx) => postJournal(tx, saleJournal()));
    const line = await prisma().journalLine.findFirstOrThrow({ where: { entryId: entry.id } });
    const cash = await prisma().account.findUniqueOrThrow({ where: { systemKey: 'CASH_ON_HAND' } });

    await expect(prisma().journalEntry.update({ where: { id: entry.id }, data: { description: 'edited' } })).rejects.toThrow(/immutable/);
    await expect(prisma().journalEntry.delete({ where: { id: entry.id } })).rejects.toThrow();
    await expect(prisma().journalLine.update({ where: { id: line.id }, data: { memo: 'edited' } })).rejects.toThrow(/cannot be changed/);
    await expect(prisma().journalLine.delete({ where: { id: line.id } })).rejects.toThrow(/cannot be changed/);
    await expect(
      prisma().journalLine.create({ data: { entryId: entry.id, lineNo: 99, accountId: cash.id, debit: '1' } }),
    ).rejects.toThrow(/cannot be added/);
  });

  it('keeps the audit log append-only', async () => {
    const log = await prisma().auditLog.create({ data: { action: 'test.event', entityType: 'test' } });
    await expect(prisma().auditLog.update({ where: { id: log.id }, data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(prisma().auditLog.delete({ where: { id: log.id } })).rejects.toThrow(/append-only/);
  });

  it('every posted entry in the ledger balances', async () => {
    const unbalanced = await prisma().$queryRaw<{ id: string }[]>`
      SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.status = 'POSTED' GROUP BY e.id HAVING SUM(l.debit) <> SUM(l.credit)`;
    expect(unbalanced).toEqual([]);
    expect(await prisma().journalEntry.count({ where: { status: 'POSTED' } })).toBeGreaterThan(0);
  });
});
