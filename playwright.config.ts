import { defineConfig, devices } from '@playwright/test';
import { E2E } from './e2e/fixtures';

/**
 * End-to-end tests: the real API (on the test database, reset and seeded at start) behind both front ends, driven in
 * Chromium. Run with `npm run e2e`. The suite shares one database, so tests run in order in a single worker.
 */
const api = { ...process.env, API_PROXY_TARGET: E2E.urls.api };

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 15_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node node_modules/tsx/dist/cli.mjs e2e/start-api.ts',
      url: `${E2E.urls.api}/api/v1/health`,
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: 'node node_modules/vite/bin/vite.js apps/backoffice --port 5273 --strictPort',
      url: E2E.urls.backoffice,
      timeout: 120_000,
      reuseExistingServer: false,
      env: api,
    },
    {
      command: 'node node_modules/vite/bin/vite.js apps/storefront --port 5274 --strictPort',
      url: E2E.urls.storefront,
      timeout: 120_000,
      reuseExistingServer: false,
      env: api,
    },
  ],
});
