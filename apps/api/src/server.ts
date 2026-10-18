import 'dotenv/config';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { createLogger } from './lib/logger';
import { disconnectPrisma } from './lib/prisma';

const env = loadEnv();
const logger = createLogger(env);
const app = createApp(env, logger);

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
});

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
