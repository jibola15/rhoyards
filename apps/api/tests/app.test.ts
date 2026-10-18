import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { dataEnvelopeSchema, errorBodySchema, healthSchema } from '@rhoyards/shared';
import { buildTestApp } from './helpers/test-app';

describe('API application', () => {
  const app = buildTestApp();

  it('GET /api/v1/health returns the health envelope', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    const body = dataEnvelopeSchema(healthSchema).parse(res.body);
    expect(body.data.status).toBe('ok');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a well-formed X-Request-Id and replaces a malformed one', async () => {
    const good = await request(app).get('/api/v1/health').set('X-Request-Id', 'trace-12345678');
    expect(good.headers['x-request-id']).toBe('trace-12345678');

    const bad = await request(app).get('/api/v1/health').set('X-Request-Id', '<script>alert(1)</script>');
    expect(bad.headers['x-request-id']).not.toContain('<');
  });

  it('returns the standard error envelope for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    const body = errorBodySchema.parse(res.body);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('rejects malformed JSON with a 400 validation error', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects oversized JSON bodies with 413', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(1_100_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('serves an OpenAPI document that includes registered routes', async () => {
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/health']).toBeDefined();
  });

  it('does not expose API docs when disabled', async () => {
    const prodLike = buildTestApp({ API_DOCS_ENABLED: 'false' });
    const res = await request(prodLike).get('/api/openapi.json');
    expect(res.status).toBe(404);
  });
});
