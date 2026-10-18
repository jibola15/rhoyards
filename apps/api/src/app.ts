import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Env } from './config/env';
import { createLogger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { createRateLimiter } from './middleware/rate-limit';
import { healthRouter } from './modules/health/health.routes';
import { buildOpenApiDocument } from './openapi/registry';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function createApp(env: Env, logger: Logger = createLogger(env)) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      autoLogging: env.NODE_ENV !== 'test',
      // Accept a caller-supplied request ID only if it is well-formed; otherwise generate one.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createRateLimiter({ windowMs: 60_000, limit: 300 }));

  if (env.API_DOCS_ENABLED) {
    const document = buildOpenApiDocument();
    app.get('/api/openapi.json', (_req, res) => {
      res.json(document);
    });
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(document));
  }

  app.use('/api/v1', healthRouter);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
