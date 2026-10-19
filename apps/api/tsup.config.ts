import { defineConfig } from 'tsup';

export default defineConfig({
  // server.ts: a long-running process; vercel.ts: the same app as a Vercel function.
  entry: ['src/server.ts', 'src/vercel.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Workspace packages ship TypeScript source, so bundle them into the API build.
  noExternal: [/^@rhoyards\//],
});
