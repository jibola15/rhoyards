import { beforeAll, describe, expect, it } from 'vitest';
import { getPrisma } from '../../src/lib/prisma';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, signIn } from '../helpers/test-app';

const app = buildTestApp();
let officer: Awaited<ReturnType<typeof signIn>>;
let cashier: Awaited<ReturnType<typeof signIn>>;
let refs: { unitId: string; mlId: string; vatId: string };

beforeAll(async () => {
  await resetDatabase();
  const prisma = getPrisma();
  const [o, c] = await Promise.all([createStaff('INVENTORY_OFFICER'), createStaff('CASHIER')]);
  [officer, cashier] = await Promise.all([signIn(app, o.email, TEST_PASSWORD), signIn(app, c.email, TEST_PASSWORD)]);
  const [pc, ml, vat] = await Promise.all([
    prisma.unit.findUniqueOrThrow({ where: { code: 'PC' } }),
    prisma.unit.findUniqueOrThrow({ where: { code: 'ML' } }),
    prisma.taxRate.findUniqueOrThrow({ where: { code: 'VAT' } }),
  ]);
  refs = { unitId: pc.id, mlId: ml.id, vatId: vat.id };
});

const post = (path: string, body: unknown, who = officer) => who.agent.post(path).set('X-CSRF-Token', who.csrf).send(body as object);
const patch = (path: string, body: unknown, who = officer) => who.agent.patch(path).set('X-CSRF-Token', who.csrf).send(body as object);

const lipstick = (overrides: Record<string, unknown> = {}) => ({
  name: 'Velvet Matte Lipstick',
  unitId: refs.unitId,
  taxRateId: refs.vatId,
  isExpiryTracked: true,
  variants: [
    { sku: 'vml-ruby', name: 'Ruby', shade: 'Ruby Red', volumeValue: '3.5', volumeUnitId: refs.mlId, sellingPrice: '8500.00', barcodes: ['6151234500011'] },
    { sku: 'VML-NUDE', name: 'Nude', shade: 'Warm Nude', sellingPrice: '8500', compareAtPrice: '9500', barcodes: ['6151234500028'] },
  ],
  ...overrides,
});

describe('product catalogue', () => {
  it('creates a product with variants, barcodes and cosmetics attributes (acceptance #1)', async () => {
    const brand = await post('/api/v1/brands', { name: 'Luxe Glow' });
    const category = await post('/api/v1/categories', { name: 'Lipstick' });
    expect(brand.status).toBe(201);
    expect(brand.body.data.slug).toBe('luxe-glow');

    const res = await post('/api/v1/products', lipstick({ brandId: brand.body.data.id, categoryId: category.body.data.id }));
    expect(res.status).toBe(201);
    const p = res.body.data;
    expect(p).toMatchObject({ name: 'Velvet Matte Lipstick', slug: 'velvet-matte-lipstick', isExpiryTracked: true, isBatchTracked: true });
    expect(p.brand.name).toBe('Luxe Glow');
    expect(p.variants).toHaveLength(2);
    const ruby = p.variants.find((v: { sku: string }) => v.sku === 'VML-RUBY');
    expect(ruby).toMatchObject({ shade: 'Ruby Red', volumeValue: '3.500', sellingPrice: '8500.00', avgCost: '0.0000', stockQty: '0.000', barcodes: ['6151234500011'] });

    const audit = await getPrisma().auditLog.findFirst({ where: { action: 'product.created', entityId: p.id } });
    expect(audit?.actorUserId).toBe(officer.user.id);
  });

  it('updates product fields and variant prices, recording before/after (acceptance #1)', async () => {
    const created = (await post('/api/v1/products', lipstick({ name: 'Gloss Stick', variants: [{ sku: 'GS-1', name: 'Clear', sellingPrice: '4000' }] }))).body.data;
    const variantId = created.variants[0].id;

    const updated = await patch(`/api/v1/products/${created.id}`, { description: 'Long-lasting', onlineVisible: true });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ description: 'Long-lasting', onlineVisible: true, slug: 'gloss-stick' });

    const priced = await patch(`/api/v1/variants/${variantId}`, { sellingPrice: '4250.50', barcodes: ['GLOSS-0001'] });
    expect(priced.status).toBe(200);
    expect(priced.body.data.variants[0]).toMatchObject({ sellingPrice: '4250.50', barcodes: ['GLOSS-0001'] });

    const audit = await getPrisma().auditLog.findFirstOrThrow({ where: { action: 'variant.updated', entityId: variantId } });
    expect(audit.before).toMatchObject({ sellingPrice: '4000.00' });
    expect(audit.after).toMatchObject({ sellingPrice: '4250.50' });
  });

  it('PATCH leaves unmentioned fields alone and clears fields sent as null/blank', async () => {
    const brand = (await post('/api/v1/brands', { name: 'Keep Me' })).body.data;
    const p = (
      await post('/api/v1/products', lipstick({ name: 'Partial Update', brandId: brand.id, description: 'Original', variants: [{ sku: 'PU-1', name: 'x', sellingPrice: '1', shade: 'Coral' }] }))
    ).body.data;

    const touched = await patch(`/api/v1/products/${p.id}`, { onlineVisible: true });
    expect(touched.body.data).toMatchObject({ brand: { id: brand.id }, description: 'Original', onlineVisible: true });

    const cleared = await patch(`/api/v1/products/${p.id}`, { brandId: null, description: '' });
    expect(cleared.body.data).toMatchObject({ brand: null, description: null });

    const variant = await patch(`/api/v1/variants/${p.variants[0].id}`, { shade: null });
    expect(variant.body.data.variants[0].shade).toBeNull();
  });

  it('rejects duplicate SKUs and barcodes, and invalid input', async () => {
    const dupSku = await post('/api/v1/products', lipstick({ name: 'Dup', variants: [{ sku: 'VML-RUBY', name: 'x', sellingPrice: '1' }] }));
    expect(dupSku.status).toBe(409);
    expect(dupSku.body.error.details.field).toBe('sku');

    const dupBarcode = await post('/api/v1/products', lipstick({ name: 'Dup2', variants: [{ sku: 'NEW-1', name: 'x', sellingPrice: '1', barcodes: ['6151234500011'] }] }));
    expect(dupBarcode.status).toBe(409);

    const invalid = await post('/api/v1/products', { name: '', unitId: refs.unitId, taxRateId: refs.vatId, variants: [] });
    expect(invalid.status).toBe(400);
    const badPrice = await post('/api/v1/products', lipstick({ name: 'Bad', variants: [{ sku: 'B 1', name: 'x', sellingPrice: '12.345' }] }));
    expect(badPrice.status).toBe(400);
  });

  it('finds variants by search and by exact barcode', async () => {
    const search = await officer.agent.get('/api/v1/variants').query({ q: 'ruby' });
    expect(search.body.data.map((v: { sku: string }) => v.sku)).toContain('VML-RUBY');
    const scan = await officer.agent.get('/api/v1/variants/by-code/6151234500028');
    expect(scan.status).toBe(200);
    expect(scan.body.data).toMatchObject({ sku: 'VML-NUDE', productName: 'Velvet Matte Lipstick', isExpiryTracked: true });
    expect((await officer.agent.get('/api/v1/variants/by-code/0000000000')).status).toBe(404);

    const list = await officer.agent.get('/api/v1/products').query({ q: '6151234500011' });
    expect(list.body.data).toHaveLength(1);
  });

  it('archives a product without stock and hides it from lists', async () => {
    const p = (await post('/api/v1/products', lipstick({ name: 'Short Lived', variants: [{ sku: 'SL-1', name: 'x', sellingPrice: '10' }] }))).body.data;
    const archived = await post(`/api/v1/products/${p.id}/archive`, {});
    expect(archived.status).toBe(200);
    expect(archived.body.data.archived).toBe(true);
    const list = await officer.agent.get('/api/v1/products').query({ q: 'Short Lived' });
    expect(list.body.data).toHaveLength(0);
    expect((await officer.agent.get(`/api/v1/variants/by-code/SL-1`)).status).toBe(404);
  });

  it('lets a cashier view the catalogue but not change it', async () => {
    expect((await cashier.agent.get('/api/v1/products')).status).toBe(200);
    expect((await post('/api/v1/brands', { name: 'Nope' }, cashier)).status).toBe(403);
    expect((await post('/api/v1/products', lipstick({ name: 'Nope' }), cashier)).status).toBe(403);
  });
});

describe('suppliers', () => {
  it('creates with a generated code, searches and deactivates', async () => {
    const created = await post('/api/v1/suppliers', { name: 'Shea Naturals Distribution', phone: '0800 000 0000', paymentTermsDays: 30 });
    expect(created.status).toBe(201);
    expect(created.body.data.code).toMatch(/^SUP-\d{6}$/);

    const found = await officer.agent.get('/api/v1/suppliers').query({ q: 'shea' });
    expect(found.body.data).toHaveLength(1);

    const off = await patch(`/api/v1/suppliers/${created.body.data.id}`, { isActive: false });
    expect(off.body.data.isActive).toBe(false);
    expect((await officer.agent.get('/api/v1/suppliers').query({ q: 'shea' })).body.data).toHaveLength(0);
    expect((await officer.agent.get('/api/v1/suppliers').query({ q: 'shea', includeInactive: 'true' })).body.data).toHaveLength(1);
    expect((await post('/api/v1/suppliers', { name: 'x', paymentTermsDays: 400 })).status).toBe(400);
  });
});
