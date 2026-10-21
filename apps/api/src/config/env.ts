import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:5174')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  API_DOCS_ENABLED: booleanString.optional(),
  DATABASE_URL: z.string().min(1).optional(),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  /** Login attempts allowed per IP per 15 minutes. */
  LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
  /** Directory for uploaded files (local-disk storage driver). */
  UPLOAD_DIR: z.string().min(1).default('./storage/uploads'),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(25).default(5),
  /** IANA time zone that defines the business day for accounting dates (e.g. a sale at 00:30). */
  BUSINESS_TIMEZONE: z.string().min(1).default('Africa/Lagos'),
  /** Sandbox card gateway for the storefront (signed webhooks). On by default outside production; never in production. */
  PAYMENT_TEST_ENABLED: booleanString.optional(),
  /** HMAC secret the test gateway signs its webhooks with. */
  PAYMENT_TEST_SECRET: z.string().min(16).optional(),
  /** Public addresses of the two apps, used for links in emails (password reset). */
  BACKOFFICE_URL: z.url().default('http://localhost:5173'),
  STOREFRONT_URL: z.url().default('http://localhost:5174'),
  /** Outgoing mail. Without SMTP_HOST, emails are written to MAIL_OUTBOX_DIR instead (development and tests only). */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** true = TLS from the start (port 465); false = STARTTLS, which is then required. */
  SMTP_SECURE: booleanString.optional(),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(3).default('Rhoyards <no-reply@localhost>'),
  MAIL_OUTBOX_DIR: z.string().min(1).default('./storage/outbox'),
  /** 32 random bytes, base64: encrypts staff authenticator secrets at rest. Generate with `openssl rand -base64 32`. */
  TWO_FACTOR_KEY: z.string().optional(),
  /** Where rate-limit counters live: `database` (shared by every API instance) or `memory` (this process only). */
  RATE_LIMIT_STORE: z.enum(['database', 'memory']).optional(),
  /** Where uploaded file bytes live: `local` (UPLOAD_DIR on disk) or `database` (hosts without a lasting disk). */
  STORAGE_DRIVER: z.enum(['local', 'database']).default('local'),
  /** Explicitly run without email (a trial deployment): password-reset emails are not sent. */
  MAIL_DISABLED: booleanString.default(false),
  /** Shared secret Vercel Cron (or any scheduler) sends as `Authorization: Bearer …` to run background jobs. */
  CRON_SECRET: z.string().min(16).optional(),
});

type Derived = 'API_DOCS_ENABLED' | 'PAYMENT_TEST_ENABLED' | 'PAYMENT_TEST_SECRET' | 'SMTP_SECURE' | 'TWO_FACTOR_KEY' | 'RATE_LIMIT_STORE';
export type Env = Omit<z.infer<typeof envSchema>, Derived> & {
  API_DOCS_ENABLED: boolean;
  PAYMENT_TEST_ENABLED: boolean;
  PAYMENT_TEST_SECRET: string;
  SMTP_SECURE: boolean;
  /** Decoded 32-byte key. */
  TWO_FACTOR_KEY: Buffer;
  RATE_LIMIT_STORE: 'database' | 'memory';
};

const DEV_TEST_GATEWAY_SECRET = 'dev-only-test-gateway-secret';
/** Development and tests only (32 bytes); production must supply its own key. */
const DEV_TWO_FACTOR_KEY = Buffer.from('rhoyards-dev-only-two-factor-key');

export const APP_VERSION = '0.1.0';

/**
 * Identifies this release: the commit on Vercel (the front ends are built with the same value), else APP_BUILD,
 * else the version. Sent as X-App-Version so an out-of-date browser tab can offer to reload.
 */
export const APP_BUILD = (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.APP_BUILD ?? APP_VERSION).slice(0, 12);

function fail(message: string): never {
  throw new Error(`Invalid environment configuration:\n${message}`);
}

/** Parses and validates configuration. Fails fast with a readable message rather than starting misconfigured. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) fail(z.prettifyError(result.error));
  const env = result.data;
  const production = env.NODE_ENV === 'production';
  if (env.NODE_ENV !== 'test' && !env.DATABASE_URL) fail('DATABASE_URL is required');
  const testGateway = env.PAYMENT_TEST_ENABLED ?? !production;
  if (testGateway && production) {
    // A sandbox that marks orders paid must never be reachable on the live store.
    fail('PAYMENT_TEST_ENABLED cannot be true in production');
  }

  let twoFactorKey = DEV_TWO_FACTOR_KEY;
  if (env.TWO_FACTOR_KEY) {
    twoFactorKey = Buffer.from(env.TWO_FACTOR_KEY, 'base64');
    if (twoFactorKey.length !== 32) fail('TWO_FACTOR_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)');
  } else if (production) {
    fail('TWO_FACTOR_KEY is required in production (openssl rand -base64 32)');
  }

  if (production) {
    // Password-reset emails must really be sent, and their links must be https.
    if (!env.MAIL_DISABLED) {
      if (!env.SMTP_HOST) fail('SMTP_HOST is required in production (password-reset emails), or set MAIL_DISABLED=true for a trial');
      if (/@localhost>?$/.test(env.MAIL_FROM)) fail('MAIL_FROM must be a real sender address in production');
    }
    for (const key of ['BACKOFFICE_URL', 'STOREFRONT_URL'] as const) {
      if (!env[key].startsWith('https://')) fail(`${key} must be an https:// address in production`);
    }
  }
  if ((env.SMTP_USER === undefined) !== (env.SMTP_PASS === undefined)) fail('Set both SMTP_USER and SMTP_PASS, or neither');

  return {
    ...env,
    // API docs default to on outside production.
    API_DOCS_ENABLED: env.API_DOCS_ENABLED ?? !production,
    PAYMENT_TEST_ENABLED: testGateway,
    PAYMENT_TEST_SECRET: env.PAYMENT_TEST_SECRET ?? DEV_TEST_GATEWAY_SECRET,
    BACKOFFICE_URL: env.BACKOFFICE_URL.replace(/\/+$/, ''),
    STOREFRONT_URL: env.STOREFRONT_URL.replace(/\/+$/, ''),
    SMTP_SECURE: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
    TWO_FACTOR_KEY: twoFactorKey,
    // Shared counters by default in production, where several instances may run.
    RATE_LIMIT_STORE: env.RATE_LIMIT_STORE ?? (production ? 'database' : 'memory'),
  };
}
