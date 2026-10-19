import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PaymentProviderCode, Settings } from '@rhoyards/shared';
import type { Env } from '../../config/env';

/**
 * Payment providers. Each one says how a customer pays, how long stock is held meanwhile, and which payment method
 * (and so which ledger account) receives the money. A browser returning from a provider never marks an order paid:
 * only a verified webhook or a staff member with payments.verify can.
 */
export interface InitiatedPayment {
  reference: string;
  providerData: { instructions?: string; redirectUrl?: string };
}

export interface PaymentProvider {
  code: PaymentProviderCode;
  name: string;
  description: string;
  /** payment_methods.code of the method (and ledger account) that receives this provider's money. */
  paymentMethodCode: string;
  holdMinutes(settings: Settings): number;
  initiate(order: { number: string; total: string }, settings: Settings): InitiatedPayment;
}

export interface WebhookEvent {
  eventId: string;
  type: 'payment.succeeded' | 'payment.failed';
  reference: string;
  amount: string;
}

/** Bank transfer to the business account, confirmed by staff (payments.verify) against the bank statement. */
const manual: PaymentProvider = {
  code: 'MANUAL',
  name: 'Bank transfer',
  description: 'Transfer the total to our bank account. Your order is confirmed once we see the payment.',
  paymentMethodCode: 'ONLINE_TRANSFER',
  holdMinutes: (s) => s.online.transferHoldHours * 60,
  initiate: (order, s) => ({
    // Customers quote the order number as the transfer narration, so it is also the payment reference.
    reference: order.number,
    providerData: {
      instructions: `${s.online.bankTransferInstructions}\nAmount: ${s.currency.symbol}${order.total}\nReference: ${order.number}`,
    },
  }),
};

/** Sandbox card gateway: the customer "pays" on a test page and the gateway calls our webhook, HMAC-signed. */
const test: PaymentProvider = {
  code: 'TEST',
  name: 'Card (test gateway)',
  description: 'Sandbox card payment for trying out the store. No real money moves.',
  paymentMethodCode: 'ONLINE_CARD',
  holdMinutes: (s) => s.online.gatewayHoldMinutes,
  initiate: () => {
    const reference = `TST-${randomUUID()}`;
    return { reference, providerData: { redirectUrl: `/pay/test/${reference}` } };
  },
};

export function enabledProviders(env: Pick<Env, 'PAYMENT_TEST_ENABLED'>): PaymentProvider[] {
  return env.PAYMENT_TEST_ENABLED ? [manual, test] : [manual];
}

export function providerFor(env: Pick<Env, 'PAYMENT_TEST_ENABLED'>, code: string): PaymentProvider | undefined {
  return enabledProviders(env).find((p) => p.code === code);
}

export const signTestPayload = (secret: string, rawBody: Buffer | string) => createHmac('sha256', secret).update(rawBody).digest('hex');

/** Verifies the test gateway's signature and reads its event. Returns null when the signature is wrong. */
export function parseTestWebhook(secret: string, rawBody: Buffer, signature: string | undefined): WebhookEvent | null {
  const expected = Buffer.from(signTestPayload(secret, rawBody));
  const given = Buffer.from(signature ?? '');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const body = JSON.parse(rawBody.toString('utf8')) as { id?: unknown; type?: unknown; data?: { reference?: unknown; amount?: unknown } };
  if (
    typeof body.id !== 'string' ||
    (body.type !== 'payment.succeeded' && body.type !== 'payment.failed') ||
    typeof body.data?.reference !== 'string' ||
    typeof body.data.amount !== 'string'
  ) {
    throw new Error('Malformed test gateway event');
  }
  return { eventId: body.id, type: body.type, reference: body.data.reference, amount: body.data.amount };
}
