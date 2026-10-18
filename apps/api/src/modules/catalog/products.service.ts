import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import {
  dec,
  slugify,
  type ProductDetail,
  type ProductInput,
  type ProductSummary,
  type ProductUpdateInput,
  type VariantDetail,
  type VariantInput,
  type VariantLookup,
  type productListQuerySchema,
  type variantSearchQuerySchema,
  type variantUpdateSchema,
} from '@rhoyards/shared';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, businessRule, conflict, notFound } from '../../lib/errors';
import { orderBy, pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { fileUrl } from '../files/files.service';
import { uniqueSlug } from './taxonomy.service';

const variantInclude = {
  barcodes: { orderBy: [{ isPrimary: 'desc' }, { barcode: 'asc' }] },
  volumeUnit: { select: { id: true, code: true } },
} satisfies Prisma.ProductVariantInclude;

const productInclude = {
  brand: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
  unit: { select: { id: true, code: true, name: true, allowsFraction: true } },
  taxRate: { select: { id: true, name: true, rate: true } },
  variants: { include: variantInclude, orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }] },
  images: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ProductInclude;

type VariantRow = Prisma.ProductVariantGetPayload<{ include: typeof variantInclude }>;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

const str = (d: Prisma.Decimal | null, dp: number) => (d === null ? null : d.toFixed(dp));
const pd = (v: string | null | undefined) => (v === null || v === undefined ? null : new Prisma.Decimal(v));

function toVariant(v: VariantRow): VariantDetail {
  return {
    id: v.id,
    productId: v.productId,
    sku: v.sku,
    name: v.name,
    shade: v.shade,
    colour: v.colour,
    tone: v.tone,
    size: v.size,
    volumeValue: str(v.volumeValue, 3),
    volumeUnit: v.volumeUnit,
    sellingPrice: v.sellingPrice.toFixed(2),
    compareAtPrice: str(v.compareAtPrice, 2),
    standardCost: str(v.standardCost, 4),
    avgCost: v.avgCost.toFixed(4),
    stockQty: v.stockQty.toFixed(3),
    stockValue: v.stockValue.toFixed(2),
    reorderLevel: v.reorderLevel.toFixed(3),
    reorderQty: v.reorderQty.toFixed(3),
    status: v.status,
    archived: v.archivedAt !== null,
    barcodes: v.barcodes.map((b) => b.barcode),
  };
}

function toDetail(p: ProductRow): ProductDetail {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    status: p.status,
    brand: p.brand,
    category: p.category,
    onlineVisible: p.onlineVisible,
    archived: p.archivedAt !== null,
    description: p.description,
    unit: p.unit,
    taxRate: { id: p.taxRate.id, name: p.taxRate.name, rate: p.taxRate.rate.toFixed(4) },
    isBatchTracked: p.isBatchTracked,
    isExpiryTracked: p.isExpiryTracked,
    variants: p.variants.map(toVariant),
    images: p.images.map((i) => ({
      id: i.id,
      fileId: i.fileId,
      url: fileUrl(i.fileId),
      altText: i.altText,
      variantId: i.variantId,
      sortOrder: i.sortOrder,
    })),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function getProduct(id: string, db: Db = getPrisma()): Promise<ProductDetail> {
  const p = await db.product.findUnique({ where: { id }, include: productInclude });
  if (!p) throw notFound('Product');
  return toDetail(p);
}

// ── Validation helpers ───────────────────────────────────────────────────

async function assertReferences(db: Db, refs: { brandId?: string | null; categoryId?: string | null; unitId?: string; taxRateId?: string }) {
  const checks: Promise<void>[] = [];
  if (refs.brandId) {
    checks.push(
      db.brand.findUnique({ where: { id: refs.brandId } }).then((b) => {
        if (!b) throw new AppError(400, 'VALIDATION_ERROR', 'Brand not found', { field: 'brandId' });
      }),
    );
  }
  if (refs.categoryId) {
    checks.push(
      db.category.findUnique({ where: { id: refs.categoryId } }).then((c) => {
        if (!c) throw new AppError(400, 'VALIDATION_ERROR', 'Category not found', { field: 'categoryId' });
      }),
    );
  }
  if (refs.unitId) {
    checks.push(
      db.unit.findUnique({ where: { id: refs.unitId } }).then((u) => {
        if (!u?.isActive) throw new AppError(400, 'VALIDATION_ERROR', 'Choose an active unit', { field: 'unitId' });
      }),
    );
  }
  if (refs.taxRateId) {
    checks.push(
      db.taxRate.findUnique({ where: { id: refs.taxRateId } }).then((t) => {
        if (!t?.isActive) throw new AppError(400, 'VALIDATION_ERROR', 'Choose an active tax rate', { field: 'taxRateId' });
      }),
    );
  }
  await Promise.all(checks);
}

async function assertCodesFree(db: Db, skus: string[], barcodes: string[], exceptVariantId?: string) {
  if (skus.length > 0) {
    const taken = await db.productVariant.findMany({
      where: { sku: { in: skus }, ...(exceptVariantId ? { id: { not: exceptVariantId } } : {}) },
      select: { sku: true },
    });
    if (taken.length > 0) throw conflict(`SKU already in use: ${taken.map((t) => t.sku).join(', ')}`, { field: 'sku', skus: taken.map((t) => t.sku) });
  }
  if (barcodes.length > 0) {
    if (new Set(barcodes).size !== barcodes.length) throw conflict('The same barcode is listed twice', { field: 'barcodes' });
    const taken = await db.variantBarcode.findMany({
      where: { barcode: { in: barcodes }, ...(exceptVariantId ? { variantId: { not: exceptVariantId } } : {}) },
      select: { barcode: true },
    });
    if (taken.length > 0) {
      throw conflict(`Barcode already in use: ${taken.map((t) => t.barcode).join(', ')}`, { field: 'barcodes', barcodes: taken.map((t) => t.barcode) });
    }
  }
}

function assertWholeQuantities(allowsFraction: boolean, values: (string | undefined | null)[]) {
  if (allowsFraction) return;
  if (values.some((v) => v && !dec(v).isInteger())) {
    throw new AppError(400, 'VALIDATION_ERROR', 'This unit is counted in whole numbers; reorder quantities must be whole', { field: 'reorderLevel' });
  }
}

function variantData(v: VariantInput) {
  return {
    sku: v.sku,
    name: v.name,
    shade: v.shade ?? null,
    colour: v.colour ?? null,
    tone: v.tone ?? null,
    size: v.size ?? null,
    volumeValue: pd(v.volumeValue),
    volumeUnitId: v.volumeUnitId,
    sellingPrice: new Prisma.Decimal(v.sellingPrice),
    compareAtPrice: pd(v.compareAtPrice),
    standardCost: pd(v.standardCost),
    reorderLevel: new Prisma.Decimal(v.reorderLevel),
    reorderQty: new Prisma.Decimal(v.reorderQty),
    status: v.status,
    barcodes: { create: v.barcodes.map((barcode, i) => ({ barcode, isPrimary: i === 0 })) },
  };
}

// ── Products ─────────────────────────────────────────────────────────────

export async function createProduct(input: ProductInput, ctx: RequestContext): Promise<ProductDetail> {
  return transaction(async (tx) => {
    await assertReferences(tx, input);
    await assertCodesFree(
      tx,
      input.variants.map((v) => v.sku),
      input.variants.flatMap((v) => v.barcodes),
    );
    const unit = await tx.unit.findUniqueOrThrow({ where: { id: input.unitId } });
    assertWholeQuantities(unit.allowsFraction, input.variants.flatMap((v) => [v.reorderLevel, v.reorderQty]));
    const slug = await uniqueSlug(slugify(input.name), async (s) => Boolean(await tx.product.findUnique({ where: { slug: s } })));

    const created = await tx.product.create({
      data: {
        name: input.name,
        slug,
        brandId: input.brandId,
        categoryId: input.categoryId,
        unitId: input.unitId,
        taxRateId: input.taxRateId,
        description: input.description ?? null,
        isBatchTracked: input.isBatchTracked,
        isExpiryTracked: input.isExpiryTracked,
        status: input.status,
        onlineVisible: input.onlineVisible,
        createdById: ctx.actorId!,
        variants: { create: input.variants.map(variantData) },
      },
      include: productInclude,
    });
    const detail = toDetail(created);
    await writeAudit(tx, ctx, { action: 'product.created', entityType: 'product', entityId: created.id, after: detail });
    return detail;
  });
}

async function hasStock(db: Db, productId: string) {
  const n = await db.productVariant.count({ where: { productId, stockQty: { not: 0 } } });
  return n > 0;
}

export async function updateProduct(id: string, input: ProductUpdateInput, ctx: RequestContext): Promise<ProductDetail> {
  return transaction(async (tx) => {
    const before = await getProduct(id, tx);
    await assertReferences(tx, input);

    const isExpiryTracked = input.isExpiryTracked ?? before.isExpiryTracked;
    const isBatchTracked = (input.isBatchTracked ?? before.isBatchTracked) || isExpiryTracked;
    const trackingChanged = isBatchTracked !== before.isBatchTracked || isExpiryTracked !== before.isExpiryTracked;
    const unitChanged = input.unitId !== undefined && input.unitId !== before.unit.id;
    if ((trackingChanged || unitChanged) && (await hasStock(tx, id))) {
      throw businessRule('Batch/expiry tracking and the unit can only be changed while the product has no stock');
    }

    await tx.product.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.brandId !== undefined ? { brandId: input.brandId } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
        ...(input.taxRateId !== undefined ? { taxRateId: input.taxRateId } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.onlineVisible !== undefined ? { onlineVisible: input.onlineVisible } : {}),
        isBatchTracked,
        isExpiryTracked,
      },
    });
    const after = await getProduct(id, tx);
    await writeAudit(tx, ctx, { action: 'product.updated', entityType: 'product', entityId: id, before, after });
    return after;
  });
}

/** Archiving hides a product from lists and sale; its history stays intact. Requires zero stock. */
export async function setProductArchived(id: string, archived: boolean, ctx: RequestContext): Promise<ProductDetail> {
  return transaction(async (tx) => {
    const before = await getProduct(id, tx);
    if (archived && (await hasStock(tx, id))) throw businessRule('Bring stock to zero (adjust or transfer it) before archiving');
    const archivedAt = archived ? new Date() : null;
    await tx.product.update({ where: { id }, data: { archivedAt } });
    await tx.productVariant.updateMany({ where: { productId: id }, data: { archivedAt } });
    const after = await getProduct(id, tx);
    await writeAudit(tx, ctx, { action: archived ? 'product.archived' : 'product.restored', entityType: 'product', entityId: id, before, after });
    return after;
  });
}

export async function listProducts(query: z.infer<typeof productListQuerySchema>) {
  const q = query.q;
  const where: Prisma.ProductWhereInput = {
    ...(query.includeArchived ? {} : { archivedAt: null }),
    ...(query.brandId ? { brandId: query.brandId } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { variants: { some: { sku: { contains: q, mode: 'insensitive' } } } },
            { variants: { some: { name: { contains: q, mode: 'insensitive' } } } },
            { variants: { some: { barcodes: { some: { barcode: q } } } } },
            { brand: { name: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        brand: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        variants: { where: { archivedAt: null }, select: { sellingPrice: true, stockQty: true } },
        images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { fileId: true } },
      },
      orderBy: orderBy(
        query.sort,
        { name: (d) => ({ name: d }), createdAt: (d) => ({ createdAt: d }), updatedAt: (d) => ({ updatedAt: d }) },
        { name: 'asc' },
      ),
      ...pageArgs(query),
    }),
    prisma.product.count({ where }),
  ]);
  const data: ProductSummary[] = rows.map((p) => {
    const prices = p.variants.map((v) => v.sellingPrice);
    const min = prices.length ? prices.reduce((a, b) => (b.lt(a) ? b : a)) : null;
    const max = prices.length ? prices.reduce((a, b) => (b.gt(a) ? b : a)) : null;
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      status: p.status,
      brand: p.brand,
      category: p.category,
      variantCount: p.variants.length,
      priceMin: min?.toFixed(2) ?? null,
      priceMax: max?.toFixed(2) ?? null,
      stockQty: p.variants.reduce((s, v) => s.plus(v.stockQty), new Prisma.Decimal(0)).toFixed(3),
      onlineVisible: p.onlineVisible,
      archived: p.archivedAt !== null,
      imageUrl: p.images[0] ? fileUrl(p.images[0].fileId) : null,
    };
  });
  return { data, total };
}

// ── Variants ─────────────────────────────────────────────────────────────

export async function addVariant(productId: string, input: VariantInput, ctx: RequestContext): Promise<ProductDetail> {
  return transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: productId }, include: { unit: true } });
    if (!product) throw notFound('Product');
    if (product.archivedAt) throw businessRule('Restore the product before adding variants');
    await assertCodesFree(tx, [input.sku], input.barcodes);
    assertWholeQuantities(product.unit.allowsFraction, [input.reorderLevel, input.reorderQty]);
    const variant = await tx.productVariant.create({ data: { ...variantData(input), productId }, include: variantInclude });
    await writeAudit(tx, ctx, { action: 'variant.created', entityType: 'variant', entityId: variant.id, after: toVariant(variant) });
    return getProduct(productId, tx);
  });
}

export async function updateVariant(id: string, input: z.infer<typeof variantUpdateSchema>, ctx: RequestContext): Promise<ProductDetail> {
  return transaction(async (tx) => {
    const existing = await tx.productVariant.findUnique({ where: { id }, include: { ...variantInclude, product: { include: { unit: true } } } });
    if (!existing) throw notFound('Variant');
    await assertCodesFree(tx, input.sku && input.sku !== existing.sku ? [input.sku] : [], input.barcodes ?? [], id);
    assertWholeQuantities(existing.product.unit.allowsFraction, [input.reorderLevel, input.reorderQty]);
    const before = toVariant(existing);

    await tx.productVariant.update({
      where: { id },
      data: {
        ...(input.sku !== undefined ? { sku: input.sku } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.shade !== undefined ? { shade: input.shade ?? null } : {}),
        ...(input.colour !== undefined ? { colour: input.colour ?? null } : {}),
        ...(input.tone !== undefined ? { tone: input.tone ?? null } : {}),
        ...(input.size !== undefined ? { size: input.size ?? null } : {}),
        ...(input.volumeValue !== undefined ? { volumeValue: pd(input.volumeValue) } : {}),
        ...(input.volumeUnitId !== undefined ? { volumeUnitId: input.volumeUnitId } : {}),
        ...(input.sellingPrice !== undefined ? { sellingPrice: new Prisma.Decimal(input.sellingPrice) } : {}),
        ...(input.compareAtPrice !== undefined ? { compareAtPrice: pd(input.compareAtPrice) } : {}),
        ...(input.standardCost !== undefined ? { standardCost: pd(input.standardCost) } : {}),
        ...(input.reorderLevel !== undefined ? { reorderLevel: new Prisma.Decimal(input.reorderLevel) } : {}),
        ...(input.reorderQty !== undefined ? { reorderQty: new Prisma.Decimal(input.reorderQty) } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
    if (input.barcodes) {
      await tx.variantBarcode.deleteMany({ where: { variantId: id } });
      await tx.variantBarcode.createMany({ data: input.barcodes.map((barcode, i) => ({ variantId: id, barcode, isPrimary: i === 0 })) });
    }
    const after = toVariant(await tx.productVariant.findUniqueOrThrow({ where: { id }, include: variantInclude }));
    // Price changes are a frequent audit question, so they are recorded with before/after like any change.
    await writeAudit(tx, ctx, { action: 'variant.updated', entityType: 'variant', entityId: id, before, after });
    return getProduct(existing.productId, tx);
  });
}

export async function setVariantArchived(id: string, archived: boolean, ctx: RequestContext): Promise<ProductDetail> {
  return transaction(async (tx) => {
    const v = await tx.productVariant.findUnique({ where: { id } });
    if (!v) throw notFound('Variant');
    if (archived && !v.stockQty.isZero()) throw businessRule('Bring this variant’s stock to zero before archiving it');
    if (archived) {
      const others = await tx.productVariant.count({ where: { productId: v.productId, archivedAt: null, id: { not: id } } });
      if (others === 0) throw businessRule('A product needs at least one active variant — archive the product instead');
    }
    await tx.productVariant.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
    await writeAudit(tx, ctx, { action: archived ? 'variant.archived' : 'variant.restored', entityType: 'variant', entityId: id });
    return getProduct(v.productId, tx);
  });
}

// ── Images ───────────────────────────────────────────────────────────────

export async function addProductImage(
  productId: string,
  input: { fileId: string; altText?: string | undefined; variantId?: string | null },
  ctx: RequestContext,
): Promise<ProductDetail> {
  return transaction(async (tx) => {
    if (!(await tx.product.findUnique({ where: { id: productId } }))) throw notFound('Product');
    const file = await tx.file.findUnique({ where: { id: input.fileId } });
    if (!file || !file.mimeType.startsWith('image/') || file.visibility !== 'PUBLIC') {
      throw new AppError(400, 'VALIDATION_ERROR', 'Upload the image first', { field: 'fileId' });
    }
    if (input.variantId && !(await tx.productVariant.findFirst({ where: { id: input.variantId, productId } }))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Variant does not belong to this product', { field: 'variantId' });
    }
    const last = await tx.productImage.aggregate({ where: { productId }, _max: { sortOrder: true } });
    await tx.productImage.create({
      data: {
        productId,
        fileId: input.fileId,
        altText: input.altText ?? null,
        variantId: input.variantId ?? null,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });
    await writeAudit(tx, ctx, { action: 'product.image_added', entityType: 'product', entityId: productId, after: { fileId: input.fileId } });
    return getProduct(productId, tx);
  });
}

export async function removeProductImage(productId: string, imageId: string, ctx: RequestContext): Promise<ProductDetail> {
  return transaction(async (tx) => {
    const image = await tx.productImage.findFirst({ where: { id: imageId, productId } });
    if (!image) throw notFound('Image');
    await tx.productImage.delete({ where: { id: imageId } });
    await writeAudit(tx, ctx, { action: 'product.image_removed', entityType: 'product', entityId: productId, before: { fileId: image.fileId } });
    return getProduct(productId, tx);
  });
}

// ── Lookup (pickers, POS) ────────────────────────────────────────────────

const lookupSelect = {
  id: true,
  sku: true,
  name: true,
  sellingPrice: true,
  avgCost: true,
  standardCost: true,
  status: true,
  barcodes: { select: { barcode: true }, orderBy: { isPrimary: 'desc' } },
  product: {
    select: {
      id: true,
      name: true,
      status: true,
      isBatchTracked: true,
      isExpiryTracked: true,
      brand: { select: { name: true } },
      unit: { select: { code: true, allowsFraction: true } },
      taxRate: { select: { id: true, rate: true } },
    },
  },
} satisfies Prisma.ProductVariantSelect;

type LookupRow = Prisma.ProductVariantGetPayload<{ select: typeof lookupSelect }>;

async function withBalances(rows: LookupRow[], locationId: string | undefined): Promise<VariantLookup[]> {
  const balances = locationId
    ? await getPrisma().inventoryBalance.findMany({ where: { locationId, variantId: { in: rows.map((r) => r.id) } } })
    : [];
  const byVariant = new Map(balances.map((b) => [b.variantId, b]));
  return rows.map((r) => {
    const b = byVariant.get(r.id);
    const onHand = locationId ? (b?.qtyOnHand ?? new Prisma.Decimal(0)) : null;
    return {
      id: r.id,
      sku: r.sku,
      name: r.name,
      productId: r.product.id,
      productName: r.product.name,
      brandName: r.product.brand?.name ?? null,
      sellingPrice: r.sellingPrice.toFixed(2),
      avgCost: r.avgCost.toFixed(4),
      isBatchTracked: r.product.isBatchTracked,
      isExpiryTracked: r.product.isExpiryTracked,
      allowsFraction: r.product.unit.allowsFraction,
      unitCode: r.product.unit.code,
      status: r.status,
      productStatus: r.product.status,
      qtyOnHand: onHand?.toFixed(3) ?? null,
      qtyAvailable: onHand ? onHand.minus(b?.qtyReserved ?? 0).toFixed(3) : null,
      barcodes: r.barcodes.map((x) => x.barcode),
      taxRateId: r.product.taxRate.id,
      taxRate: r.product.taxRate.rate.toFixed(4),
      standardCost: r.standardCost?.toFixed(4) ?? null,
    };
  });
}

export async function searchVariants(query: z.infer<typeof variantSearchQuerySchema>) {
  const q = query.q;
  const where: Prisma.ProductVariantWhereInput = {
    archivedAt: null,
    product: { archivedAt: null, ...(query.activeOnly ? { status: 'ACTIVE' } : {}) },
    ...(query.activeOnly ? { status: 'ACTIVE' } : {}),
    ...(q
      ? {
          OR: [
            { sku: { contains: q, mode: 'insensitive' } },
            { name: { contains: q, mode: 'insensitive' } },
            { product: { name: { contains: q, mode: 'insensitive' } } },
            { barcodes: { some: { barcode: q } } },
          ],
        }
      : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.productVariant.findMany({
      where,
      select: lookupSelect,
      orderBy: [{ product: { name: 'asc' } }, { name: 'asc' }],
      ...pageArgs(query),
    }),
    prisma.productVariant.count({ where }),
  ]);
  return { data: await withBalances(rows, query.locationId), total };
}

/** Exact match on barcode or SKU — what a barcode scanner sends. */
export async function findVariantByCode(code: string, locationId?: string): Promise<VariantLookup> {
  const trimmed = code.trim();
  const row = await getPrisma().productVariant.findFirst({
    where: {
      archivedAt: null,
      product: { archivedAt: null },
      OR: [{ barcodes: { some: { barcode: trimmed } } }, { sku: trimmed.toUpperCase() }],
    },
    select: lookupSelect,
  });
  if (!row) throw new AppError(404, 'NOT_FOUND', `No product has the barcode or SKU "${trimmed}"`);
  const [result] = await withBalances([row], locationId);
  return result!;
}
