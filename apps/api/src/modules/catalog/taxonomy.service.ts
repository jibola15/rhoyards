import type { z } from 'zod';
import {
  slugify,
  type BrandSummary,
  type CategorySummary,
  type UnitSummary,
  type brandInputSchema,
  type brandUpdateSchema,
  type categoryInputSchema,
  type categoryUpdateSchema,
  type unitInputSchema,
  type unitUpdateSchema,
} from '@rhoyards/shared';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { businessRule, conflict, notFound } from '../../lib/errors';
import { getPrisma, transaction, type Db } from '../../lib/prisma';

/** Returns `base`, or `base-2`, `base-3`… — the first slug not already used in the given table. */
export async function uniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  const root = base || 'item';
  if (!(await exists(root))) return root;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${root}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw conflict('Could not generate a unique URL slug');
}

// ── Brands ───────────────────────────────────────────────────────────────

export async function listBrands(): Promise<BrandSummary[]> {
  const rows = await getPrisma().brand.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { products: { where: { archivedAt: null } } } } },
  });
  return rows.map((b) => ({
    id: b.id,
    name: b.name,
    slug: b.slug,
    description: b.description,
    isActive: b.isActive,
    productCount: b._count.products,
  }));
}

export async function createBrand(input: z.infer<typeof brandInputSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    if (await tx.brand.findFirst({ where: { name: { equals: input.name, mode: 'insensitive' } } })) {
      throw conflict('A brand with this name already exists', { field: 'name' });
    }
    const slug = await uniqueSlug(slugify(input.name), async (s) => Boolean(await tx.brand.findUnique({ where: { slug: s } })));
    const brand = await tx.brand.create({ data: { name: input.name, slug, description: input.description ?? null, isActive: input.isActive } });
    await writeAudit(tx, ctx, { action: 'brand.created', entityType: 'brand', entityId: brand.id, after: brand });
    return brand;
  });
}

export async function updateBrand(id: string, input: z.infer<typeof brandUpdateSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const before = await tx.brand.findUnique({ where: { id } });
    if (!before) throw notFound('Brand');
    if (input.name && input.name.toLowerCase() !== before.name.toLowerCase()) {
      const clash = await tx.brand.findFirst({ where: { id: { not: id }, name: { equals: input.name, mode: 'insensitive' } } });
      if (clash) throw conflict('A brand with this name already exists', { field: 'name' });
    }
    const after = await tx.brand.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await writeAudit(tx, ctx, { action: 'brand.updated', entityType: 'brand', entityId: id, before, after });
    return after;
  });
}

// ── Categories ───────────────────────────────────────────────────────────

export async function listCategories(): Promise<CategorySummary[]> {
  const rows = await getPrisma().category.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { products: { where: { archivedAt: null } } } } },
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    parentId: c.parentId,
    description: c.description,
    sortOrder: c.sortOrder,
    isActive: c.isActive,
    productCount: c._count.products,
  }));
}

/** Prevents a category becoming its own ancestor. */
async function assertNoCycle(db: Db, id: string, parentId: string | null) {
  let current = parentId;
  for (let depth = 0; current && depth < 50; depth += 1) {
    if (current === id) throw businessRule('A category cannot be placed inside itself or one of its subcategories');
    const parent: { parentId: string | null } | null = await db.category.findUnique({ where: { id: current }, select: { parentId: true } });
    current = parent?.parentId ?? null;
  }
}

export async function createCategory(input: z.infer<typeof categoryInputSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    if (input.parentId && !(await tx.category.findUnique({ where: { id: input.parentId } }))) {
      throw notFound('Parent category');
    }
    const slug = await uniqueSlug(slugify(input.name), async (s) => Boolean(await tx.category.findUnique({ where: { slug: s } })));
    const category = await tx.category.create({
      data: {
        name: input.name,
        slug,
        parentId: input.parentId,
        description: input.description ?? null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
    });
    await writeAudit(tx, ctx, { action: 'category.created', entityType: 'category', entityId: category.id, after: category });
    return category;
  });
}

export async function updateCategory(id: string, input: z.infer<typeof categoryUpdateSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const before = await tx.category.findUnique({ where: { id } });
    if (!before) throw notFound('Category');
    if (input.parentId !== undefined) await assertNoCycle(tx, id, input.parentId);
    const after = await tx.category.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await writeAudit(tx, ctx, { action: 'category.updated', entityType: 'category', entityId: id, before, after });
    return after;
  });
}

// ── Units ────────────────────────────────────────────────────────────────

export async function listUnits(): Promise<UnitSummary[]> {
  const rows = await getPrisma().unit.findMany({ orderBy: [{ isActive: 'desc' }, { code: 'asc' }] });
  return rows.map(({ id, code, name, allowsFraction, isActive }) => ({ id, code, name, allowsFraction, isActive }));
}

export async function createUnit(input: z.infer<typeof unitInputSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    if (await tx.unit.findUnique({ where: { code: input.code } })) throw conflict('A unit with this code already exists', { field: 'code' });
    const unit = await tx.unit.create({ data: input });
    await writeAudit(tx, ctx, { action: 'unit.created', entityType: 'unit', entityId: unit.id, after: unit });
    return unit;
  });
}

export async function updateUnit(id: string, input: z.infer<typeof unitUpdateSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const before = await tx.unit.findUnique({ where: { id } });
    if (!before) throw notFound('Unit');
    if (input.allowsFraction === false && before.allowsFraction) {
      // Existing fractional stock would become unrepresentable.
      const fractional = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*) AS n FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE p.unit_id = ${id}::uuid AND v.stock_qty <> trunc(v.stock_qty)`;
      if (Number(fractional[0]?.n ?? 0) > 0) throw businessRule('Some products in this unit hold fractional quantities');
    }
    const after = await tx.unit.update({ where: { id }, data: input });
    await writeAudit(tx, ctx, { action: 'unit.updated', entityType: 'unit', entityId: id, before, after });
    return after;
  });
}
