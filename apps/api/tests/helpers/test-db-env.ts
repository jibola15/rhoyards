import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

export const API_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Database name from a postgres URL, e.g. "rhoyards_test". */
export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/**
 * Points Prisma at the dedicated test DATABASE. Refuses to run if the test URL is missing, equals the
 * development URL, or names a database without "test" in it — tests TRUNCATE everything.
 *
 * A separate database is required: separating by schema is NOT safe behind Neon's PgBouncer pooler,
 * where search_path can carry over between pooled connections.
 */
export function useTestDatabaseEnv(): void {
  // Already validated and switched (global setup runs first; workers inherit its environment).
  if (process.env.RHOYARDS_TEST_DB === '1') return;
  config({ path: `${API_DIR}/.env`, quiet: true });
  const testUrl = process.env.TEST_DATABASE_URL;
  const testDirect = process.env.TEST_DIRECT_URL ?? testUrl;
  if (!testUrl || !testDirect) {
    throw new Error('TEST_DATABASE_URL is not set (see apps/api/.env.example). Integration tests need a test database.');
  }
  for (const url of [testUrl, testDirect]) {
    const db = databaseName(url);
    if (!db.includes('test')) {
      throw new Error(`Refusing to run tests against database "${db}": the test database name must contain "test".`);
    }
    if (new URL(url).searchParams.has('schema')) {
      throw new Error('Do not isolate tests with ?schema= — use a separate test database.');
    }
  }
  const devUrl = process.env.DATABASE_URL;
  if (devUrl && databaseName(devUrl) === databaseName(testUrl) && new URL(devUrl).host.replace('-pooler', '') === new URL(testUrl).host.replace('-pooler', '')) {
    throw new Error('TEST_DATABASE_URL must point at a different database from DATABASE_URL.');
  }
  process.env.DATABASE_URL = testUrl;
  process.env.DIRECT_URL = testDirect;
  process.env.NODE_ENV = 'test';
  process.env.RHOYARDS_TEST_DB = '1';
}
