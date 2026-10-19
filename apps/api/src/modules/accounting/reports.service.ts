import type { Account, Prisma } from '@prisma/client';
import {
  dec,
  isDebitNormal,
  sum,
  ZERO,
  type BalanceSheet,
  type CashFlowStatement,
  type Decimal,
  type GeneralLedger,
  type ProfitAndLoss,
  type ReceivablesAging,
  type ReceivablesAgingRow,
  type ReportSection,
  type TrialBalance,
} from '@rhoyards/shared';
import { businessDate, startOfBusinessDay } from '../../lib/business-date';
import { notFound } from '../../lib/errors';
import { getPrisma, type Db } from '../../lib/prisma';
import { accountRef, addDays, isoDate, normalBalance, todayIso, toDate, totalsByAccount, type Totals } from './common';

/**
 * Financial statements, computed from posted journal lines only (see docs/ACCOUNTING_RULES.md §6–§8).
 * Every figure is a Decimal until it is formatted for the response.
 */

const fmt = (d: Decimal) => d.toFixed(2);

/** Start of the fiscal year containing the date, or 1 January when no fiscal year covers it. */
async function yearStart(db: Db, date: string) {
  const d = toDate(date);
  const fy = await db.fiscalYear.findFirst({ where: { startDate: { lte: d }, endDate: { gte: d } } });
  return fy ? isoDate(fy.startDate) : `${date.slice(0, 4)}-01-01`;
}

async function range(db: Db, from?: string, to?: string) {
  const end = to ?? todayIso();
  return { from: from ?? (await yearStart(db, end)), to: end };
}

function section(key: string, label: string, accounts: Account[], amount: (a: Account) => Decimal): ReportSection {
  const rows = accounts
    .map((a) => ({ account: accountRef(a), value: amount(a) }))
    .filter((r) => !r.value.isZero())
    .sort((a, b) => a.account.code.localeCompare(b.account.code));
  return { key, label, rows: rows.map((r) => ({ account: r.account, amount: fmt(r.value) })), total: fmt(sum(rows.map((r) => r.value))) };
}

// ── Trial balance ─────────────────────────────────────────────────────────

export async function trialBalance(asOf = todayIso()): Promise<TrialBalance> {
  const prisma = getPrisma();
  const [accounts, totals] = await Promise.all([prisma.account.findMany({ orderBy: { code: 'asc' } }), totalsByAccount(prisma, { to: toDate(asOf) })]);
  let debit = ZERO;
  let credit = ZERO;
  const rows = [];
  for (const a of accounts) {
    const t = totals.get(a.id);
    if (!t) continue;
    const net = t.debit.minus(t.credit);
    if (net.isZero()) continue;
    if (net.gt(0)) debit = debit.plus(net);
    else credit = credit.minus(net);
    rows.push({ account: accountRef(a), debit: net.gt(0) ? fmt(net) : '0.00', credit: net.lt(0) ? fmt(net.neg()) : '0.00' });
  }
  return { asOf, rows, totals: { debit: fmt(debit), credit: fmt(credit) } };
}

// ── General ledger ────────────────────────────────────────────────────────

interface LedgerRow {
  entry_id: string;
  number: string;
  entry_date: Date;
  description: string;
  source_type: string;
  memo: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  running: Prisma.Decimal;
}

export async function generalLedger(q: { accountId: string; from?: string | undefined; to?: string | undefined; page: number; pageSize: number }): Promise<GeneralLedger> {
  const prisma = getPrisma();
  const account = await prisma.account.findUnique({ where: { id: q.accountId } });
  if (!account) throw notFound('Account');
  const { from, to } = await range(prisma, q.from, q.to);
  const [fromDate, toDateValue] = [toDate(from), toDate(to)];
  const sign = (d: Decimal) => (isDebitNormal(account.type) ? d : d.neg());

  const inRange = { accountId: account.id, entry: { status: 'POSTED' as const, entryDate: { gte: fromDate, lte: toDateValue } } };
  const [before, within, total] = await Promise.all([
    prisma.journalLine.aggregate({ where: { accountId: account.id, entry: { status: 'POSTED', entryDate: { lt: fromDate } } }, _sum: { debit: true, credit: true } }),
    prisma.journalLine.aggregate({ where: inRange, _sum: { debit: true, credit: true } }),
    prisma.journalLine.count({ where: inRange }),
  ]);
  const opening = sign(dec(before._sum.debit?.toString() ?? 0).minus(before._sum.credit?.toString() ?? 0));
  const totalDebit = dec(within._sum.debit?.toString() ?? 0);
  const totalCredit = dec(within._sum.credit?.toString() ?? 0);

  // The running sum is a window over the whole range, so a later page still starts from the right balance.
  const rows = await prisma.$queryRaw<LedgerRow[]>`
    SELECT je.id AS entry_id, je.number, je.entry_date, je.description, je.source_type, jl.memo, jl.debit, jl.credit,
           SUM(jl.debit - jl.credit) OVER (ORDER BY je.entry_date, je.number, jl.line_no ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_id = ${account.id}::uuid AND je.status = 'POSTED'
      AND je.entry_date BETWEEN ${from}::date AND ${to}::date
    ORDER BY je.entry_date, je.number, jl.line_no
    LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;

  return {
    account: { ...accountRef(account), normal: isDebitNormal(account.type) ? 'DEBIT' : 'CREDIT' },
    from,
    to,
    openingBalance: fmt(opening),
    totalDebit: fmt(totalDebit),
    totalCredit: fmt(totalCredit),
    closingBalance: fmt(opening.plus(sign(totalDebit.minus(totalCredit)))),
    lines: rows.map((r) => ({
      entryId: r.entry_id,
      number: r.number,
      date: isoDate(r.entry_date),
      description: r.description,
      memo: r.memo,
      sourceType: r.source_type,
      debit: r.debit.toFixed(2),
      credit: r.credit.toFixed(2),
      balance: fmt(opening.plus(sign(dec(r.running.toString())))),
    })),
    meta: { page: q.page, pageSize: q.pageSize, total },
  };
}

// ── Profit and loss ───────────────────────────────────────────────────────

/** Year-end closing entries are left out: they move the year's profit to equity and would zero every line. */
export async function profitAndLoss(fromIso?: string, toIso?: string): Promise<ProfitAndLoss> {
  const prisma = getPrisma();
  const { from, to } = await range(prisma, fromIso, toIso);
  const [accounts, totals] = await Promise.all([
    prisma.account.findMany({ where: { type: { in: ['INCOME', 'EXPENSE'] } } }),
    totalsByAccount(prisma, { from: toDate(from), to: toDate(to), excludeSources: ['YEAR_END'] }),
  ]);
  const income = accounts.filter((a) => a.type === 'INCOME');
  const expense = accounts.filter((a) => a.type === 'EXPENSE');
  const credit = (a: Account) => normalBalance('INCOME', totals.get(a.id));
  const debit = (a: Account) => normalBalance('EXPENSE', totals.get(a.id));

  const revenue = section('revenue', 'Revenue', income.filter((a) => a.subtype === 'REVENUE'), credit);
  const deductions = section('deductions', 'Less returns and discounts', income.filter((a) => a.subtype === 'CONTRA_REVENUE'), debit);
  const otherIncome = section('otherIncome', 'Other income', income.filter((a) => a.subtype !== 'REVENUE' && a.subtype !== 'CONTRA_REVENUE'), credit);
  const costOfSales = section('costOfSales', 'Cost of sales', expense.filter((a) => a.subtype === 'COGS'), debit);
  const otherExpenses = section('otherExpenses', 'Other expenses', expense.filter((a) => a.subtype === 'OTHER_EXPENSE'), debit);
  const operatingExpenses = section('operatingExpenses', 'Operating expenses', expense.filter((a) => a.subtype !== 'COGS' && a.subtype !== 'OTHER_EXPENSE'), debit);

  const netSales = dec(revenue.total).minus(deductions.total);
  const grossProfit = netSales.minus(costOfSales.total);
  const netProfit = grossProfit.plus(otherIncome.total).minus(operatingExpenses.total).minus(otherExpenses.total);
  return {
    from,
    to,
    revenue,
    deductions,
    netSales: fmt(netSales),
    costOfSales,
    grossProfit: fmt(grossProfit),
    otherIncome,
    operatingExpenses,
    otherExpenses,
    netProfit: fmt(netProfit),
  };
}

// ── Balance sheet ─────────────────────────────────────────────────────────

const ASSET_SECTIONS: [string, string][] = [
  ['CASH', 'Cash and bank'],
  ['CURRENT_ASSET', 'Current assets'],
  ['NON_CURRENT_ASSET', 'Non-current assets'],
];
const LIABILITY_SECTIONS: [string, string][] = [
  ['CURRENT_LIABILITY', 'Current liabilities'],
  ['NON_CURRENT_LIABILITY', 'Non-current liabilities'],
];

/** Accounts whose subtype is not one of the listed sections fall into the first (current) section after cash. */
function bySubtype(accounts: Account[], sections: [string, string][], fallback: string, amount: (a: Account) => Decimal) {
  const known = new Set(sections.map(([k]) => k));
  return sections
    .map(([key, label]) => section(key, label, accounts.filter((a) => (known.has(a.subtype ?? '') ? a.subtype : fallback) === key), amount))
    .filter((s) => s.rows.length > 0);
}

export async function balanceSheet(asOf = todayIso()): Promise<BalanceSheet> {
  const prisma = getPrisma();
  const [accounts, totals] = await Promise.all([prisma.account.findMany(), totalsByAccount(prisma, { to: toDate(asOf) })]);
  const bal = (a: Account) => normalBalance(a.type, totals.get(a.id));
  const of = (type: Account['type']) => accounts.filter((a) => a.type === type);

  const assets = bySubtype(of('ASSET'), ASSET_SECTIONS, 'CURRENT_ASSET', bal);
  const liabilities = bySubtype(of('LIABILITY'), LIABILITY_SECTIONS, 'CURRENT_LIABILITY', bal);
  const equity = section('equity', 'Equity', of('EQUITY'), bal);
  // Closing entries zero the income and expense accounts of closed years, so what remains is not yet closed.
  const currentEarnings = sum(of('INCOME').map(bal)).minus(sum(of('EXPENSE').map(bal)));

  const totalAssets = sum(assets.map((s) => s.total));
  const totalLiabilities = sum(liabilities.map((s) => s.total));
  const totalEquity = dec(equity.total).plus(currentEarnings);
  const totalLiabilitiesAndEquity = totalLiabilities.plus(totalEquity);
  return {
    asOf,
    assets,
    totalAssets: fmt(totalAssets),
    liabilities,
    totalLiabilities: fmt(totalLiabilities),
    equity,
    currentEarnings: fmt(currentEarnings),
    totalEquity: fmt(totalEquity),
    totalLiabilitiesAndEquity: fmt(totalLiabilitiesAndEquity),
    balanced: totalAssets.equals(totalLiabilitiesAndEquity),
  };
}

// ── Cash flow (direct method) ─────────────────────────────────────────────

const OPENING = 'OPENING_BALANCE';

/**
 * Cash accounts are those classified CASH. For every entry that moves cash, its other lines say where the cash
 * came from or went (credit − debit = cash in), grouped by that account's activity. Entries made only of cash
 * accounts (transfers between tills and the bank) net to nothing and are left out. Opening balances are not a
 * cash flow: cash brought in by an opening-balance entry inside the range counts as opening cash.
 */
export async function cashFlow(fromIso?: string, toIso?: string): Promise<CashFlowStatement> {
  const prisma = getPrisma();
  const { from, to } = await range(prisma, fromIso, toIso);
  const [fromDate, toDateValue] = [toDate(from), toDate(to)];
  const accounts = await prisma.account.findMany();
  const cash = accounts.filter((a) => a.subtype === 'CASH');
  const cashIds = cash.map((a) => a.id);

  const [before, opening, atEnd, flows] = await Promise.all([
    totalsByAccount(prisma, { to: addDays(fromDate, -1) }),
    totalsByAccount(prisma, { from: fromDate, to: toDateValue, onlySources: [OPENING] }),
    totalsByAccount(prisma, { to: toDateValue }),
    prisma.$queryRaw<{ account_id: string; amount: Prisma.Decimal }[]>`
      SELECT jl.account_id, SUM(jl.credit - jl.debit) AS amount
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.status = 'POSTED' AND je.entry_date BETWEEN ${from}::date AND ${to}::date
        AND je.source_type <> ${OPENING}
        AND NOT (jl.account_id = ANY(${cashIds}::uuid[]))
        AND EXISTS (SELECT 1 FROM journal_lines c WHERE c.entry_id = je.id AND c.account_id = ANY(${cashIds}::uuid[]))
      GROUP BY jl.account_id`,
  ]);
  const flowBy = new Map(flows.map((f) => [f.account_id, dec(f.amount.toString())]));
  const amount = (a: Account) => flowBy.get(a.id) ?? ZERO;
  const activity = (a: Account) =>
    a.subtype === 'NON_CURRENT_ASSET' ? 'investing' : a.type === 'EQUITY' || a.subtype === 'NON_CURRENT_LIABILITY' ? 'financing' : 'operating';
  const others = accounts.filter((a) => flowBy.has(a.id));

  const operating = section('operating', 'Operating activities', others.filter((a) => activity(a) === 'operating'), amount);
  const investing = section('investing', 'Investing activities', others.filter((a) => activity(a) === 'investing'), amount);
  const financing = section('financing', 'Financing activities', others.filter((a) => activity(a) === 'financing'), amount);
  const cashBal = (t: Map<string, Totals>, a: Account) => normalBalance('ASSET', t.get(a.id));
  const openingCash = sum(cash.map((a) => cashBal(before, a).plus(cashBal(opening, a))));
  const closingCash = sum(cash.map((a) => cashBal(atEnd, a)));
  return {
    from,
    to,
    openingCash: fmt(openingCash),
    operating,
    investing,
    financing,
    netChange: fmt(sum([operating.total, investing.total, financing.total])),
    closingCash: fmt(closingCash),
    cashAccounts: cash
      .map((a) => ({ account: accountRef(a), opening: fmt(cashBal(before, a).plus(cashBal(opening, a))), closing: fmt(cashBal(atEnd, a)) }))
      .filter((c) => c.opening !== '0.00' || c.closing !== '0.00')
      .sort((a, b) => a.account.code.localeCompare(b.account.code)),
  };
}

// ── Aged receivables ──────────────────────────────────────────────────────

/** Unpaid credit-sale balances by age (days since the sale), per customer; reconciled to the AR ledger. */
export async function receivablesAging(asOf = todayIso()): Promise<ReceivablesAging> {
  const prisma = getPrisma();
  const asOfDate = toDate(asOf);
  const [sales, ar] = await Promise.all([
    prisma.sale.findMany({
      where: { status: 'COMPLETED', customerId: { not: null }, balanceDue: { gt: 0 }, completedAt: { lt: startOfBusinessDay(isoDate(addDays(asOfDate, 1))) } },
      select: { balanceDue: true, completedAt: true, customer: { select: { id: true, code: true, name: true } } },
    }),
    prisma.account.findUniqueOrThrow({ where: { systemKey: 'AR' } }),
  ]);
  const ledger = await totalsByAccount(prisma, { to: asOfDate });

  type Buckets = [Decimal, Decimal, Decimal, Decimal];
  const byCustomer = new Map<string, { customer: ReceivablesAgingRow['customer']; b: Buckets }>();
  for (const s of sales) {
    const entry = byCustomer.get(s.customer!.id) ?? { customer: s.customer!, b: [ZERO, ZERO, ZERO, ZERO] as Buckets };
    const days = Math.floor((asOfDate.getTime() - businessDate(s.completedAt!).getTime()) / 86_400_000);
    const i = days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3;
    entry.b[i] = entry.b[i].plus(s.balanceDue.toString());
    byCustomer.set(s.customer!.id, entry);
  }
  const fmtRow = (b: Buckets) => ({ days0to30: fmt(b[0]), days31to60: fmt(b[1]), days61to90: fmt(b[2]), over90: fmt(b[3]), balance: fmt(sum(b)) });
  const totals: Buckets = [ZERO, ZERO, ZERO, ZERO];
  for (const { b } of byCustomer.values()) b.forEach((v, i) => (totals[i] = totals[i]!.plus(v)));
  return {
    asOf,
    rows: [...byCustomer.values()].sort((a, b) => a.customer.name.localeCompare(b.customer.name)).map(({ customer, b }) => ({ customer, ...fmtRow(b) })),
    totals: fmtRow(totals),
    ledgerBalance: fmt(normalBalance('ASSET', ledger.get(ar.id))),
  };
}
