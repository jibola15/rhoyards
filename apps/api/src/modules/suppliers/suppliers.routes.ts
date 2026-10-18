import { Router } from 'express';
import { z } from 'zod';
import { supplierInputSchema, supplierListQuerySchema, supplierUpdateSchema } from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { listEnvelope } from '../../lib/pagination';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requirePermission } from '../auth/auth.middleware';
import { createSupplier, getSupplier, listSuppliers, updateSupplier } from './suppliers.service';

const idParams = z.object({ id: z.uuid() });

registry.registerPath({ method: 'get', path: '/suppliers', tags: ['Suppliers'], summary: 'List suppliers (suppliers.view)', request: { query: supplierListQuerySchema }, responses: { 200: { description: 'Suppliers' } } });
registry.registerPath({ method: 'post', path: '/suppliers', tags: ['Suppliers'], summary: 'Create a supplier; code is generated if omitted (suppliers.manage)', request: { body: { content: { 'application/json': { schema: supplierInputSchema } } } }, responses: { 201: { description: 'Created' } } });
registry.registerPath({ method: 'get', path: '/suppliers/{id}', tags: ['Suppliers'], summary: 'Supplier (suppliers.view)', request: { params: idParams }, responses: { 200: { description: 'Supplier' } } });
registry.registerPath({ method: 'patch', path: '/suppliers/{id}', tags: ['Suppliers'], summary: 'Update or deactivate (suppliers.manage)', request: { params: idParams, body: { content: { 'application/json': { schema: supplierUpdateSchema } } } }, responses: { 200: { description: 'Updated' } } });

export const suppliersRouter = Router();

suppliersRouter.get('/suppliers', ...requirePermission('suppliers.view'), async (req, res) => {
  const query = parse(supplierListQuerySchema, req.query);
  const { data, total } = await listSuppliers(query);
  res.json(listEnvelope(data, total, query));
});
suppliersRouter.post('/suppliers', ...requirePermission('suppliers.manage'), async (req, res) => {
  res.status(201).json({ data: await createSupplier(parse(supplierInputSchema, req.body), requestContext(req)) });
});
suppliersRouter.get('/suppliers/:id', ...requirePermission('suppliers.view'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await getSupplier(id) });
});
suppliersRouter.patch('/suppliers/:id', ...requirePermission('suppliers.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await updateSupplier(id, parse(supplierUpdateSchema, req.body), requestContext(req)) });
});
