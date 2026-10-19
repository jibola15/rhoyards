import { Router, type Request } from 'express';
import { forbidden } from '../../lib/errors';
import { z } from 'zod';
import { customerInputSchema, customerListQuerySchema, customerReceiptSchema, customerUpdateSchema } from '@rhoyards/shared';
import { withIdempotency } from '../../lib/idempotency';
import { createCustomerReceipt, customerStatement, getCustomerReceipt } from './receivables.service';
import { requestContext } from '../../lib/audit';
import { listEnvelope } from '../../lib/pagination';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requireAnyPermission, requirePermission } from '../auth/auth.middleware';
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

registry.registerPath({ method: 'get', path: '/customers/{id}/statement', tags: ['Customers'], summary: 'Credit sales, payments and return credits with running balance; open sales (customers.view)', request: { params: idParams }, responses: { 200: { description: 'Statement' } } });
registry.registerPath({ method: 'post', path: '/customer-receipts', tags: ['Customers'], summary: 'Record a customer payment against credit sales (customer_receipts.manage, Idempotency-Key)', request: json(customerReceiptSchema), responses: { 201: { description: 'Recorded' } } });
registry.registerPath({ method: 'get', path: '/customer-receipts/{id}', tags: ['Customers'], summary: 'Customer payment (customers.view)', request: { params: idParams }, responses: { 200: { description: 'Receipt' } } });

customersRouter.get('/customers/:id/statement', ...requireAnyPermission('customers.view', 'customer_receipts.manage'), async (req, res) => {
  res.json({ data: await customerStatement(parse(idParams, req.params).id) });
});
customersRouter.post('/customer-receipts', ...requirePermission('customer_receipts.manage'), async (req, res) => {
  const input = parse(customerReceiptSchema, req.body);
  const result = await withIdempotency(`customer-receipt:${req.auth!.user.id}`, req.get('idempotency-key'), input, async () => ({
    status: 201,
    body: { data: await createCustomerReceipt(input, req.auth!.user.id, requestContext(req)) },
  }));
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
});
customersRouter.get('/customer-receipts/:id', ...requireAnyPermission('customers.view', 'customer_receipts.manage'), async (req, res) => {
  res.json({ data: await getCustomerReceipt(parse(idParams, req.params).id) });
});
