import { Router } from 'express';
import { dataEnvelopeSchema, healthSchema, type DataEnvelope, type Health } from '@rhoyards/shared';
import { APP_VERSION } from '../../config/env';
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
