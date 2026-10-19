import { Router } from 'express';
import { z } from 'zod';
import {
  cancelOrderSchema,
  orderListQuerySchema,
  orderTransitionSchema,
  shippingMethodInputSchema,
  shippingMethodUpdateSchema,
  verifyPaymentSchema,
} from '@rhoyards/shared';
import type { Env } from '../../config/env';
import { requestContext } from '../../lib/audit';
import { listEnvelope } from '../../lib/pagination';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requireAnyPermission, requirePermission } from '../auth/auth.middleware';
import { cancelOrder, getOrder, listOrders, moveOrder, retryFulfilment, verifyManualPayment } from './orders.service';
import { createShippingMethod, listShippingMethods, updateShippingMethod } from './shipping.service';

const idParams = z.object({ id: z.uuid() });

type Method = 'get' | 'post' | 'patch';
const docs: [string, Method, string, z.ZodType | undefined][] = [
  ['/orders', 'get', 'Online orders (orders.view)', undefined],
  ['/orders/{id}', 'get', 'Online order with items, payments and history (orders.view)', undefined],
  ['/orders/{id}/status', 'post', 'Move a paid order through processing, packed, shipped, delivered (orders.manage)', orderTransitionSchema],
  ['/orders/{id}/cancel', 'post', 'Cancel an order awaiting payment; frees its stock (orders.manage)', cancelOrderSchema],
  ['/orders/{id}/verify-payment', 'post', 'Confirm a bank transfer for the order (payments.verify); creates the sale', verifyPaymentSchema],
  ['/orders/{id}/retry-fulfilment', 'post', 'Complete an on-hold order from its deposit once stock is back (orders.manage)', undefined],
  ['/shipping-methods', 'get', 'Delivery options (orders.view or settings.view)', undefined],
  ['/shipping-methods', 'post', 'Add a delivery option (settings.manage)', shippingMethodInputSchema],
  ['/shipping-methods/{id}', 'patch', 'Edit a delivery option (settings.manage)', shippingMethodUpdateSchema],
];
for (const [path, method, summary, body] of docs) {
  registry.registerPath({
    method,
    path,
    tags: ['Orders'],
    summary,
    request: {
      ...(path.includes('{id}') ? { params: idParams } : {}),
      ...(path === '/orders' ? { query: orderListQuerySchema } : {}),
      ...(body ? { body: { content: { 'application/json': { schema: body } } } } : {}),
    },
    responses: { 200: { description: 'OK' } },
  });
}

export function ordersRouter(env: Env) {
  const router = Router();
  const view = requirePermission('orders.view');
  const manage = requirePermission('orders.manage');

  router.get('/orders', ...view, async (req, res) => {
    const query = parse(orderListQuerySchema, req.query);
    const { data, total } = await listOrders(query);
    res.json(listEnvelope(data, total, query));
  });
  router.get('/orders/:id', ...view, async (req, res) => {
    res.json({ data: await getOrder(parse(idParams, req.params).id) });
  });
  router.post('/orders/:id/status', ...manage, async (req, res) => {
    const input = parse(orderTransitionSchema, req.body);
    res.json({ data: await moveOrder(parse(idParams, req.params).id, input, req.auth!.user.id, requestContext(req)) });
  });
  router.post('/orders/:id/cancel', ...manage, async (req, res) => {
    const id = parse(idParams, req.params).id;
    await cancelOrder(id, { userId: req.auth!.user.id }, parse(cancelOrderSchema, req.body).reason, requestContext(req));
    res.json({ data: await getOrder(id) });
  });
  router.post('/orders/:id/verify-payment', ...requirePermission('payments.verify'), async (req, res) => {
    const input = parse(verifyPaymentSchema, req.body);
    const { result, order } = await verifyManualPayment(parse(idParams, req.params).id, input, req.auth!.user.id, env, requestContext(req));
    res.json({ data: order, meta: { result } });
  });
  router.post('/orders/:id/retry-fulfilment', ...manage, async (req, res) => {
    res.json({ data: await retryFulfilment(parse(idParams, req.params).id, req.auth!.user.id, env, requestContext(req)) });
  });

  router.get('/shipping-methods', ...requireAnyPermission('orders.view', 'settings.view'), async (_req, res) => {
    res.json({ data: await listShippingMethods() });
  });
  router.post('/shipping-methods', ...requirePermission('settings.manage'), async (req, res) => {
    res.status(201).json({ data: await createShippingMethod(parse(shippingMethodInputSchema, req.body), requestContext(req)) });
  });
  router.patch('/shipping-methods/:id', ...requirePermission('settings.manage'), async (req, res) => {
    res.json({ data: await updateShippingMethod(parse(idParams, req.params).id, parse(shippingMethodUpdateSchema, req.body), requestContext(req)) });
  });
  return router;
}
