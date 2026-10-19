import type { IncomingMessage, ServerResponse } from 'node:http';
import { waitUntil } from '@vercel/functions';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { runDueJobs } from './jobs';
import { createLogger } from './lib/logger';

/**
 * Entry point on Vercel (serverless functions): the same Express app, with no timers. Background jobs are started by
 * incoming requests instead — at most once a minute per function instance, finishing after the response via
 * `waitUntil` — and by the daily Vercel Cron call to /api/v1/internal/cron. `runScheduledJob` keeps each job to once
 * per interval however many instances are running.
 */
const env = loadEnv();
const logger = createLogger(env);
const app = createApp(env, logger);

const CHECK_EVERY_MS = 60_000;
let lastCheck = 0;

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const now = Date.now();
  if (now - lastCheck >= CHECK_EVERY_MS) {
    lastCheck = now;
    waitUntil(runDueJobs(logger));
  }
  return app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
