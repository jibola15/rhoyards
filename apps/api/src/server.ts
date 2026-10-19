import 'dotenv/config';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { createLogger } from './lib/logger';
import { disconnectPrisma } from './lib/prisma';
import { releaseExpiredReservations } from './modules/orders/orders.service';

const env = loadEnv();
const logger = createLogger(env);
const app = createApp(env, logger);

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
});

// Unpaid online orders hold stock only until their deadline; free it once a minute.
const releaseJob = setInterval(() => {
  releaseExpiredReservations()
    .then((n) => n > 0 && logger.info({ released: n }, 'Released expired order reservations'))
    .catch((err: unknown) => logger.error({ err }, 'Releasing expired reservations failed'));
}, 60_000);
releaseJob.unref();

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
