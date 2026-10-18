import { beforeAll, describe, expect, it } from 'vitest';
import { getPrisma } from '../../src/lib/prisma';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, signIn } from '../helpers/test-app';

const app = buildTestApp();
let owner: Awaited<ReturnType<typeof signIn>>;
let manager: Awaited<ReturnType<typeof signIn>>;
let roleIds: Record<string, string>;
let mainLocationId: string;

beforeAll(async () => {
  await resetDatabase();
  const prisma = getPrisma();
  const [o, m] = await Promise.all([createStaff('OWNER'), createStaff('MANAGER')]);
  [owner, manager] = await Promise.all([signIn(app, o.email, TEST_PASSWORD), signIn(app, m.email, TEST_PASSWORD)]);
  roleIds = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.code, r.id]));
  mainLocationId = (await prisma.location.findUniqueOrThrow({ where: { code: 'MAIN' } })).id;
});

const newUser = (overrides: Record<string, unknown> = {}) => ({
  email: `new.${Math.random().toString(36).slice(2)}@test.local`,
  fullName: 'Ada Okafor',
  password: 'temporary-pass-123',
  roleIds: [roleIds.CASHIER],
  locationIds: [mainLocationId],
  ...overrides,
});

describe('staff user management', () => {
  it('creates a user, requires a password change, and audits the creation', async () => {
    const body = newUser();
    const res = await owner.agent.post('/api/v1/users').set('X-CSRF-Token', owner.csrf).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: body.email, fullName: 'Ada Okafor', status: 'ACTIVE', mustChangePassword: true });
    expect(res.body.data.roles.map((r: { code: string }) => r.code)).toEqual(['CASHIER']);
    expect(res.body.data.locations[0].code).toBe('MAIN');
    expect(res.body.data).not.toHaveProperty('passwordHash');

    const audit = await getPrisma().auditLog.findFirst({ where: { action: 'user.created', entityId: res.body.data.id } });
    expect(audit?.actorUserId).toBe(owner.user.id);
    expect(JSON.stringify(audit?.after)).not.toContain('temporary-pass-123');
  });

  it('lists with search, filters and pagination', async () => {
    await owner.agent.post('/api/v1/users').set('X-CSRF-Token', owner.csrf).send(newUser({ fullName: 'Zainab Searchable' }));
    const res = await owner.agent.get('/api/v1/users').query({ q: 'searchable', pageSize: 5 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].fullName).toBe('Zainab Searchable');
    expect(res.body.meta).toEqual({ page: 1, pageSize: 5, total: 1 });

    const bad = await owner.agent.get('/api/v1/users').query({ sort: 'passwordHash:asc' });
    expect(bad.status).toBe(400);
  });

  it('validates input and rejects duplicate emails', async () => {
    const invalid = await owner.agent
      .post('/api/v1/users')
      .set('X-CSRF-Token', owner.csrf)
      .send(newUser({ email: 'not-an-email', password: 'short', roleIds: [] }));
    expect(invalid.status).toBe(400);
    const fields = invalid.body.error.details.map((d: { path: string }) => d.path);
    expect(fields).toEqual(expect.arrayContaining(['email', 'password', 'roleIds']));

    const body = newUser();
    await owner.agent.post('/api/v1/users').set('X-CSRF-Token', owner.csrf).send(body);
    const dup = await owner.agent
      .post('/api/v1/users')
      .set('X-CSRF-Token', owner.csrf)
      .send({ ...body, email: body.email.toUpperCase() });
    expect(dup.status).toBe(409);
  });

  it('blocks privilege escalation by non-owners', async () => {
    const grantOwner = await manager.agent
      .post('/api/v1/users')
      .set('X-CSRF-Token', manager.csrf)
      .send(newUser({ roleIds: [roleIds.OWNER] }));
    expect(grantOwner.status).toBe(403);

    // Accountant holds journals.post, which a manager does not have.
    const grantAccountant = await manager.agent
      .post('/api/v1/users')
      .set('X-CSRF-Token', manager.csrf)
      .send(newUser({ roleIds: [roleIds.ACCOUNTANT] }));
    expect(grantAccountant.status).toBe(403);

    const grantCashier = await manager.agent
      .post('/api/v1/users')
      .set('X-CSRF-Token', manager.csrf)
      .send(newUser({ roleIds: [roleIds.CASHIER] }));
    expect(grantCashier.status).toBe(201);

    const editOwner = await manager.agent
      .patch(`/api/v1/users/${owner.user.id}`)
      .set('X-CSRF-Token', manager.csrf)
      .send({ fullName: 'Hijacked' });
    expect(editOwner.status).toBe(403);
  });

  it('protects the last active owner and prevents self-disable', async () => {
    const selfDisable = await owner.agent
      .patch(`/api/v1/users/${owner.user.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ status: 'DISABLED' });
    expect(selfDisable.status).toBe(422);

    const dropOwner = await owner.agent
      .patch(`/api/v1/users/${owner.user.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ roleIds: [roleIds.MANAGER] });
    expect(dropOwner.status).toBe(422);
    expect(dropOwner.body.error.message).toMatch(/at least one active owner/i);
  });

  it('disabling a user signs them out immediately', async () => {
    const target = await createStaff('CASHIER');
    const session = await signIn(app, target.email, TEST_PASSWORD);
    expect((await session.agent.get('/api/v1/auth/me')).status).toBe(200);

    const res = await owner.agent
      .patch(`/api/v1/users/${target.user.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ status: 'DISABLED' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DISABLED');
    expect((await session.agent.get('/api/v1/auth/me')).status).toBe(401);

    const audit = await getPrisma().auditLog.findFirst({ where: { action: 'user.updated', entityId: target.user.id } });
    expect(audit?.before).toMatchObject({ status: 'ACTIVE' });
    expect(audit?.after).toMatchObject({ status: 'DISABLED' });
  });

  it('resets a password, forcing a change and revoking sessions', async () => {
    const target = await createStaff('CASHIER');
    const session = await signIn(app, target.email, TEST_PASSWORD);
    const res = await owner.agent
      .post(`/api/v1/users/${target.user.id}/reset-password`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ newPassword: 'fresh-temporary-456' });
    expect(res.status).toBe(204);
    expect((await session.agent.get('/api/v1/auth/me')).status).toBe(401);
    const relogin = await signIn(app, target.email, 'fresh-temporary-456');
    expect(relogin.user.mustChangePassword).toBe(true);
  });
});
