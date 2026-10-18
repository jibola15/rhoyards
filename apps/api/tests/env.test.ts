import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';

describe('environment configuration', () => {
  it('applies safe defaults', () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_DOCS_ENABLED).toBe(true);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:5174']);
  });

  it('disables API docs by default in production', () => {
    expect(loadEnv({ NODE_ENV: 'production' }).API_DOCS_ENABLED).toBe(false);
    expect(loadEnv({ NODE_ENV: 'production', API_DOCS_ENABLED: 'true' }).API_DOCS_ENABLED).toBe(true);
  });

  it('fails fast on invalid values', () => {
    expect(() => loadEnv({ PORT: 'not-a-port' })).toThrow(/Invalid environment configuration/);
    expect(() => loadEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
