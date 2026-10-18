import { Router } from 'express';
import { z } from 'zod';
import {
  adjustmentInputSchema,
  batchQuerySchema,
  documentListQuerySchema,
  movementQuerySchema,
  stockQuerySchema,
  transferInputSchema,
} from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { listEnvelope } from '../../lib/pagination';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requirePermission } from '../auth/auth.middleware';
import { cancelAdjustment, createAdjustment, getAdjustment, listAdjustments, postAdjustment, updateAdjustment } from './adjustments.service';
import { inventoryValuation, listBatches, listMovements, listStock } from './inventory.queries';
import { cancelTransfer, createTransfer, dispatchTransfer, getTransfer, listTransfers, receiveTransfer, updateTransfer } from './transfers.service';

const idParams = z.object({ id: z.uuid() });
const adjustmentListQuery = documentListQuerySchema.extend({ status: z.enum(['DRAFT', 'POSTED', 'CANCELLED']).optional() });
const transferListQuery = documentListQuerySchema.extend({ status: z.enum(['DRAFT', 'DISPATCHED', 'RECEIVED', 'CANCELLED']).optional() });
const movementQuery = movementQuerySchema.extend({
  type: z
    .enum(['OPENING', 'PURCHASE_RECEIPT', 'PURCHASE_RETURN', 'SALE', 'SALE_RETURN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'WRITE_OFF', 'TRANSFER_OUT', 'TRANSFER_IN'])
    .optional(),
});
const json = <T extends z.ZodType>(schema: T) => ({ body: { content: { 'application/json': { schema } } } });

registry.registerPath({ method: 'get', path: '/inventory/stock', tags: ['Inventory'], summary: 'Stock levels by variant, optional location and low-stock filter (inventory.view)', request: { query: stockQuerySchema }, responses: { 200: { description: 'Stock rows' } } });
registry.registerPath({ method: 'get', path: '/inventory/movements', tags: ['Inventory'], summary: 'Stock ledger (inventory.view)', request: { query: movementQuery }, responses: { 200: { description: 'Movements' } } });
registry.registerPath({ method: 'get', path: '/inventory/batches', tags: ['Inventory'], summary: 'Lots with stock, soonest expiry first (inventory.view)', request: { query: batchQuerySchema }, responses: { 200: { description: 'Batches' } } });
registry.registerPath({ method: 'get', path: '/inventory/valuation', tags: ['Inventory'], summary: 'Stock ledger value vs Inventory GL balance (inventory.view)', responses: { 200: { description: 'Valuation' } } });
registry.registerPath({ method: 'get', path: '/stock-adjustments', tags: ['Inventory'], summary: 'List adjustments (inventory.view)', request: { query: adjustmentListQuery }, responses: { 200: { description: 'Adjustments' } } });
registry.registerPath({ method: 'post', path: '/stock-adjustments', tags: ['Inventory'], summary: 'Create a draft adjustment (inventory.adjust)', request: json(adjustmentInputSchema), responses: { 201: { description: 'Draft' } } });
registry.registerPath({ method: 'get', path: '/stock-adjustments/{id}', tags: ['Inventory'], summary: 'Adjustment detail', request: { params: idParams }, responses: { 200: { description: 'Adjustment' } } });
registry.registerPath({ method: 'put', path: '/stock-adjustments/{id}', tags: ['Inventory'], summary: 'Replace a draft (inventory.adjust)', request: { params: idParams, ...json(adjustmentInputSchema) }, responses: { 200: { description: 'Draft' } } });
registry.registerPath({ method: 'post', path: '/stock-adjustments/{id}/post', tags: ['Inventory'], summary: 'Post: moves stock and posts the journal atomically (inventory.adjust.approve)', request: { params: idParams }, responses: { 200: { description: 'Posted' }, 409: { description: 'Insufficient stock' } } });
registry.registerPath({ method: 'post', path: '/stock-adjustments/{id}/cancel', tags: ['Inventory'], summary: 'Cancel a draft (inventory.adjust)', request: { params: idParams }, responses: { 200: { description: 'Cancelled' } } });
registry.registerPath({ method: 'get', path: '/stock-transfers', tags: ['Inventory'], summary: 'List transfers (inventory.view)', request: { query: transferListQuery }, responses: { 200: { description: 'Transfers' } } });
registry.registerPath({ method: 'post', path: '/stock-transfers', tags: ['Inventory'], summary: 'Create a draft transfer (inventory.transfer)', request: json(transferInputSchema), responses: { 201: { description: 'Draft' } } });
registry.registerPath({ method: 'get', path: '/stock-transfers/{id}', tags: ['Inventory'], summary: 'Transfer detail', request: { params: idParams }, responses: { 200: { description: 'Transfer' } } });
registry.registerPath({ method: 'put', path: '/stock-transfers/{id}', tags: ['Inventory'], summary: 'Replace a draft (inventory.transfer)', request: { params: idParams, ...json(transferInputSchema) }, responses: { 200: { description: 'Draft' } } });
for (const action of ['dispatch', 'receive', 'cancel'] as const) {
  registry.registerPath({ method: 'post', path: `/stock-transfers/{id}/${action}`, tags: ['Inventory'], summary: `${action[0]!.toUpperCase()}${action.slice(1)} (inventory.transfer)`, request: { params: idParams }, responses: { 200: { description: 'Transfer' } } });
}

export const inventoryRouter = Router();
const view = requirePermission('inventory.view');

inventoryRouter.get('/inventory/stock', ...view, async (req, res) => {
  const query = parse(stockQuerySchema, req.query);
  const { data, total } = await listStock(query);
  res.json(listEnvelope(data, total, query));
});
inventoryRouter.get('/inventory/movements', ...view, async (req, res) => {
  const query = parse(movementQuery, req.query);
  const { data, total } = await listMovements(query);
  res.json(listEnvelope(data, total, query));
});
inventoryRouter.get('/inventory/batches', ...view, async (req, res) => {
  const query = parse(batchQuerySchema, req.query);
  const { data, total } = await listBatches(query);
  res.json(listEnvelope(data, total, query));
});
inventoryRouter.get('/inventory/valuation', ...view, async (_req, res) => {
  res.json({ data: await inventoryValuation() });
});

// Adjustments
inventoryRouter.get('/stock-adjustments', ...view, async (req, res) => {
  const query = parse(adjustmentListQuery, req.query);
  const { data, total } = await listAdjustments(query);
  res.json(listEnvelope(data, total, query));
});
inventoryRouter.post('/stock-adjustments', ...requirePermission('inventory.adjust'), async (req, res) => {
  res.status(201).json({ data: await createAdjustment(parse(adjustmentInputSchema, req.body), requestContext(req)) });
});
inventoryRouter.get('/stock-adjustments/:id', ...view, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await getAdjustment(id) });
});
inventoryRouter.put('/stock-adjustments/:id', ...requirePermission('inventory.adjust'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await updateAdjustment(id, parse(adjustmentInputSchema, req.body), requestContext(req)) });
});
inventoryRouter.post('/stock-adjustments/:id/post', ...requirePermission('inventory.adjust.approve'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await postAdjustment(id, req.auth!, requestContext(req)) });
});
inventoryRouter.post('/stock-adjustments/:id/cancel', ...requirePermission('inventory.adjust'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await cancelAdjustment(id, requestContext(req)) });
});

// Transfers
inventoryRouter.get('/stock-transfers', ...view, async (req, res) => {
  const query = parse(transferListQuery, req.query);
  const { data, total } = await listTransfers(query);
  res.json(listEnvelope(data, total, query));
});
inventoryRouter.post('/stock-transfers', ...requirePermission('inventory.transfer'), async (req, res) => {
  res.status(201).json({ data: await createTransfer(parse(transferInputSchema, req.body), requestContext(req)) });
});
inventoryRouter.get('/stock-transfers/:id', ...view, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await getTransfer(id) });
});
inventoryRouter.put('/stock-transfers/:id', ...requirePermission('inventory.transfer'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await updateTransfer(id, parse(transferInputSchema, req.body), requestContext(req)) });
});
inventoryRouter.post('/stock-transfers/:id/dispatch', ...requirePermission('inventory.transfer'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await dispatchTransfer(id, requestContext(req)) });
});
inventoryRouter.post('/stock-transfers/:id/receive', ...requirePermission('inventory.transfer'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await receiveTransfer(id, requestContext(req)) });
});
inventoryRouter.post('/stock-transfers/:id/cancel', ...requirePermission('inventory.transfer'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await cancelTransfer(id, requestContext(req)) });
});
