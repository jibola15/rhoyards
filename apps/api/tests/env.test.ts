import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';

describe('environment configuration', () => {
  const db = { DATABASE_URL: 'postgresql://user:pass@localhost/db' };

  it('applies safe defaults', () => {
    const env = loadEnv({ ...db });
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_DOCS_ENABLED).toBe(true);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:5174']);
  });

  it('disables API docs by default in production', () => {
    expect(loadEnv({ ...db, NODE_ENV: 'production' }).API_DOCS_ENABLED).toBe(false);
    expect(loadEnv({ ...db, NODE_ENV: 'production', API_DOCS_ENABLED: 'true' }).API_DOCS_ENABLED).toBe(true);
  });

  it('fails fast on invalid values', () => {
    expect(() => loadEnv({ ...db, PORT: 'not-a-port' })).toThrow(/Invalid environment configuration/);
    expect(() => loadEnv({ ...db, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('enables the test payment gateway outside production only', () => {
    expect(loadEnv({ ...db }).PAYMENT_TEST_ENABLED).toBe(true);
    expect(loadEnv({ ...db, NODE_ENV: 'production' }).PAYMENT_TEST_ENABLED).toBe(false);
    expect(() => loadEnv({ ...db, NODE_ENV: 'production', PAYMENT_TEST_ENABLED: 'true' })).toThrow(/cannot be true in production/);
  });

  it('requires a database URL outside tests', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL is required/);
    expect(() => loadEnv({ NODE_ENV: 'test' })).not.toThrow();
  });
});
