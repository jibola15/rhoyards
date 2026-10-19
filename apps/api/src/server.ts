import 'dotenv/config';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { createLogger } from './lib/logger';
import { disconnectPrisma } from './lib/prisma';
import { runMaintenance } from './lib/maintenance';
import { releaseExpiredReservations } from './modules/orders/orders.service';

const env = loadEnv();
const logger = createLogger(env);
const app = createApp(env, logger);

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
  if (env.NODE_ENV === 'production' && env.TRUST_PROXY === 0) {
    logger.warn('TRUST_PROXY is 0: behind a reverse proxy every client shares the proxy IP for rate limits and audit logs. Set it to the number of proxies in front of the API.');
  }
});

// Unpaid online orders hold stock only until their deadline; free it once a minute.
const releaseJob = setInterval(() => {
  releaseExpiredReservations()
    .then((n) => n > 0 && logger.info({ released: n }, 'Released expired order reservations'))
    .catch((err: unknown) => logger.error({ err }, 'Releasing expired reservations failed'));
}, 60_000);
releaseJob.unref();

// Hourly housekeeping (expired sessions and idempotency keys).
const maintenanceJob = setInterval(() => {
  runMaintenance()
    .then((r) => logger.info(r, 'Maintenance done'))
    .catch((err: unknown) => logger.error({ err }, 'Maintenance failed'));
}, 3_600_000);
maintenanceJob.unref();

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  server.close((err) => {
    if (err) logger.error({ err }, 'Error during shutdown');
    void disconnectPrisma().finally(() => process.exit(err ? 1 : 0));
  });
  // Force-exit if connections do not drain in time.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
