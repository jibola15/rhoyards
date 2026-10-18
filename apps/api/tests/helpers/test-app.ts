import { createApp } from '../../src/app';
import { loadEnv, type Env } from '../../src/config/env';

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...overrides });
}

export function buildTestApp(overrides: Record<string, string> = {}) {
  return createApp(testEnv(overrides));
}
