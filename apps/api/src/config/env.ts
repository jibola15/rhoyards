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
  return {
    ...env,
    // API docs default to on outside production.
    API_DOCS_ENABLED: env.API_DOCS_ENABLED ?? env.NODE_ENV !== 'production',
  };
}
