import 'dotenv/config';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { createLogger } from './lib/logger';
import { disconnectPrisma } from './lib/prisma';
import { runDueJobs } from './jobs';
import { INSTANCE_ID } from './lib/jobs';

const env = loadEnv();
const logger = createLogger(env);
const app = createApp(env, logger);

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV, instance: INSTANCE_ID }, 'API listening');
  if (env.NODE_ENV === 'production' && env.TRUST_PROXY === 0) {
    logger.warn('TRUST_PROXY is 0: behind a reverse proxy every client shares the proxy IP for rate limits and audit logs. Set it to the number of proxies in front of the API.');
  }
});

// Background jobs: check every minute. Every instance runs the same timer; runScheduledJob lets only one of them do
// each run, so any number of API instances can sit behind a load balancer.
const jobsTimer = setInterval(() => void runDueJobs(logger), 60_000);
jobsTimer.unref();

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
