import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@rhoyards/shared';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, signIn } from '../helpers/test-app';

const app = buildTestApp();
let cashier: Awaited<ReturnType<typeof signIn>>;
let manager: Awaited<ReturnType<typeof signIn>>;
let accountant: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  await resetDatabase();
  const [c, m, a] = await Promise.all([createStaff('CASHIER'), createStaff('MANAGER'), createStaff('ACCOUNTANT')]);
  [cashier, manager, accountant] = await Promise.all([
    signIn(app, c.email, TEST_PASSWORD),
    signIn(app, m.email, TEST_PASSWORD),
    signIn(app, a.email, TEST_PASSWORD),
  ]);
});

describe('role-based access control (enforced by the API)', () => {
  it('rejects anonymous access to protected resources with 401', async () => {
    for (const path of ['/api/v1/users', '/api/v1/roles', '/api/v1/settings', '/api/v1/audit-logs', '/api/v1/tax-rates']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
  });

  it('a cashier cannot reach administrative functions', async () => {
    const { agent, csrf } = cashier;
    expect((await agent.get('/api/v1/users')).status).toBe(403);
    expect((await agent.get('/api/v1/audit-logs')).status).toBe(403);
    expect((await agent.get('/api/v1/settings')).status).toBe(403);
    const patch = await agent.patch('/api/v1/settings').set('X-CSRF-Token', csrf).send({ pricing: { pricesIncludeTax: false } });
    expect(patch.status).toBe(403);
    expect(patch.body.error.code).toBe('FORBIDDEN');
    const role = await agent
      .post('/api/v1/roles')
      .set('X-CSRF-Token', csrf)
      .send({ code: 'SNEAKY', name: 'Sneaky', permissions: ['users.manage'] });
    expect(role.status).toBe(403);
  });

  it('a cashier can still read reference data every signed-in user needs', async () => {
    expect((await cashier.agent.get('/api/v1/tax-rates')).status).toBe(200);
    expect((await cashier.agent.get('/api/v1/locations')).status).toBe(200);
  });

  it('a manager can view settings but not change tax-pricing settings; an accountant can', async () => {
    expect((await manager.agent.get('/api/v1/settings')).status).toBe(200);
    const body = { pricing: { pricesIncludeTax: false } };
    const byManager = await manager.agent.patch('/api/v1/settings').set('X-CSRF-Token', manager.csrf).send(body);
    expect(byManager.status).toBe(403);
    const byAccountant = await accountant.agent.patch('/api/v1/settings').set('X-CSRF-Token', accountant.csrf).send(body);
    expect(byAccountant.status).toBe(200);
    expect(byAccountant.body.data.pricing.pricesIncludeTax).toBe(false);
    // restore default for other suites
    await accountant.agent
      .patch('/api/v1/settings')
      .set('X-CSRF-Token', accountant.csrf)
      .send({ pricing: DEFAULT_SETTINGS.pricing });
  });

  it('permission changes take effect on the next request without re-login', async () => {
    const { agent } = cashier;
    expect((await agent.get('/api/v1/users')).status).toBe(403);
    const { getPrisma } = await import('../../src/lib/prisma');
    const prisma = getPrisma();
    const [role, perm] = await Promise.all([
      prisma.role.findUniqueOrThrow({ where: { code: 'CASHIER' } }),
      prisma.permission.findUniqueOrThrow({ where: { code: 'users.view' } }),
    ]);
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    expect((await agent.get('/api/v1/users')).status).toBe(200);
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } } });
    expect((await agent.get('/api/v1/users')).status).toBe(403);
  });
});
