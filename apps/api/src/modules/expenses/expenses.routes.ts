import { Router } from 'express';
import { z } from 'zod';
import { expenseCategorySchema, expenseInputSchema, expenseListQuerySchema, rejectReturnSchema } from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { listEnvelope } from '../../lib/pagination';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requireAnyPermission, requirePermission } from '../auth/auth.middleware';
import {
  approveExpense,
  createExpense,
  deleteExpense,
  getExpense,
  listExpenseCategories,
  listExpenses,
  rejectExpense,
  saveExpenseCategory,
  submitExpense,
  updateExpense,
} from './expenses.service';

const idParams = z.object({ id: z.uuid() });
const docs: [string, 'get' | 'post' | 'put' | 'patch' | 'delete', string, z.ZodType | undefined][] = [
  ['/expense-categories', 'get', 'Expense categories (expenses.view)', undefined],
  ['/expense-categories', 'post', 'Add a category (settings.manage)', expenseCategorySchema],
  ['/expense-categories/{id}', 'put', 'Edit a category (settings.manage)', expenseCategorySchema],
  ['/expenses', 'get', 'Expenses (expenses.view)', undefined],
  ['/expenses', 'post', 'Record a draft expense (expenses.create)', expenseInputSchema],
  ['/expenses/{id}', 'get', 'Expense with attachments (expenses.view)', undefined],
  ['/expenses/{id}', 'put', 'Edit a draft (recorder or expenses.approve)', expenseInputSchema],
  ['/expenses/{id}', 'delete', 'Delete a draft (recorder or expenses.approve)', undefined],
  ['/expenses/{id}/submit', 'post', 'Submit for approval (expenses.create)', undefined],
  ['/expenses/{id}/approve', 'post', 'Approve and post to the ledger (expenses.approve)', undefined],
  ['/expenses/{id}/reject', 'post', 'Send back to draft with a reason (expenses.approve)', rejectReturnSchema],
];
for (const [path, method, summary, body] of docs) {
  registry.registerPath({
    method,
    path,
    tags: ['Expenses'],
    summary,
    request: { ...(path.includes('{id}') ? { params: idParams } : {}), ...(body ? { body: { content: { 'application/json': { schema: body } } } } : {}) },
    responses: { 200: { description: 'OK' } },
  });
}

export const expensesRouter = Router();
const view = requireAnyPermission('expenses.view', 'expenses.create', 'expenses.approve');

expensesRouter.get('/expense-categories', ...view, async (_req, res) => {
  res.json({ data: await listExpenseCategories() });
});
expensesRouter.post('/expense-categories', ...requirePermission('settings.manage'), async (req, res) => {
  res.status(201).json({ data: await saveExpenseCategory(null, parse(expenseCategorySchema, req.body), requestContext(req)) });
});
expensesRouter.put('/expense-categories/:id', ...requirePermission('settings.manage'), async (req, res) => {
  res.json({ data: await saveExpenseCategory(parse(idParams, req.params).id, parse(expenseCategorySchema, req.body), requestContext(req)) });
});

expensesRouter.get('/expenses', ...view, async (req, res) => {
  const query = parse(expenseListQuerySchema, req.query);
  const { data, total } = await listExpenses(query);
  res.json(listEnvelope(data, total, query));
});
expensesRouter.post('/expenses', ...requirePermission('expenses.create'), async (req, res) => {
  res.status(201).json({ data: await createExpense(parse(expenseInputSchema, req.body), req.auth!.user.id, requestContext(req)) });
});
expensesRouter.get('/expenses/:id', ...view, async (req, res) => {
  res.json({ data: await getExpense(parse(idParams, req.params).id) });
});
expensesRouter.put('/expenses/:id', ...requireAnyPermission('expenses.create', 'expenses.approve'), async (req, res) => {
  res.json({ data: await updateExpense(parse(idParams, req.params).id, parse(expenseInputSchema, req.body), req.auth!, requestContext(req)) });
});
expensesRouter.delete('/expenses/:id', ...requireAnyPermission('expenses.create', 'expenses.approve'), async (req, res) => {
  await deleteExpense(parse(idParams, req.params).id, req.auth!, requestContext(req));
  res.status(204).end();
});
expensesRouter.post('/expenses/:id/submit', ...requireAnyPermission('expenses.create', 'expenses.approve'), async (req, res) => {
  res.json({ data: await submitExpense(parse(idParams, req.params).id, req.auth!, requestContext(req)) });
});
expensesRouter.post('/expenses/:id/approve', ...requirePermission('expenses.approve'), async (req, res) => {
  res.json({ data: await approveExpense(parse(idParams, req.params).id, req.auth!.user.id, requestContext(req)) });
});
expensesRouter.post('/expenses/:id/reject', ...requirePermission('expenses.approve'), async (req, res) => {
  const { reason } = parse(rejectReturnSchema, req.body);
  res.json({ data: await rejectExpense(parse(idParams, req.params).id, reason, req.auth!.user.id, requestContext(req)) });
});
