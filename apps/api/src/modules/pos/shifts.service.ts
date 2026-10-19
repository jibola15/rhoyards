import { Prisma } from '@prisma/client';
import { dec, sum, ZERO, type ShiftSummary } from '@rhoyards/shared';
import { postJournal } from '../../engines/posting/posting.service';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { businessDate } from '../../lib/business-date';
import { AppError, businessRule, conflict, forbidden, notFound } from '../../lib/errors';
import { pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import type { AuthContext } from '../auth/auth.types';

const SOURCE = 'CASHIER_SHIFT';

const include = {
  register: { select: { id: true, name: true, locationId: true, location: { select: { name: true } } } },
  cashier: { select: { id: true, fullName: true } },
  closedBy: { select: { fullName: true } },
} satisfies Prisma.CashierShiftInclude;
type Row = Prisma.CashierShiftGetPayload<{ include: typeof include }>;

/** Takings for a shift from its completed sales. Cash expected = float + cash applied (change already netted). */
async function takings(db: Db, shiftId: string) {
  const [totals] = await db.$queryRaw<{ n: bigint; total: string; discount: string; tax: string; credit: string }[]>`
    SELECT COUNT(*) AS n, COALESCE(SUM(total), 0)::text AS total, COALESCE(SUM(discount_total), 0)::text AS discount,
           COALESCE(SUM(tax_total), 0)::text AS tax, COALESCE(SUM(balance_due), 0)::text AS credit
    FROM sales WHERE shift_id = ${shiftId}::uuid AND status = 'COMPLETED'`;
  const byMethod = await db.$queryRaw<{ method_id: string; name: string; kind: string; amount: string }[]>`
    SELECT pm.id AS method_id, pm.name, pm.kind::text AS kind, SUM(sp.amount)::text AS amount
    FROM sale_payments sp
    JOIN sales s ON s.id = sp.sale_id AND s.shift_id = ${shiftId}::uuid AND s.status = 'COMPLETED'
    JOIN payment_methods pm ON pm.id = sp.payment_method_id
    GROUP BY pm.id, pm.name, pm.kind, pm.sort_order ORDER BY pm.sort_order`;
  const cash = sum(byMethod.filter((m) => m.kind === 'CASH').map((m) => m.amount));
  return { totals: totals!, byMethod, cash };
}

async function toSummary(db: Db, s: Row): Promise<ShiftSummary> {
  const t = await takings(db, s.id);
  const expected = s.expectedCash ? dec(s.expectedCash.toString()) : dec(s.openingFloat.toString()).plus(t.cash);
  return {
    id: s.id,
    number: s.number,
    status: s.status,
    register: { id: s.register.id, name: s.register.name, locationId: s.register.locationId, locationName: s.register.location.name },
    cashier: { id: s.cashier.id, name: s.cashier.fullName },
    openedAt: s.openedAt.toISOString(),
    closedAt: s.closedAt?.toISOString() ?? null,
    closedBy: s.closedBy?.fullName ?? null,
    openingFloat: s.openingFloat.toFixed(2),
    salesCount: Number(t.totals.n),
    salesTotal: dec(t.totals.total).toFixed(2),
    discountTotal: dec(t.totals.discount).toFixed(2),
    taxTotal: dec(t.totals.tax).toFixed(2),
    creditTotal: dec(t.totals.credit).toFixed(2),
    byMethod: t.byMethod.map((m) => ({ methodId: m.method_id, name: m.name, kind: m.kind, amount: dec(m.amount).toFixed(2) })),
    expectedCash: expected.toFixed(2),
    countedCash: s.countedCash?.toFixed(2) ?? null,
    variance: s.variance?.toFixed(2) ?? null,
    closeNote: s.closeNote,
  };
}

export async function getShift(id: string, db: Db = getPrisma()) {
  const s = await db.cashierShift.findUnique({ where: { id }, include });
  if (!s) throw notFound('Shift');
  return toSummary(db, s);
}

export async function myOpenShift(userId: string, db: Db = getPrisma()) {
  const s = await db.cashierShift.findFirst({ where: { cashierId: userId, status: 'OPEN' }, include });
  return s ? toSummary(db, s) : null;
}

export async function listShifts(query: { page: number; pageSize: number; q?: string | undefined; registerId?: string | undefined; cashierId?: string | undefined; status?: 'OPEN' | 'CLOSED' | undefined }) {
  const where: Prisma.CashierShiftWhereInput = {
    ...(query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { cashier: { fullName: { contains: query.q, mode: 'insensitive' } } }] } : {}),
    ...(query.registerId ? { registerId: query.registerId } : {}),
    ...(query.cashierId ? { cashierId: query.cashierId } : {}),
    ...(query.status ? { status: query.status } : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.cashierShift.findMany({ where, include, orderBy: { openedAt: 'desc' }, ...pageArgs(query) }),
    prisma.cashierShift.count({ where }),
  ]);
  return { data: await Promise.all(rows.map((r) => toSummary(prisma, r))), total };
}

/** Registers a user may use: those at their assigned locations (all, if none are assigned). */
export function assertRegisterAccess(actor: AuthContext, locationId: string) {
  const assigned = actor.user.locationIds;
  if (assigned.length > 0 && !assigned.includes(locationId)) throw forbidden('You are not assigned to this location');
}

export async function openShift(input: { registerId: string; openingFloat: string }, actor: AuthContext, ctx: RequestContext) {
  return transaction(async (tx) => {
    const register = await tx.register.findUnique({ where: { id: input.registerId }, include: { location: true } });
    if (!register?.isActive || !register.location.isActive || !register.location.isPosEnabled) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Choose an active register', { field: 'registerId' });
    }
    assertRegisterAccess(actor, register.locationId);
    if (await tx.cashierShift.findFirst({ where: { registerId: register.id, status: 'OPEN' } })) {
      throw conflict(`${register.name} already has an open shift`);
    }
    if (await tx.cashierShift.findFirst({ where: { cashierId: actor.user.id, status: 'OPEN' } })) {
      throw conflict('You already have an open shift — close it first');
    }
    const number = await nextDocumentNumber(tx, 'CASHIER_SHIFT', 'SH-');
    // The partial unique indexes catch a concurrent second open (surfaced as 409 by the error handler).
    const s = await tx.cashierShift.create({
      data: { number, registerId: register.id, cashierId: actor.user.id, openingFloat: new Prisma.Decimal(input.openingFloat) },
      include,
    });
    await writeAudit(tx, ctx, { action: 'shift.opened', entityType: 'cashier_shift', entityId: s.id, after: { number, register: register.name, openingFloat: input.openingFloat } });
    return toSummary(tx, s);
  });
}

/**
 * Closes a shift against the cash counted in the drawer. The shift row is locked first, so no sale
 * can complete on it while it is being closed. A difference is posted to Cash over/short.
 */
export async function closeShift(id: string, input: { countedCash: string; note?: string | null | undefined }, actor: AuthContext, ctx: RequestContext) {
  return transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ status: string; cashier_id: string }[]>`
      SELECT status::text, cashier_id FROM cashier_shifts WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw notFound('Shift');
    if (row.status !== 'OPEN') throw businessRule('This shift is already closed');
    const own = row.cashier_id === actor.user.id;
    if (!(own && actor.permissions.has('pos.shift.manage')) && !actor.permissions.has('pos.shift.reconcile')) {
      throw forbidden('Only the cashier or a supervisor can close this shift');
    }

    const shift = await tx.cashierShift.findUniqueOrThrow({ where: { id }, include });
    const t = await takings(tx, id);
    const expected = dec(shift.openingFloat.toString()).plus(t.cash);
    const counted = dec(input.countedCash);
    const variance = counted.minus(expected);

    let journalId: string | null = null;
    if (!variance.isZero()) {
      const amount = variance.abs();
      const journal = await postJournal(tx, {
        entryDate: businessDate(),
        sourceType: SOURCE,
        sourceId: id,
        postingKey: `${SOURCE}:${id}:VARIANCE`,
        description: `Cash ${variance.gt(ZERO) ? 'over' : 'short'} on shift ${shift.number}`,
        lines: variance.gt(ZERO)
          ? [
              { accountKey: 'CASH_ON_HAND', debit: amount, locationId: shift.register.locationId },
              { accountKey: 'CASH_OVER_SHORT', credit: amount },
            ]
          : [
              { accountKey: 'CASH_OVER_SHORT', debit: amount },
              { accountKey: 'CASH_ON_HAND', credit: amount, locationId: shift.register.locationId },
            ],
        actorId: actor.user.id,
      });
      journalId = journal.id;
    }

    await tx.cashierShift.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedById: actor.user.id,
        expectedCash: new Prisma.Decimal(expected.toFixed(2)),
        countedCash: new Prisma.Decimal(counted.toFixed(2)),
        variance: new Prisma.Decimal(variance.toFixed(2)),
        closeNote: input.note ?? null,
        journalEntryId: journalId,
      },
    });
    await writeAudit(tx, ctx, {
      action: 'shift.closed',
      entityType: 'cashier_shift',
      entityId: id,
      after: { number: shift.number, expected: expected.toFixed(2), counted: counted.toFixed(2), variance: variance.toFixed(2) },
    });
    return getShift(id, tx);
  });
}
