import 'dotenv/config';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { createLogger } from './lib/logger';
import { disconnectPrisma } from './lib/prisma';
import { INSTANCE_ID, runScheduledJob } from './lib/jobs';
import { runMaintenance, type MaintenanceResult } from './lib/maintenance';
import { releaseExpiredReservations } from './modules/orders/orders.service';

const env = loadEnv();
const logger = createLogger(env);
const app = createApp(env, logger);

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV, instance: INSTANCE_ID }, 'API listening');
  if (env.NODE_ENV === 'production' && env.TRUST_PROXY === 0) {
    logger.warn('TRUST_PROXY is 0: behind a reverse proxy every client shares the proxy IP for rate limits and audit logs. Set it to the number of proxies in front of the API.');
  }
});

// Background jobs. Every instance runs the same timers; runScheduledJob lets only one of them do each run, so any
// number of API instances can sit behind a load balancer.
function schedule(name: string, intervalMs: number, checkEveryMs: number, job: () => Promise<unknown>, done: (result: never) => void) {
  const timer = setInterval(() => {
    runScheduledJob(name, intervalMs, job)
      .then((outcome) => outcome.ran && done(outcome.result as never))
      .catch((err: unknown) => logger.error({ err, job: name }, 'Background job failed'));
  }, checkEveryMs);
  timer.unref();
}

// Unpaid online orders hold stock only until their deadline; free it once a minute.
schedule('release-expired-reservations', 60_000, 60_000, releaseExpiredReservations, (n: number) => {
  if (n > 0) logger.info({ released: n }, 'Released expired order reservations');
});
// Hourly housekeeping (expired sessions, idempotency keys, sign-in challenges, reset links, rate-limit counters).
schedule('maintenance', 3_600_000, 5 * 60_000, runMaintenance, (r: MaintenanceResult) => logger.info(r, 'Maintenance done'));

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
