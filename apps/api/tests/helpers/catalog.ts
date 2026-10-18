import type { ProductInput, VariantInput } from '@rhoyards/shared';
import { createProduct } from '../../src/modules/catalog/products.service';
import { getPrisma } from '../../src/lib/prisma';

let seq = 0;

/** Creates a product with one or more variants through the real service. Returns the product detail. */
export async function makeProduct(
  actorId: string,
  opts: { batch?: boolean; expiry?: boolean; unit?: string; variants?: Partial<VariantInput>[]; name?: string } = {},
) {
  const prisma = getPrisma();
  const [unit, vat] = await Promise.all([
    prisma.unit.findUniqueOrThrow({ where: { code: opts.unit ?? 'PC' } }),
    prisma.taxRate.findUniqueOrThrow({ where: { code: 'VAT' } }),
  ]);
  seq += 1;
  const tag = `${Date.now().toString(36).toUpperCase()}${seq}`;
  const variants = (opts.variants ?? [{}]).map(
    (v, i): VariantInput => ({
      sku: `T-${tag}-${i}`,
      name: `Variant ${i}`,
      sellingPrice: '1000.00',
      reorderLevel: '0',
      reorderQty: '0',
      status: 'ACTIVE',
      barcodes: [],
      volumeUnitId: null,
      ...v,
    }),
  );
  const input: ProductInput = {
    name: opts.name ?? `Test product ${tag}`,
    brandId: null,
    categoryId: null,
    unitId: unit.id,
    taxRateId: vat.id,
    isBatchTracked: Boolean(opts.batch || opts.expiry),
    isExpiryTracked: Boolean(opts.expiry),
    status: 'ACTIVE',
    onlineVisible: false,
    variants,
  };
  return createProduct(input, { actorId });
}

export const mainLocationId = async () => (await getPrisma().location.findUniqueOrThrow({ where: { code: 'MAIN' } })).id;

export const isoDaysFromNow = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
