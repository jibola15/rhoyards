import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { APP_VERSION } from '../config/env';

/** Route modules register their paths here; the document is generated from the same Zod schemas used for validation. */
export const registry = new OpenAPIRegistry();

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Rhoyards Retail Management API',
      version: APP_VERSION,
      description:
        'REST API for inventory, POS, online orders, purchasing and accounting. All money values are decimal strings. Errors use the ErrorBody envelope.',
    },
    servers: [{ url: '/api/v1' }],
  });
}
