import { defineConfig } from 'vitest/config';

// defineConfig (not defineProject): pool options are needed here and defineProject's types omit them.
export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup-env.ts'],
    // Integration tests share one test schema and reset it per file, so files must run one at a time
    // in a single worker (fileParallelism is not honoured per project).
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    // The database is remote (Neon); allow for network latency.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
