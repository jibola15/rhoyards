import { execSync } from 'node:child_process';
import { API_DIR, useTestDatabaseEnv } from './helpers/test-db-env';

/** Applies all migrations to the test schema once per run. */
export default function setup() {
  useTestDatabaseEnv();
  execSync('npx prisma migrate deploy', {
    cwd: API_DIR,
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  });
}
