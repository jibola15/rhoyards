import type { Prisma, Supplier } from '@prisma/client';
import type { z } from 'zod';
import type { SupplierSummary, supplierInputSchema, supplierListQuerySchema, supplierUpdateSchema } from '@rhoyards/shared';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { orderBy, pageArgs } from '../../lib/pagination';
import { getPrisma, transaction } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';

const toSummary = (s: Supplier): SupplierSummary => ({
  id: s.id,
  code: s.code,
  name: s.name,
  contactName: s.contactName,
  email: s.email,
  phone: s.phone,
  address: s.address,
  taxId: s.taxId,
  paymentTermsDays: s.paymentTermsDays,
  notes: s.notes,
  isActive: s.isActive,
  createdAt: s.createdAt.toISOString(),
});

export async function listSuppliers(query: z.infer<typeof supplierListQuerySchema>) {
  const where: Prisma.SupplierWhereInput = {
    ...(query.includeInactive ? {} : { isActive: true }),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' } },
            { code: { contains: query.q, mode: 'insensitive' } },
            { contactName: { contains: query.q, mode: 'insensitive' } },
            { phone: { contains: query.q } },
          ],
        }
      : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.supplier.findMany({
      where,
      orderBy: orderBy(query.sort, { name: (d) => ({ name: d }), code: (d) => ({ code: d }), createdAt: (d) => ({ createdAt: d }) }, { name: 'asc' }),
      ...pageArgs(query),
    }),
    prisma.supplier.count({ where }),
  ]);
  return { data: rows.map(toSummary), total };
}

export async function getSupplier(id: string): Promise<SupplierSummary> {
  const s = await getPrisma().supplier.findUnique({ where: { id } });
  if (!s) throw notFound('Supplier');
  return toSummary(s);
}

export async function createSupplier(input: z.infer<typeof supplierInputSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const code = input.code ?? (await nextDocumentNumber(tx, 'SUPPLIER', 'SUP-'));
    if (await tx.supplier.findUnique({ where: { code } })) throw conflict('A supplier with this code already exists', { field: 'code' });
    const s = await tx.supplier.create({
      data: {
        code,
        name: input.name,
        contactName: input.contactName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        taxId: input.taxId ?? null,
        paymentTermsDays: input.paymentTermsDays,
        notes: input.notes ?? null,
        isActive: input.isActive,
      },
    });
    const summary = toSummary(s);
    await writeAudit(tx, ctx, { action: 'supplier.created', entityType: 'supplier', entityId: s.id, after: summary });
    return summary;
  });
}

/** Suppliers are deactivated (isActive=false), never deleted, so purchase history keeps its references. */
export async function updateSupplier(id: string, input: z.infer<typeof supplierUpdateSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const before = await tx.supplier.findUnique({ where: { id } });
    if (!before) throw notFound('Supplier');
    const nullable = <K extends keyof typeof input>(k: K) => (input[k] !== undefined ? { [k]: input[k] ?? null } : {});
    const s = await tx.supplier.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...nullable('contactName'),
        ...nullable('email'),
        ...nullable('phone'),
        ...nullable('address'),
        ...nullable('taxId'),
        ...nullable('notes'),
        ...(input.paymentTermsDays !== undefined ? { paymentTermsDays: input.paymentTermsDays } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    const after = toSummary(s);
    await writeAudit(tx, ctx, { action: 'supplier.updated', entityType: 'supplier', entityId: id, before: toSummary(before), after });
    return after;
  });
}
