import { afterAll } from 'vitest';
import { disconnectPrisma } from '../src/lib/prisma';
import { useTestDatabaseEnv } from './helpers/test-db-env';

useTestDatabaseEnv();

afterAll(async () => {
  await disconnectPrisma();
});
