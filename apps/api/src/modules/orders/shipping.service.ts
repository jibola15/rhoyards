import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import type { ShippingMethodRow, shippingMethodInputSchema, shippingMethodUpdateSchema } from '@rhoyards/shared';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { getPrisma, transaction } from '../../lib/prisma';
import { toShippingRow } from '../store/cart.service';

export async function listShippingMethods(): Promise<ShippingMethodRow[]> {
  const rows = await getPrisma().shippingMethod.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  return rows.map(toShippingRow);
}

const duplicateName = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' ? conflict('A delivery option with this name already exists', { field: 'name' }) : e;

export async function createShippingMethod(input: z.infer<typeof shippingMethodInputSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const m = await tx.shippingMethod
      .create({
        data: {
          name: input.name,
          description: input.description ?? null,
          fee: new Prisma.Decimal(input.fee),
          freeOver: input.freeOver ? new Prisma.Decimal(input.freeOver) : null,
          states: input.isPickup ? [] : input.states,
          isPickup: input.isPickup,
          isActive: input.isActive,
          sortOrder: input.sortOrder,
        },
      })
      .catch((e: unknown) => {
        throw duplicateName(e);
      });
    const row = toShippingRow(m);
    await writeAudit(tx, ctx, { action: 'shipping_method.created', entityType: 'shipping_method', entityId: m.id, after: row });
    return row;
  });
}

export async function updateShippingMethod(id: string, input: z.infer<typeof shippingMethodUpdateSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const before = await tx.shippingMethod.findUnique({ where: { id } });
    if (!before) throw notFound('Delivery option');
    const m = await tx.shippingMethod
      .update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.fee !== undefined ? { fee: new Prisma.Decimal(input.fee) } : {}),
          ...(input.freeOver !== undefined ? { freeOver: input.freeOver ? new Prisma.Decimal(input.freeOver) : null } : {}),
          ...(input.states !== undefined ? { states: input.states } : {}),
          ...(input.isPickup !== undefined ? { isPickup: input.isPickup, ...(input.isPickup ? { states: [] } : {}) } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        },
      })
      .catch((e: unknown) => {
        throw duplicateName(e);
      });
    const after = toShippingRow(m);
    await writeAudit(tx, ctx, { action: 'shipping_method.updated', entityType: 'shipping_method', entityId: id, before: toShippingRow(before), after });
    return after;
  });
}
