import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { dec, sum, type AccountRow } from '@rhoyards/shared';
import { businessDate } from '../../src/lib/business-date';
import { ensureFiscalYear } from '../../src/lib/fiscal-calendar';
import { getPrisma } from '../../src/lib/prisma';
import { mainLocationId, makeProduct } from '../helpers/catalog';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, signIn } from '../helpers/test-app';

const app = buildTestApp();
const prisma = () => getPrisma();
type Agent = Awaited<ReturnType<typeof signIn>>;
let accountant: Agent;
let manager: Agent;
let cashier: Agent;
let owner: Agent;
let acc: Record<string, string>; // account code → id
const today = businessDate().toISOString().slice(0, 10);
const thisYear = Number(today.slice(0, 4));

const send = (who: Agent, method: 'post' | 'patch' | 'put' | 'delete', path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  let req = who.agent[method](`/api/v1${path}`).set('X-CSRF-Token', who.csrf);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(body as object);
};
const get = (who: Agent, path: string) => who.agent.get(`/api/v1${path}`);
const ok = async (p: Promise<request.Response> | request.Test, status = 200) => {
  const res = await p;
  if (res.status !== status) throw new Error(`Expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const status = async (p: Promise<request.Response> | request.Test) => (await p).status;
const jl = (code: string, debit: string, credit = '') => ({ accountId: acc[code]!, debit: credit ? '' : debit, credit });
/** Creates and posts a manual journal through the API. */
const postManual = async (entryDate: string, description: string, lines: ReturnType<typeof jl>[]) => {
  const draft = await ok(send(accountant, 'post', '/accounting/journals', { entryDate, description, lines }), 201);
  return ok(send(accountant, 'post', `/accounting/journals/${draft.id}/post`));
};

beforeAll(async () => {
  await resetDatabase();
  const [a, m, c, o] = await Promise.all([createStaff('ACCOUNTANT'), createStaff('MANAGER'), createStaff('CASHIER'), createStaff('OWNER')]);
  [accountant, manager, cashier, owner] = await Promise.all([signIn(app, a.email, TEST_PASSWORD), signIn(app, m.email, TEST_PASSWORD), signIn(app, c.email, TEST_PASSWORD), signIn(app, o.email, TEST_PASSWORD)]);
  const accounts: AccountRow[] = await ok(get(accountant, '/accounting/accounts'));
  acc = Object.fromEntries(accounts.map((x) => [x.code, x.id]));
});

describe('chart of accounts', () => {
  it('adds accounts with a classification that matches the type, and protects system accounts', async () => {
    const equipment = await ok(send(accountant, 'post', '/accounting/accounts', { code: '1500', name: 'Shop equipment', type: 'ASSET', subtype: 'NON_CURRENT_ASSET' }), 201);
    acc['1500'] = equipment.id;
    expect(equipment).toMatchObject({ isPostable: true, isActive: true, isControl: false, balance: '0.00' });

    expect(await status(send(accountant, 'post', '/accounting/accounts', { code: '1500', name: 'Again', type: 'ASSET', subtype: 'CURRENT_ASSET' }))).toBe(409);
    expect(await status(send(accountant, 'post', '/accounting/accounts', { code: '1510', name: 'Wrong', type: 'ASSET', subtype: 'REVENUE' }))).toBe(400);
    expect(await status(send(cashier, 'post', '/accounting/accounts', { code: '1520', name: 'No', type: 'ASSET', subtype: 'CURRENT_ASSET' }))).toBe(403);
    expect(await status(get(cashier, '/accounting/accounts'))).toBe(403);

    const cashId = acc['1000']!;
    expect(await status(send(accountant, 'patch', `/accounting/accounts/${cashId}`, { type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' }))).toBe(422);
    expect(await status(send(accountant, 'patch', `/accounting/accounts/${cashId}`, { isActive: false }))).toBe(422);
    expect(await ok(send(accountant, 'patch', `/accounting/accounts/${cashId}`, { name: 'Cash in tills' }))).toMatchObject({ name: 'Cash in tills', code: '1000' });

    const accounts: AccountRow[] = await ok(get(accountant, '/accounting/accounts'));
    expect(accounts.filter((x) => x.isControl).map((x) => x.systemKey).sort()).toEqual(['AP', 'AR', 'GRNI', 'INVENTORY']);
  });
});

describe('manual journals', () => {
  let draftId: string;
  let postedId: string;

  it('saves a draft that does not touch the ledger', async () => {
    const draft = await ok(send(accountant, 'post', '/accounting/journals', { entryDate: today, description: 'October rent', lines: [jl('6000', '40000.00'), jl('1010', '', '40000.00')] }), 201);
    draftId = draft.id;
    expect(draft).toMatchObject({ status: 'DRAFT', number: null, sourceType: 'MANUAL', totalDebit: '40000.00', totalCredit: '40000.00' });
    expect((await ok(get(accountant, '/reports/trial-balance'))).rows).toEqual([]);

    const updated = await ok(send(accountant, 'put', `/accounting/journals/${draftId}`, { entryDate: today, description: 'October rent', lines: [jl('6000', '50000.00'), jl('1010', '', '50000.00')] }));
    expect(updated.totalDebit).toBe('50000.00');
  });

  it('refuses unbalanced entries, control accounts and missing permissions', async () => {
    const body = (lines: ReturnType<typeof jl>[]) => ({ entryDate: today, description: 'Bad', lines });
    const unbalanced = await send(accountant, 'post', '/accounting/journals', body([jl('6000', '100.00'), jl('1010', '', '99.99')]));
    expect(unbalanced.status).toBe(400);
    expect(unbalanced.body.error.message).toBe('Journal entry is not balanced');
    expect(await status(send(accountant, 'post', '/accounting/journals', body([jl('6000', '100.00', '100.00'), jl('1010', '', '100.00')])))).toBe(400);
    const control = await send(accountant, 'post', '/accounting/journals', body([jl('1100', '100.00'), jl('4200', '', '100.00')]));
    expect(control.status).toBe(422);
    expect(control.body.error.message).toMatch(/cannot take manual entries/);

    expect(await status(send(cashier, 'post', '/accounting/journals', body([jl('6000', '1.00'), jl('1010', '', '1.00')])))).toBe(403);
    expect(await status(send(manager, 'post', `/accounting/journals/${draftId}/post`))).toBe(403);
  });

  it('posts a draft with the next number; posted entries can no longer change (acceptance #8)', async () => {
    const posted = await ok(send(accountant, 'post', `/accounting/journals/${draftId}/post`));
    postedId = posted.id;
    expect(posted).toMatchObject({ status: 'POSTED', total: '50000.00', reversible: true });
    expect(posted.number).toMatch(/^JE-\d{6}$/);

    const again = { entryDate: today, description: 'Edit', lines: [jl('6000', '1.00'), jl('1010', '', '1.00')] };
    expect(await status(send(accountant, 'put', `/accounting/journals/${postedId}`, again))).toBe(422);
    expect(await status(send(accountant, 'delete', `/accounting/journals/${postedId}`))).toBe(422);
    expect(await status(send(accountant, 'post', `/accounting/journals/${postedId}/post`))).toBe(422);

    // The database refuses too, whatever the application does.
    await expect(prisma().$executeRaw`UPDATE journal_entries SET description = 'tampered' WHERE id = ${postedId}::uuid`).rejects.toThrow(/immutable/);
    await expect(prisma().$executeRaw`UPDATE journal_lines SET debit = 1 WHERE entry_id = ${postedId}::uuid AND debit > 0`).rejects.toThrow(/cannot be changed/);
    await expect(prisma().$executeRaw`DELETE FROM journal_lines WHERE entry_id = ${postedId}::uuid`).rejects.toThrow(/cannot be changed/);
  });

  it('corrects a posted journal by reversal, once', async () => {
    const reversal = await ok(send(accountant, 'post', `/accounting/journals/${postedId}/reverse`, { entryDate: today, reason: 'Wrong amount' }), 201);
    expect(reversal.reversalOf).toEqual({ id: postedId, number: expect.any(String) });
    expect(reversal.lines.map((l: { account: { code: string }; debit: string; credit: string }) => [l.account.code, l.debit, l.credit])).toEqual([
      ['6000', '0.00', '50000.00'],
      ['1010', '50000.00', '0.00'],
    ]);
    expect((await ok(get(accountant, `/accounting/journals/${postedId}`))).reversible).toBe(false);
    expect(await status(send(accountant, 'post', `/accounting/journals/${postedId}/reverse`, { entryDate: today, reason: 'Again' }))).toBe(409);
    expect(await status(send(accountant, 'post', `/accounting/journals/${reversal.id}/reverse`, { entryDate: today, reason: 'Undo' }))).toBe(422);

    // Drafts can be deleted; the right amount is then posted afresh.
    const draft = await ok(send(accountant, 'post', '/accounting/journals', { entryDate: today, description: 'Scrap', lines: [jl('6000', '1.00'), jl('1010', '', '1.00')] }), 201);
    expect(await status(send(accountant, 'delete', `/accounting/journals/${draft.id}`))).toBe(204);
    await postManual(today, 'October rent', [jl('6000', '40000.00'), jl('1010', '', '40000.00')]);
  });
});

describe('opening balances', () => {
  it('posts once, balancing to Opening balance equity, and can be redone after a reversal', async () => {
    const state = await ok(get(accountant, '/accounting/opening-balances'));
    expect(state.current).toBeNull();
    const codes = state.accounts.map((a: { code: string }) => a.code);
    expect(codes).toContain('1010');
    expect(codes).not.toContain('1100'); // control account
    expect(codes).not.toContain('3900'); // the balancing account itself

    const first = await ok(send(accountant, 'post', '/accounting/opening-balances', { entryDate: today, lines: [jl('1010', '300000.00'), jl('3000', '', '150000.00')] }), 201);
    expect(first.lines.map((l: { account: { code: string }; debit: string; credit: string }) => [l.account.code, l.debit, l.credit])).toEqual([
      ['1010', '300000.00', '0.00'],
      ['3000', '0.00', '150000.00'],
      ['3900', '0.00', '150000.00'],
    ]);
    expect(await status(send(accountant, 'post', '/accounting/opening-balances', { entryDate: today, lines: [jl('1010', '1.00')] }))).toBe(422);
    expect(await status(send(accountant, 'post', `/accounting/journals/${first.id}/reverse`, { entryDate: today, reason: 'Bank figure was wrong' }))).toBe(201);
    expect(await status(send(accountant, 'post', '/accounting/opening-balances', { entryDate: today, lines: [jl('1200', '5.00')] }))).toBe(422);

    await ok(send(accountant, 'post', '/accounting/opening-balances', { entryDate: today, lines: [jl('1010', '200000.00'), jl('3000', '', '150000.00')] }), 201);
    expect((await ok(get(accountant, '/accounting/opening-balances'))).current.total).toBe('200000.00');
  });
});

describe('periods and year-end close', () => {
  const lastYear = thisYear - 1;
  let lastYearId: string;

  it('closes periods in order once they have ended, and blocks postings into them', async () => {
    lastYearId = (await ensureFiscalYear(prisma(), lastYear, 1)).id;
    await postManual(`${lastYear}-06-15`, 'Consulting income', [jl('1010', '10000.00'), jl('4200', '', '10000.00')]);
    await postManual(`${lastYear}-07-01`, 'July rent', [jl('6000', '4000.00'), jl('1010', '', '4000.00')]);

    const years = await ok(get(accountant, '/accounting/fiscal-years'));
    const ly = years.find((y: { id: string }) => y.id === lastYearId);
    const current = years.find((y: { name: string }) => y.name === `FY${thisYear}`);
    expect(ly.periods).toHaveLength(12);
    const [jan, feb] = ly.periods;

    expect(await status(send(accountant, 'post', `/accounting/periods/${feb.id}/close`))).toBe(422); // January first
    const thisMonth = current.periods.find((p: { startDate: string; endDate: string }) => p.startDate <= today && p.endDate >= today);
    expect((await send(accountant, 'post', `/accounting/periods/${thisMonth.id}/close`)).body.error.message).toMatch(/has not ended/);
    expect(await status(send(manager, 'post', `/accounting/periods/${jan.id}/close`))).toBe(403);

    // A draft in the period must be dealt with before closing.
    const draft = await ok(send(accountant, 'post', '/accounting/journals', { entryDate: `${lastYear}-01-20`, description: 'Pending', lines: [jl('6000', '1.00'), jl('1010', '', '1.00')] }), 201);
    expect((await send(accountant, 'post', `/accounting/periods/${jan.id}/close`)).body.error.message).toMatch(/draft journal/);
    await ok(send(accountant, 'delete', `/accounting/journals/${draft.id}`), 204);
    await ok(send(accountant, 'post', `/accounting/periods/${jan.id}/close`));

    const late = await ok(send(accountant, 'post', '/accounting/journals', { entryDate: `${lastYear}-01-25`, description: 'Late', lines: [jl('6000', '1.00'), jl('1010', '', '1.00')] }), 201);
    expect((await send(accountant, 'post', `/accounting/journals/${late.id}/post`)).body.error.message).toMatch(/is closed/);
    await send(accountant, 'delete', `/accounting/journals/${late.id}`);

    // Reopen only the latest closed period.
    await ok(send(accountant, 'post', `/accounting/periods/${feb.id}/close`));
    expect((await send(accountant, 'post', `/accounting/periods/${jan.id}/reopen`, { reason: 'Missed invoice' })).body.error.message).toMatch(/Reopen Feb/);
    await ok(send(accountant, 'post', `/accounting/periods/${feb.id}/reopen`, { reason: 'Missed invoice' }));
    await ok(send(accountant, 'post', `/accounting/periods/${feb.id}/close`));
  });

  it('moves the year profit to retained earnings and locks the year', async () => {
    const years = await ok(get(accountant, '/accounting/fiscal-years'));
    const periods = years.find((y: { id: string }) => y.id === lastYearId).periods as { id: string; status: string }[];
    expect((await send(accountant, 'post', `/accounting/fiscal-years/${lastYearId}/close`)).body.error.message).toMatch(/Close every period/);
    for (const p of periods.slice(0, 11)) if (p.status === 'OPEN') await ok(send(accountant, 'post', `/accounting/periods/${p.id}/close`));

    const { closingEntry } = await ok(send(accountant, 'post', `/accounting/fiscal-years/${lastYearId}/close`));
    expect(closingEntry).toMatchObject({ sourceType: 'YEAR_END', entryDate: `${lastYear}-12-31` });
    const byCode = Object.fromEntries(closingEntry.lines.map((l: { account: { code: string }; debit: string; credit: string }) => [l.account.code, [l.debit, l.credit]]));
    expect(byCode).toEqual({ '4200': ['10000.00', '0.00'], '6000': ['0.00', '4000.00'], '3100': ['0.00', '6000.00'] });

    const after = (await ok(get(accountant, '/accounting/fiscal-years'))).find((y: { id: string }) => y.id === lastYearId);
    expect(after.status).toBe('CLOSED');
    expect(after.periods.every((p: { status: string }) => p.status === 'CLOSED')).toBe(true);
    expect(await status(send(accountant, 'post', `/accounting/periods/${after.periods[11].id}/reopen`, { reason: 'Try' }))).toBe(422);
    await expect(prisma().fiscalYear.update({ where: { id: lastYearId }, data: { status: 'OPEN' } })).rejects.toThrow(/cannot be reopened/);

    // The year's P&L is still reported (closing entries are left out), and the profit now sits in retained earnings.
    expect((await ok(get(accountant, `/reports/profit-and-loss?from=${lastYear}-01-01&to=${lastYear}-12-31`))).netProfit).toBe('6000.00');
    const bs = await ok(get(accountant, `/reports/balance-sheet?asOf=${lastYear}-12-31`));
    expect(bs.equity.rows).toEqual([{ account: expect.objectContaining({ code: '3100' }), amount: '6000.00' }]);
    expect(bs.currentEarnings).toBe('0.00');
  });

  it('adds the next fiscal year, one year ahead at most', async () => {
    const years = await ok(send(accountant, 'post', '/accounting/fiscal-years'), 201);
    expect(years.map((y: { name: string }) => y.name)).toContain(`FY${thisYear + 1}`);
    expect(await status(send(accountant, 'post', '/accounting/fiscal-years'))).toBe(422);
  });
});

describe('reports reconcile with the ledger (acceptance #13)', () => {
  beforeAll(async () => {
    // Trading activity: opening stock, a cash sale and a credit sale, plus owner money in and equipment bought.
    const gel = (await makeProduct((await prisma().user.findFirstOrThrow()).id, { variants: [{ sellingPrice: '1075.00' }] })).variants[0]!.id;
    const opening = await ok(send(manager, 'post', '/stock-adjustments', { locationId: await mainLocationId(), reason: 'OPENING_STOCK', lines: [{ variantId: gel, qtyChange: '10', unitCost: '600' }] }), 201);
    await ok(send(manager, 'post', `/stock-adjustments/${opening.id}/post`));

    const ctx = await ok(get(manager, '/pos/context'));
    const till = ctx.registers[0].id;
    const cash = ctx.paymentMethods.find((p: { code: string }) => p.code === 'CASH').id;
    await ok(send(manager, 'post', '/pos/shifts/open', { registerId: till, openingFloat: '0' }), 201);
    const sell = (body: object) => send(manager, 'post', '/pos/sales', { registerId: till, ...body }, { 'Idempotency-Key': randomUUID() });
    await ok(sell({ lines: [{ variantId: gel, qty: '2', unitPrice: '1075.00' }], payments: [{ paymentMethodId: cash, amount: '2150.00' }] }), 201);
    const customer = await ok(send(manager, 'post', '/customers', { name: 'Glow Salon', allowCredit: true, creditLimit: '5000' }), 201);
    await ok(sell({ customerId: customer.id, lines: [{ variantId: gel, qty: '1', unitPrice: '1075.00' }], payments: [{ paymentMethodId: cash, amount: '75.00' }] }), 201);

    await postManual(today, 'Owner adds capital', [jl('1010', '100000.00'), jl('3000', '', '100000.00')]);
    await postManual(today, 'Display shelving', [jl('1500', '30000.00'), jl('1010', '', '30000.00')]);
  });

  it('every entry balances and the trial balance agrees with the general ledger (acceptance #8)', async () => {
    const unbalanced = await prisma().$queryRaw<unknown[]>`
      SELECT je.id FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.status = 'POSTED' GROUP BY je.id, je.total_debit, je.total_credit
      HAVING SUM(jl.debit) <> SUM(jl.credit) OR SUM(jl.debit) <> je.total_debit OR je.total_debit <> je.total_credit`;
    expect(unbalanced).toEqual([]);

    const tb = await ok(get(owner, '/reports/trial-balance'));
    expect(tb.totals.debit).toBe(tb.totals.credit);
    for (const row of tb.rows as { account: { id: string; type: string }; debit: string; credit: string }[]) {
      const gl = await ok(get(owner, `/accounting/ledger?accountId=${row.account.id}&from=2000-01-01`));
      const debitNormal = row.account.type === 'ASSET' || row.account.type === 'EXPENSE';
      const net = dec(row.debit).minus(row.credit);
      expect(gl.closingBalance).toBe((debitNormal ? net : net.neg()).toFixed(2));
    }
  });

  it('pages the general ledger with a running balance', async () => {
    const all = await ok(get(owner, `/accounting/ledger?accountId=${acc['1010']}&from=${thisYear}-01-01`));
    expect(all.meta.total).toBeGreaterThan(3);
    const page2 = await ok(get(owner, `/accounting/ledger?accountId=${acc['1010']}&from=${thisYear}-01-01&pageSize=2&page=2`));
    expect(page2.lines).toEqual(all.lines.slice(2, 4));
    expect(all.lines.at(-1).balance).toBe(all.closingBalance);
    expect(dec(all.openingBalance).plus(all.totalDebit).minus(all.totalCredit).toFixed(2)).toBe(all.closingBalance);
  });

  it('balance sheet balances and its current earnings equal the profit for the year', async () => {
    const bs = await ok(get(owner, '/reports/balance-sheet'));
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssets).toBe(bs.totalLiabilitiesAndEquity);
    const pl = await ok(get(owner, `/reports/profit-and-loss?from=${thisYear}-01-01&to=${today}`));
    expect(pl.netProfit).toBe(bs.currentEarnings);
    // 3 gels sold for 3,000 net of VAT, cost 1,800; rent 40,000.
    expect(pl).toMatchObject({ netSales: '3000.00', grossProfit: '1200.00', netProfit: '-38800.00' });
    expect(pl.costOfSales.total).toBe('1800.00');
  });

  it('cash flow explains the change in cash, by activity', async () => {
    const cf = await ok(get(owner, `/reports/cash-flow?from=${thisYear}-01-01&to=${today}`));
    expect(dec(cf.openingCash).plus(cf.netChange).toFixed(2)).toBe(cf.closingCash);
    expect(cf.openingCash).toBe('206000.00'); // last year's net 6,000 + opening balances 200,000
    expect(cf.financing.rows).toEqual([{ account: expect.objectContaining({ code: '3000' }), amount: '100000.00' }]);
    expect(cf.investing.rows).toEqual([{ account: expect.objectContaining({ code: '1500' }), amount: '-30000.00' }]);
    const tb = await ok(get(owner, '/reports/trial-balance'));
    const cashIds = new Set(cf.cashAccounts.map((c: { account: { id: string } }) => c.account.id));
    const tbCash = sum(tb.rows.filter((r: { account: { id: string } }) => cashIds.has(r.account.id)).map((r: { debit: string; credit: string }) => dec(r.debit).minus(r.credit)));
    expect(tbCash.toFixed(2)).toBe(cf.closingCash);
  });

  it('aged receivables and payables equal their control accounts', async () => {
    const ar = await ok(get(owner, '/reports/receivables-aging'));
    expect(ar.totals.balance).toBe('1000.00');
    expect(ar.ledgerBalance).toBe(ar.totals.balance);
    expect(ar.rows).toEqual([expect.objectContaining({ customer: expect.objectContaining({ name: 'Glow Salon' }), days0to30: '1000.00' })]);

    const ap = await ok(get(owner, '/reports/payables-aging'));
    const tb = await ok(get(owner, '/reports/trial-balance'));
    const apRow = tb.rows.find((r: { account: { code: string } }) => r.account.code === '2000');
    expect(ap.totals.balance).toBe(apRow ? dec(apRow.credit).minus(apRow.debit).toFixed(2) : '0.00');

    expect((await ok(get(owner, '/inventory/valuation'))).difference).toBe('0.00');
  });

  it('lets managers read the statements but not the ledger', async () => {
    expect(await status(get(manager, '/reports/balance-sheet'))).toBe(200);
    expect(await status(get(manager, '/accounting/journals'))).toBe(403);
    expect(await status(get(cashier, '/reports/profit-and-loss'))).toBe(403);
  });
});
