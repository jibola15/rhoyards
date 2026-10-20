import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  closeShiftSchema,
  listQuerySchema,
  openShiftSchema,
  paymentMethodInputSchema,
  paymentMethodUpdateSchema,
  registerInputSchema,
  registerUpdateSchema,
  saleInputSchema,
  saleListQuerySchema,
  suspendSaleSchema,
  type PosContext,
} from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { AppError, forbidden } from '../../lib/errors';
import { withIdempotency } from '../../lib/idempotency';
import { listEnvelope } from '../../lib/pagination';
import { getPrisma } from '../../lib/prisma';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requireAnyPermission, requirePermission } from '../auth/auth.middleware';
import { assertLocationAccess, documentStore, locationScope } from '../auth/location-scope';
import { getSettings } from '../settings/settings.service';
import { completeSale, getSale, listSales, receiptFor, resumeSale, suspendSale } from './sales.service';
import { createPaymentMethod, createRegister, listPaymentMethods, listRegisters, updatePaymentMethod, updateRegister } from './setup.service';
import { closeShift, getShift, listShifts, myOpenShift, openShift } from './shifts.service';

const idParams = z.object({ id: z.uuid() });
const json = <T extends z.ZodType>(schema: T) => ({ body: { content: { 'application/json': { schema } } } });

const requireAny = requireAnyPermission;

const docs: [string, 'get' | 'post' | 'patch', string, z.ZodType | undefined][] = [
  ['/pos/context', 'get', 'Registers, my open shift, payment methods and pricing settings for the till (pos.sell)', undefined],
  ['/pos/shifts/open', 'post', 'Open a shift on a register with an opening float (pos.shift.manage)', openShiftSchema],
  ['/pos/shifts', 'get', 'List shifts (pos.shift.reconcile or sales.view)', undefined],
  ['/pos/shifts/{id}', 'get', 'Shift summary: takings by payment method and expected cash', undefined],
  ['/pos/shifts/{id}/close', 'post', 'Close with the counted cash; over/short is posted (own shift: pos.shift.manage; any: pos.shift.reconcile)', closeShiftSchema],
  ['/pos/sales', 'post', 'Complete a sale atomically — requires an Idempotency-Key header (pos.sell)', saleInputSchema],
  ['/pos/sales/suspend', 'post', 'Park a sale for later (pos.sell)', suspendSaleSchema],
  ['/pos/sales/suspended', 'get', 'Parked sales (?registerId=) (pos.sell)', undefined],
  ['/pos/sales/{id}/resume', 'post', 'Take a parked sale back to the till (pos.sell)', undefined],
  ['/sales', 'get', 'Completed sales (sales.view; cashiers see their own)', saleListQuerySchema],
  ['/sales/{id}', 'get', 'Sale detail', undefined],
  ['/sales/{id}/receipt', 'get', 'Receipt data', undefined],
  ['/payment-methods', 'get', 'Payment methods (settings.view)', undefined],
  ['/payment-methods', 'post', 'Create (settings.manage)', paymentMethodInputSchema],
  ['/payment-methods/{id}', 'patch', 'Update (settings.manage)', paymentMethodUpdateSchema],
  ['/registers', 'get', 'Registers (settings.view)', undefined],
  ['/registers', 'post', 'Create (locations.manage)', registerInputSchema],
  ['/registers/{id}', 'patch', 'Update (locations.manage)', registerUpdateSchema],
];
for (const [path, method, summary, body] of docs) {
  registry.registerPath({
    method,
    path,
    tags: ['POS'],
    summary,
    request: { ...(path.includes('{id}') ? { params: idParams } : {}), ...(body && method !== 'get' ? json(body) : {}) },
    responses: { 200: { description: 'OK' } },
  });
}

export const posRouter = Router();

/** A supervisor closes shifts only at their own stores (see auth/location-scope.ts). */
const shiftStore = documentStore(async (id) => {
  const s = await getPrisma().cashierShift.findUnique({ where: { id }, select: { register: { select: { locationId: true } } } });
  return s ? [s.register.locationId] : null;
});

// ── Till context ─────────────────────────────────────────────────────────
posRouter.get('/pos/context', ...requirePermission('pos.sell'), async (req, res) => {
  const settings = await getSettings();
  const context: PosContext = {
    registers: await listRegisters({ activeOnly: true, locationIds: req.auth!.user.locationIds }),
    myShift: await myOpenShift(req.auth!.user.id),
    paymentMethods: await listPaymentMethods({ posOnly: true }),
    pricing: {
      pricesIncludeTax: settings.pricing.pricesIncludeTax,
      vatRegistered: settings.business.vatRegistered,
      maxDiscountPercent: String(settings.pos.maxDiscountPercent),
    },
    inventory: { blockExpiredSale: settings.inventory.blockExpiredSale, allowNegativeStock: settings.inventory.allowNegativeStock },
    currency: settings.currency,
  };
  res.json({ data: context });
});

// ── Shifts ───────────────────────────────────────────────────────────────
posRouter.post('/pos/shifts/open', ...requirePermission('pos.shift.manage'), async (req, res) => {
  res.status(201).json({ data: await openShift(parse(openShiftSchema, req.body), req.auth!, requestContext(req)) });
});
posRouter.get('/pos/shifts', ...requireAny('pos.shift.reconcile', 'sales.view'), async (req, res) => {
  const q = parse(listQuerySchema.extend({ registerId: z.uuid().optional(), cashierId: z.uuid().optional(), status: z.enum(['OPEN', 'CLOSED']).optional() }), req.query);
  const { data, total } = await listShifts(q, locationScope(req.auth));
  res.json(listEnvelope(data, total, q));
});
posRouter.get('/pos/shifts/:id', ...requireAny('pos.shift.manage', 'pos.shift.reconcile', 'sales.view'), async (req, res) => {
  const shift = await getShift(parse(idParams, req.params).id);
  assertLocationAccess(req.auth, shift.register.locationId);
  const p = req.auth!.permissions;
  if (shift.cashier.id !== req.auth!.user.id && !p.has('pos.shift.reconcile') && !p.has('sales.view')) throw forbidden();
  res.json({ data: shift });
});
posRouter.post('/pos/shifts/:id/close', ...requireAny('pos.shift.manage', 'pos.shift.reconcile'), shiftStore, async (req, res) => {
  res.json({ data: await closeShift(parse(idParams, req.params).id, parse(closeShiftSchema, req.body), req.auth!, requestContext(req)) });
});

// ── Sales ────────────────────────────────────────────────────────────────
posRouter.post('/pos/sales', ...requirePermission('pos.sell'), async (req, res) => {
  const input = parse(saleInputSchema, req.body);
  const key = req.get('idempotency-key');
  // The key is stored with the request body minus the supervisor's password.
  const fingerprint = { ...input, discountApproval: input.discountApproval ? { email: input.discountApproval.email } : undefined };
  const result = await withIdempotency(`pos-sale:${req.auth!.user.id}`, key, fingerprint, async () => ({
    status: 201,
    body: { data: await completeSale(input, req.auth!, requestContext(req), key!) },
  }));
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
});
posRouter.post('/pos/sales/suspend', ...requirePermission('pos.sell'), async (req, res) => {
  res.status(201).json({ data: await suspendSale(parse(suspendSaleSchema, req.body), req.auth!, requestContext(req)) });
});
posRouter.get('/pos/sales/suspended', ...requirePermission('pos.sell'), async (req, res) => {
  const q = parse(listQuerySchema.extend({ registerId: z.uuid().optional() }), req.query);
  const { data, total } = await listSales({ ...q, status: 'SUSPENDED' }, locationScope(req.auth));
  res.json(listEnvelope(data, total, q));
});
posRouter.post('/pos/sales/:id/resume', ...requirePermission('pos.sell'), async (req, res) => {
  res.json({ data: await resumeSale(parse(idParams, req.params).id, req.auth!, requestContext(req)) });
});

/** Cashiers without sales.view see only the sales they rang up. */
function assertCanSeeSale(req: Parameters<RequestHandler>[0], sale: { cashierId: string; location: { id: string } }) {
  if (!req.auth!.permissions.has('sales.view') && sale.cashierId !== req.auth!.user.id) throw forbidden();
  assertLocationAccess(req.auth, sale.location.id);
}

posRouter.get('/sales', ...requireAny('sales.view', 'pos.sell'), async (req, res) => {
  const q = parse(saleListQuerySchema, req.query);
  const scoped = req.auth!.permissions.has('sales.view') ? q : { ...q, cashierId: req.auth!.user.id };
  const { data, total } = await listSales(scoped, locationScope(req.auth));
  res.json(listEnvelope(data, total, q));
});
posRouter.get('/sales/:id', ...requireAny('sales.view', 'pos.sell'), async (req, res) => {
  const sale = await getSale(parse(idParams, req.params).id);
  assertCanSeeSale(req, sale);
  res.json({ data: sale });
});
posRouter.get('/sales/:id/receipt', ...requireAny('sales.view', 'pos.sell'), async (req, res) => {
  const receipt = await receiptFor(parse(idParams, req.params).id);
  assertCanSeeSale(req, receipt.sale);
  res.json({ data: receipt });
});

// ── Setup: payment methods and registers ────────────────────────────────
posRouter.get('/payment-methods', ...requireAny('settings.view', 'pos.sell', 'refunds.process', 'customer_receipts.manage'), async (_req, res) => {
  res.json({ data: await listPaymentMethods() });
});
posRouter.post('/payment-methods', ...requirePermission('settings.manage'), async (req, res) => {
  res.status(201).json({ data: await createPaymentMethod(parse(paymentMethodInputSchema, req.body), requestContext(req)) });
});
posRouter.patch('/payment-methods/:id', ...requirePermission('settings.manage'), async (req, res) => {
  const input = parse(paymentMethodUpdateSchema, req.body);
  if (Object.keys(input).length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Nothing to update');
  res.json({ data: await updatePaymentMethod(parse(idParams, req.params).id, input, requestContext(req)) });
});
posRouter.get('/registers', ...requireAny('settings.view', 'pos.sell'), async (_req, res) => {
  res.json({ data: await listRegisters() });
});
posRouter.post('/registers', ...requirePermission('locations.manage'), async (req, res) => {
  res.status(201).json({ data: await createRegister(parse(registerInputSchema, req.body), requestContext(req)) });
});
posRouter.patch('/registers/:id', ...requirePermission('locations.manage'), async (req, res) => {
  const input = parse(registerUpdateSchema, req.body);
  if (Object.keys(input).length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Nothing to update');
  res.json({ data: await updateRegister(parse(idParams, req.params).id, input, requestContext(req)) });
});
