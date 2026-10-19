import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { runScheduledJob } from '../../src/lib/jobs';
import { runMaintenance } from '../../src/lib/maintenance';
import { getPrisma } from '../../src/lib/prisma';
import { INVALID_RESET_LINK } from '../../src/modules/auth/password-reset.service';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { buildTestApp, buildTestAppWithMail, signIn } from '../helpers/test-app';

const { app, mailer } = buildTestAppWithMail({ BACKOFFICE_URL: 'https://office.example', STOREFRONT_URL: 'https://shop.example' });
const prisma = () => getPrisma();

beforeAll(async () => {
  await resetDatabase();
});

/** Waits for the email the API sends after answering, and returns the token from its link. */
async function resetTokenFor(email: string, linkPrefix: string): Promise<string> {
  await expect.poll(() => mailer.lastTo(email)?.subject, { timeout: 15_000 }).toBe('Reset your Rhoyards password');
  const text = mailer.lastTo(email)!.text;
  expect(text).toContain(`${linkPrefix}#token=`);
  return /#token=([A-Za-z0-9_-]+)/.exec(text)![1]!;
}

describe('staff password reset', () => {
  it('emails a single-use link; the new password works, sessions end, and two-factor is still required', async () => {
    const { email, user } = await createStaff('CASHIER', { username: 'bola' });
    const before = await signIn(app, email, TEST_PASSWORD);
    await prisma().user.update({ where: { id: user.id }, data: { failedLoginCount: 3 } });

    const asked = await request(app).post('/api/v1/auth/password-reset').send({ identifier: 'BOLA' });
    expect(asked.status).toBe(202);
    const token = await resetTokenFor(email, 'https://office.example/reset-password');
    const stored = await prisma().passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(stored.tokenHash).not.toBe(token);

    const confirm = (newPassword: string, t = token) => request(app).post('/api/v1/auth/password-reset/confirm').send({ token: t, newPassword });
    expect((await confirm('short')).status).toBe(400);
    expect((await confirm('a-fresh-passphrase-1')).status).toBe(204);

    expect((await before.agent.get('/api/v1/auth/me')).status).toBe(401);
    const login = await request(app).post('/api/v1/auth/login').send({ identifier: email, password: 'a-fresh-passphrase-1' });
    expect(login.body.data.next).toBe('TWO_FACTOR');
    await expect(signIn(app, email, TEST_PASSWORD)).rejects.toThrow();
    await expect(signIn(app, 'bola', 'a-fresh-passphrase-1')).resolves.toBeDefined();
    expect((await prisma().user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginCount).toBe(0);

    const reused = await confirm('another-passphrase-2');
    expect(reused.status).toBe(422);
    expect(reused.body.error.message).toBe(INVALID_RESET_LINK);
    await expect.poll(() => mailer.lastTo(email)?.subject).toBe('Your Rhoyards password was changed');
    expect(await prisma().auditLog.count({ where: { entityId: user.id, action: 'auth.password_reset_completed' } })).toBe(1);
  });

  it('answers the same for unknown accounts and sends nothing', async () => {
    const sent = mailer.sent.length;
    const res = await request(app).post('/api/v1/auth/password-reset').send({ identifier: 'nobody@test.local' });
    expect(res.status).toBe(202);
    expect(res.body.data.message).toMatch(/If an account matches/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(mailer.sent.length).toBe(sent);
  });

  it('rejects expired links, keeps only the newest link, and limits requests per account', async () => {
    const { email, user } = await createStaff('CASHIER');
    await request(app).post('/api/v1/auth/password-reset').send({ identifier: email });
    const first = await resetTokenFor(email, 'https://office.example/reset-password');
    mailer.sent.length = 0;
    await request(app).post('/api/v1/auth/password-reset').send({ identifier: email });
    const second = await resetTokenFor(email, 'https://office.example/reset-password');
    expect(second).not.toBe(first);
    expect((await request(app).post('/api/v1/auth/password-reset/confirm').send({ token: first, newPassword: 'a-fresh-passphrase-1' })).status).toBe(422);

    await prisma().passwordResetToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).post('/api/v1/auth/password-reset/confirm').send({ token: second, newPassword: 'a-fresh-passphrase-1' })).status).toBe(422);

    // Two requests so far this hour; the third is sent, the fourth silently dropped.
    mailer.sent.length = 0;
    await request(app).post('/api/v1/auth/password-reset').send({ identifier: email });
    await resetTokenFor(email, 'https://office.example/reset-password');
    mailer.sent.length = 0;
    await request(app).post('/api/v1/auth/password-reset').send({ identifier: email });
    await new Promise((r) => setTimeout(r, 1500));
    expect(mailer.sent).toHaveLength(0);
  });

  it('does not send links to disabled staff', async () => {
    const { email, user } = await createStaff('CASHIER');
    await prisma().user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    await request(app).post('/api/v1/auth/password-reset').send({ identifier: email });
    await new Promise((r) => setTimeout(r, 1500));
    expect(mailer.lastTo(email)).toBeUndefined();
  });
});

describe('shopper password reset', () => {
  it('emails a storefront link; the new password signs in and old sessions end', async () => {
    const shop = request.agent(app);
    const email = 'shopper.reset@test.local';
    const registered = await shop.post('/api/v1/store/auth/register').send({ name: 'Ada Shopper', email, phone: '+2348012345678', password: 'shopper-password' });
    expect(registered.status).toBe(201);

    expect((await request(app).post('/api/v1/store/auth/password-reset').send({ email: 'SHOPPER.reset@test.local' })).status).toBe(202);
    const token = await resetTokenFor(email, 'https://shop.example/account/reset-password');
    // A storefront token is not a staff token.
    expect((await request(app).post('/api/v1/auth/password-reset/confirm').send({ token, newPassword: 'a-fresh-passphrase-1' })).status).toBe(422);

    const done = await request(app).post('/api/v1/store/auth/password-reset/confirm').send({ token, newPassword: 'new-shopper-pass' });
    expect(done.status).toBe(204);
    expect((await shop.get('/api/v1/store/auth/me')).status).toBe(401);
    expect((await request(app).post('/api/v1/store/auth/login').send({ email, password: 'shopper-password' })).status).toBe(401);
    expect((await request(app).post('/api/v1/store/auth/login').send({ email, password: 'new-shopper-pass' })).status).toBe(200);
  });
});

describe('several API instances', () => {
  it('share rate limits through the database', async () => {
    const env = { RATE_LIMIT_STORE: 'database', LOGIN_RATE_LIMIT: '3' };
    const a = buildTestApp(env);
    const b = buildTestApp(env);
    await prisma().rateLimitBucket.deleteMany({});
    const attempt = (target: typeof a) => request(target).post('/api/v1/auth/login').send({ identifier: 'nobody', password: 'whatever-123' });
    expect((await attempt(a)).status).toBe(401);
    expect((await attempt(b)).status).toBe(401);
    expect((await attempt(a)).status).toBe(401);
    const limited = await attempt(b);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(await prisma().rateLimitBucket.findFirst({ where: { key: { startsWith: 'staff-login:' } } })).toMatchObject({ hits: 4 });
  });

  it('runs a background job once per interval, whichever instance gets there first', async () => {
    let runs = 0;
    const job = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 500));
      return runs;
    };
    const now = new Date();
    const [x, y] = await Promise.all([runScheduledJob('test-job', 60_000, job, () => now), runScheduledJob('test-job', 60_000, job, () => now)]);
    expect([x.ran, y.ran].sort()).toEqual([false, true]);
    expect(runs).toBe(1);

    expect(await runScheduledJob('test-job', 60_000, job, () => new Date(now.getTime() + 10_000))).toEqual({ ran: false, reason: 'not-due' });
    expect(await runScheduledJob('test-job', 60_000, job, () => new Date(now.getTime() + 60_000))).toEqual({ ran: true, result: 2 });

    const failing = () => Promise.reject(new Error('boom'));
    await expect(runScheduledJob('test-failing-job', 60_000, failing)).rejects.toThrow(/boom/);
    const row = await prisma().scheduledJob.findUniqueOrThrow({ where: { name: 'test-failing-job' } });
    expect(row).toMatchObject({ lastStatus: 'failed', lastError: 'boom' });
    // Recorded as run: another instance does not retry it straight away.
    expect(await runScheduledJob('test-failing-job', 60_000, failing)).toEqual({ ran: false, reason: 'not-due' });
  });

  it('maintenance clears expired challenges, reset links and rate-limit counters', async () => {
    const { user } = await createStaff('CASHIER');
    const old = new Date(Date.now() - 2 * 86_400_000);
    await prisma().loginChallenge.create({ data: { tokenHash: 'old-challenge', userId: user.id, kind: 'TWO_FACTOR', expiresAt: old } });
    await prisma().passwordResetToken.create({ data: { tokenHash: 'old-reset', realm: 'STAFF', userId: user.id, expiresAt: old } });
    await prisma().rateLimitBucket.create({ data: { key: 'test:old', hits: 3, resetAt: old } });
    const result = await runMaintenance();
    expect(result.loginChallenges).toBeGreaterThanOrEqual(1);
    expect(result.passwordResetTokens).toBeGreaterThanOrEqual(1);
    expect(result.rateLimits).toBeGreaterThanOrEqual(1);
    expect(await prisma().loginChallenge.findUnique({ where: { tokenHash: 'old-challenge' } })).toBeNull();
  });
});
