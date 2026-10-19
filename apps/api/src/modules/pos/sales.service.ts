import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import {
  dec,
  priceSale,
  PricingError,
  sum,
  ZERO,
  type Decimal,
  type ReceiptData,
  type SaleDetail,
  type SaleInput,
  type SaleSummary,
  type SuspendedCart,
  type saleListQuerySchema,
  type suspendSaleSchema,
} from '@rhoyards/shared';
import { openStockSession } from '../../engines/inventory/inventory.engine';
import { postJournal, type JournalLineInput } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { businessDate, startOfBusinessDay } from '../../lib/business-date';
import { AppError, businessRule, forbidden, notFound } from '../../lib/errors';
import { pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import { authUserInclude, effectivePermissions } from '../auth/auth-user';
import type { AuthContext } from '../auth/auth.types';
import { verifyAgainstDummy, verifyPassword } from '../auth/password';
import { availableCredit } from '../customers/customers.service';
import { assertQuantityUnit } from '../inventory/stock-documents';
import { getSettings } from '../settings/settings.service';
import { assertRegisterAccess } from './shifts.service';

const SOURCE = 'SALE';
type Tx = Prisma.TransactionClient;
const money = (v: Decimal) => new Prisma.Decimal(v.toFixed(2));
const invalid = (message: string, details?: unknown) => new AppError(400, 'VALIDATION_ERROR', message, details);

// ── Read models ──────────────────────────────────────────────────────────

const include = {
  location: { select: { id: true, name: true } },
  register: { select: { id: true, name: true } },
  shift: { select: { id: true, number: true } },
  customer: { select: { id: true, name: true } },
  cashier: { select: { fullName: true } },
  discountApprovedBy: { select: { fullName: true } },
  items: { orderBy: { lineNo: 'asc' } },
  payments: { orderBy: { createdAt: 'asc' }, include: { paymentMethod: { select: { id: true, name: true, kind: true } } } },
} satisfies Prisma.SaleInclude;
type Row = Prisma.SaleGetPayload<{ include: typeof include }>;

function summary(s: Omit<Row, 'items' | 'payments' | 'shift' | 'discountApprovedBy'> & { _count?: { items: number }; items?: unknown[] }): SaleSummary {
  return {
    id: s.id,
    number: s.number,
    channel: s.channel,
    status: s.status,
    location: s.location,
    register: s.register,
    customer: s.customer,
    cashier: s.cashier.fullName,
    cashierId: s.cashierId,
    total: s.total.toFixed(2),
    balanceDue: s.balanceDue.toFixed(2),
    itemCount: s._count?.items ?? s.items?.length ?? 0,
    completedAt: s.completedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

function toDetail(s: Row): SaleDetail {
  return {
    ...summary(s),
    pricesIncludeTax: s.pricesIncludeTax,
    shift: s.shift,
    grossTotal: s.grossTotal.toFixed(2),
    discountTotal: s.discountTotal.toFixed(2),
    subtotal: s.subtotal.toFixed(2),
    taxTotal: s.taxTotal.toFixed(2),
    amountPaid: s.amountPaid.toFixed(2),
    changeGiven: s.changeGiven.toFixed(2),
    costTotal: s.costTotal.toFixed(2),
    discountApprovedBy: s.discountApprovedBy?.fullName ?? null,
    note: s.note,
    journalEntryId: s.journalEntryId,
    items: s.items.map((i) => ({
      id: i.id,
      lineNo: i.lineNo,
      variantId: i.variantId,
      sku: i.sku,
      description: i.description,
      qty: i.qty.toFixed(3),
      unitPrice: i.unitPrice.toFixed(2),
      listPrice: i.listPrice.toFixed(2),
      discountAmount: i.discountAmount.toFixed(2),
      taxRate: i.taxRate.toFixed(4),
      netAmount: i.netAmount.toFixed(2),
      taxAmount: i.taxAmount.toFixed(2),
      lineTotal: i.lineTotal.toFixed(2),
      unitCost: i.unitCost.toFixed(4),
      costAmount: i.costAmount.toFixed(2),
      qtyReturned: i.qtyReturned.toFixed(3),
    })),
    payments: s.payments.map((p) => ({
      id: p.id,
      method: p.paymentMethod,
      amount: p.amount.toFixed(2),
      tendered: p.tendered?.toFixed(2) ?? null,
      changeGiven: p.changeGiven.toFixed(2),
      reference: p.reference,
    })),
  };
}

export async function getSale(id: string, db: Db = getPrisma()) {
  const s = await db.sale.findUnique({ where: { id }, include });
  if (!s) throw notFound('Sale');
  return toDetail(s);
}

export async function listSales(query: z.infer<typeof saleListQuerySchema> & { status?: 'COMPLETED' | 'SUSPENDED'; registerId?: string | undefined }) {
  const where: Prisma.SaleWhereInput = {
    status: query.status ?? 'COMPLETED',
    ...(query.shiftId ? { shiftId: query.shiftId } : {}),
    ...(query.customerId ? { customerId: query.customerId } : {}),
    ...(query.cashierId ? { cashierId: query.cashierId } : {}),
    ...(query.registerId ? { registerId: query.registerId } : {}),
    ...(query.channel ? { channel: query.channel } : {}),
    ...(query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { customer: { name: { contains: query.q, mode: 'insensitive' } } }] } : {}),
    ...(query.from || query.to
      ? {
          completedAt: {
            ...(query.from ? { gte: startOfBusinessDay(query.from) } : {}),
            ...(query.to ? { lt: new Date(startOfBusinessDay(query.to).getTime() + 86_400_000) } : {}),
          },
        }
      : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.sale.findMany({
      where,
      include: {
        location: { select: { id: true, name: true } },
        register: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true } },
        cashier: { select: { fullName: true } },
        _count: { select: { items: true } },
      },
      orderBy: [{ completedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      ...pageArgs(query),
    }),
    prisma.sale.count({ where }),
  ]);
  return { data: rows.map(summary), total };
}

// ── Validation shared by complete and suspend ───────────────────────────

type Line = SaleInput['lines'][number];

async function loadContext(tx: Tx, input: { registerId: string; customerId?: string | null | undefined; lines: Line[] }, actor: AuthContext) {
  const register = await tx.register.findUnique({ where: { id: input.registerId }, include: { location: true } });
  if (!register?.isActive || !register.location.isActive || !register.location.isPosEnabled) {
    throw invalid('This register is not available', { field: 'registerId' });
  }
  assertRegisterAccess(actor, register.locationId);

  // FOR SHARE on the shift: a close (FOR UPDATE) waits for in-flight sales and vice versa.
  const [shift] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM cashier_shifts WHERE register_id = ${register.id}::uuid AND cashier_id = ${actor.user.id}::uuid AND status = 'OPEN' FOR SHARE`;
  if (!shift) throw businessRule('Open a shift on this register before selling');

  const customer = input.customerId ? await tx.customer.findUnique({ where: { id: input.customerId } }) : null;
  if (input.customerId && !customer?.isActive) throw invalid('Customer not found or inactive', { field: 'customerId' });

  const variants = new Map(
    (
      await tx.productVariant.findMany({
        where: { id: { in: input.lines.map((l) => l.variantId) } },
        include: { product: { include: { taxRate: true, unit: true } } },
      })
    ).map((v) => [v.id, v]),
  );
  const settings = await getSettings(tx);
  const priced = input.lines.map((l, i) => {
    const n = i + 1;
    const v = variants.get(l.variantId);
    if (!v || v.archivedAt || v.product.archivedAt) throw invalid(`Line ${n}: product not found`, { line: n });
    if (v.status !== 'ACTIVE' || v.product.status !== 'ACTIVE') throw businessRule(`Line ${n}: ${v.sku} is not for sale (${v.product.status === 'ACTIVE' ? v.status : v.product.status})`);
    assertQuantityUnit(n, v.sku, v.product.unit.allowsFraction, v.product.unit.code, l.qty);
    // Tax is charged only when the business is VAT-registered.
    const taxRate = settings.business.vatRegistered ? dec(v.product.taxRate.rate.toString()) : ZERO;
    return { line: l, variant: v, taxRate, taxRateId: settings.business.vatRegistered ? v.product.taxRateId : null };
  });

  let pricing;
  try {
    pricing = priceSale(
      priced.map((p) => ({ qty: p.line.qty, unitPrice: p.line.unitPrice, discount: p.line.discount ?? null, taxRate: p.taxRate })),
      settings.pricing.pricesIncludeTax,
    );
  } catch (e) {
    if (e instanceof PricingError) throw invalid(e.message, { line: e.line });
    throw e;
  }
  return { register, shiftId: shift.id, customer, priced, pricing, settings };
}

/** Checks price overrides and discount authority. Returns the approving supervisor, if one was needed. */
async function authorise(
  tx: Tx,
  ctx: Awaited<ReturnType<typeof loadContext>>,
  actor: AuthContext,
  approval: SaleInput['discountApproval'],
) {
  for (const [i, p] of ctx.priced.entries()) {
    if (!dec(p.line.unitPrice).equals(p.variant.sellingPrice.toString()) && !actor.permissions.has('pos.price.override')) {
      throw forbidden(`Line ${i + 1}: changing the price of ${p.variant.sku} needs the price-override permission`);
    }
  }
  const hasDiscount = ctx.pricing.discountTotal.gt(ZERO);
  if (!hasDiscount) return null;

  const limit = dec(ctx.settings.pos.maxDiscountPercent);
  const withinLimit = ctx.pricing.maxDiscountPercent.lte(limit);
  const actorMay = actor.permissions.has('pos.discount.override') || (withinLimit && actor.permissions.has('pos.discount'));
  if (actorMay) return null;

  if (!approval) {
    throw new AppError(403, 'FORBIDDEN', withinLimit ? 'Discounts need a supervisor' : `Discounts above ${limit.toFixed(0)}% need a supervisor's approval`, {
      approvalRequired: true,
    });
  }
  // Supervisor approval at the till: their own credentials, checked like a login.
  const supervisor = await tx.user.findUnique({ where: { email: approval.email.toLowerCase() }, include: authUserInclude });
  if (!supervisor) {
    await verifyAgainstDummy(approval.password);
    throw new AppError(403, 'FORBIDDEN', 'Supervisor approval failed', { approvalRequired: true });
  }
  const ok = supervisor.status === 'ACTIVE' && (await verifyPassword(supervisor.passwordHash, approval.password));
  if (!ok || !effectivePermissions(supervisor).has('pos.discount.override') || supervisor.id === actor.user.id) {
    throw new AppError(403, 'FORBIDDEN', 'Supervisor approval failed', { approvalRequired: true });
  }
  return supervisor.id;
}

function itemRows(ctx: Awaited<ReturnType<typeof loadContext>>) {
  return ctx.priced.map((p, i) => {
    const l = ctx.pricing.lines[i]!;
    return {
      lineNo: i + 1,
      variantId: p.variant.id,
      sku: p.variant.sku,
      description: `${p.variant.product.name} — ${p.variant.name}`,
      qty: new Prisma.Decimal(p.line.qty),
      unitPrice: new Prisma.Decimal(p.line.unitPrice),
      listPrice: p.variant.sellingPrice,
      discountAmount: money(l.discount),
      taxRateId: p.taxRateId,
      taxRate: new Prisma.Decimal(p.taxRate.toFixed(4)),
      netAmount: money(l.net),
      taxAmount: money(l.tax),
      lineTotal: money(l.total),
    };
  });
}

// ── Complete a sale ──────────────────────────────────────────────────────

/**
 * Completes a POS sale atomically:
 *  1. validates register, open shift, customer, products, prices and discount authority;
 *  2. saves the sale and its lines;
 *  3. records the payments (split, with change on cash) — any shortfall only as authorised credit;
 *  4. issues stock first-expiry-first-out at moving-average cost (expired lots blocked per settings);
 *  5. posts revenue, VAT, payments/AR, and COGS / inventory in one journal;
 *  6. writes the audit record.
 * Any failure rolls the whole transaction back.
 */
export async function completeSale(input: SaleInput, actor: AuthContext, reqCtx: RequestContext, idempotencyKey: string): Promise<SaleDetail> {
  return transaction(async (tx) => {
    const ctx = await loadContext(tx, input, actor);
    const approvedBy = await authorise(tx, ctx, actor, input.discountApproval);
    const total = ctx.pricing.total;

    // Payments
    const methods = new Map(
      (await tx.paymentMethod.findMany({ where: { id: { in: input.payments.map((p) => p.paymentMethodId) } } })).map((m) => [m.id, m]),
    );
    const payments = input.payments.map((p, i) => {
      const m = methods.get(p.paymentMethodId);
      if (!m?.isActive || !m.availablePos) throw invalid(`Payment ${i + 1}: this payment method is not available`, { payment: i + 1 });
      if (m.requiresReference && !p.reference) throw invalid(`Payment ${i + 1}: enter the ${m.name} reference`, { payment: i + 1, field: 'reference' });
      const amount = dec(p.amount);
      let change = ZERO;
      if (p.tendered !== undefined) {
        if (m.kind !== 'CASH') throw invalid(`Payment ${i + 1}: change can only be given on cash`, { payment: i + 1 });
        const tendered = dec(p.tendered);
        if (tendered.lt(amount)) throw invalid(`Payment ${i + 1}: cash tendered is less than the amount`, { payment: i + 1 });
        change = tendered.minus(amount);
      }
      return { input: p, method: m, amount, change };
    });
    const paid = sum(payments.map((p) => p.amount));
    if (paid.gt(total)) throw invalid(`Payments (${paid.toFixed(2)}) exceed the total (${total.toFixed(2)}); give change on cash instead`, { field: 'payments' });
    const balanceDue = total.minus(paid);

    // Anything unpaid can only go on an authorised customer's account.
    if (balanceDue.gt(ZERO)) {
      if (!ctx.customer) throw businessRule(`${balanceDue.toFixed(2)} is still to be paid`, { balanceDue: balanceDue.toFixed(2) });
      if (!actor.permissions.has('pos.credit_sale')) throw forbidden('Selling on credit needs the credit-sale permission');
      if (!ctx.customer.allowCredit) throw businessRule(`${ctx.customer.name} is not set up for credit`);
      const credit = await availableCredit(tx, ctx.customer.id);
      if (balanceDue.gt(credit.available)) {
        throw businessRule(`Credit limit exceeded: ${credit.available.toFixed(2)} available, ${balanceDue.toFixed(2)} needed`, {
          available: credit.available.toFixed(2),
        });
      }
    }

    // 2. The sale and its lines (still unnumbered until everything else has succeeded)
    const saleId = randomUUID();
    await tx.sale.create({
      data: {
        id: saleId,
        status: 'SUSPENDED',
        channel: 'POS',
        locationId: ctx.register.locationId,
        registerId: ctx.register.id,
        shiftId: ctx.shiftId,
        customerId: ctx.customer?.id ?? null,
        cashierId: actor.user.id,
        pricesIncludeTax: ctx.settings.pricing.pricesIncludeTax,
        note: input.note ?? null,
        items: { create: itemRows(ctx) },
      },
    });
    const items = await tx.saleItem.findMany({ where: { saleId }, orderBy: { lineNo: 'asc' } });

    // 4. Stock out (FEFO, moving average)
    const session = await openStockSession(tx, items.map((i) => ({ variantId: i.variantId, locationId: ctx.register.locationId })), actor.user.id);
    const allowNegative = ctx.settings.inventory.allowNegativeStock && actor.permissions.has('stock.negative.allow');
    let costTotal = ZERO;
    for (const item of items) {
      const issue = await session.issue({
        variantId: item.variantId,
        locationId: ctx.register.locationId,
        qty: dec(item.qty.toString()),
        type: 'SALE',
        source: { type: SOURCE, id: saleId, lineId: item.id },
        expired: ctx.settings.inventory.blockExpiredSale ? 'block' : 'allow',
        allowNegative,
      });
      costTotal = costTotal.plus(issue.totalCost);
      await tx.saleItem.update({ where: { id: item.id }, data: { unitCost: new Prisma.Decimal(issue.unitCost.toFixed(4)), costAmount: money(issue.totalCost) } });
    }

    // 3. Payments
    if (payments.length > 0) {
      await tx.salePayment.createMany({
        data: payments.map((p) => ({
          saleId,
          paymentMethodId: p.method.id,
          amount: money(p.amount),
          tendered: p.input.tendered !== undefined ? new Prisma.Decimal(p.input.tendered) : null,
          changeGiven: money(p.change),
          reference: p.input.reference ?? null,
        })),
      });
    }

    // 5. One journal: money in, revenue and VAT out, cost of the goods sold
    const number = await nextDocumentNumber(tx, 'SALE', 'S-');
    const lines: JournalLineInput[] = [];
    const byAccount = new Map<string, Decimal>();
    for (const p of payments) byAccount.set(p.method.accountId, (byAccount.get(p.method.accountId) ?? ZERO).plus(p.amount));
    for (const [accountId, amount] of byAccount) lines.push({ accountId, debit: amount, locationId: ctx.register.locationId });
    if (balanceDue.gt(ZERO)) lines.push({ accountKey: 'AR', debit: balanceDue, memo: `On account: ${ctx.customer!.name}` });
    if (ctx.pricing.subtotal.gt(ZERO)) lines.push({ accountKey: 'SALES_REVENUE', credit: ctx.pricing.subtotal, locationId: ctx.register.locationId });
    if (ctx.pricing.taxTotal.gt(ZERO)) lines.push({ accountKey: 'VAT_OUTPUT', credit: ctx.pricing.taxTotal });
    if (costTotal.gt(ZERO)) {
      lines.push({ accountKey: 'COGS', debit: costTotal, locationId: ctx.register.locationId }, { accountKey: 'INVENTORY', credit: costTotal, locationId: ctx.register.locationId });
    }
    const journal =
      lines.length >= 2
        ? await postJournal(tx, {
            entryDate: businessDate(),
            sourceType: SOURCE,
            sourceId: saleId,
            postingKey: `${SOURCE}:${saleId}`,
            description: `POS sale ${number}`,
            lines,
            actorId: actor.user.id,
          })
        : null;

    await tx.sale.update({
      where: { id: saleId },
      data: {
        status: 'COMPLETED',
        number,
        grossTotal: money(ctx.pricing.grossTotal),
        discountTotal: money(ctx.pricing.discountTotal),
        subtotal: money(ctx.pricing.subtotal),
        taxTotal: money(ctx.pricing.taxTotal),
        total: money(total),
        amountPaid: money(paid),
        changeGiven: money(sum(payments.map((p) => p.change))),
        balanceDue: money(balanceDue),
        costTotal: money(costTotal),
        discountApprovedById: approvedBy,
        idempotencyKey,
        journalEntryId: journal?.id ?? null,
        completedAt: new Date(),
      },
    });

    // 6. Audit
    await writeAudit(tx, reqCtx, {
      action: 'sale.completed',
      entityType: 'sale',
      entityId: saleId,
      after: {
        number,
        total: total.toFixed(2),
        discount: ctx.pricing.discountTotal.toFixed(2),
        balanceDue: balanceDue.toFixed(2),
        ...(approvedBy ? { discountApprovedBy: approvedBy } : {}),
      },
    });
    return getSale(saleId, tx);
  });
}

// ── Suspend / resume ─────────────────────────────────────────────────────

export async function suspendSale(input: z.infer<typeof suspendSaleSchema>, actor: AuthContext, reqCtx: RequestContext) {
  return transaction(async (tx) => {
    const ctx = await loadContext(tx, input, actor);
    const id = randomUUID();
    await tx.sale.create({
      data: {
        id,
        status: 'SUSPENDED',
        locationId: ctx.register.locationId,
        registerId: ctx.register.id,
        shiftId: ctx.shiftId,
        customerId: ctx.customer?.id ?? null,
        cashierId: actor.user.id,
        pricesIncludeTax: ctx.settings.pricing.pricesIncludeTax,
        grossTotal: money(ctx.pricing.grossTotal),
        discountTotal: money(ctx.pricing.discountTotal),
        subtotal: money(ctx.pricing.subtotal),
        taxTotal: money(ctx.pricing.taxTotal),
        total: money(ctx.pricing.total),
        note: input.note ?? null,
        items: { create: itemRows(ctx) },
      },
    });
    await writeAudit(tx, reqCtx, { action: 'sale.suspended', entityType: 'sale', entityId: id, after: { total: ctx.pricing.total.toFixed(2) } });
    return getSale(id, tx);
  });
}

/** Returns a suspended sale's cart to the till and removes the parked record (it never touched stock or the ledger). */
export async function resumeSale(id: string, actor: AuthContext, reqCtx: RequestContext): Promise<SuspendedCart> {
  return transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ status: string }[]>`SELECT status::text FROM sales WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw notFound('Sale');
    if (row.status !== 'SUSPENDED') throw businessRule('Only suspended sales can be resumed');
    const sale = await tx.sale.findUniqueOrThrow({
      where: { id },
      include: {
        items: { orderBy: { lineNo: 'asc' }, include: { variant: { select: { product: { select: { unit: { select: { allowsFraction: true } } } } } } } },
        customer: { select: { id: true, name: true } },
      },
    });
    const location = await tx.location.findUniqueOrThrow({ where: { id: sale.locationId } });
    assertRegisterAccess(actor, location.id);
    await tx.sale.delete({ where: { id } });
    await writeAudit(tx, reqCtx, { action: 'sale.resumed', entityType: 'sale', entityId: id, before: { total: sale.total.toFixed(2), items: sale.items.length } });
    return {
      registerId: sale.registerId,
      customer: sale.customer,
      note: sale.note,
      lines: sale.items.map((i) => ({
        variantId: i.variantId,
        sku: i.sku,
        description: i.description,
        qty: i.qty.toFixed(3),
        unitPrice: i.unitPrice.toFixed(2),
        listPrice: i.listPrice.toFixed(2),
        taxRate: i.taxRate.toFixed(4),
        allowsFraction: i.variant.product.unit.allowsFraction,
        discount: i.discountAmount.gt(0) ? { type: 'amount' as const, value: i.discountAmount.toFixed(2) } : null,
      })),
    };
  });
}

// ── Receipt ──────────────────────────────────────────────────────────────

export async function receiptFor(id: string): Promise<ReceiptData> {
  const sale = await getSale(id);
  if (sale.status !== 'COMPLETED') throw businessRule('Only completed sales have receipts');
  const settings = await getSettings();
  const byRate = new Map<string, { net: Decimal; tax: Decimal }>();
  for (const i of sale.items) {
    const r = byRate.get(i.taxRate) ?? { net: ZERO, tax: ZERO };
    byRate.set(i.taxRate, { net: r.net.plus(i.netAmount), tax: r.tax.plus(i.taxAmount) });
  }
  return {
    business: settings.business,
    header: settings.receipt.header,
    footer: settings.receipt.footer,
    currency: settings.currency,
    sale,
    taxSummary: [...byRate.entries()].map(([rate, v]) => ({ rate, net: v.net.toFixed(2), tax: v.tax.toFixed(2) })),
  };
}
