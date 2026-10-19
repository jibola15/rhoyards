import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';

describe('environment configuration', () => {
  const db = { DATABASE_URL: 'postgresql://user:pass@localhost/db' };
  /** The minimum a production deployment must set. */
  const prod = {
    ...db,
    NODE_ENV: 'production',
    TWO_FACTOR_KEY: Buffer.alloc(32, 7).toString('base64'),
    SMTP_HOST: 'smtp.example.com',
    MAIL_FROM: 'Rhoyards <no-reply@rhoyards.example>',
    BACKOFFICE_URL: 'https://office.rhoyards.example',
    STOREFRONT_URL: 'https://shop.rhoyards.example/',
  };

  it('applies safe defaults', () => {
    const env = loadEnv({ ...db });
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_DOCS_ENABLED).toBe(true);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:5174']);
    expect(env.RATE_LIMIT_STORE).toBe('memory');
    expect(env.TWO_FACTOR_KEY).toHaveLength(32);
  });

  it('disables API docs by default in production', () => {
    expect(loadEnv(prod).API_DOCS_ENABLED).toBe(false);
    expect(loadEnv({ ...prod, API_DOCS_ENABLED: 'true' }).API_DOCS_ENABLED).toBe(true);
  });

  it('fails fast on invalid values', () => {
    expect(() => loadEnv({ ...db, PORT: 'not-a-port' })).toThrow(/Invalid environment configuration/);
    expect(() => loadEnv({ ...db, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => loadEnv({ ...db, TWO_FACTOR_KEY: 'too-short' })).toThrow(/32 random bytes/);
    expect(() => loadEnv({ ...db, SMTP_USER: 'mailer' })).toThrow(/SMTP_USER and SMTP_PASS/);
  });

  it('enables the test payment gateway outside production only', () => {
    expect(loadEnv({ ...db }).PAYMENT_TEST_ENABLED).toBe(true);
    expect(loadEnv(prod).PAYMENT_TEST_ENABLED).toBe(false);
    expect(() => loadEnv({ ...prod, PAYMENT_TEST_ENABLED: 'true' })).toThrow(/cannot be true in production/);
  });

  it('requires a database URL outside tests', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL is required/);
    expect(() => loadEnv({ NODE_ENV: 'test' })).not.toThrow();
  });

  it('requires a two-factor key, real mail and https links in production, and shares rate limits there', () => {
    const env = loadEnv(prod);
    expect(env.RATE_LIMIT_STORE).toBe('database');
    expect(env.STOREFRONT_URL).toBe('https://shop.rhoyards.example');
    expect(env.SMTP_SECURE).toBe(false);
    expect(() => loadEnv({ ...prod, TWO_FACTOR_KEY: undefined })).toThrow(/TWO_FACTOR_KEY is required/);
    expect(() => loadEnv({ ...prod, SMTP_HOST: undefined })).toThrow(/SMTP_HOST is required/);
    expect(() => loadEnv({ ...prod, MAIL_FROM: undefined })).toThrow(/MAIL_FROM/);
    expect(() => loadEnv({ ...prod, BACKOFFICE_URL: 'http://office.rhoyards.example' })).toThrow(/https/);
    expect(loadEnv({ ...prod, SMTP_PORT: '465' }).SMTP_SECURE).toBe(true);
  });
});
