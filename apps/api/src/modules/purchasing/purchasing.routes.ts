import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  dateInput,
  grnInputSchema,
  invoiceInputSchema,
  paymentInputSchema,
  poInputSchema,
  purchaseListQuerySchema,
  purchaseReturnInputSchema,
} from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { withIdempotency } from '../../lib/idempotency';
import { listEnvelope } from '../../lib/pagination';
import { getPrisma } from '../../lib/prisma';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requireAnyPermission, requirePermission } from '../auth/auth.middleware';
import { assertLocationAccess, bodyStore, documentStore, locationScope } from '../auth/location-scope';
import {
  cancelSupplierInvoice,
  createSupplierInvoice,
  getSupplierInvoice,
  listSupplierInvoices,
  openReceiptLines,
  postSupplierInvoice,
  updateSupplierInvoice,
} from './invoices.service';
import { approvePurchaseOrder, createPurchaseOrder, endPurchaseOrder, getPurchaseOrder, listPurchaseOrders, updatePurchaseOrder } from './orders.service';
import { createSupplierPayment, getSupplierPayment, listSupplierPayments } from './payments.service';
import {
  cancelGoodsReceipt,
  createGoodsReceipt,
  getGoodsReceipt,
  listGoodsReceipts,
  postGoodsReceipt,
  receiveFromPurchaseOrder,
  updateGoodsReceipt,
} from './receipts.service';
import { cancelPurchaseReturn, createPurchaseReturn, getPurchaseReturn, listPurchaseReturns, postPurchaseReturn, updatePurchaseReturn } from './returns.service';
import { accountOptions, payablesAging, supplierStatement } from './statements.service';

const idParams = z.object({ id: z.uuid() });
const json = <T extends z.ZodType>(schema: T) => ({ body: { content: { 'application/json': { schema } } } });
const listQuery = (statuses: [string, ...string[]]) => purchaseListQuerySchema.extend({ status: z.enum(statuses).optional() });
const poListQuery = listQuery(['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED']);
const docListQuery = listQuery(['DRAFT', 'POSTED', 'CANCELLED']);
const invoiceListQuery = listQuery(['DRAFT', 'POSTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED']).extend({
  openOnly: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

const requireAny = requireAnyPermission;

const view = requirePermission('purchasing.view');
const manage = requirePermission('purchasing.manage');
const invoices = requirePermission('supplier_invoices.manage');
const payments = requirePermission('supplier_payments.manage');

// ── OpenAPI ──────────────────────────────────────────────────────────────
const docs: [string, 'get' | 'post' | 'put', string, z.ZodType | undefined][] = [
  ['/purchase-orders', 'get', 'List purchase orders (purchasing.view)', undefined],
  ['/purchase-orders', 'post', 'Create a draft purchase order (purchasing.manage)', poInputSchema],
  ['/purchase-orders/{id}', 'get', 'Purchase order with lines and receipts', undefined],
  ['/purchase-orders/{id}', 'put', 'Replace a draft (purchasing.manage)', poInputSchema],
  ['/purchase-orders/{id}/approve', 'post', 'Approve (purchasing.approve)', undefined],
  ['/purchase-orders/{id}/cancel', 'post', 'Cancel an order with nothing received (purchasing.manage)', undefined],
  ['/purchase-orders/{id}/close', 'post', 'Close a partly received order (purchasing.manage)', undefined],
  ['/purchase-orders/{id}/receipts', 'post', 'Create a draft goods receipt for the outstanding quantities (purchasing.manage)', undefined],
  ['/goods-receipts', 'get', 'List goods receipts (purchasing.view)', undefined],
  ['/goods-receipts', 'post', 'Create a draft goods receipt (purchasing.manage)', grnInputSchema],
  ['/goods-receipts/{id}', 'get', 'Goods receipt detail', undefined],
  ['/goods-receipts/{id}', 'put', 'Replace a draft (purchasing.manage)', grnInputSchema],
  ['/goods-receipts/{id}/post', 'post', 'Post: stock in, order updated, Dr Inventory / Cr GRNI (purchasing.manage)', undefined],
  ['/goods-receipts/{id}/cancel', 'post', 'Cancel a draft (purchasing.manage)', undefined],
  ['/supplier-invoices', 'get', 'List supplier invoices (purchasing.view)', undefined],
  ['/supplier-invoices', 'post', 'Create a draft invoice (supplier_invoices.manage)', invoiceInputSchema],
  ['/supplier-invoices/open-receipt-lines', 'get', 'Received goods not yet invoiced for ?supplierId= (supplier_invoices.manage)', undefined],
  ['/supplier-invoices/{id}', 'get', 'Invoice detail with payments', undefined],
  ['/supplier-invoices/{id}', 'put', 'Replace a draft (supplier_invoices.manage)', invoiceInputSchema],
  ['/supplier-invoices/{id}/post', 'post', 'Post: match receipts, Dr GRNI ± variance, Dr VAT input / Cr AP (supplier_invoices.manage)', undefined],
  ['/supplier-invoices/{id}/cancel', 'post', 'Cancel a draft (supplier_invoices.manage)', undefined],
  ['/supplier-payments', 'get', 'List supplier payments (purchasing.view or supplier_payments.manage)', undefined],
  ['/supplier-payments', 'post', 'Record a payment — requires an Idempotency-Key header (supplier_payments.manage)', paymentInputSchema],
  ['/supplier-payments/{id}', 'get', 'Payment detail with allocations', undefined],
  ['/purchase-returns', 'get', 'List returns to suppliers (purchasing.view)', undefined],
  ['/purchase-returns', 'post', 'Create a draft return against a goods receipt (purchasing.manage)', purchaseReturnInputSchema],
  ['/purchase-returns/{id}', 'get', 'Return detail', undefined],
  ['/purchase-returns/{id}', 'put', 'Replace a draft (purchasing.manage)', purchaseReturnInputSchema],
  ['/purchase-returns/{id}/post', 'post', 'Post: stock out, GRNI cleared or debit note raised (purchasing.manage)', undefined],
  ['/purchase-returns/{id}/cancel', 'post', 'Cancel a draft (purchasing.manage)', undefined],
  ['/suppliers/{id}/statement', 'get', 'Supplier statement with running balance (?from=&to=) (purchasing.view)', undefined],
  ['/reports/payables-aging', 'get', 'Aged payables by supplier (?asOf=) (purchasing.view)', undefined],
  ['/purchasing/accounts', 'get', 'Accounts for purchasing forms (?kind=payment|expense)', undefined],
];
for (const [path, method, summary, body] of docs) {
  registry.registerPath({
    method,
    path,
    tags: ['Purchasing'],
    summary,
    request: { ...(path.includes('{id}') ? { params: idParams } : {}), ...(body ? json(body) : {}) },
    responses: { 200: { description: 'OK' } },
  });
}

// Store access (see auth/location-scope.ts): purchasing documents belong to the store that receives the goods.
const poStore = documentStore(async (id) => {
  const d = await getPrisma().purchaseOrder.findUnique({ where: { id }, select: { locationId: true } });
  return d ? [d.locationId] : null;
});
const grnStore = documentStore(async (id) => {
  const d = await getPrisma().goodsReceipt.findUnique({ where: { id }, select: { locationId: true } });
  return d ? [d.locationId] : null;
});
const returnStore = documentStore(async (id) => {
  const d = await getPrisma().purchaseReturn.findUnique({ where: { id }, select: { locationId: true } });
  return d ? [d.locationId] : null;
});
/** A purchase return is made from a goods receipt, at that receipt's store. */
const returnReceiptStore: RequestHandler = async (req, _res, next) => {
  const receiptId = (req.body as { receiptId?: unknown } | undefined)?.receiptId;
  if (locationScope(req.auth) && typeof receiptId === 'string' && /^[0-9a-f-]{36}$/i.test(receiptId)) {
    const grn = await getPrisma().goodsReceipt.findUnique({ where: { id: receiptId }, select: { locationId: true } });
    if (grn) assertLocationAccess(req.auth, grn.locationId);
  }
  next();
};

export const purchasingRouter = Router();

// Purchase orders
purchasingRouter.get('/purchase-orders', ...view, async (req, res) => {
  const q = parse(poListQuery, req.query);
  const { data, total } = await listPurchaseOrders(q, locationScope(req.auth));
  res.json(listEnvelope(data, total, q));
});
purchasingRouter.post('/purchase-orders', ...manage, bodyStore((b) => b.locationId), async (req, res) => {
  res.status(201).json({ data: await createPurchaseOrder(parse(poInputSchema, req.body), requestContext(req)) });
});
purchasingRouter.get('/purchase-orders/:id', ...view, poStore, async (req, res) => {
  res.json({ data: await getPurchaseOrder(parse(idParams, req.params).id) });
});
purchasingRouter.put('/purchase-orders/:id', ...manage, poStore, bodyStore((b) => b.locationId), async (req, res) => {
  res.json({ data: await updatePurchaseOrder(parse(idParams, req.params).id, parse(poInputSchema, req.body), requestContext(req)) });
});
purchasingRouter.post('/purchase-orders/:id/approve', ...requirePermission('purchasing.approve'), poStore, async (req, res) => {
  res.json({ data: await approvePurchaseOrder(parse(idParams, req.params).id, requestContext(req)) });
});
purchasingRouter.post('/purchase-orders/:id/cancel', ...manage, poStore, async (req, res) => {
  res.json({ data: await endPurchaseOrder(parse(idParams, req.params).id, 'cancel', requestContext(req)) });
});
purchasingRouter.post('/purchase-orders/:id/close', ...manage, poStore, async (req, res) => {
  res.json({ data: await endPurchaseOrder(parse(idParams, req.params).id, 'close', requestContext(req)) });
});
purchasingRouter.post('/purchase-orders/:id/receipts', ...manage, poStore, async (req, res) => {
  const { receivedDate } = parse(z.object({ receivedDate: dateInput.default(new Date().toISOString().slice(0, 10)) }), req.body ?? {});
  res.status(201).json({ data: await receiveFromPurchaseOrder(parse(idParams, req.params).id, receivedDate, requestContext(req)) });
});

// Goods receipts
purchasingRouter.get('/goods-receipts', ...view, async (req, res) => {
  const q = parse(docListQuery, req.query);
  const { data, total } = await listGoodsReceipts(q, locationScope(req.auth));
  res.json(listEnvelope(data, total, q));
});
purchasingRouter.post('/goods-receipts', ...manage, bodyStore((b) => b.locationId), async (req, res) => {
  res.status(201).json({ data: await createGoodsReceipt(parse(grnInputSchema, req.body), requestContext(req)) });
});
purchasingRouter.get('/goods-receipts/:id', ...view, grnStore, async (req, res) => {
  res.json({ data: await getGoodsReceipt(parse(idParams, req.params).id) });
});
purchasingRouter.put('/goods-receipts/:id', ...manage, grnStore, bodyStore((b) => b.locationId), async (req, res) => {
  res.json({ data: await updateGoodsReceipt(parse(idParams, req.params).id, parse(grnInputSchema, req.body), requestContext(req)) });
});
purchasingRouter.post('/goods-receipts/:id/post', ...manage, grnStore, async (req, res) => {
  res.json({ data: await postGoodsReceipt(parse(idParams, req.params).id, requestContext(req)) });
});
purchasingRouter.post('/goods-receipts/:id/cancel', ...manage, grnStore, async (req, res) => {
  res.json({ data: await cancelGoodsReceipt(parse(idParams, req.params).id, requestContext(req)) });
});

// Supplier invoices
purchasingRouter.get('/supplier-invoices', ...requireAny('purchasing.view', 'supplier_invoices.manage', 'supplier_payments.manage'), async (req, res) => {
  const q = parse(invoiceListQuery, req.query);
  const { data, total } = await listSupplierInvoices(q);
  res.json(listEnvelope(data, total, q));
});
purchasingRouter.get('/supplier-invoices/open-receipt-lines', ...invoices, async (req, res) => {
  const { supplierId } = parse(z.object({ supplierId: z.uuid() }), req.query);
  res.json({ data: await openReceiptLines(supplierId) });
});
purchasingRouter.post('/supplier-invoices', ...invoices, async (req, res) => {
  res.status(201).json({ data: await createSupplierInvoice(parse(invoiceInputSchema, req.body), requestContext(req)) });
});
purchasingRouter.get('/supplier-invoices/:id', ...requireAny('purchasing.view', 'supplier_invoices.manage', 'supplier_payments.manage'), async (req, res) => {
  res.json({ data: await getSupplierInvoice(parse(idParams, req.params).id) });
});
purchasingRouter.put('/supplier-invoices/:id', ...invoices, async (req, res) => {
  res.json({ data: await updateSupplierInvoice(parse(idParams, req.params).id, parse(invoiceInputSchema, req.body), requestContext(req)) });
});
purchasingRouter.post('/supplier-invoices/:id/post', ...invoices, async (req, res) => {
  res.json({ data: await postSupplierInvoice(parse(idParams, req.params).id, requestContext(req)) });
});
purchasingRouter.post('/supplier-invoices/:id/cancel', ...invoices, async (req, res) => {
  res.json({ data: await cancelSupplierInvoice(parse(idParams, req.params).id, requestContext(req)) });
});

// Supplier payments
purchasingRouter.get('/supplier-payments', ...requireAny('purchasing.view', 'supplier_payments.manage'), async (req, res) => {
  const q = parse(purchaseListQuerySchema, req.query);
  const { data, total } = await listSupplierPayments(q);
  res.json(listEnvelope(data, total, q));
});
purchasingRouter.post('/supplier-payments', ...payments, async (req, res) => {
  const input = parse(paymentInputSchema, req.body);
  const ctx = requestContext(req);
  const result = await withIdempotency(`supplier-payment:${req.auth!.user.id}`, req.get('idempotency-key'), input, async () => ({
    status: 201,
    body: { data: await createSupplierPayment(input, ctx) },
  }));
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
});
purchasingRouter.get('/supplier-payments/:id', ...requireAny('purchasing.view', 'supplier_payments.manage'), async (req, res) => {
  res.json({ data: await getSupplierPayment(parse(idParams, req.params).id) });
});

// Purchase returns
purchasingRouter.get('/purchase-returns', ...view, async (req, res) => {
  const q = parse(docListQuery, req.query);
  const { data, total } = await listPurchaseReturns(q, locationScope(req.auth));
  res.json(listEnvelope(data, total, q));
});
purchasingRouter.post('/purchase-returns', ...manage, returnReceiptStore, async (req, res) => {
  res.status(201).json({ data: await createPurchaseReturn(parse(purchaseReturnInputSchema, req.body), requestContext(req)) });
});
purchasingRouter.get('/purchase-returns/:id', ...view, returnStore, async (req, res) => {
  res.json({ data: await getPurchaseReturn(parse(idParams, req.params).id) });
});
purchasingRouter.put('/purchase-returns/:id', ...manage, returnStore, returnReceiptStore, async (req, res) => {
  res.json({ data: await updatePurchaseReturn(parse(idParams, req.params).id, parse(purchaseReturnInputSchema, req.body), requestContext(req)) });
});
purchasingRouter.post('/purchase-returns/:id/post', ...manage, returnStore, async (req, res) => {
  res.json({ data: await postPurchaseReturn(parse(idParams, req.params).id, requestContext(req)) });
});
purchasingRouter.post('/purchase-returns/:id/cancel', ...manage, returnStore, async (req, res) => {
  res.json({ data: await cancelPurchaseReturn(parse(idParams, req.params).id, requestContext(req)) });
});

// Statements, ageing, account options
purchasingRouter.get('/suppliers/:id/statement', ...requireAny('purchasing.view', 'supplier_payments.manage'), async (req, res) => {
  const { from, to } = parse(z.object({ from: dateInput.optional(), to: dateInput.optional() }), req.query);
  res.json({ data: await supplierStatement(parse(idParams, req.params).id, from, to) });
});
purchasingRouter.get('/reports/payables-aging', ...requireAny('purchasing.view', 'reports.financial'), async (req, res) => {
  const { asOf } = parse(z.object({ asOf: dateInput.optional() }), req.query);
  res.json({ data: await payablesAging(asOf) });
});
purchasingRouter.get('/purchasing/accounts', ...requireAny('purchasing.view', 'supplier_invoices.manage', 'supplier_payments.manage', 'settings.manage', 'expenses.create', 'expenses.approve', 'reconciliation.manage'), async (req, res) => {
  const { kind } = parse(z.object({ kind: z.enum(['payment', 'expense']) }), req.query);
  res.json({ data: await accountOptions(kind) });
});
