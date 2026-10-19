import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import {
  dec,
  FULFILMENT_TRANSITIONS,
  type CheckoutInput,
  type OrderDetail,
  type OrderStatus,
  type OrderSummary,
  type orderListQuerySchema,
  type orderTransitionSchema,
  type StoreOrder,
} from '@rhoyards/shared';
import type { Env } from '../../config/env';
import { openStockSession, type StockSession } from '../../engines/inventory/inventory.engine';
import { postJournal } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { businessDate } from '../../lib/business-date';
import { AppError, businessRule, notFound } from '../../lib/errors';
import { pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import { systemUserId } from '../../lib/system-user';
import { getSettings } from '../settings/settings.service';
import { priceCart } from '../store/cart.service';
import type { CustomerContext } from '../store/customer-auth';
import { providerFor, type PaymentProvider, type WebhookEvent } from '../payments/providers';
import { createOnlineSale, type OrderForSale } from './online-sale';

type Tx = Prisma.TransactionClient;
const money = (v: { toFixed(dp: number): string }) => new Prisma.Decimal(v.toFixed(2));
const PAID_STATES: OrderStatus[] = ['PAID', 'PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERED'];

// ── Read models ──────────────────────────────────────────────────────────

const include = {
  items: { orderBy: { lineNo: 'asc' } },
  history: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { fullName: true } } } },
  payments: { orderBy: { createdAt: 'desc' }, include: { verifiedBy: { select: { fullName: true } } } },
  customer: true,
  location: { select: { id: true, name: true } },
  sale: { select: { id: true, number: true } },
} satisfies Prisma.OnlineOrderInclude;
type Row = Prisma.OnlineOrderGetPayload<{ include: typeof include }>;

function toStoreOrder(o: Row): StoreOrder {
  const attempt = o.payments[0];
  const data = (attempt?.providerData ?? {}) as { instructions?: string; redirectUrl?: string };
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    placedAt: o.placedAt.toISOString(),
    paidAt: o.paidAt?.toISOString() ?? null,
    reservedUntil: o.reservationStatus === 'ACTIVE' ? (o.reservedUntil?.toISOString() ?? null) : null,
    items: o.items.map((i) => ({
      lineNo: i.lineNo,
      variantId: i.variantId,
      sku: i.sku,
      description: i.description,
      qty: i.qty.toFixed(3),
      unitPrice: i.unitPrice.toFixed(2),
      net: i.netAmount.toFixed(2),
      tax: i.taxAmount.toFixed(2),
      total: i.lineTotal.toFixed(2),
    })),
    itemsTotal: o.itemsTotal.toFixed(2),
    shipping: { name: o.shippingName, isPickup: o.isPickup, fee: o.shippingFee.toFixed(2) },
    subtotal: o.subtotal.toFixed(2),
    taxTotal: o.taxTotal.toFixed(2),
    total: o.total.toFixed(2),
    pricesIncludeTax: o.pricesIncludeTax,
    address: o.isPickup ? null : { recipient: o.recipient!, phone: o.phone!, line1: o.line1!, line2: o.line2, city: o.city!, state: o.state! as never },
    trackingReference: o.trackingReference,
    payment: attempt
      ? {
          provider: attempt.provider,
          reference: attempt.reference,
          status: attempt.status,
          instructions: attempt.status === 'INITIATED' ? (data.instructions ?? null) : null,
          redirectUrl: attempt.status === 'INITIATED' && o.status === 'PENDING_PAYMENT' ? (data.redirectUrl ?? null) : null,
        }
      : null,
    history: o.history.map((h) => ({ from: h.fromStatus, to: h.toStatus, at: h.createdAt.toISOString(), by: h.byCustomer ? 'Customer' : (h.actor?.fullName ?? null), note: h.note })),
    canCancel: o.status === 'PENDING_PAYMENT',
  };
}

function toDetail(o: Row): OrderDetail {
  return {
    ...toStoreOrder(o),
    customer: { id: o.customer.id, code: o.customer.code, name: o.customer.name, email: o.email, phone: o.customer.phone },
    location: o.location,
    note: o.note,
    sale: o.sale && o.sale.number ? { id: o.sale.id, number: o.sale.number } : null,
    depositJournalId: o.depositJournalId,
    payments: o.payments.map((p) => ({
      id: p.id,
      provider: p.provider,
      reference: p.reference,
      amount: p.amount.toFixed(2),
      status: p.status,
      verifiedAt: p.verifiedAt?.toISOString() ?? null,
      verifiedBy: p.verifiedBy?.fullName ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
  };
}

export async function listOrders(query: z.infer<typeof orderListQuerySchema>): Promise<{ data: OrderSummary[]; total: number }> {
  const where: Prisma.OnlineOrderWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.customerId ? { customerId: query.customerId } : {}),
    ...(query.q
      ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { customer: { name: { contains: query.q, mode: 'insensitive' } } }, { email: { contains: query.q, mode: 'insensitive' } }] }
      : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.onlineOrder.findMany({
      where,
      include: { customer: { select: { id: true, name: true } }, _count: { select: { items: true } } },
      orderBy: { placedAt: 'desc' },
      ...pageArgs(query),
    }),
    prisma.onlineOrder.count({ where }),
  ]);
  return {
    total,
    data: rows.map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      customer: o.customer,
      itemCount: o._count.items,
      total: o.total.toFixed(2),
      provider: o.provider,
      placedAt: o.placedAt.toISOString(),
      paidAt: o.paidAt?.toISOString() ?? null,
    })),
  };
}

export async function getOrder(id: string, db: Db = getPrisma()): Promise<OrderDetail> {
  const o = await db.onlineOrder.findUnique({ where: { id }, include });
  if (!o) throw notFound('Order');
  return toDetail(o);
}

export async function listCustomerOrders(customerId: string): Promise<StoreOrder[]> {
  const rows = await getPrisma().onlineOrder.findMany({ where: { customerId }, include, orderBy: { placedAt: 'desc' }, take: 100 });
  return rows.map(toStoreOrder);
}

/** A customer sees only their own orders; anyone else's number is simply "not found". */
export async function getCustomerOrder(customerId: string, number: string, db: Db = getPrisma()): Promise<StoreOrder> {
  const o = await db.onlineOrder.findFirst({ where: { number, customerId }, include });
  if (!o) throw notFound('Order');
  return toStoreOrder(o);
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function lockOrder(tx: Tx, id: string) {
  const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM online_orders WHERE id = ${id}::uuid FOR UPDATE`;
  if (!row) throw notFound('Order');
  return tx.onlineOrder.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { lineNo: 'asc' } } } });
}

async function addHistory(tx: Tx, orderId: string, from: OrderStatus | null, to: OrderStatus, by: { userId?: string | null; customer?: boolean; note?: string | null }) {
  await tx.orderStatusHistory.create({ data: { orderId, fromStatus: from, toStatus: to, actorUserId: by.userId ?? null, byCustomer: by.customer ?? false, note: by.note ?? null } });
}

const stockKeys = (order: OrderForSale) => order.items.map((i) => ({ variantId: i.variantId, locationId: order.locationId }));

async function releaseReservation(session: StockSession, order: OrderForSale) {
  for (const i of order.items) await session.release({ variantId: i.variantId, locationId: order.locationId, qty: dec(i.qty.toString()) });
}

/** Re-reserves an order whose hold has lapsed. Returns false (and changes nothing) if the stock is no longer there. */
async function tryReserve(session: StockSession, order: OrderForSale, blockExpired: boolean) {
  const done: OrderForSale['items'] = [];
  try {
    for (const i of order.items) {
      await session.reserve({ variantId: i.variantId, locationId: order.locationId, qty: dec(i.qty.toString()), expired: blockExpired ? 'block' : 'allow' });
      done.push(i);
    }
    return true;
  } catch (e) {
    if (!(e instanceof AppError) || e.code !== 'INSUFFICIENT_STOCK') throw e;
    for (const i of done) await session.release({ variantId: i.variantId, locationId: order.locationId, qty: dec(i.qty.toString()) });
    return false;
  }
}

// ── Checkout ─────────────────────────────────────────────────────────────

/**
 * Places an order: prices the cart from the database, reserves the stock at the fulfilment location (refused if it
 * is not there) and starts a payment with the chosen provider, all in one transaction.
 */
export async function placeOrder(input: CheckoutInput, customer: CustomerContext, env: Env, ctx: RequestContext): Promise<StoreOrder> {
  return transaction(async (tx) => {
    const priced = await priceCart(tx, input.items, { shippingMethodId: input.shippingMethodId, state: input.address?.state });
    const { quote, settings, location, chosen } = priced;
    if (!settings.online.enabled) throw businessRule('The online store is not taking orders at the moment');
    const provider = providerFor(env, input.provider);
    if (!provider) throw new AppError(400, 'VALIDATION_ERROR', 'This payment option is not available', { field: 'provider' });
    if (!chosen) throw new AppError(400, 'VALIDATION_ERROR', 'Choose a delivery option available for your address', { field: 'shippingMethodId' });
    if (!chosen.isPickup && !input.address) throw new AppError(400, 'VALIDATION_ERROR', 'Enter a delivery address', { field: 'address' });
    const problems = quote.lines.filter((l) => l.problem);
    if (problems.length > 0) {
      throw new AppError(409, 'INSUFFICIENT_STOCK', 'Some items in your cart are no longer available in that quantity', {
        lines: problems.map((l) => ({ variantId: l.variantId, problem: l.problem, available: l.available })),
      });
    }

    const actorId = await systemUserId(tx);
    const number = await nextDocumentNumber(tx, 'ONLINE_ORDER', 'WEB-');
    const address = chosen.isPickup ? null : input.address!;
    const now = new Date();
    const order = await tx.onlineOrder.create({
      data: {
        number,
        customerId: customer.customerId,
        locationId: location.id,
        pricesIncludeTax: settings.pricing.pricesIncludeTax,
        email: customer.email,
        shippingMethodId: chosen.id,
        shippingName: chosen.name,
        isPickup: chosen.isPickup,
        shippingFee: money(priced.shipping.fee),
        shippingNet: money(priced.shipping.net),
        shippingTax: money(priced.shipping.tax),
        itemsTotal: quote.itemsTotal,
        subtotal: quote.subtotal,
        taxTotal: quote.taxTotal,
        total: quote.total,
        recipient: address?.recipient ?? null,
        phone: address?.phone ?? null,
        line1: address?.line1 ?? null,
        line2: address?.line2 ?? null,
        city: address?.city ?? null,
        state: address?.state ?? null,
        note: input.note ?? null,
        provider: provider.code,
        reservedUntil: new Date(now.getTime() + provider.holdMinutes(settings) * 60_000),
        items: {
          create: priced.lines.map((l, i) => ({
            lineNo: i + 1,
            variantId: l.variant!.id,
            sku: l.variant!.sku,
            description: `${l.variant!.product.name} — ${l.variant!.name}`,
            qty: new Prisma.Decimal(l.item.qty.toFixed(3)),
            unitPrice: l.variant!.sellingPrice,
            taxRateId: settings.business.vatRegistered ? l.variant!.product.taxRateId : null,
            taxRate: new Prisma.Decimal(l.taxRate.toFixed(4)),
            netAmount: money(l.priced.net),
            taxAmount: money(l.priced.tax),
            lineTotal: money(l.priced.total),
          })),
        },
      },
      include: { items: { orderBy: { lineNo: 'asc' } } },
    });

    // Reserve: the engine locks the variants and refuses if POS or another order took the stock meanwhile.
    const session = await openStockSession(tx, stockKeys(order), actorId);
    for (const i of order.items) {
      await session.reserve({ variantId: i.variantId, locationId: order.locationId, qty: dec(i.qty.toString()), expired: settings.inventory.blockExpiredSale ? 'block' : 'allow' });
    }

    const payment = provider.initiate({ number, total: order.total.toFixed(2) }, settings);
    await tx.paymentAttempt.create({ data: { orderId: order.id, provider: provider.code, reference: payment.reference, amount: order.total, providerData: payment.providerData } });
    await addHistory(tx, order.id, null, 'PENDING_PAYMENT', { customer: true });

    if (address && input.saveAddress) {
      const exists = await tx.customerAddress.findFirst({ where: { customerId: customer.customerId, line1: address.line1, city: address.city, state: address.state } });
      if (!exists) {
        const first = (await tx.customerAddress.count({ where: { customerId: customer.customerId } })) === 0;
        await tx.customerAddress.create({ data: { customerId: customer.customerId, ...address, line2: address.line2 ?? null, isDefault: first } });
      }
    }
    await writeAudit(tx, ctx, { action: 'order.placed', entityType: 'online_order', entityId: order.id, after: { number, total: order.total.toFixed(2), provider: provider.code } });
    return getCustomerOrder(customer.customerId, number, tx);
  });
}

// ── Payment ──────────────────────────────────────────────────────────────

export type SettleResult = 'PAID' | 'ON_HOLD' | 'PAID_AFTER_CANCEL' | 'ALREADY_PAID';

/**
 * Records a confirmed payment on an order (caller holds the order lock and has checked the amount).
 * - Unpaid order: its reservation (or, if that lapsed, fresh stock) becomes a sale; revenue is recognised now.
 * - Stock gone meanwhile: the money is held as a customer deposit and the order goes ON_HOLD for staff.
 * - Cancelled order: the money is held as a deposit and the order stays cancelled (to be refunded).
 * Idempotent: an order already paid or on hold is left alone.
 */
async function settle(
  tx: Tx,
  order: OrderForSale,
  attempt: { id: string; reference: string; provider: string },
  provider: PaymentProvider,
  actorId: string,
  note: string | null,
): Promise<SettleResult> {
  if (PAID_STATES.includes(order.status) || order.status === 'ON_HOLD' || (order.status === 'CANCELLED' && order.depositJournalId)) return 'ALREADY_PAID';

  const settings = await getSettings(tx);
  const method = await tx.paymentMethod.findUniqueOrThrow({ where: { code: provider.paymentMethodCode } });
  const now = new Date();
  await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'SUCCEEDED', verifiedAt: now, verifiedById: actorId } });

  const holdAsDeposit = async () =>
    postJournal(tx, {
      entryDate: businessDate(),
      sourceType: 'ONLINE_ORDER',
      sourceId: order.id,
      postingKey: `ONLINE_DEPOSIT:${order.id}`,
      description: `Payment for order ${order.number} held as a deposit`,
      lines: [
        { accountId: method.accountId, debit: order.total.toString(), locationId: order.locationId },
        { accountKey: 'CUSTOMER_DEPOSITS', credit: order.total.toString() },
      ],
      actorId,
    });

  if (order.status === 'CANCELLED') {
    const deposit = await holdAsDeposit();
    await tx.onlineOrder.update({ where: { id: order.id }, data: { depositJournalId: deposit.id, paidAt: now } });
    await addHistory(tx, order.id, 'CANCELLED', 'CANCELLED', { userId: actorId, note: 'Payment received after cancellation; held as a deposit to refund' });
    return 'PAID_AFTER_CANCEL';
  }

  const session = await openStockSession(tx, stockKeys(order), actorId);
  const reserved = order.reservationStatus === 'ACTIVE' || (await tryReserve(session, order, settings.inventory.blockExpiredSale));
  if (!reserved) {
    const deposit = await holdAsDeposit();
    await tx.onlineOrder.update({ where: { id: order.id }, data: { status: 'ON_HOLD', depositJournalId: deposit.id, paidAt: now, reservationStatus: 'RELEASED' } });
    await addHistory(tx, order.id, order.status, 'ON_HOLD', { userId: actorId, note: 'Paid, but the items sold out after the reservation lapsed' });
    return 'ON_HOLD';
  }
  await releaseReservation(session, order);
  const sale = await createOnlineSale(tx, session, order, { paymentMethodId: method.id, reference: attempt.reference, debit: { accountId: method.accountId }, actorId, settings });
  await tx.onlineOrder.update({ where: { id: order.id }, data: { status: 'PAID', saleId: sale.saleId, paidAt: now, reservationStatus: 'CONSUMED' } });
  await addHistory(tx, order.id, order.status, 'PAID', { userId: actorId, note: note ?? `Payment ${attempt.reference} confirmed; sale ${sale.number}` });
  return 'PAID';
}

/** Staff confirm a bank transfer they can see on the statement (payments.verify). */
export async function verifyManualPayment(orderId: string, input: { reference: string; note?: string | null | undefined }, actorId: string, env: Env, ctx: RequestContext) {
  return transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    const attempt = await tx.paymentAttempt.findFirst({ where: { orderId, provider: 'MANUAL', status: 'INITIATED' }, orderBy: { createdAt: 'desc' } });
    if (!attempt) throw businessRule('This order has no bank-transfer payment waiting to be confirmed');
    await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { providerData: { ...(attempt.providerData as object), bankReference: input.reference } } });
    const result = await settle(tx, order, { id: attempt.id, reference: input.reference, provider: 'MANUAL' }, providerFor(env, 'MANUAL')!, actorId, input.note ?? null);
    await writeAudit(tx, ctx, { action: 'payment.verified_manually', entityType: 'online_order', entityId: orderId, after: { reference: input.reference, result } });
    return { result, order: await getOrder(orderId, tx) };
  });
}

/**
 * Applies a provider event. The event row was stored (and claimed) by the caller; this runs once per event and
 * returns the outcome recorded on it. Unknown references and wrong amounts never mark anything paid.
 */
export async function applyPaymentEvent(tx: Tx, env: Env, providerCode: PaymentProvider['code'], event: WebhookEvent): Promise<string> {
  const attempt = await tx.paymentAttempt.findUnique({ where: { provider_reference: { provider: providerCode, reference: event.reference } } });
  if (!attempt) return 'UNKNOWN_REFERENCE';
  const order = await lockOrder(tx, attempt.orderId);
  if (event.type === 'payment.failed') {
    if (attempt.status === 'INITIATED') await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED' } });
    return 'FAILED';
  }
  if (!dec(event.amount).equals(attempt.amount.toString())) return 'AMOUNT_MISMATCH';
  if (attempt.status === 'SUCCEEDED') return 'ALREADY_PAID';
  if (attempt.status === 'FAILED') return 'ATTEMPT_ALREADY_FAILED';
  const provider = providerFor(env, providerCode);
  if (!provider) return 'PROVIDER_DISABLED';
  return settle(tx, order, attempt, provider, await systemUserId(tx), null);
}

/** After a declined card payment, the customer may start a new attempt on the same order (same provider). */
export async function restartPayment(customerId: string, number: string, env: Env, ctx: RequestContext): Promise<StoreOrder> {
  return transaction(async (tx) => {
    const found = await tx.onlineOrder.findFirst({ where: { number, customerId }, select: { id: true } });
    if (!found) throw notFound('Order');
    const order = await lockOrder(tx, found.id);
    if (order.status !== 'PENDING_PAYMENT') throw businessRule('This order is not awaiting payment');
    const latest = await tx.paymentAttempt.findFirst({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' } });
    if (latest?.status !== 'FAILED') throw businessRule('A payment for this order is already in progress');
    const provider = providerFor(env, latest.provider);
    if (!provider) throw businessRule('This payment option is no longer available');
    const payment = provider.initiate({ number: order.number, total: order.total.toFixed(2) }, await getSettings(tx));
    await tx.paymentAttempt.create({ data: { orderId: order.id, provider: provider.code, reference: payment.reference, amount: order.total, providerData: payment.providerData } });
    await writeAudit(tx, ctx, { action: 'order.payment_restarted', entityType: 'online_order', entityId: order.id });
    return getCustomerOrder(customerId, number, tx);
  });
}

// ── Cancellation, expiry and fulfilment ──────────────────────────────────

/** Cancels an unpaid order and frees its stock. Paid orders are cancelled through a return and refund (Phase 8). */
export async function cancelOrder(orderId: string, by: { userId?: string; customerId?: string }, reason: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (by.customerId && order.customerId !== by.customerId) throw notFound('Order');
    if (order.status !== 'PENDING_PAYMENT') throw businessRule('Only orders awaiting payment can be cancelled here');
    if (order.reservationStatus === 'ACTIVE') {
      const session = await openStockSession(tx, stockKeys(order), by.userId ?? (await systemUserId(tx)));
      await releaseReservation(session, order);
    }
    await tx.onlineOrder.update({ where: { id: orderId }, data: { status: 'CANCELLED', cancelledAt: new Date(), reservationStatus: 'RELEASED' } });
    await addHistory(tx, orderId, order.status, 'CANCELLED', { userId: by.userId ?? null, customer: Boolean(by.customerId), note: reason });
    await writeAudit(tx, ctx, { action: 'order.cancelled', entityType: 'online_order', entityId: orderId, after: { reason, byCustomer: Boolean(by.customerId) } });
  });
}

/**
 * Frees the stock of unpaid orders whose hold has run out. The order stays "awaiting payment": a late payment still
 * completes it if the stock is there, and otherwise puts it on hold. Run every minute by the server.
 */
export async function releaseExpiredReservations(now = new Date()): Promise<number> {
  const prisma = getPrisma();
  const due = await prisma.onlineOrder.findMany({ where: { reservationStatus: 'ACTIVE', reservedUntil: { lt: now } }, select: { id: true }, take: 50 });
  let released = 0;
  for (const { id } of due) {
    await transaction(async (tx) => {
      const order = await lockOrder(tx, id);
      if (order.reservationStatus !== 'ACTIVE' || !order.reservedUntil || order.reservedUntil >= now) return;
      const actorId = await systemUserId(tx);
      const session = await openStockSession(tx, stockKeys(order), actorId);
      await releaseReservation(session, order);
      await tx.onlineOrder.update({ where: { id }, data: { reservationStatus: 'RELEASED' } });
      await addHistory(tx, id, order.status, order.status, { userId: actorId, note: 'Payment not received in time; reserved items released' });
      released++;
    });
  }
  return released;
}

/** Fulfilment steps after payment: processing → packed → shipped → delivered (collected, for store pickup). */
export async function moveOrder(orderId: string, input: z.infer<typeof orderTransitionSchema>, actorId: string, ctx: RequestContext) {
  return transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    const allowed = FULFILMENT_TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(input.to)) throw businessRule(`An order that is ${order.status.toLowerCase().replace('_', ' ')} cannot move to ${input.to.toLowerCase()}`);
    if (order.status === 'PACKED' && input.to === 'DELIVERED' && !order.isPickup) throw businessRule('Ship the order before marking it delivered');
    if (order.status === 'PACKED' && input.to === 'SHIPPED' && order.isPickup) throw businessRule('Store-pickup orders are marked delivered when collected');
    await tx.onlineOrder.update({ where: { id: orderId }, data: { status: input.to, ...(input.trackingReference ? { trackingReference: input.trackingReference } : {}) } });
    await addHistory(tx, orderId, order.status, input.to, { userId: actorId, note: input.note ?? null });
    await writeAudit(tx, ctx, { action: 'order.status_changed', entityType: 'online_order', entityId: orderId, before: { status: order.status }, after: { status: input.to } });
    return getOrder(orderId, tx);
  });
}

/** Completes an on-hold order once stock is back: the deposit becomes the sale's payment. */
export async function retryFulfilment(orderId: string, actorId: string, env: Env, ctx: RequestContext) {
  return transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.status !== 'ON_HOLD') throw businessRule('Only orders on hold can be retried');
    const settings = await getSettings(tx);
    const session = await openStockSession(tx, stockKeys(order), actorId);
    if (!(await tryReserve(session, order, settings.inventory.blockExpiredSale))) throw businessRule('The items are still not in stock');
    await releaseReservation(session, order);
    const provider = providerFor(env, order.provider ?? 'MANUAL') ?? providerFor(env, 'MANUAL')!;
    const method = await tx.paymentMethod.findUniqueOrThrow({ where: { code: provider.paymentMethodCode } });
    const attempt = await tx.paymentAttempt.findFirstOrThrow({ where: { orderId, status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' } });
    const sale = await createOnlineSale(tx, session, order, { paymentMethodId: method.id, reference: attempt.reference, debit: { accountKey: 'CUSTOMER_DEPOSITS' }, actorId, settings });
    await tx.onlineOrder.update({ where: { id: orderId }, data: { status: 'PAID', saleId: sale.saleId, reservationStatus: 'CONSUMED' } });
    await addHistory(tx, orderId, 'ON_HOLD', 'PAID', { userId: actorId, note: `Back in stock; sale ${sale.number} completed from the deposit` });
    await writeAudit(tx, ctx, { action: 'order.fulfilment_retried', entityType: 'online_order', entityId: orderId, after: { saleId: sale.saleId } });
    return getOrder(orderId, tx);
  });
}
