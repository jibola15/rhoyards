import { Prisma, type Customer } from '@prisma/client';
import type { z } from 'zod';
import { dec, ZERO, type CustomerSummary, type Decimal, type customerInputSchema, type customerListQuerySchema, type customerUpdateSchema } from '@rhoyards/shared';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { orderBy, pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import { customerBalances } from './receivables.service';

export { customerBalances };

const toSummary = (c: Customer, balance?: Decimal): CustomerSummary => ({
  id: c.id,
  code: c.code,
  name: c.name,
  type: c.type,
  phone: c.phone,
  email: c.email,
  address: c.address,
  allowCredit: c.allowCredit,
  creditLimit: c.creditLimit.toFixed(2),
  balance: (balance ?? ZERO).toFixed(2),
  notes: c.notes,
  isActive: c.isActive,
  createdAt: c.createdAt.toISOString(),
});

export async function listCustomers(query: z.infer<typeof customerListQuerySchema>) {
  const where: Prisma.CustomerWhereInput = {
    ...(query.includeInactive ? {} : { isActive: true }),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' } },
            { phone: { contains: query.q.replace(/\s+/g, '') } },
            { code: { contains: query.q, mode: 'insensitive' } },
            { email: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: orderBy(query.sort, { name: (d) => ({ name: d }), createdAt: (d) => ({ createdAt: d }) }, { name: 'asc' }),
      ...pageArgs(query),
    }),
    prisma.customer.count({ where }),
  ]);
  const balances = await customerBalances(prisma, rows.map((r) => r.id));
  return { data: rows.map((c) => toSummary(c, balances.get(c.id))), total };
}

export async function getCustomer(id: string, db: Db = getPrisma()) {
  const c = await db.customer.findUnique({ where: { id } });
  if (!c) throw notFound('Customer');
  const balances = await customerBalances(db, [id]);
  return toSummary(c, balances.get(id));
}

const normalisePhone = (p: string | null | undefined) => (p ? p.replace(/\s+/g, '') : p);

export async function createCustomer(input: z.infer<typeof customerInputSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const code = await nextDocumentNumber(tx, 'CUSTOMER', 'CUS-');
    const c = await tx.customer.create({
      data: {
        code,
        name: input.name,
        type: input.type,
        phone: normalisePhone(input.phone) ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        allowCredit: input.allowCredit,
        creditLimit: new Prisma.Decimal(input.creditLimit),
        notes: input.notes ?? null,
        isActive: input.isActive,
      },
    });
    const summary = toSummary(c);
    await writeAudit(tx, ctx, { action: 'customer.created', entityType: 'customer', entityId: c.id, after: summary });
    return summary;
  });
}

export async function updateCustomer(id: string, input: z.infer<typeof customerUpdateSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const before = await getCustomer(id, tx);
    const nullable = <K extends 'phone' | 'email' | 'address' | 'notes'>(k: K) =>
      input[k] !== undefined ? { [k]: (k === 'phone' ? normalisePhone(input[k]) : input[k]) ?? null } : {};
    await tx.customer.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...nullable('phone'),
        ...nullable('email'),
        ...nullable('address'),
        ...nullable('notes'),
        ...(input.allowCredit !== undefined ? { allowCredit: input.allowCredit } : {}),
        ...(input.creditLimit !== undefined ? { creditLimit: new Prisma.Decimal(input.creditLimit) } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    const after = await getCustomer(id, tx);
    await writeAudit(tx, ctx, { action: 'customer.updated', entityType: 'customer', entityId: id, before, after });
    return after;
  });
}

/** Credit still available to a customer (limit − balance owed). */
export async function availableCredit(db: Db, customerId: string) {
  const c = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
  const owed = (await customerBalances(db, [customerId])).get(customerId) ?? ZERO;
  return { customer: c, owed, available: dec(c.creditLimit.toString()).minus(owed) };
}
