import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Env } from './config/env';
import { setBusinessTimeZone } from './lib/business-date';
import { createLogger } from './lib/logger';
import { createMailer, type Mailer } from './lib/mailer';
import { LocalDiskStorage, type FileStorage } from './lib/storage';
import { accountingRouter } from './modules/accounting/accounting.routes';
import { ordersRouter } from './modules/orders/orders.routes';
import { bankingRouter } from './modules/banking/banking.routes';
import { expensesRouter } from './modules/expenses/expenses.routes';
import { returnsRouter } from './modules/returns/returns.routes';
import { reportingRouter } from './modules/reporting/reporting.routes';
import { webhooksRouter } from './modules/payments/webhooks';
import { storeRouter } from './modules/store/store.routes';
import { catalogRouter } from './modules/catalog/catalog.routes';
import { filesRouter } from './modules/files/files.routes';
import { inventoryRouter } from './modules/inventory/inventory.routes';
import { customersRouter } from './modules/customers/customers.routes';
import { posRouter } from './modules/pos/pos.routes';
import { purchasingRouter } from './modules/purchasing/purchasing.routes';
import { suppliersRouter } from './modules/suppliers/suppliers.routes';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { createRateLimiter } from './middleware/rate-limit';
import { auditRouter } from './modules/audit/audit.routes';
import { csrfProtection, loadSession, originCheck } from './modules/auth/auth.middleware';
import { authRouter } from './modules/auth/auth.routes';
import type { AuthConfig, SessionConfig } from './modules/auth/auth.types';
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

export function authConfig(env: Env): AuthConfig {
  return {
    session: sessionConfig(env),
    twoFactorKey: env.TWO_FACTOR_KEY,
    issuer: 'Rhoyards',
    backofficeUrl: env.BACKOFFICE_URL,
    storefrontUrl: env.STOREFRONT_URL,
  };
}

export function createApp(
  env: Env,
  logger: Logger = createLogger(env),
  storage: FileStorage = new LocalDiskStorage(env.UPLOAD_DIR),
  mailer: Mailer = createMailer(env, logger),
) {
  const app = express();
  const auth = authConfig(env);
  const sessions = auth.session;
  setBusinessTimeZone(env.BUSINESS_TIMEZONE);
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
  // The API only ever serves JSON and files: nothing it returns may load or run anything. The (development-only)
  // Swagger UI is the one HTML page and keeps helmet's default policy.
  const strictHeaders = helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
  });
  const docsHeaders = helmet();
  app.use((req, res, next) => (req.path.startsWith('/api/docs') ? docsHeaders : strictHeaders)(req, res, next));
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
  app.use(
    express.json({
      limit: '1mb',
      // Webhook signatures are computed over the exact bytes received.
      verify: (req, _res, buf) => {
        if (req.url?.startsWith('/api/v1/webhooks/')) (req as express.Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(cookieParser());
  app.use('/api', createRateLimiter({ name: 'api', windowMs: 60_000, limit: 300, shared: env.RATE_LIMIT_STORE === 'database' }));

  if (env.API_DOCS_ENABLED) {
    const document = buildOpenApiDocument();
    app.get('/api/openapi.json', (_req, res) => {
      res.json(document);
    });
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(document));
  }

  // Unauthenticated system endpoints.
  app.use('/api/v1', healthRouter);
  // Payment providers call these server-to-server; they authenticate by signature, not session.
  app.use('/api/v1', webhooksRouter(env));
  // The public storefront has its own customer sessions and CSRF, so it is mounted before the staff middleware.
  app.use('/api/v1/store', originCheck(env.CORS_ORIGINS), storeRouter(env, auth, mailer));

  // Staff API: origin check → session → CSRF, then module routers enforce permissions per route.
  app.use('/api/v1', originCheck(env.CORS_ORIGINS), loadSession(sessions), csrfProtection);
  app.use('/api/v1', authRouter(auth, env, mailer));
  app.use('/api/v1', usersRouter);
  app.use('/api/v1', rolesRouter);
  app.use('/api/v1', settingsRouter);
  app.use('/api/v1', auditRouter);
  app.use('/api/v1', filesRouter(storage, env.MAX_UPLOAD_MB));
  app.use('/api/v1', catalogRouter);
  app.use('/api/v1', suppliersRouter);
  app.use('/api/v1', inventoryRouter);
  app.use('/api/v1', purchasingRouter);
  app.use('/api/v1', customersRouter);
  app.use('/api/v1', posRouter);
  app.use('/api/v1', accountingRouter);
  app.use('/api/v1', ordersRouter(env));
  app.use('/api/v1', returnsRouter);
  app.use('/api/v1', expensesRouter);
  app.use('/api/v1', bankingRouter);
  app.use('/api/v1', reportingRouter);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
