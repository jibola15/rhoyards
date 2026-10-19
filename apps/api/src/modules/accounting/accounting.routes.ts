import { Router } from 'express';
import { z } from 'zod';
import {
  accountInputSchema,
  accountUpdateSchema,
  asOfQuerySchema,
  journalInputSchema,
  journalListQuerySchema,
  ledgerQuerySchema,
  openingBalancesSchema,
  rangeQuerySchema,
  reopenPeriodSchema,
  reverseJournalSchema,
} from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { listEnvelope } from '../../lib/pagination';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requireAnyPermission, requirePermission } from '../auth/auth.middleware';
import { createAccount, listAccounts, updateAccount } from './accounts.service';
import { createJournal, deleteJournal, getJournal, listJournals, postJournalDraft, reverseLedgerEntry, updateJournal } from './journals.service';
import { openingBalancesState, postOpeningBalances } from './opening-balances.service';
import { closeFiscalYear, closePeriod, createNextFiscalYear, listFiscalYears, reopenPeriod } from './periods.service';
import { balanceSheet, cashFlow, generalLedger, profitAndLoss, receivablesAging, trialBalance } from './reports.service';

const idParams = z.object({ id: z.uuid() });
const view = requirePermission('accounting.view');
const statements = requireAnyPermission('reports.financial', 'accounting.view');

// ── OpenAPI ──────────────────────────────────────────────────────────────
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const docs: [string, Method, string, z.ZodType | undefined, z.ZodObject | undefined][] = [
  ['/accounting/accounts', 'get', 'Chart of accounts with posted balances (accounting.view)', undefined, undefined],
  ['/accounting/accounts', 'post', 'Add an account (accounts.manage)', accountInputSchema, undefined],
  ['/accounting/accounts/{id}', 'patch', 'Edit, reclassify or deactivate an account (accounts.manage)', accountUpdateSchema, undefined],
  ['/accounting/journals', 'get', 'Journal entries, all sources (accounting.view)', undefined, journalListQuerySchema],
  ['/accounting/journals', 'post', 'Create a draft manual journal (journals.create)', journalInputSchema, undefined],
  ['/accounting/journals/{id}', 'get', 'Journal entry with lines (accounting.view)', undefined, undefined],
  ['/accounting/journals/{id}', 'put', 'Replace a draft manual journal (journals.create)', journalInputSchema, undefined],
  ['/accounting/journals/{id}', 'delete', 'Delete a draft manual journal (journals.create)', undefined, undefined],
  ['/accounting/journals/{id}/post', 'post', 'Post a draft manual journal (journals.post)', undefined, undefined],
  ['/accounting/journals/{id}/reverse', 'post', 'Reverse a posted manual or opening-balance entry (journals.reverse)', reverseJournalSchema, undefined],
  ['/accounting/fiscal-years', 'get', 'Fiscal years and their periods (accounting.view)', undefined, undefined],
  ['/accounting/fiscal-years', 'post', 'Add the next fiscal year with 12 monthly periods (periods.manage)', undefined, undefined],
  ['/accounting/fiscal-years/{id}/close', 'post', 'Year-end close: profit to retained earnings, year locked (periods.manage)', undefined, undefined],
  ['/accounting/periods/{id}/close', 'post', 'Close a period that has ended (periods.manage)', undefined, undefined],
  ['/accounting/periods/{id}/reopen', 'post', 'Reopen the latest closed period (periods.manage)', reopenPeriodSchema, undefined],
  ['/accounting/opening-balances', 'get', 'Opening balances in force and eligible accounts (accounting.view)', undefined, undefined],
  ['/accounting/opening-balances', 'post', 'Post opening balances; the difference goes to Opening balance equity (journals.post)', openingBalancesSchema, undefined],
  ['/accounting/ledger', 'get', 'General ledger for one account with running balance (accounting.view)', undefined, ledgerQuerySchema],
  ['/reports/trial-balance', 'get', 'Trial balance (reports.financial or accounting.view)', undefined, asOfQuerySchema],
  ['/reports/profit-and-loss', 'get', 'Profit and loss (reports.financial or accounting.view)', undefined, rangeQuerySchema],
  ['/reports/balance-sheet', 'get', 'Balance sheet (reports.financial or accounting.view)', undefined, asOfQuerySchema],
  ['/reports/cash-flow', 'get', 'Cash flow, direct method (reports.financial or accounting.view)', undefined, rangeQuerySchema],
  ['/reports/receivables-aging', 'get', 'Aged receivables by customer (reports.financial or accounting.view)', undefined, asOfQuerySchema],
];
for (const [path, method, summary, body, query] of docs) {
  registry.registerPath({
    method,
    path,
    tags: ['Accounting'],
    summary,
    request: {
      ...(path.includes('{id}') ? { params: idParams } : {}),
      ...(query ? { query } : {}),
      ...(body ? { body: { content: { 'application/json': { schema: body } } } } : {}),
    },
    responses: { 200: { description: 'OK' } },
  });
}

export const accountingRouter = Router();

// ── Chart of accounts ────────────────────────────────────────────────────
accountingRouter.get('/accounting/accounts', ...view, async (_req, res) => {
  res.json({ data: await listAccounts() });
});
accountingRouter.post('/accounting/accounts', ...requirePermission('accounts.manage'), async (req, res) => {
  res.status(201).json({ data: await createAccount(parse(accountInputSchema, req.body), requestContext(req)) });
});
accountingRouter.patch('/accounting/accounts/:id', ...requirePermission('accounts.manage'), async (req, res) => {
  res.json({ data: await updateAccount(parse(idParams, req.params).id, parse(accountUpdateSchema, req.body), requestContext(req)) });
});

// ── Journals ─────────────────────────────────────────────────────────────
accountingRouter.get('/accounting/journals', ...view, async (req, res) => {
  const query = parse(journalListQuerySchema, req.query);
  const { data, total } = await listJournals(query);
  res.json(listEnvelope(data, total, query));
});
accountingRouter.post('/accounting/journals', ...requirePermission('journals.create'), async (req, res) => {
  res.status(201).json({ data: await createJournal(parse(journalInputSchema, req.body), req.auth!.user.id, requestContext(req)) });
});
accountingRouter.get('/accounting/journals/:id', ...view, async (req, res) => {
  res.json({ data: await getJournal(parse(idParams, req.params).id) });
});
accountingRouter.put('/accounting/journals/:id', ...requirePermission('journals.create'), async (req, res) => {
  res.json({ data: await updateJournal(parse(idParams, req.params).id, parse(journalInputSchema, req.body), requestContext(req)) });
});
accountingRouter.delete('/accounting/journals/:id', ...requirePermission('journals.create'), async (req, res) => {
  await deleteJournal(parse(idParams, req.params).id, requestContext(req));
  res.status(204).end();
});
accountingRouter.post('/accounting/journals/:id/post', ...requirePermission('journals.post'), async (req, res) => {
  res.json({ data: await postJournalDraft(parse(idParams, req.params).id, req.auth!.user.id, requestContext(req)) });
});
accountingRouter.post('/accounting/journals/:id/reverse', ...requirePermission('journals.reverse'), async (req, res) => {
  const input = parse(reverseJournalSchema, req.body);
  res.status(201).json({ data: await reverseLedgerEntry(parse(idParams, req.params).id, input, req.auth!.user.id, requestContext(req)) });
});

// ── Periods ──────────────────────────────────────────────────────────────
accountingRouter.get('/accounting/fiscal-years', ...view, async (_req, res) => {
  res.json({ data: await listFiscalYears() });
});
accountingRouter.post('/accounting/fiscal-years', ...requirePermission('periods.manage'), async (req, res) => {
  await createNextFiscalYear(requestContext(req));
  res.status(201).json({ data: await listFiscalYears() });
});
accountingRouter.post('/accounting/fiscal-years/:id/close', ...requirePermission('periods.manage'), async (req, res) => {
  const result = await closeFiscalYear(parse(idParams, req.params).id, req.auth!.user.id, requestContext(req));
  res.json({ data: { ...result, years: await listFiscalYears() } });
});
accountingRouter.post('/accounting/periods/:id/close', ...requirePermission('periods.manage'), async (req, res) => {
  await closePeriod(parse(idParams, req.params).id, req.auth!.user.id, requestContext(req));
  res.json({ data: await listFiscalYears() });
});
accountingRouter.post('/accounting/periods/:id/reopen', ...requirePermission('periods.manage'), async (req, res) => {
  const { reason } = parse(reopenPeriodSchema, req.body);
  await reopenPeriod(parse(idParams, req.params).id, reason, requestContext(req));
  res.json({ data: await listFiscalYears() });
});

// ── Opening balances ─────────────────────────────────────────────────────
accountingRouter.get('/accounting/opening-balances', ...view, async (_req, res) => {
  res.json({ data: await openingBalancesState() });
});
accountingRouter.post('/accounting/opening-balances', ...requirePermission('journals.post'), async (req, res) => {
  res.status(201).json({ data: await postOpeningBalances(parse(openingBalancesSchema, req.body), req.auth!.user.id, requestContext(req)) });
});

// ── Ledger and statements ────────────────────────────────────────────────
accountingRouter.get('/accounting/ledger', ...view, async (req, res) => {
  res.json({ data: await generalLedger(parse(ledgerQuerySchema, req.query)) });
});
accountingRouter.get('/reports/trial-balance', ...statements, async (req, res) => {
  res.json({ data: await trialBalance(parse(asOfQuerySchema, req.query).asOf) });
});
accountingRouter.get('/reports/profit-and-loss', ...statements, async (req, res) => {
  const { from, to } = parse(rangeQuerySchema, req.query);
  res.json({ data: await profitAndLoss(from, to) });
});
accountingRouter.get('/reports/balance-sheet', ...statements, async (req, res) => {
  res.json({ data: await balanceSheet(parse(asOfQuerySchema, req.query).asOf) });
});
accountingRouter.get('/reports/cash-flow', ...statements, async (req, res) => {
  const { from, to } = parse(rangeQuerySchema, req.query);
  res.json({ data: await cashFlow(from, to) });
});
accountingRouter.get('/reports/receivables-aging', ...statements, async (req, res) => {
  res.json({ data: await receivablesAging(parse(asOfQuerySchema, req.query).asOf) });
});
