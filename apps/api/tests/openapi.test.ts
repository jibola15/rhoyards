import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/openapi/registry';
import { buildTestApp } from './helpers/test-app';

interface Layer {
  name: string;
  route?: { path: string; methods: Record<string, boolean> };
  handle: { stack?: Layer[] };
  matchers?: ((path: string) => { path: string } | false)[];
}

/** Every route the running app serves, as "METHOD /path" relative to /api/v1, with Express params as {param}. */
function servedRoutes(): string[] {
  const app = buildTestApp() as unknown as { router: { stack: Layer[] } };
  const out: string[] = [];
  // prefix is null at the app's top level, where the only routes are the OpenAPI document itself.
  const walk = (stack: Layer[], prefix: string | null) => {
    for (const layer of stack) {
      if (layer.route) {
        if (prefix === null) continue;
        for (const method of Object.keys(layer.route.methods)) {
          out.push(`${method.toUpperCase()} ${(prefix + layer.route.path).replace(/:(\w+)/g, '{$1}')}`);
        }
      } else if (layer.handle.stack) {
        // A mounted router: find where it is mounted by asking its matcher about a probe path.
        const mount = layer.matchers?.[0]?.('/api/v1/store/__probe');
        if (!mount || !mount.path.startsWith('/api/v1')) continue;
        walk(layer.handle.stack, mount.path.replace(/^\/api\/v1/, ''));
      }
    }
  };
  walk(app.router.stack, null);
  return [...new Set(out)].sort();
}

describe('OpenAPI document', () => {
  it('documents every route the API serves', () => {
    const doc = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, unknown>> };
    const documented = new Set(Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`)));
    const served = servedRoutes();
    expect(served.length).toBeGreaterThan(150);
    expect(served.filter((r) => !documented.has(r))).toEqual([]);
  });
});
