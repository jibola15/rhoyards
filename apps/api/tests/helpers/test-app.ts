import request from 'supertest';
import type { Express } from 'express';
import type { LoginStep } from '@rhoyards/shared';
import { createApp } from '../../src/app';
import { loadEnv, type Env } from '../../src/config/env';
import { MemoryMailer } from '../../src/lib/mailer';
import { getPrisma } from '../../src/lib/prisma';
import { decryptSecret } from '../../src/lib/secret-box';
import { identifierWhere } from '../../src/modules/auth/auth.service';
import { timeStep, totpCode } from '../../src/modules/auth/totp';

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', LOGIN_RATE_LIMIT: '10000', ...overrides });
}

/** The app with emails kept in memory. */
export function buildTestAppWithMail(overrides: Record<string, string> = {}) {
  const mailer = new MemoryMailer();
  const env = testEnv(overrides);
  return { app: createApp(env, undefined, undefined, mailer), mailer, env };
}

export function buildTestApp(overrides: Record<string, string> = {}) {
  return buildTestAppWithMail(overrides).app;
}

/** The current code of a user's authenticator (decrypting the stored secret with the test key). */
export async function currentTotp(identifier: string): Promise<string> {
  const user = await getPrisma().user.findUniqueOrThrow({ where: identifierWhere(identifier.toLowerCase()) });
  if (!user.totpSecretEnc) throw new Error(`${identifier} has no authenticator set up`);
  return totpCode(decryptSecret(user.totpSecretEnc, testEnv().TWO_FACTOR_KEY), timeStep());
}

/**
 * Signs in (password, then the authenticator code — setting one up first if needed) and returns a cookie-keeping
 * agent plus the CSRF token for state-changing calls.
 */
export async function signIn(app: Express, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ identifier, password });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${identifier}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const step = res.body.data as LoginStep;
  let done: request.Response;
  let backupCodes: string[] | undefined;
  if (step.next === 'TWO_FACTOR_SETUP') {
    done = await agent
      .post('/api/v1/auth/login/two-factor-setup')
      .send({ challengeToken: step.challengeToken, code: totpCode(step.setup.secret, timeStep()) });
    backupCodes = done.body.data?.backupCodes as string[] | undefined;
  } else {
    // Tests sign the same user in many times within one 30-second step; a code is normally usable once per step.
    await getPrisma().user.update({ where: identifierWhere(identifier.toLowerCase()), data: { totpLastStep: null } });
    done = await agent.post('/api/v1/auth/login/two-factor').send({ challengeToken: step.challengeToken, code: await currentTotp(identifier) });
  }
  if (done.status !== 200) {
    throw new Error(`Two-factor sign-in failed for ${identifier}: ${done.status} ${JSON.stringify(done.body)}`);
  }
  return { agent, csrf: done.body.data.csrfToken as string, user: done.body.data.user, backupCodes };
}
