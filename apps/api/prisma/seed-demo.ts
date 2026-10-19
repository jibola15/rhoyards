/**
 * Development demo data: fictional brands, cosmetics products, suppliers and opening stock.
 * Uses the real services, so opening stock goes through the inventory engine and posts journals.
 * Idempotent: products whose SKUs already exist are skipped. Never run against production.
 */
import 'dotenv/config';
import { ALL_PERMISSIONS, type AuthUser, type ProductInput } from '@rhoyards/shared';
import { getPrisma, disconnectPrisma } from '../src/lib/prisma';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { createBrand, createCategory } from '../src/modules/catalog/taxonomy.service';
import { createProduct } from '../src/modules/catalog/products.service';
import { createAdjustment, postAdjustment } from '../src/modules/inventory/adjustments.service';
import { createSupplier } from '../src/modules/suppliers/suppliers.service';

const prisma = getPrisma();

const days = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to load demo data in production');
  const owner = await prisma.user.findFirst({ where: { roles: { some: { role: { code: 'OWNER' } } } }, orderBy: { createdAt: 'asc' } });
  if (!owner) throw new Error('Run the base seed first (an owner account is required)');
  const ctx = { actorId: owner.id };
  const actor: AuthContext = {
    sessionId: 'seed',
    csrfToken: 'seed',
    expiresAt: new Date(),
    user: { id: owner.id, email: owner.email, username: owner.username, fullName: owner.fullName, mustChangePassword: false, roles: [], locationIds: [], permissions: [] } as AuthUser,
    permissions: new Set(ALL_PERMISSIONS),
  };

  const brandId = async (name: string) =>
    (await prisma.brand.findUnique({ where: { name } }))?.id ?? (await createBrand({ name, isActive: true }, ctx)).id;
  const categoryId = async (name: string, parentId: string | null = null) =>
    (await prisma.category.findFirst({ where: { name, parentId } }))?.id ??
    (await createCategory({ name, parentId, sortOrder: 0, isActive: true }, ctx)).id;

  const luxe = await brandId('Luxe Glow');
  const velvet = await brandId('Velvet Rose');
  const shea = await brandId('Shea Naturals');
  const aura = await brandId('Aura Scents');
  const makeup = await categoryId('Makeup');
  const skincare = await categoryId('Skincare');
  const hair = await categoryId('Hair care');
  const fragrance = await categoryId('Fragrance');
  const lipstick = await categoryId('Lipstick', makeup);
  const foundation = await categoryId('Foundation', makeup);
  const moisturiser = await categoryId('Moisturisers', skincare);

  const [pc, ml, vat] = await Promise.all([
    prisma.unit.findUniqueOrThrow({ where: { code: 'PC' } }),
    prisma.unit.findUniqueOrThrow({ where: { code: 'ML' } }),
    prisma.taxRate.findUniqueOrThrow({ where: { code: 'VAT' } }),
  ]);
  const base = { unitId: pc.id, taxRateId: vat.id, status: 'ACTIVE' as const, onlineVisible: true, isBatchTracked: false, isExpiryTracked: false };
  const v = (sku: string, name: string, price: string, extra: Partial<ProductInput['variants'][number]> = {}) => ({
    sku,
    name,
    sellingPrice: price,
    reorderLevel: '5',
    reorderQty: '24',
    status: 'ACTIVE' as const,
    barcodes: [] as string[],
    volumeUnitId: null,
    ...extra,
  });

  // [product, opening lines: qty, unit cost, lot/expiry]
  const catalogue: { product: ProductInput; stock: { qty: string; cost: string; lot?: string; expiry?: string }[] }[] = [
    {
      product: {
        ...base,
        name: 'Velvet Matte Lipstick',
        brandId: velvet,
        categoryId: lipstick,
        isBatchTracked: true,
        isExpiryTracked: true,
        variants: [
          v('VR-VML-RUBY', 'Ruby Red', '8500.00', { shade: 'Ruby Red', volumeValue: '3.5', volumeUnitId: ml.id, barcodes: ['2000000000011'] }),
          v('VR-VML-NUDE', 'Warm Nude', '8500.00', { shade: 'Warm Nude', volumeValue: '3.5', volumeUnitId: ml.id, barcodes: ['2000000000028'] }),
          v('VR-VML-BERRY', 'Deep Berry', '8500.00', { shade: 'Deep Berry', volumeValue: '3.5', volumeUnitId: ml.id, barcodes: ['2000000000035'] }),
        ],
      },
      stock: [
        { qty: '18', cost: '4200', lot: 'VR2401', expiry: days(420) },
        { qty: '12', cost: '4200', lot: 'VR2402', expiry: days(25) },
        { qty: '3', cost: '4300', lot: 'VR2312', expiry: days(-10) },
      ],
    },
    {
      product: {
        ...base,
        name: 'Second Skin Foundation',
        brandId: luxe,
        categoryId: foundation,
        isBatchTracked: true,
        isExpiryTracked: true,
        variants: [
          v('LG-SSF-110', 'Shade 110 Porcelain', '15500.00', { shade: '110', tone: 'Cool', volumeValue: '30', volumeUnitId: ml.id, barcodes: ['2000000000042'] }),
          v('LG-SSF-340', 'Shade 340 Caramel', '15500.00', { shade: '340', tone: 'Warm', volumeValue: '30', volumeUnitId: ml.id, barcodes: ['2000000000059'] }),
          v('LG-SSF-520', 'Shade 520 Espresso', '15500.00', { shade: '520', tone: 'Neutral', volumeValue: '30', volumeUnitId: ml.id, barcodes: ['2000000000066'] }),
        ],
      },
      stock: [
        { qty: '10', cost: '8100', lot: 'LG-F-118', expiry: days(600) },
        { qty: '14', cost: '8100', lot: 'LG-F-121', expiry: days(700) },
        { qty: '4', cost: '8000', lot: 'LG-F-099', expiry: days(60) },
      ],
    },
    {
      product: {
        ...base,
        name: 'Whipped Shea Body Butter',
        brandId: shea,
        categoryId: moisturiser,
        isBatchTracked: true,
        isExpiryTracked: true,
        variants: [
          v('SN-WSB-200', '200 ml', '6500.00', { size: '200 ml', volumeValue: '200', volumeUnitId: ml.id, barcodes: ['2000000000073'] }),
          v('SN-WSB-400', '400 ml', '11000.00', { size: '400 ml', volumeValue: '400', volumeUnitId: ml.id, barcodes: ['2000000000080'] }),
        ],
      },
      stock: [
        { qty: '30', cost: '2900', lot: 'SN-0424', expiry: days(300) },
        { qty: '2', cost: '5100', lot: 'SN-0425', expiry: days(320) },
      ],
    },
    {
      product: {
        ...base,
        name: 'Edge Control Gel',
        brandId: shea,
        categoryId: hair,
        variants: [v('SN-ECG-100', '100 g', '3500.00', { size: '100 g', barcodes: ['2000000000097'] })],
      },
      stock: [{ qty: '40', cost: '1600' }],
    },
    {
      product: {
        ...base,
        name: 'Oud Velours Eau de Parfum',
        brandId: aura,
        categoryId: fragrance,
        variants: [
          v('AS-OUD-50', '50 ml', '32000.00', { volumeValue: '50', volumeUnitId: ml.id, barcodes: ['2000000000103'] }),
          v('AS-OUD-100', '100 ml', '52000.00', { volumeValue: '100', volumeUnitId: ml.id, barcodes: ['2000000000110'] }),
        ],
      },
      stock: [
        { qty: '6', cost: '17500' },
        { qty: '3', cost: '28000' },
      ],
    },
    {
      product: {
        ...base,
        name: 'Makeup Brush Set',
        brandId: luxe,
        categoryId: makeup,
        unitId: (await prisma.unit.findUniqueOrThrow({ where: { code: 'SET' } })).id,
        variants: [v('LG-BRUSH-12', '12-piece', '18000.00', { barcodes: ['2000000000127'] })],
      },
      stock: [{ qty: '7', cost: '9000' }],
    },
  ];

  const main = await prisma.location.findUniqueOrThrow({ where: { code: 'MAIN' } });
  const openingLines: Parameters<typeof createAdjustment>[0]['lines'] = [];
  let created = 0;
  for (const item of catalogue) {
    const skus = item.product.variants.map((x) => x.sku);
    if ((await prisma.productVariant.count({ where: { sku: { in: skus } } })) > 0) continue;
    const product = await createProduct(item.product, ctx);
    created += 1;
    item.stock.forEach((s, i) => {
      // Spread stock lines across variants: batch products give each lot to a variant in turn.
      const variant = product.variants[i % product.variants.length]!;
      openingLines.push({
        variantId: variant.id,
        qtyChange: s.qty,
        unitCost: s.cost,
        ...(s.lot ? { lotNumber: s.lot } : {}),
        ...(s.expiry ? { expiryDate: s.expiry } : {}),
      });
    });
  }

  if (openingLines.length > 0) {
    const draft = await createAdjustment({ locationId: main.id, reason: 'OPENING_STOCK', note: 'Demo opening stock', lines: openingLines }, ctx);
    const posted = await postAdjustment(draft.id, actor, ctx);
    console.log(`Opening stock ${posted.number} posted: ₦${posted.totalValue}`);
  }

  if ((await prisma.supplier.count()) === 0) {
    await createSupplier({ name: 'Shea Naturals Distribution Ltd', contactName: 'Accounts desk', phone: '0800 000 0001', paymentTermsDays: 30, isActive: true }, ctx);
    await createSupplier({ name: 'Glow Beauty Wholesale', contactName: 'Sales team', phone: '0800 000 0002', paymentTermsDays: 14, isActive: true }, ctx);
  }
  console.log(`Demo data loaded: ${created} new products.`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
