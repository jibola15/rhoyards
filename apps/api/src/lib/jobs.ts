import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { getPrisma } from './prisma';

/** Identifies this process in `scheduled_jobs.run_by`. */
export const INSTANCE_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Timers drift; a run this close to the interval still counts as due. */
const DUE_TOLERANCE = 0.9;

export type JobOutcome<T> = { ran: true; result: T } | { ran: false; reason: 'locked' | 'not-due' };

/**
 * Runs a background job at most once per interval across every API instance.
 *
 * A transaction-scoped advisory lock (released at commit; safe behind a connection pooler) admits one instance at a
 * time; the `scheduled_jobs` row then says whether the job already ran this interval. Every instance can run the
 * same timers: whichever gets there first does the work, the others skip.
 */
export async function runScheduledJob<T>(
  name: string,
  intervalMs: number,
  job: () => Promise<T>,
  now: () => Date = () => new Date(),
): Promise<JobOutcome<T>> {
  const prisma = getPrisma();
  const outcome = await prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<[{ locked: boolean }]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${`rhoyards-job:${name}`})) AS "locked"`;
      if (!lock.locked) return { ran: false, reason: 'locked' } as const;

      const startedAt = now();
      const last = await tx.scheduledJob.findUnique({ where: { name } });
      if (last?.lastStartedAt && startedAt.getTime() - last.lastStartedAt.getTime() < intervalMs * DUE_TOLERANCE) {
        return { ran: false, reason: 'not-due' } as const;
      }

      let status = 'ok';
      let error: string | null = null;
      let result: T | undefined;
      try {
        result = await job();
      } catch (err) {
        status = 'failed';
        error = err instanceof Error ? err.message.slice(0, 1000) : String(err);
      }
      const record = { lastStartedAt: startedAt, lastFinishedAt: now(), lastStatus: status, lastError: error, runBy: INSTANCE_ID };
      await tx.scheduledJob.upsert({ where: { name }, create: { name, ...record }, update: record });
      return error === null ? ({ ran: true, result: result as T } as const) : ({ failed: error } as const);
    },
    { maxWait: 10_000, timeout: Math.max(intervalMs, 120_000) },
  );
  // A failed run is recorded first (so other instances do not retry at once), then reported to the caller's log.
  if ('failed' in outcome) throw new Error(`Job ${name} failed: ${outcome.failed}`);
  return outcome;
}
