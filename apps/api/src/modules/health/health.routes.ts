import { Router } from 'express';
import { dataEnvelopeSchema, healthSchema, type DataEnvelope, type Health } from '@rhoyards/shared';
import { APP_VERSION } from '../../config/env';
import { getPrisma } from '../../lib/prisma';
import { registry } from '../../openapi/registry';

export const healthRouter = Router();

registry.registerPath({
  method: 'get',
  path: '/health',
  tags: ['System'],
  summary: 'Liveness check',
  responses: {
    200: {
      description: 'The API process is running',
      content: { 'application/json': { schema: dataEnvelopeSchema(healthSchema) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/health/ready',
  tags: ['System'],
  summary: 'Readiness check: the API can reach the database',
  responses: { 200: { description: 'Ready' }, 503: { description: 'Database unreachable' } },
});

healthRouter.get('/health/ready', async (_req, res) => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    res.json({ data: { status: 'ready', database: 'ok' } });
  } catch {
    res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Database is unreachable' } });
  }
});

healthRouter.get('/health', (_req, res) => {
  const payload: DataEnvelope<Health> = {
    data: {
      status: 'ok',
      service: 'rhoyards-api',
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      time: new Date().toISOString(),
    },
  };
  res.json(payload);
});
