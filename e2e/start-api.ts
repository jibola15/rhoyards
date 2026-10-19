/**
 * Starts the API for the end-to-end tests: on the TEST database (never the development one), reset and seeded with
 * a known owner and one online product in stock. Run by Playwright's webServer; see playwright.config.ts.
 */
import request from 'supertest';
import { useTestDatabaseEnv } from '../apps/api/tests/helpers/test-db-env';

useTestDatabaseEnv();

const { loadEnv } = await import('../apps/api/src/config/env');
const { createApp } = await import('../apps/api/src/app');
const { getPrisma } = await import('../apps/api/src/lib/prisma');
const { hashPassword } = await import('../apps/api/src/modules/auth/password');
const { encryptSecret } = await import('../apps/api/src/lib/secret-box');
const { hashBackupCode } = await import('../apps/api/src/modules/auth/two-factor.service');
const { timeStep, totpCode } = await import('../apps/api/src/modules/auth/totp');
const { resetDatabase } = await import('../apps/api/tests/helpers/db');
const { makeProduct, mainLocationId } = await import('../apps/api/tests/helpers/catalog');
const { E2E } = await import('./fixtures');

const PORT = Number(process.env.E2E_API_PORT ?? 4100);
const env = loadEnv({ ...process.env, NODE_ENV: 'test', PORT: String(PORT), LOG_LEVEL: 'warn', LOGIN_RATE_LIMIT: '1000' });
const app = createApp(env);

await resetDatabase();
const prisma = getPrisma();
const ownerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
const owner = await prisma.user.create({
  data: {
    email: E2E.owner.email,
    username: E2E.owner.username,
    fullName: 'E2E Owner',
    passwordHash: await hashPassword(E2E.owner.password),
    totpSecretEnc: encryptSecret(E2E.owner.totpSecret, env.TWO_FACTOR_KEY),
    totpEnabledAt: new Date(),
    roles: { create: { roleId: ownerRole.id } },
    backupCodes: { create: E2E.owner.backupCodes.map((c) => ({ codeHash: hashBackupCode(c) })) },
  },
});
const product = await makeProduct(owner.id, { name: E2E.product.name, variants: [{ sku: E2E.product.sku, name: '250 ml', sellingPrice: E2E.product.price }] });
await prisma.product.update({ where: { id: product.id }, data: { onlineVisible: true } });

// Opening stock through the real API, so stock and ledger are consistent.
const agent = request.agent(app);
const step = await agent.post('/api/v1/auth/login').send({ identifier: E2E.owner.email, password: E2E.owner.password });
const login = await agent
  .post('/api/v1/auth/login/two-factor')
  .send({ challengeToken: step.body.data.challengeToken, code: totpCode(E2E.owner.totpSecret, timeStep()) });
const csrf = login.body.data.csrfToken as string;
const adj = await agent
  .post('/api/v1/stock-adjustments')
  .set('X-CSRF-Token', csrf)
  .send({ locationId: await mainLocationId(), reason: 'OPENING_STOCK', lines: [{ variantId: product.variants[0]!.id, qtyChange: '20', unitCost: '1200' }] });
await agent.post(`/api/v1/stock-adjustments/${adj.body.data.id}/post`).set('X-CSRF-Token', csrf);
// Let the browser tests use this 30-second step's code again.
await prisma.user.update({ where: { id: owner.id }, data: { totpLastStep: null } });

app.listen(PORT, () => console.log(`E2E API listening on ${PORT}`));
