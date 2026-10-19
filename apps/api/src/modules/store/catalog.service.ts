import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import {
  dec,
  Decimal,
  ZERO,
  type StockLevel,
  type StoreFacets,
  type StoreProductCard,
  type StoreProductDetail,
  type storeProductQuerySchema,
} from '@rhoyards/shared';
import { businessRule, notFound } from '../../lib/errors';
import { getPrisma, type Db } from '../../lib/prisma';
import { fileUrl } from '../files/files.service';
import { getSettings } from '../settings/settings.service';

/**
 * The public catalogue: only active, online-visible products with at least one active variant. Stock shown is
 * what can be sold at the fulfilment location now (on hand − reserved), the same pool the POS sells from.
 */

/** The location that fulfils online orders (the store). */
export async function fulfilmentLocation(db: Db) {
  const location = await db.location.findFirst({ where: { isOnlineFulfilment: true, isActive: true }, orderBy: { createdAt: 'asc' } });
  if (!location) throw businessRule('The online store has no fulfilment location. Mark a location for online orders in Settings.');
  return location;
}

const LOW_STOCK = dec(5);
const MAX_PER_LINE = 20;

export function stockLevel(available: Decimal): StockLevel {
  if (available.lte(ZERO)) return 'OUT';
  return available.lte(LOW_STOCK) ? 'LOW' : 'IN_STOCK';
}

export const visibleVariant = {
  status: 'ACTIVE',
  archivedAt: null,
  product: { status: 'ACTIVE', onlineVisible: true, archivedAt: null },
} satisfies Prisma.ProductVariantWhereInput;

interface CardRow {
  id: string;
  slug: string;
  name: string;
  brand: string | null;
  min_price: Prisma.Decimal;
  max_price: Prisma.Decimal;
  compare_at: Prisma.Decimal | null;
  available: Prisma.Decimal;
  total: bigint;
}

const SORTS = {
  newest: Prisma.sql`created_at DESC, name ASC`,
  'price:asc': Prisma.sql`min_price ASC, name ASC`,
  'price:desc': Prisma.sql`max_price DESC, name ASC`,
  'name:asc': Prisma.sql`name ASC`,
} as const;

/** One query does the filtering, price range, stock and pagination, so large catalogues page in the database. */
export async function listStoreProducts(q: z.infer<typeof storeProductQuerySchema>): Promise<{ data: StoreProductCard[]; total: number }> {
  const prisma = getPrisma();
  const location = await fulfilmentLocation(prisma);
  const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await prisma.$queryRaw<CardRow[]>`
    WITH p AS (
      SELECT pr.id, pr.slug, pr.name, pr.created_at, b.name AS brand,
             MIN(v.selling_price) AS min_price, MAX(v.selling_price) AS max_price, MAX(v.compare_at_price) AS compare_at,
             COALESCE(SUM(GREATEST(ib.qty_on_hand - ib.qty_reserved, 0)), 0) AS available
      FROM products pr
      JOIN product_variants v ON v.product_id = pr.id AND v.status = 'ACTIVE' AND v.archived_at IS NULL
      LEFT JOIN brands b ON b.id = pr.brand_id
      LEFT JOIN categories c ON c.id = pr.category_id
      LEFT JOIN inventory_balances ib ON ib.variant_id = v.id AND ib.location_id = ${location.id}::uuid
      WHERE pr.status = 'ACTIVE' AND pr.online_visible AND pr.archived_at IS NULL
        ${like ? Prisma.sql`AND (pr.name ILIKE ${like} OR b.name ILIKE ${like} OR v.sku ILIKE ${like})` : Prisma.empty}
        ${q.brand ? Prisma.sql`AND b.slug = ${q.brand}` : Prisma.empty}
        ${q.category ? Prisma.sql`AND (c.slug = ${q.category} OR c.parent_id = (SELECT id FROM categories WHERE slug = ${q.category}))` : Prisma.empty}
      GROUP BY pr.id, b.name
    )
    SELECT id, slug, name, brand, min_price, max_price, compare_at, available, COUNT(*) OVER () AS total
    FROM p
    WHERE TRUE
      ${q.minPrice ? Prisma.sql`AND max_price >= ${q.minPrice}::numeric` : Prisma.empty}
      ${q.maxPrice ? Prisma.sql`AND min_price <= ${q.maxPrice}::numeric` : Prisma.empty}
      ${q.inStock === 'true' ? Prisma.sql`AND available > 0` : Prisma.empty}
    ORDER BY ${SORTS[q.sort ?? 'newest']}
    LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;

  const images = await prisma.productImage.findMany({
    where: { productId: { in: rows.map((r) => r.id) } },
    orderBy: [{ productId: 'asc' }, { sortOrder: 'asc' }],
    select: { productId: true, fileId: true },
  });
  const firstImage = new Map<string, string>();
  for (const i of images) if (!firstImage.has(i.productId)) firstImage.set(i.productId, fileUrl(i.fileId));

  return {
    total: Number(rows[0]?.total ?? 0),
    data: rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      brand: r.brand,
      imageUrl: firstImage.get(r.id) ?? null,
      minPrice: r.min_price.toFixed(2),
      maxPrice: r.max_price.toFixed(2),
      compareAtPrice: r.compare_at?.toFixed(2) ?? null,
      inStock: dec(r.available.toString()).gt(0),
    })),
  };
}

export async function getStoreProduct(slug: string): Promise<StoreProductDetail> {
  const prisma = getPrisma();
  const [location, settings] = await Promise.all([fulfilmentLocation(prisma), getSettings(prisma)]);
  const p = await prisma.product.findFirst({
    where: { slug, status: 'ACTIVE', onlineVisible: true, archivedAt: null },
    include: {
      brand: true,
      category: true,
      images: { orderBy: { sortOrder: 'asc' } },
      variants: {
        where: { status: 'ACTIVE', archivedAt: null },
        orderBy: { sellingPrice: 'asc' },
        include: { volumeUnit: true, balances: { where: { locationId: location.id } } },
      },
    },
  });
  if (!p || p.variants.length === 0) throw notFound('Product');
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    brand: p.brand ? { name: p.brand.name, slug: p.brand.slug } : null,
    category: p.category ? { name: p.category.name, slug: p.category.slug } : null,
    images: p.images.map((i) => ({ url: fileUrl(i.fileId), alt: i.altText, variantId: i.variantId })),
    pricesIncludeTax: settings.pricing.pricesIncludeTax,
    variants: p.variants.map((v) => {
      const b = v.balances[0];
      const available = b ? Decimal.max(dec(b.qtyOnHand.toString()).minus(b.qtyReserved.toString()), ZERO) : ZERO;
      return {
        id: v.id,
        sku: v.sku,
        name: v.name,
        shade: v.shade,
        colour: v.colour,
        size: v.size,
        volume: v.volumeValue && v.volumeUnit ? `${dec(v.volumeValue.toString()).toString()} ${v.volumeUnit.code.toLowerCase()}` : null,
        price: v.sellingPrice.toFixed(2),
        compareAtPrice: v.compareAtPrice?.toFixed(2) ?? null,
        stock: stockLevel(available),
        maxQty: Math.min(MAX_PER_LINE, available.floor().toNumber()),
      };
    }),
  };
}

export async function storeFacets(): Promise<StoreFacets> {
  const prisma = getPrisma();
  const visible = { status: 'ACTIVE', onlineVisible: true, archivedAt: null, variants: { some: { status: 'ACTIVE', archivedAt: null } } } satisfies Prisma.ProductWhereInput;
  const [categories, brands] = await Promise.all([
    prisma.category.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { _count: { select: { products: { where: visible } } } } }),
    prisma.brand.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, include: { _count: { select: { products: { where: visible } } } } }),
  ]);
  return {
    categories: categories.filter((c) => c._count.products > 0).map((c) => ({ slug: c.slug, name: c.name, count: c._count.products })),
    brands: brands.filter((b) => b._count.products > 0).map((b) => ({ slug: b.slug, name: b.name, count: b._count.products })),
  };
}
