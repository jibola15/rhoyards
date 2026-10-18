import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { loadEnv, type Env } from '../../src/config/env';

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', LOGIN_RATE_LIMIT: '10000', ...overrides });
}

export function buildTestApp(overrides: Record<string, string> = {}) {
  return createApp(testEnv(overrides));
}

/** Signs in and returns a cookie-keeping agent plus the CSRF token for state-changing calls. */
export async function signIn(app: Express, email: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { agent, csrf: res.body.data.csrfToken as string, user: res.body.data.user };
}
