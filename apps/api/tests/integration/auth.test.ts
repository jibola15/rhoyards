import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LoginStep } from '@rhoyards/shared';
import { getPrisma } from '../../src/lib/prisma';
import { INVALID_LOGIN, MAX_FAILED_LOGINS } from '../../src/modules/auth/auth.service';
import { timeStep, totpCode } from '../../src/modules/auth/totp';
import { MAX_CODE_ATTEMPTS } from '../../src/modules/auth/two-factor.service';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, currentTotp, signIn } from '../helpers/test-app';

const app = buildTestApp();
const prisma = () => getPrisma();

beforeAll(async () => {
  await resetDatabase();
});

const passwordStep = async (identifier: string, password = TEST_PASSWORD) => {
  const res = await request(app).post('/api/v1/auth/login').send({ identifier, password });
  return { res, step: res.body.data as LoginStep };
};
const codeStep = (challengeToken: string, code: string) => request(app).post('/api/v1/auth/login/two-factor').send({ challengeToken, code });
/** Allows a fresh code in the same 30-second step (each code is accepted once). */
const forgetLastCode = (userId: string) => prisma().user.update({ where: { id: userId }, data: { totpLastStep: null } });

describe('staff sign-in: password step', () => {
  it('accepts the email (any case) or the username, and creates no session until the second factor', async () => {
    const { email } = await createStaff('OWNER', { username: 'ada.owner' });
    for (const identifier of [email.toUpperCase(), 'Ada.Owner']) {
      const { res, step } = await passwordStep(identifier);
      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(step.next).toBe('TWO_FACTOR');
      expect(step.challengeToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(res.body.data).not.toHaveProperty('csrfToken');
    }
    expect(await prisma().session.count({ where: { user: { email } } })).toBe(0);
  });

  it('gives the same generic error for a wrong password, an unknown email and an unknown username', async () => {
    const { email } = await createStaff('CASHIER');
    const results = await Promise.all([
      passwordStep(email, 'not-the-password'),
      passwordStep('nobody@test.local', 'whatever-123'),
      passwordStep('nobody', 'whatever-123'),
    ]);
    for (const { res } of results) {
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe(INVALID_LOGIN);
    }
  });

  it(`locks the account after ${MAX_FAILED_LOGINS} failed attempts, even for the right password`, async () => {
    const { email, user } = await createStaff('CASHIER');
    for (let i = 0; i < MAX_FAILED_LOGINS; i += 1) await passwordStep(email, `wrong-password-${i}`);
    const locked = await prisma().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    const { res } = await passwordStep(email);
    expect(res.status).toBe(401);
    expect(await prisma().auditLog.count({ where: { entityId: user.id, action: 'auth.login_locked' } })).toBe(1);
  });

  it('rejects disabled users', async () => {
    const { email, user } = await createStaff('CASHIER');
    await prisma().user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    expect((await passwordStep(email)).res.status).toBe(401);
  });

  it('rejects login from a foreign Origin', async () => {
    const { email } = await createStaff('CASHIER');
    const res = await request(app).post('/api/v1/auth/login').set('Origin', 'https://evil.example').send({ identifier: email, password: TEST_PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe('staff sign-in: second factor', () => {
  it('signs in with the authenticator code: HttpOnly cookie, permissions, CSRF token', async () => {
    const { email, user } = await createStaff('OWNER', { username: 'grace' });
    const { step } = await passwordStep(email);
    const res = await codeStep(step.challengeToken, await currentTotp(email));

    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/rh_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(res.body.data.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(res.body.data.user).toMatchObject({ email, username: 'grace' });
    expect(res.body.data.user.permissions).toContain('users.manage');
    expect(res.body.data.user).not.toHaveProperty('passwordHash');

    const stored = await prisma().session.findFirstOrThrow({ where: { userId: user.id } });
    expect(cookie).not.toContain(stored.tokenHash);
    const audit = await prisma().auditLog.findFirstOrThrow({ where: { entityId: user.id, action: 'auth.login' } });
    expect(audit.after).toEqual({ method: 'totp' });

    // The challenge is single-use.
    expect((await codeStep(step.challengeToken, await currentTotp(email))).status).toBe(401);
  });

  it('accepts each authenticator code once', async () => {
    const { email } = await createStaff('CASHIER');
    const code = await currentTotp(email);
    const first = await passwordStep(email);
    expect((await codeStep(first.step.challengeToken, code)).status).toBe(200);
    const second = await passwordStep(email);
    const replay = await codeStep(second.step.challengeToken, code);
    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toMatch(/code is not right/);
  });

  it('accepts a backup code once, and records that one was used', async () => {
    const { email, user } = await createStaff('CASHIER');
    // Backup codes come from setting up two-factor; issue some for this user.
    const { agent, csrf } = await signIn(app, email, TEST_PASSWORD);
    await forgetLastCode(user.id);
    const regenerated = await agent.post('/api/v1/auth/two-factor/backup-codes').set('X-CSRF-Token', csrf).send({ code: await currentTotp(email) });
    expect(regenerated.status).toBe(200);
    const codes = regenerated.body.data.backupCodes as string[];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);

    const { step } = await passwordStep(email);
    expect((await codeStep(step.challengeToken, codes[0]!.toUpperCase())).status).toBe(200);
    const again = await passwordStep(email);
    expect((await codeStep(again.step.challengeToken, codes[0]!)).status).toBe(401);

    const status = await agent.get('/api/v1/auth/two-factor');
    expect(status.body.data.backupCodesLeft).toBe(9);
    const audit = await prisma().auditLog.findFirstOrThrow({ where: { entityId: user.id, action: 'auth.login' }, orderBy: { createdAt: 'desc' } });
    expect(audit.after).toEqual({ method: 'backup_code', backupCodesLeft: 9 });
  });

  it(`allows ${MAX_CODE_ATTEMPTS} codes per sign-in, and wrong codes count toward the lockout`, async () => {
    const { email, user } = await createStaff('CASHIER');
    const { step } = await passwordStep(email);
    for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i += 1) {
      const res = await codeStep(step.challengeToken, '000000');
      expect(res.status).toBe(401);
      expect(res.body.error.details).toBeUndefined();
    }
    expect((await prisma().user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginCount).toBe(MAX_CODE_ATTEMPTS - 1);
    // The fifth wrong code reaches the lockout threshold; after that even the right code needs a fresh sign-in.
    await codeStep(step.challengeToken, '000000');
    const locked = await prisma().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    const after = await codeStep(step.challengeToken, await currentTotp(email));
    expect(after.status).toBe(401);
    expect(after.body.error.details).toEqual({ restart: true });
    expect(await prisma().auditLog.count({ where: { entityId: user.id, action: 'auth.two_factor_failed' } })).toBe(MAX_CODE_ATTEMPTS);
  });

  it('expires an unfinished sign-in', async () => {
    const { email, user } = await createStaff('CASHIER');
    const { step } = await passwordStep(email);
    await prisma().loginChallenge.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await codeStep(step.challengeToken, await currentTotp(email));
    expect(res.status).toBe(401);
    expect(res.body.error.details).toEqual({ restart: true });
  });

  it('makes someone without an authenticator set one up at first sign-in, then requires it', async () => {
    const { email, user } = await createStaff('CASHIER', { twoFactor: false });
    const { step } = await passwordStep(email);
    expect(step.next).toBe('TWO_FACTOR_SETUP');
    if (step.next !== 'TWO_FACTOR_SETUP') return;
    expect(step.setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(step.setup.otpauthUri).toContain(`otpauth://totp/Rhoyards%3A${encodeURIComponent(email)}?secret=${step.setup.secret}`);

    const setup = (code: string) => request(app).post('/api/v1/auth/login/two-factor-setup').send({ challengeToken: step.challengeToken, code });
    expect((await setup('123456')).status).toBe(401);
    // A sign-in challenge cannot be used to finish set-up, or the other way round.
    expect((await codeStep(step.challengeToken, totpCode(step.setup.secret, timeStep()))).body.error.details).toEqual({ restart: true });

    const done = await setup(totpCode(step.setup.secret, timeStep()));
    expect(done.status).toBe(200);
    expect(String(done.headers['set-cookie'])).toMatch(/rh_sid=/);
    expect(done.body.data.backupCodes).toHaveLength(10);
    expect(done.body.data.user.email).toBe(email);

    const stored = await prisma().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.totpEnabledAt).not.toBeNull();
    expect(stored.totpSecretEnc).not.toContain(step.setup.secret); // encrypted at rest
    expect(await prisma().userBackupCode.count({ where: { userId: user.id } })).toBe(10);
    expect(await prisma().auditLog.count({ where: { entityId: user.id, action: 'auth.two_factor_enabled' } })).toBe(1);

    expect((await passwordStep(email)).step.next).toBe('TWO_FACTOR');
  });
});

describe('sessions', () => {
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
    const { step } = await passwordStep(email);
    const login = await codeStep(step.challengeToken, await currentTotp(email));
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const csrf = login.body.data.csrfToken as string;

    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(200);
    const out = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrf);
    expect(out.status).toBe(204);

    // Replaying the old cookie must not work even if a client kept it.
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('expires idle sessions', async () => {
    const { email, user } = await createStaff('CASHIER');
    const { agent } = await signIn(app, email, TEST_PASSWORD);
    await prisma().session.updateMany({ where: { userId: user.id }, data: { idleExpiresAt: new Date(Date.now() - 1000) } });
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
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

describe('managing two-factor', () => {
  it('replaces backup codes only with a valid code; the old ones stop working', async () => {
    const { email, user } = await createStaff('CASHIER');
    const { agent, csrf } = await signIn(app, email, TEST_PASSWORD);
    const wrong = await agent.post('/api/v1/auth/two-factor/backup-codes').set('X-CSRF-Token', csrf).send({ code: '000000' });
    expect(wrong.status).toBe(422);

    await forgetLastCode(user.id);
    const first = (await agent.post('/api/v1/auth/two-factor/backup-codes').set('X-CSRF-Token', csrf).send({ code: await currentTotp(email) })).body.data
      .backupCodes as string[];
    // A backup code can authorise the next replacement.
    const second = await agent.post('/api/v1/auth/two-factor/backup-codes').set('X-CSRF-Token', csrf).send({ code: first[3] });
    expect(second.status).toBe(200);
    const { step } = await passwordStep(email);
    expect((await codeStep(step.challengeToken, first[0]!)).status).toBe(401);
    expect((await codeStep(step.challengeToken, (second.body.data.backupCodes as string[])[0]!)).status).toBe(200);
  });

  it('moves to a new authenticator after the password and a code from the new app; other sessions end', async () => {
    const { email, user } = await createStaff('CASHIER');
    const other = await signIn(app, email, TEST_PASSWORD);
    const { agent, csrf } = await signIn(app, email, TEST_PASSWORD);
    const oldCode = await currentTotp(email);

    expect((await agent.post('/api/v1/auth/two-factor/change').set('X-CSRF-Token', csrf).send({ password: 'wrong-password' })).status).toBe(422);
    const started = await agent.post('/api/v1/auth/two-factor/change').set('X-CSRF-Token', csrf).send({ password: TEST_PASSWORD });
    expect(started.status).toBe(200);
    const { challengeToken, setup } = started.body.data as { challengeToken: string; setup: { secret: string } };

    // Another user's session cannot finish this change.
    const { email: otherEmail } = await createStaff('CASHIER');
    const stranger = await signIn(app, otherEmail, TEST_PASSWORD);
    const hijack = await stranger.agent
      .post('/api/v1/auth/two-factor/change/confirm')
      .set('X-CSRF-Token', stranger.csrf)
      .send({ challengeToken, code: totpCode(setup.secret, timeStep()) });
    expect(hijack.status).toBe(401);

    // The old app's code does not confirm the new one.
    const old = await agent.post('/api/v1/auth/two-factor/change/confirm').set('X-CSRF-Token', csrf).send({ challengeToken, code: oldCode });
    expect(old.status).toBe(422);
    const confirmed = await agent
      .post('/api/v1/auth/two-factor/change/confirm')
      .set('X-CSRF-Token', csrf)
      .send({ challengeToken, code: totpCode(setup.secret, timeStep()) });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.backupCodes).toHaveLength(10);

    expect((await other.agent.get('/api/v1/auth/me')).status).toBe(401);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);
    await forgetLastCode(user.id);
    const { step } = await passwordStep(email);
    expect((await codeStep(step.challengeToken, oldCode)).status).toBe(401);
    expect(await prisma().auditLog.count({ where: { entityId: user.id, action: 'auth.authenticator_changed' } })).toBe(1);
  });

  it('lets an administrator reset a lost authenticator: sessions end and set-up is required again', async () => {
    const { email: adminEmail, user: admin } = await createStaff('OWNER');
    const { email, user } = await createStaff('CASHIER');
    const cashier = await signIn(app, email, TEST_PASSWORD);
    const { agent, csrf } = await signIn(app, adminEmail, TEST_PASSWORD);

    const self = await agent.post(`/api/v1/users/${admin.id}/reset-two-factor`).set('X-CSRF-Token', csrf);
    expect(self.status).toBe(422);
    const res = await agent.post(`/api/v1/users/${user.id}/reset-two-factor`).set('X-CSRF-Token', csrf);
    expect(res.status).toBe(204);

    expect((await cashier.agent.get('/api/v1/auth/me')).status).toBe(401);
    const list = await agent.get(`/api/v1/users/${user.id}`);
    expect(list.body.data.twoFactorEnabled).toBe(false);
    expect((await passwordStep(email)).step.next).toBe('TWO_FACTOR_SETUP');
    expect(await prisma().auditLog.count({ where: { entityId: user.id, action: 'user.two_factor_reset' } })).toBe(1);

    // Without users.manage, no reset.
    expect((await cashier.agent.post(`/api/v1/users/${admin.id}/reset-two-factor`)).status).toBe(401);
    const { email: managerEmail } = await createStaff('CASHIER');
    const plain = await signIn(app, managerEmail, TEST_PASSWORD);
    expect((await plain.agent.post(`/api/v1/users/${admin.id}/reset-two-factor`).set('X-CSRF-Token', plain.csrf)).status).toBe(403);
  });
});
