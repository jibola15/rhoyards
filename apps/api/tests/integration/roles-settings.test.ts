import { beforeAll, describe, expect, it } from 'vitest';
import { getPrisma } from '../../src/lib/prisma';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, signIn } from '../helpers/test-app';

const app = buildTestApp();
let owner: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  await resetDatabase();
  const o = await createStaff('OWNER');
  owner = await signIn(app, o.email, TEST_PASSWORD);
});

const post = (path: string, body: unknown) => owner.agent.post(path).set('X-CSRF-Token', owner.csrf).send(body as object);
const patch = (path: string, body: unknown) => owner.agent.patch(path).set('X-CSRF-Token', owner.csrf).send(body as object);

describe('roles', () => {
  it('lists the seeded system roles; Owner holds every permission and cannot be edited', async () => {
    const res = await owner.agent.get('/api/v1/roles');
    const codes = res.body.data.map((r: { code: string }) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining(['OWNER', 'MANAGER', 'ACCOUNTANT', 'INVENTORY_OFFICER', 'CASHIER', 'ONLINE_ORDER_MANAGER']),
    );
    const ownerRole = res.body.data.find((r: { code: string }) => r.code === 'OWNER');
    const catalogue = await owner.agent.get('/api/v1/permissions');
    expect(ownerRole.permissions).toHaveLength(catalogue.body.data.length);

    const edit = await patch(`/api/v1/roles/${ownerRole.id}`, { permissions: [] });
    expect(edit.status).toBe(422);
  });

  it('creates, edits and deletes a custom role', async () => {
    const created = await post('/api/v1/roles', {
      code: 'SENIOR_CASHIER',
      name: 'Senior cashier',
      permissions: ['pos.sell', 'pos.discount', 'pos.discount.override'],
    });
    expect(created.status).toBe(201);
    expect(created.body.data.permissions).toEqual(['pos.discount', 'pos.discount.override', 'pos.sell']);

    const updated = await patch(`/api/v1/roles/${created.body.data.id}`, { permissions: ['pos.sell'] });
    expect(updated.body.data.permissions).toEqual(['pos.sell']);

    const del = await owner.agent.delete(`/api/v1/roles/${created.body.data.id}`).set('X-CSRF-Token', owner.csrf);
    expect(del.status).toBe(204);
  });

  it('rejects unknown permissions and deleting system roles', async () => {
    const bad = await post('/api/v1/roles', { code: 'BAD_ROLE', name: 'Bad', permissions: ['launch.missiles'] });
    expect(bad.status).toBe(400);
    const cashier = await getPrisma().role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const del = await owner.agent.delete(`/api/v1/roles/${cashier.id}`).set('X-CSRF-Token', owner.csrf);
    expect(del.status).toBe(422);
  });
});

describe('settings', () => {
  it('returns defaults (NGN, VAT-inclusive pricing) and saves a section with an audit record', async () => {
    const res = await owner.agent.get('/api/v1/settings');
    expect(res.body.data.currency.code).toBe('NGN');
    expect(res.body.data.pricing.pricesIncludeTax).toBe(true);
    expect(res.body.data.business.vatRegistered).toBe(true);

    const saved = await patch('/api/v1/settings', {
      business: { ...res.body.data.business, name: 'Rhoyards Beauty', taxId: '12345678-0001' },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.business.name).toBe('Rhoyards Beauty');

    const audit = await getPrisma().auditLog.findFirstOrThrow({ where: { action: 'settings.updated' }, orderBy: { createdAt: 'desc' } });
    expect(audit.before).toMatchObject({ business: { name: 'Rhoyards' } });
    expect(audit.after).toMatchObject({ business: { name: 'Rhoyards Beauty' } });
  });

  it('validates settings', async () => {
    expect((await patch('/api/v1/settings', { currency: { code: 'naira', symbol: '₦' } })).status).toBe(400);
    expect((await patch('/api/v1/settings', {})).status).toBe(400);
    expect((await patch('/api/v1/settings', { inventory: { allowNegativeStock: 'yes' } })).status).toBe(400);
  });
});

describe('tax rates', () => {
  it('seeds VAT, zero-rated and exempt rates; rates are editable and validated', async () => {
    const list = await owner.agent.get('/api/v1/tax-rates');
    const vat = list.body.data.find((t: { code: string }) => t.code === 'VAT');
    expect(vat).toMatchObject({ kind: 'STANDARD', rate: '7.5000' });

    const edited = await patch(`/api/v1/tax-rates/${vat.id}`, { rate: '10' });
    expect(edited.body.data.rate).toBe('10.0000');

    const badZero = await post('/api/v1/tax-rates', { code: 'ZR2', name: 'Zero 2', kind: 'ZERO_RATED', rate: '5' });
    expect(badZero.status).toBe(400);
    const tooHigh = await post('/api/v1/tax-rates', { code: 'HIGH', name: 'High', kind: 'STANDARD', rate: '150' });
    expect(tooHigh.status).toBe(400);
  });
});

describe('locations', () => {
  it('seeds the main store and keeps at least one active location', async () => {
    const list = await owner.agent.get('/api/v1/locations');
    expect(list.body.data).toHaveLength(1);
    const main = list.body.data[0];
    expect(main).toMatchObject({ code: 'MAIN', type: 'STORE', isPosEnabled: true, isOnlineFulfilment: true });

    const deactivate = await patch(`/api/v1/locations/${main.id}`, { isActive: false });
    expect(deactivate.status).toBe(422);

    const wh = await post('/api/v1/locations', { code: 'WH1', name: 'Back store', type: 'WAREHOUSE' });
    expect(wh.status).toBe(201);
    const dup = await post('/api/v1/locations', { code: 'WH1', name: 'Again', type: 'WAREHOUSE' });
    expect(dup.status).toBe(409);
  });
});
