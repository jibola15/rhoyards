import { Router } from 'express';
import { z } from 'zod';
import { refundInputSchema, rejectReturnSchema, returnInputSchema, returnListQuerySchema } from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { withIdempotency } from '../../lib/idempotency';
import { listEnvelope } from '../../lib/pagination';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requireAnyPermission, requirePermission } from '../auth/auth.middleware';
import { approveReturn, completeReturn, createReturn, getReturn, listReturns, rejectReturn, returnableSale } from './returns.service';

const idParams = z.object({ id: z.uuid() });
const docs: [string, 'get' | 'post', string, z.ZodType | undefined][] = [
  ['/returns', 'get', 'Sales returns (returns.create, returns.approve, refunds.process or sales.view)', undefined],
  ['/returns', 'post', 'Request a return (returns.create); approve: true also approves it (returns.approve)', returnInputSchema],
  ['/returns/{id}', 'get', 'Return with lines and refund', undefined],
  ['/returns/{id}/approve', 'post', 'Approve (returns.approve)', undefined],
  ['/returns/{id}/reject', 'post', 'Reject (returns.approve)', rejectReturnSchema],
  ['/returns/{id}/refund', 'post', 'Refund and complete: stock, ledger and payment in one transaction (refunds.process, Idempotency-Key)', refundInputSchema],
  ['/sales/{id}/returnable', 'get', 'What can still be returned from a sale (returns.create)', undefined],
];
for (const [path, method, summary, body] of docs) {
  registry.registerPath({
    method,
    path,
    tags: ['Returns'],
    summary,
    request: { ...(path.includes('{id}') ? { params: idParams } : {}), ...(body ? { body: { content: { 'application/json': { schema: body } } } } : {}) },
    responses: { 200: { description: 'OK' } },
  });
}

export const returnsRouter = Router();
const view = requireAnyPermission('returns.create', 'returns.approve', 'refunds.process', 'sales.view');

returnsRouter.get('/returns', ...view, async (req, res) => {
  const query = parse(returnListQuerySchema, req.query);
  const { data, total } = await listReturns(query);
  res.json(listEnvelope(data, total, query));
});
returnsRouter.get('/returns/:id', ...view, async (req, res) => {
  res.json({ data: await getReturn(parse(idParams, req.params).id) });
});
returnsRouter.get('/sales/:id/returnable', ...requirePermission('returns.create'), async (req, res) => {
  res.json({ data: await returnableSale(parse(idParams, req.params).id) });
});
returnsRouter.post('/returns', ...requirePermission('returns.create'), async (req, res) => {
  res.status(201).json({ data: await createReturn(parse(returnInputSchema, req.body), req.auth!, requestContext(req)) });
});
returnsRouter.post('/returns/:id/approve', ...requirePermission('returns.approve'), async (req, res) => {
  res.json({ data: await approveReturn(parse(idParams, req.params).id, req.auth!.user.id, requestContext(req)) });
});
returnsRouter.post('/returns/:id/reject', ...requirePermission('returns.approve'), async (req, res) => {
  const { reason } = parse(rejectReturnSchema, req.body);
  res.json({ data: await rejectReturn(parse(idParams, req.params).id, reason, req.auth!.user.id, requestContext(req)) });
});
returnsRouter.post('/returns/:id/refund', ...requirePermission('refunds.process'), async (req, res) => {
  const id = parse(idParams, req.params).id;
  const input = parse(refundInputSchema, req.body);
  const result = await withIdempotency(`refund:${id}`, req.get('idempotency-key'), input, async () => ({
    status: 200,
    body: { data: await completeReturn(id, input, req.auth!.user.id, requestContext(req)) },
  }));
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
});
