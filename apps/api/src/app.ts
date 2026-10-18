import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
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
import { auditRouter } from './modules/audit/audit.routes';
import { csrfProtection, loadSession, originCheck } from './modules/auth/auth.middleware';
import { authRouter } from './modules/auth/auth.routes';
import type { SessionConfig } from './modules/auth/auth.types';
import { healthRouter } from './modules/health/health.routes';
import { rolesRouter } from './modules/roles/roles.routes';
import { settingsRouter } from './modules/settings/settings.routes';
import { usersRouter } from './modules/users/users.routes';
import { buildOpenApiDocument } from './openapi/registry';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function sessionConfig(env: Env): SessionConfig {
  return {
    idleMinutes: env.SESSION_IDLE_MINUTES,
    absoluteHours: env.SESSION_ABSOLUTE_HOURS,
    secureCookie: env.NODE_ENV === 'production',
  };
}

export function createApp(env: Env, logger: Logger = createLogger(env)) {
  const app = express();
  const sessions = sessionConfig(env);
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
  app.use(cookieParser());
  app.use('/api', createRateLimiter({ windowMs: 60_000, limit: 300 }));

  if (env.API_DOCS_ENABLED) {
    const document = buildOpenApiDocument();
    app.get('/api/openapi.json', (_req, res) => {
      res.json(document);
    });
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(document));
  }

  // Unauthenticated system endpoints.
  app.use('/api/v1', healthRouter);

  // Staff API: origin check → session → CSRF, then module routers enforce permissions per route.
  app.use('/api/v1', originCheck(env.CORS_ORIGINS), loadSession(sessions), csrfProtection);
  app.use('/api/v1', authRouter(sessions, env.LOGIN_RATE_LIMIT));
  app.use('/api/v1', usersRouter);
  app.use('/api/v1', rolesRouter);
  app.use('/api/v1', settingsRouter);
  app.use('/api/v1', auditRouter);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
