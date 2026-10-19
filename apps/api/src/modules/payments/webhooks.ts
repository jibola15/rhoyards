import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import type { Env } from '../../config/env';
import { AppError } from '../../lib/errors';
import { getPrisma, transaction } from '../../lib/prisma';
import { createRateLimiter } from '../../middleware/rate-limit';
import { registry } from '../../openapi/registry';
import { applyPaymentEvent } from '../orders/orders.service';
import { parseTestWebhook, signTestPayload, type WebhookEvent } from './providers';

/**
 * Payment webhooks. Every call is stored before anything is done with it. A valid event claims its
 * (provider, event_id) row, so a redelivered event is answered "duplicate" and changes nothing; an event that failed
 * half-way (never marked processed) is processed again on redelivery. Events with a bad signature are kept as evidence
 * under a fresh id, so a forger cannot claim a real event's id ahead of the provider.
 */

export interface WebhookOutcome {
  status: number;
  body: { received: boolean; duplicate?: boolean; result?: string };
}

export async function receiveTestWebhook(env: Env, rawBody: Buffer, signature: string | undefined): Promise<WebhookOutcome> {
  const prisma = getPrisma();
  let event: WebhookEvent | null;
  try {
    event = parseTestWebhook(env.PAYMENT_TEST_SECRET, rawBody, signature);
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Malformed webhook payload');
  }
  if (!event) {
    await prisma.paymentWebhookEvent.create({
      data: {
        provider: 'TEST',
        eventId: `invalid:${randomUUID()}`,
        signatureValid: false,
        payload: { body: rawBody.toString('utf8').slice(0, 4000) },
        processedAt: new Date(),
        result: 'INVALID_SIGNATURE',
      },
    });
    return { status: 401, body: { received: false, result: 'INVALID_SIGNATURE' } };
  }

  const payload = JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue;
  await prisma.$executeRaw`
    INSERT INTO payment_webhook_events (id, provider, event_id, signature_valid, payload, received_at)
    VALUES (gen_random_uuid(), 'TEST', ${event.eventId}, true, ${JSON.stringify(payload)}::jsonb, now())
    ON CONFLICT (provider, event_id) DO NOTHING`;

  const verified = event;
  return transaction(async (tx) => {
    // The row lock makes concurrent deliveries of one event take turns; the second sees it processed.
    const [row] = await tx.$queryRaw<{ id: string; processed_at: Date | null; result: string | null }[]>`
      SELECT id, processed_at, result FROM payment_webhook_events WHERE provider = 'TEST' AND event_id = ${verified.eventId} FOR UPDATE`;
    if (!row) throw new Error('Webhook event row missing after insert');
    if (row.processed_at) return { status: 200, body: { received: true, duplicate: true, result: row.result ?? undefined } };
    const result = await applyPaymentEvent(tx, env, 'TEST', verified);
    await tx.paymentWebhookEvent.update({ where: { id: row.id }, data: { processedAt: new Date(), result } });
    return { status: 200, body: { received: true, result } };
  });
}

/** What the sandbox gateway would send: used by the storefront's test payment page and by tests. */
export function testGatewayEvent(env: Env, event: WebhookEvent) {
  const raw = Buffer.from(JSON.stringify({ id: event.eventId, type: event.type, data: { reference: event.reference, amount: event.amount, currency: 'NGN' } }));
  return { raw, signature: signTestPayload(env.PAYMENT_TEST_SECRET, raw) };
}

registry.registerPath({
  method: 'post',
  path: '/webhooks/payments/test',
  tags: ['Payments'],
  summary: 'Test gateway webhook (HMAC-SHA256 of the raw body in X-Test-Signature). Idempotent per event id.',
  responses: { 200: { description: 'Received (or duplicate)' }, 401: { description: 'Bad signature' } },
});

export function webhooksRouter(env: Env) {
  const router = Router();
  const limiter = createRateLimiter({ name: 'webhooks', windowMs: 60_000, limit: 300, shared: env.RATE_LIMIT_STORE === 'database' });
  if (env.PAYMENT_TEST_ENABLED) {
    router.post('/webhooks/payments/test', limiter, async (req, res) => {
      if (!req.rawBody) throw new AppError(400, 'VALIDATION_ERROR', 'Expected a JSON body');
      const outcome = await receiveTestWebhook(env, req.rawBody, req.get('x-test-signature'));
      res.status(outcome.status).json(outcome.body);
    });
  }
  return router;
}
