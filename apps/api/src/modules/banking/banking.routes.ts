import { Router } from 'express';
import { z } from 'zod';
import { reconciliationLinesSchema, reconciliationStartSchema, settlementSchema } from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requireAnyPermission, requirePermission } from '../auth/auth.middleware';
import { completeReconciliation, deleteReconciliation, getReconciliation, listReconciliations, recordSettlement, setClearedLines, startReconciliation } from './banking.service';

const idParams = z.object({ id: z.uuid() });
const docs: [string, 'get' | 'post' | 'put' | 'delete', string, z.ZodType | undefined][] = [
  ['/reconciliations', 'get', 'Bank and cash reconciliations (?accountId=) (reconciliation.manage or accounting.view)', undefined],
  ['/reconciliations', 'post', 'Start a reconciliation to a statement (reconciliation.manage)', reconciliationStartSchema],
  ['/reconciliations/{id}', 'get', 'Reconciliation with the lines on offer and the difference', undefined],
  ['/reconciliations/{id}', 'delete', 'Discard an unfinished reconciliation (reconciliation.manage)', undefined],
  ['/reconciliations/{id}/lines', 'put', 'Set the cleared lines (reconciliation.manage)', reconciliationLinesSchema],
  ['/reconciliations/{id}/complete', 'post', 'Complete when the difference is zero (reconciliation.manage)', undefined],
  ['/settlements', 'post', 'Card/gateway settlement into the bank, less charges (reconciliation.manage)', settlementSchema],
];
for (const [path, method, summary, body] of docs) {
  registry.registerPath({
    method,
    path,
    tags: ['Banking'],
    summary,
    request: { ...(path.includes('{id}') ? { params: idParams } : {}), ...(body ? { body: { content: { 'application/json': { schema: body } } } } : {}) },
    responses: { 200: { description: 'OK' } },
  });
}

export const bankingRouter = Router();
const view = requireAnyPermission('reconciliation.manage', 'accounting.view');
const manage = requirePermission('reconciliation.manage');

bankingRouter.get('/reconciliations', ...view, async (req, res) => {
  const { accountId } = parse(z.object({ accountId: z.uuid().optional() }), req.query);
  res.json({ data: await listReconciliations(accountId) });
});
bankingRouter.post('/reconciliations', ...manage, async (req, res) => {
  res.status(201).json({ data: await startReconciliation(parse(reconciliationStartSchema, req.body), req.auth!.user.id, requestContext(req)) });
});
bankingRouter.get('/reconciliations/:id', ...view, async (req, res) => {
  res.json({ data: await getReconciliation(parse(idParams, req.params).id) });
});
bankingRouter.delete('/reconciliations/:id', ...manage, async (req, res) => {
  await deleteReconciliation(parse(idParams, req.params).id, requestContext(req));
  res.status(204).end();
});
bankingRouter.put('/reconciliations/:id/lines', ...manage, async (req, res) => {
  res.json({ data: await setClearedLines(parse(idParams, req.params).id, parse(reconciliationLinesSchema, req.body).cleared) });
});
bankingRouter.post('/reconciliations/:id/complete', ...manage, async (req, res) => {
  res.json({ data: await completeReconciliation(parse(idParams, req.params).id, req.auth!.user.id, requestContext(req)) });
});
bankingRouter.post('/settlements', ...manage, async (req, res) => {
  res.status(201).json({ data: await recordSettlement(parse(settlementSchema, req.body), req.auth!.user.id, requestContext(req)) });
});
