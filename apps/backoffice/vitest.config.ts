import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  test: {
    name: 'backoffice',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // Lazy-loaded routes plus simulated typing can exceed 5 s when all projects run in parallel.
    testTimeout: 15_000,
  },
});
