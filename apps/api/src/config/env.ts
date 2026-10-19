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
});

export type Env = Omit<z.infer<typeof envSchema>, 'API_DOCS_ENABLED'> & { API_DOCS_ENABLED: boolean };

export const APP_VERSION = '0.1.0';

/** Parses and validates configuration. Fails fast with a readable message rather than starting misconfigured. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  const env = result.data;
  if (env.NODE_ENV !== 'test' && !env.DATABASE_URL) {
    throw new Error('Invalid environment configuration:\nDATABASE_URL is required');
  }
  return {
    ...env,
    // API docs default to on outside production.
    API_DOCS_ENABLED: env.API_DOCS_ENABLED ?? env.NODE_ENV !== 'production',
  };
}
