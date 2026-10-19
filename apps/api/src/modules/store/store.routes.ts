import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type {
  NIGERIAN_STATES} from '@rhoyards/shared';
import {
  cartQuoteSchema,
  checkoutSchema,
  customerLoginSchema,
  customerPasswordResetConfirmSchema,
  customerPasswordResetRequestSchema,
  customerRegisterSchema,
  storeProductQuerySchema,
  type StoreAddress,
  type StoreInfo,
} from '@rhoyards/shared';
import type { Env } from '../../config/env';
import { requestContext } from '../../lib/audit';
import type { Mailer } from '../../lib/mailer';
import { notFound } from '../../lib/errors';
import { withIdempotency } from '../../lib/idempotency';
import { getPrisma } from '../../lib/prisma';
import { parse } from '../../lib/validation';
import { createRateLimiter } from '../../middleware/rate-limit';
import { registry } from '../../openapi/registry';
import type { AuthConfig } from '../auth/auth.types';
import { confirmCustomerPasswordReset, requestCustomerPasswordReset } from '../auth/password-reset.service';
import { cancelOrder, getCustomerOrder, listCustomerOrders, placeOrder, restartPayment } from '../orders/orders.service';
import { enabledProviders } from '../payments/providers';
import { receiveTestWebhook, testGatewayEvent } from '../payments/webhooks';
import { getSettings } from '../settings/settings.service';
import { priceCart } from './cart.service';
import { getStoreProduct, listStoreProducts, storeFacets } from './catalog.service';
import {
  customerCookieName,
  customerCookieOptions,
  customerCsrf,
  loadCustomerSession,
  loginCustomer,
  logoutCustomer,
  registerCustomer,
  requireCustomer,
  storeSessionPayload,
} from './customer-auth';

const slugParams = z.object({ slug: z.string().min(1).max(200) });
const numberParams = z.object({ number: z.string().regex(/^WEB-\d{1,12}$/) });
const referenceParams = z.object({ reference: z.string().min(3).max(80) });

const docs: [string, 'get' | 'post' | 'delete', string][] = [
  ['/store/info', 'get', 'Store name, currency, pricing mode and payment options'],
  ['/store/catalog/products', 'get', 'Online catalogue with filters (category, brand, price, in stock) and sorting'],
  ['/store/catalog/products/{slug}', 'get', 'Product page with variants, images and stock level'],
  ['/store/catalog/facets', 'get', 'Categories and brands with product counts'],
  ['/store/cart/quote', 'post', 'Price a cart (server-side prices, VAT, delivery) and check stock'],
  ['/store/auth/register', 'post', 'Create a customer account and sign in'],
  ['/store/auth/login', 'post', 'Customer sign-in (separate cookie and sessions from staff)'],
  ['/store/auth/me', 'get', 'Signed-in customer and CSRF token'],
  ['/store/auth/logout', 'post', 'Sign out'],
  ['/store/auth/password-reset', 'post', 'Forgot password: emails a single-use reset link if an account matches (always 202)'],
  ['/store/auth/password-reset/confirm', 'post', 'Set a new password with a reset token; signs out every device'],
  ['/store/addresses', 'get', 'Saved delivery addresses'],
  ['/store/addresses/{id}', 'delete', 'Remove a saved address'],
  ['/store/checkout', 'post', 'Place an order: reserves stock and starts payment (Idempotency-Key required)'],
  ['/store/orders', 'get', "The customer's orders"],
  ['/store/orders/{number}', 'get', 'One of the customer\'s orders, with payment instructions and tracking'],
  ['/store/test-gateway/{reference}', 'get', 'Test gateway page data: amount and order (development and tests only)'],
  ['/store/test-gateway/{reference}', 'post', 'Test gateway: pay or decline; sends itself a signed webhook (development and tests only)'],
  ['/store/orders/{number}/pay', 'post', 'Start a new payment attempt after a declined one'],
  ['/store/orders/{number}/cancel', 'post', 'Cancel an order still awaiting payment'],
];
for (const [path, method, summary] of docs) {
  registry.registerPath({ method, path, tags: ['Storefront'], summary, responses: { 200: { description: 'OK' } } });
}

const toAddress = (a: { id: string; recipient: string; phone: string; line1: string; line2: string | null; city: string; state: string; isDefault: boolean }): StoreAddress => ({
  id: a.id,
  recipient: a.recipient,
  phone: a.phone,
  line1: a.line1,
  line2: a.line2,
  city: a.city,
  state: a.state as (typeof NIGERIAN_STATES)[number],
  isDefault: a.isDefault,
});

/** The public storefront API, mounted at /api/v1/store ahead of the staff session and CSRF middleware. */
export function storeRouter(env: Env, auth: AuthConfig, mailer: Mailer) {
  const router = Router();
  const secureCookie = auth.session.secureCookie;
  const cookieName = customerCookieName(secureCookie);
  const shared = env.RATE_LIMIT_STORE === 'database';
  const authLimiter = createRateLimiter({ name: 'store-auth', windowMs: 15 * 60_000, limit: env.LOGIN_RATE_LIMIT, shared });
  const resetLimiter = createRateLimiter({ name: 'store-password-reset', windowMs: 15 * 60_000, limit: env.LOGIN_RATE_LIMIT, shared });
  const checkoutLimiter = createRateLimiter({ name: 'store-checkout', windowMs: 10 * 60_000, limit: 30, shared });
  router.use(loadCustomerSession(secureCookie), customerCsrf);

  // ── Catalogue (public) ────────────────────────────────────────────────
  router.get('/info', async (_req, res) => {
    const s = await getSettings();
    const info: StoreInfo = {
      name: s.business.name,
      phone: s.business.phone,
      email: s.business.email,
      address: s.business.address,
      currency: s.currency,
      pricesIncludeTax: s.pricing.pricesIncludeTax,
      onlineEnabled: s.online.enabled,
      providers: enabledProviders(env).map((p) => ({ code: p.code, name: p.name, description: p.description })),
    };
    res.json({ data: info });
  });
  router.get('/catalog/products', async (req, res) => {
    const query = parse(storeProductQuerySchema, req.query);
    const { data, total } = await listStoreProducts(query);
    res.json({ data, meta: { page: query.page, pageSize: query.pageSize, total } });
  });
  router.get('/catalog/products/:slug', async (req, res) => {
    res.json({ data: await getStoreProduct(parse(slugParams, req.params).slug) });
  });
  router.get('/catalog/facets', async (_req, res) => {
    res.json({ data: await storeFacets() });
  });
  router.post('/cart/quote', async (req, res) => {
    const input = parse(cartQuoteSchema, req.body);
    const { quote } = await priceCart(getPrisma(), input.items, { shippingMethodId: input.shippingMethodId, state: input.state });
    res.json({ data: quote });
  });

  // ── Customer accounts ─────────────────────────────────────────────────
  const meta = (req: Parameters<typeof requestContext>[0]) => ({ ...requestContext(req), ...(req.get('user-agent') ? { userAgent: req.get('user-agent')! } : {}) });
  router.post('/auth/register', authLimiter, async (req, res) => {
    const { session, context } = await registerCustomer(parse(customerRegisterSchema, req.body), meta(req));
    res.cookie(cookieName, session.token, customerCookieOptions(secureCookie, session.expiresAt));
    res.status(201).json({ data: storeSessionPayload(context) });
  });
  router.post('/auth/login', authLimiter, async (req, res) => {
    const { session, context } = await loginCustomer(parse(customerLoginSchema, req.body), meta(req));
    res.cookie(cookieName, session.token, customerCookieOptions(secureCookie, session.expiresAt));
    res.json({ data: storeSessionPayload(context) });
  });
  router.get('/auth/me', requireCustomer, (req, res) => {
    res.json({ data: storeSessionPayload(req.customer!) });
  });
  router.post('/auth/logout', requireCustomer, async (req, res) => {
    await logoutCustomer(req.customer!.sessionId);
    res.clearCookie(cookieName, { path: '/' });
    res.status(204).end();
  });
  router.post('/auth/password-reset', resetLimiter, (req, res) => {
    const { email } = parse(customerPasswordResetRequestSchema, req.body);
    // Answer first, then look the account up: the response (and its timing) is the same whether or not it exists.
    requestCustomerPasswordReset(email, requestContext(req), auth, mailer).catch((err: unknown) => req.log.error({ err }, 'Password reset request failed'));
    res.status(202).json({ data: { message: 'If an account matches, a link to reset the password has been emailed.' } });
  });
  router.post('/auth/password-reset/confirm', resetLimiter, async (req, res) => {
    const notice = await confirmCustomerPasswordReset(parse(customerPasswordResetConfirmSchema, req.body), requestContext(req));
    mailer.send(notice).catch((err: unknown) => req.log.error({ err }, 'Sending email failed'));
    res.clearCookie(cookieName, { path: '/' });
    res.status(204).end();
  });

  router.get('/addresses', requireCustomer, async (req, res) => {
    const rows = await getPrisma().customerAddress.findMany({ where: { customerId: req.customer!.customerId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] });
    res.json({ data: rows.map(toAddress) });
  });
  router.delete('/addresses/:id', requireCustomer, async (req, res) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const result = await getPrisma().customerAddress.deleteMany({ where: { id, customerId: req.customer!.customerId } });
    if (result.count === 0) throw notFound('Address');
    res.status(204).end();
  });

  // ── Orders ────────────────────────────────────────────────────────────
  router.post('/checkout', checkoutLimiter, requireCustomer, async (req, res) => {
    const key = req.get('idempotency-key');
    const input = parse(checkoutSchema, req.body);
    const customer = req.customer!;
    const result = await withIdempotency(`store-checkout:${customer.customerId}`, key, input, async () => ({
      status: 201,
      body: { data: await placeOrder(input, customer, env, requestContext(req)) },
    }));
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  });
  router.get('/orders', requireCustomer, async (req, res) => {
    res.json({ data: await listCustomerOrders(req.customer!.customerId) });
  });
  router.get('/orders/:number', requireCustomer, async (req, res) => {
    res.json({ data: await getCustomerOrder(req.customer!.customerId, parse(numberParams, req.params).number) });
  });
  router.post('/orders/:number/pay', requireCustomer, async (req, res) => {
    res.json({ data: await restartPayment(req.customer!.customerId, parse(numberParams, req.params).number, env, requestContext(req)) });
  });
  router.post('/orders/:number/cancel', requireCustomer, async (req, res) => {
    const { number } = parse(numberParams, req.params);
    const order = await getCustomerOrder(req.customer!.customerId, number);
    await cancelOrder(order.id, { customerId: req.customer!.customerId }, 'Cancelled by the customer', requestContext(req));
    res.json({ data: await getCustomerOrder(req.customer!.customerId, number) });
  });

  // ── Sandbox card gateway (never in production) ────────────────────────
  if (env.PAYMENT_TEST_ENABLED) {
    const ownAttempt = async (customerId: string, reference: string) => {
      const attempt = await getPrisma().paymentAttempt.findFirst({ where: { provider: 'TEST', reference, order: { customerId } }, include: { order: { select: { number: true } } } });
      if (!attempt) throw notFound('Payment');
      return attempt;
    };
    router.get('/test-gateway/:reference', requireCustomer, async (req, res) => {
      const a = await ownAttempt(req.customer!.customerId, parse(referenceParams, req.params).reference);
      res.json({ data: { reference: a.reference, orderNumber: a.order.number, amount: a.amount.toFixed(2), status: a.status } });
    });
    // Plays the gateway's part: signs an event and delivers it to our own webhook handler.
    router.post('/test-gateway/:reference', requireCustomer, async (req, res) => {
      const { outcome } = parse(z.object({ outcome: z.enum(['succeeded', 'failed']) }), req.body);
      const a = await ownAttempt(req.customer!.customerId, parse(referenceParams, req.params).reference);
      const { raw, signature } = testGatewayEvent(env, { eventId: `evt_${randomUUID()}`, type: `payment.${outcome}`, reference: a.reference, amount: a.amount.toFixed(2) });
      await receiveTestWebhook(env, raw, signature);
      res.json({ data: await getCustomerOrder(req.customer!.customerId, a.order.number) });
    });
  }
  return router;
}
