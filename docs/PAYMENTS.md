# Online payments

How the online store takes payment, and what a real card gateway (e.g. Paystack or Flutterwave) needs to plug in. Code: [`apps/api/src/modules/payments/`](../apps/api/src/modules/payments) and [`apps/api/src/modules/orders/orders.service.ts`](../apps/api/src/modules/orders/orders.service.ts).

## Rules every provider follows

1. **Only the server marks an order paid**, and only from a verified source: a webhook whose signature checks out, or a staff member with `payments.verify` confirming a bank transfer (audited). A customer's browser returning from a payment page never changes an order; the order page polls until the webhook has arrived.
2. **The amount must match.** A webhook whose amount differs from the payment attempt is recorded (`AMOUNT_MISMATCH`) and does nothing.
3. **Webhooks are stored before they are acted on.** `payment_webhook_events` has `UNIQUE (provider, event_id)`: a redelivered event is answered "duplicate" and changes nothing; an event that failed part-way (never marked processed) is processed again when redelivered. Events with a bad signature are kept as evidence under a fresh id, so a forger cannot claim a real event's id first. Stored events cannot be edited (database trigger).
4. **Payment confirmation is one transaction**: the attempt is marked succeeded, the order's stock reservation becomes a sale (channel ONLINE) and the journal is posted, or nothing happens. See [ACCOUNTING_RULES.md §5d](ACCOUNTING_RULES.md).

## Providers today

| Code | Customer experience | Confirmed by | Money lands in |
|---|---|---|---|
| `MANUAL` (bank transfer) | Sees the bank details, amount and order number (the transfer reference) | Staff with `payments.verify`, entering the bank's transaction reference | Payment method `ONLINE_TRANSFER` → Bank (1010) |
| `TEST` (sandbox card) | Redirected to `/pay/test/<reference>` on the storefront and clicks Pay or Decline | HMAC-SHA256-signed webhook to `POST /api/v1/webhooks/payments/test` (header `X-Test-Signature`) | Payment method `ONLINE_CARD` → Payment gateway clearing (1030) |

The test gateway is on by default in development and tests and **refuses to start in production** (`PAYMENT_TEST_ENABLED`, `PAYMENT_TEST_SECRET`).

Stock is held while the customer pays: `online.transferHoldHours` (default 24) for transfers and `online.gatewayHoldMinutes` (default 30) for card payments (Settings → Online store).

## Adding a real gateway

1. Add the provider code to the `PaymentProvider` enum (migration) and `PAYMENT_PROVIDERS` in `packages/shared/src/store.ts`.
2. Seed a payment method for it (usually `kind = CARD`, account Payment gateway clearing, `available_online = true`).
3. Implement `PaymentProvider` in `providers.ts`: `initiate()` calls the gateway's "initialise transaction" API with the amount in the smallest unit and our reference, and returns `{ reference, providerData: { redirectUrl } }` (the hosted checkout URL).
4. Add a webhook route like the test one: verify the gateway's signature over the **raw body** (`req.rawBody`; for Paystack, HMAC-SHA512 with the secret key in `x-paystack-signature`), map its event to `{ eventId, type, reference, amount }`, store it, then call `applyPaymentEvent`.
5. Optionally verify with the gateway's "verify transaction" API before settling, as a second check.
6. Keep secrets in environment variables only. Settle card clearing to the bank with a journal (Phase 8 card settlement: Dr Bank, Dr Bank charges, Cr gateway clearing).

## Edge cases handled

| Situation | Result |
|---|---|
| Payment after the stock hold ran out, items still in stock | Order completes normally (stock re-reserved and issued) |
| Payment after the hold ran out, items sold meanwhile | Order goes **On hold**; money held as a customer deposit (Dr gateway/bank, Cr Customer deposits 2200). Staff complete it from the deposit once stock is back, or refund (Phase 8) |
| Payment for an order already cancelled | Order stays cancelled; money held as a customer deposit to refund |
| Card declined | Attempt marked failed; the customer can start a new attempt on the same order |
| Same webhook delivered twice, or two events for one payment | One sale, one journal |
