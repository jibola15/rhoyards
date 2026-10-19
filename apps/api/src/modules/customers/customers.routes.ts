import { Router, type Request } from 'express';
import { forbidden } from '../../lib/errors';
import { z } from 'zod';
import { customerInputSchema, customerListQuerySchema, customerUpdateSchema } from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { listEnvelope } from '../../lib/pagination';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requirePermission } from '../auth/auth.middleware';
import { createCustomer, getCustomer, listCustomers, updateCustomer } from './customers.service';

const idParams = z.object({ id: z.uuid() });
const json = <T extends z.ZodType>(schema: T) => ({ body: { content: { 'application/json': { schema } } } });

registry.registerPath({ method: 'get', path: '/customers', tags: ['Customers'], summary: 'Search customers by name, phone, code or email (customers.view)', request: { query: customerListQuerySchema }, responses: { 200: { description: 'Customers with credit balance' } } });
registry.registerPath({ method: 'post', path: '/customers', tags: ['Customers'], summary: 'Create a customer (customers.manage)', request: json(customerInputSchema), responses: { 201: { description: 'Created' } } });
registry.registerPath({ method: 'get', path: '/customers/{id}', tags: ['Customers'], summary: 'Customer (customers.view)', request: { params: idParams }, responses: { 200: { description: 'Customer' } } });
registry.registerPath({ method: 'patch', path: '/customers/{id}', tags: ['Customers'], summary: 'Update or deactivate (customers.manage)', request: { params: idParams, ...json(customerUpdateSchema) }, responses: { 200: { description: 'Updated' } } });

export const customersRouter = Router();

customersRouter.get('/customers', ...requirePermission('customers.view'), async (req, res) => {
  const query = parse(customerListQuerySchema, req.query);
  const { data, total } = await listCustomers(query);
  res.json(listEnvelope(data, total, query));
});
/** Credit terms can only be set by users who may sell on credit. */
function assertMayGrantCredit(req: Request, touchesCredit: boolean) {
  if (touchesCredit && !req.auth!.permissions.has('pos.credit_sale')) {
    throw forbidden('Only staff allowed to sell on credit can set credit terms');
  }
}

customersRouter.post('/customers', ...requirePermission('customers.manage'), async (req, res) => {
  const input = parse(customerInputSchema, req.body);
  assertMayGrantCredit(req, input.allowCredit || Number(input.creditLimit) > 0);
  res.status(201).json({ data: await createCustomer(input, requestContext(req)) });
});
customersRouter.get('/customers/:id', ...requirePermission('customers.view'), async (req, res) => {
  res.json({ data: await getCustomer(parse(idParams, req.params).id) });
});
customersRouter.patch('/customers/:id', ...requirePermission('customers.manage'), async (req, res) => {
  const input = parse(customerUpdateSchema, req.body);
  assertMayGrantCredit(req, input.allowCredit !== undefined || input.creditLimit !== undefined);
  res.json({ data: await updateCustomer(parse(idParams, req.params).id, input, requestContext(req)) });
});
