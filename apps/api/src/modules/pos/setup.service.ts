import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import type {
  PaymentMethodSummary,
  RegisterSummary,
  paymentMethodInputSchema,
  paymentMethodUpdateSchema,
  registerInputSchema,
  registerUpdateSchema,
} from '@rhoyards/shared';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, conflict, notFound } from '../../lib/errors';
import { getPrisma, transaction, type Db } from '../../lib/prisma';

// ── Payment methods ──────────────────────────────────────────────────────

const methodInclude = { account: { select: { id: true, code: true, name: true } } } satisfies Prisma.PaymentMethodInclude;
type MethodRow = Prisma.PaymentMethodGetPayload<{ include: typeof methodInclude }>;

const toMethod = (m: MethodRow): PaymentMethodSummary => ({
  id: m.id,
  code: m.code,
  name: m.name,
  kind: m.kind,
  account: m.account,
  requiresReference: m.requiresReference,
  availablePos: m.availablePos,
  availableOnline: m.availableOnline,
  isActive: m.isActive,
  sortOrder: m.sortOrder,
});

export async function listPaymentMethods(filter: { posOnly?: boolean } = {}, db: Db = getPrisma()) {
  const rows = await db.paymentMethod.findMany({
    where: filter.posOnly ? { isActive: true, availablePos: true } : {},
    include: methodInclude,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return rows.map(toMethod);
}

/** Payments must land in a cash/bank-type account (subtype CASH): cash drawer, card clearing, bank, gateway. */
async function assertMoneyAccount(db: Db, accountId: string) {
  const a = await db.account.findUnique({ where: { id: accountId } });
  if (!a || a.subtype !== 'CASH' || !a.isActive || !a.isPostable) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Choose an active cash, bank or clearing account', { field: 'accountId' });
  }
}

export async function createPaymentMethod(input: z.infer<typeof paymentMethodInputSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    if (await tx.paymentMethod.findUnique({ where: { code: input.code } })) throw conflict('A payment method with this code exists', { field: 'code' });
    await assertMoneyAccount(tx, input.accountId);
    const m = await tx.paymentMethod.create({ data: input, include: methodInclude });
    await writeAudit(tx, ctx, { action: 'payment_method.created', entityType: 'payment_method', entityId: m.id, after: toMethod(m) });
    return toMethod(m);
  });
}

export async function updatePaymentMethod(id: string, input: z.infer<typeof paymentMethodUpdateSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const before = await tx.paymentMethod.findUnique({ where: { id }, include: methodInclude });
    if (!before) throw notFound('Payment method');
    if (input.accountId) await assertMoneyAccount(tx, input.accountId);
    const m = await tx.paymentMethod.update({ where: { id }, data: input, include: methodInclude });
    await writeAudit(tx, ctx, { action: 'payment_method.updated', entityType: 'payment_method', entityId: id, before: toMethod(before), after: toMethod(m) });
    return toMethod(m);
  });
}

// ── Registers ────────────────────────────────────────────────────────────

const registerInclude = {
  location: { select: { id: true, name: true } },
  shifts: { where: { status: 'OPEN' }, select: { id: true, number: true, openedAt: true, cashier: { select: { fullName: true } } } },
} satisfies Prisma.RegisterInclude;
type RegisterRow = Prisma.RegisterGetPayload<{ include: typeof registerInclude }>;

const toRegister = (r: RegisterRow): RegisterSummary => {
  const open = r.shifts[0];
  return {
    id: r.id,
    name: r.name,
    location: r.location,
    isActive: r.isActive,
    openShift: open ? { id: open.id, number: open.number, cashier: open.cashier.fullName, openedAt: open.openedAt.toISOString() } : null,
  };
};

export async function listRegisters(filter: { locationIds?: string[] | undefined; activeOnly?: boolean } = {}, db: Db = getPrisma()) {
  const rows = await db.register.findMany({
    where: {
      ...(filter.activeOnly ? { isActive: true, location: { isActive: true, isPosEnabled: true } } : {}),
      ...(filter.locationIds && filter.locationIds.length > 0 ? { locationId: { in: filter.locationIds } } : {}),
    },
    include: registerInclude,
    orderBy: [{ location: { name: 'asc' } }, { name: 'asc' }],
  });
  return rows.map(toRegister);
}

export async function createRegister(input: z.infer<typeof registerInputSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const location = await tx.location.findUnique({ where: { id: input.locationId } });
    if (!location?.isActive) throw new AppError(400, 'VALIDATION_ERROR', 'Choose an active location', { field: 'locationId' });
    if (await tx.register.findFirst({ where: { locationId: input.locationId, name: { equals: input.name, mode: 'insensitive' } } })) {
      throw conflict('A register with this name exists at this location', { field: 'name' });
    }
    const r = await tx.register.create({ data: input, include: registerInclude });
    await writeAudit(tx, ctx, { action: 'register.created', entityType: 'register', entityId: r.id, after: toRegister(r) });
    return toRegister(r);
  });
}

export async function updateRegister(id: string, input: z.infer<typeof registerUpdateSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const before = await tx.register.findUnique({ where: { id }, include: registerInclude });
    if (!before) throw notFound('Register');
    if (input.isActive === false && before.shifts.length > 0) throw conflict('Close the open shift on this register first');
    const r = await tx.register.update({ where: { id }, data: input, include: registerInclude });
    await writeAudit(tx, ctx, { action: 'register.updated', entityType: 'register', entityId: id, before: toRegister(before), after: toRegister(r) });
    return toRegister(r);
  });
}
