import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { getPrisma } from '../../src/lib/prisma';
import { MAX_FAILED_LOGINS } from '../../src/modules/auth/auth.service';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, signIn } from '../helpers/test-app';

const app = buildTestApp();
const prisma = () => getPrisma();
const GENERIC = 'Invalid email or password, or the account is temporarily locked';

beforeAll(async () => {
  await resetDatabase();
});

describe('staff authentication', () => {
  it('signs in, sets an HttpOnly session cookie and returns permissions + CSRF token', async () => {
    const { email } = await createStaff('OWNER');
    const res = await request(app).post('/api/v1/auth/login').send({ email: email.toUpperCase(), password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/rh_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(res.body.data.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(res.body.data.user.permissions).toContain('users.manage');
    expect(res.body.data.user).not.toHaveProperty('passwordHash');

    const stored = await prisma().session.findFirstOrThrow({ where: { user: { email } } });
    expect(cookie).not.toContain(stored.tokenHash);
  });

  it('GET /auth/me returns the session for a signed-in user and 401 otherwise', async () => {
    const { email } = await createStaff('CASHIER');
    const { agent } = await signIn(app, email, TEST_PASSWORD);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(email);
    expect(me.body.data.user.permissions).toContain('pos.sell');
    expect(me.body.data.user.permissions).not.toContain('users.manage');

    const anon = await request(app).get('/api/v1/auth/me');
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('gives the same generic error for a wrong password and an unknown email', async () => {
    const { email } = await createStaff('CASHIER');
    const wrong = await request(app).post('/api/v1/auth/login').send({ email, password: 'not-the-password' });
    const unknown = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@test.local', password: 'whatever-123' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(GENERIC);
    expect(unknown.body.error.message).toBe(GENERIC);
  });

  it(`locks the account after ${MAX_FAILED_LOGINS} failed attempts, even for the right password`, async () => {
    const { email, user } = await createStaff('CASHIER');
    for (let i = 0; i < MAX_FAILED_LOGINS; i += 1) {
      await request(app).post('/api/v1/auth/login').send({ email, password: `wrong-password-${i}` });
    }
    const locked = await prisma().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    const res = await request(app).post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(401);
    expect(await prisma().auditLog.count({ where: { entityId: user.id, action: 'auth.login_locked' } })).toBe(1);
  });

  it('rejects disabled users', async () => {
    const { email, user } = await createStaff('CASHIER');
    await prisma().user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('requires the CSRF token on state-changing requests', async () => {
    const { email } = await createStaff('CASHIER');
    const { agent, csrf } = await signIn(app, email, TEST_PASSWORD);

    const missing = await agent.post('/api/v1/auth/logout');
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('CSRF_INVALID');

    const forged = await agent.post('/api/v1/auth/logout').set('X-CSRF-Token', `${csrf.slice(0, -2)}xx`);
    expect(forged.status).toBe(403);

    const ok = await agent.post('/api/v1/auth/logout').set('X-CSRF-Token', csrf);
    expect(ok.status).toBe(204);
  });

  it('logout revokes the session server-side', async () => {
    const { email } = await createStaff('CASHIER');
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const csrf = login.body.data.csrfToken as string;

    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(200);
    const out = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrf);
    expect(out.status).toBe(204);

    // Replaying the old cookie must not work even if a client kept it.
    const replay = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(replay.status).toBe(401);
  });

  it('expires idle sessions', async () => {
    const { email, user } = await createStaff('CASHIER');
    const { agent } = await signIn(app, email, TEST_PASSWORD);
    await prisma().session.updateMany({ where: { userId: user.id }, data: { idleExpiresAt: new Date(Date.now() - 1000) } });
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects login from a foreign Origin', async () => {
    const { email } = await createStaff('CASHIER');
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('forces a pending password change before anything else, then signs out other sessions', async () => {
    const { email } = await createStaff('OWNER', { mustChangePassword: true });
    const first = await signIn(app, email, TEST_PASSWORD);
    const second = await signIn(app, email, TEST_PASSWORD);

    const blocked = await first.agent.get('/api/v1/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const weak = await first.agent
      .post('/api/v1/auth/change-password')
      .set('X-CSRF-Token', first.csrf)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(400);

    const changed = await first.agent
      .post('/api/v1/auth/change-password')
      .set('X-CSRF-Token', first.csrf)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-much-better-passphrase' });
    expect(changed.status).toBe(204);

    expect((await first.agent.get('/api/v1/users')).status).toBe(200);
    expect((await second.agent.get('/api/v1/auth/me')).status).toBe(401);
    await expect(signIn(app, email, TEST_PASSWORD)).rejects.toThrow();
    await expect(signIn(app, email, 'a-much-better-passphrase')).resolves.toBeDefined();
  });
});
