import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Logger } from 'pino';
import { runScheduledJob } from './lib/jobs';
import { runMaintenance } from './lib/maintenance';
import { forbidden } from './lib/errors';
import { registry } from './openapi/registry';
import { releaseExpiredReservations } from './modules/orders/orders.service';

/**
 * The background jobs. Wherever they are triggered from — the long-running server's timers, incoming requests on a
 * serverless host, or a cron call — `runScheduledJob` makes each run at most once per interval across all instances.
 */
export const SCHEDULED_JOBS: { name: string; intervalMs: number; run: () => Promise<unknown> }[] = [
  // Unpaid online orders hold stock only until their deadline.
  { name: 'release-expired-reservations', intervalMs: 60_000, run: releaseExpiredReservations },
  // Expired sessions, idempotency keys, sign-in challenges, reset links, rate-limit counters.
  { name: 'maintenance', intervalMs: 3_600_000, run: runMaintenance },
];

/** Runs every job that is due; failures are logged, not thrown, so one job cannot stop the others. */
export async function runDueJobs(logger: Logger): Promise<Record<string, string>> {
  const outcomes: Record<string, string> = {};
  for (const job of SCHEDULED_JOBS) {
    try {
      const outcome = await runScheduledJob(job.name, job.intervalMs, job.run);
      outcomes[job.name] = outcome.ran ? 'ran' : outcome.reason;
      if (outcome.ran) logger.info({ job: job.name, result: outcome.result }, 'Background job done');
    } catch (err) {
      outcomes[job.name] = 'failed';
      logger.error({ err, job: job.name }, 'Background job failed');
    }
  }
  return outcomes;
}

registry.registerPath({
  method: 'get',
  path: '/internal/cron',
  tags: ['System'],
  summary: 'Run background jobs that are due (for Vercel Cron or another scheduler). Requires `Authorization: Bearer <CRON_SECRET>`.',
  responses: { 200: { description: 'What each job did' }, 403: { description: 'Wrong or missing secret' } },
});

/** Mounted only when CRON_SECRET is set. */
export function cronRouter(secret: string, logger: Logger) {
  const router = Router();
  const expected = Buffer.from(`Bearer ${secret}`);
  router.get('/internal/cron', async (req, res) => {
    const given = Buffer.from(req.get('authorization') ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw forbidden();
    res.json({ data: await runDueJobs(logger) });
  });
  return router;
}
