import { defineConfig } from 'vitest/config';

// Each workspace owns its own vitest config; the root runs them all as projects.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
  },
});
