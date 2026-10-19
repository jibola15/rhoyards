import { getPrisma } from './prisma';

const DAY = 86_400_000;

export interface MaintenanceResult {
  sessions: number;
  idempotencyKeys: number;
  loginChallenges: number;
  passwordResetTokens: number;
  rateLimits: number;
}

/**
 * Housekeeping: deletes sessions that ended more than 30 days ago (kept a while for audit/support), idempotency keys
 * past their expiry, finished or expired sign-in challenges and reset links, and expired rate-limit counters.
 * Nothing here touches business records.
 */
export async function runMaintenance(now = new Date()): Promise<MaintenanceResult> {
  const prisma = getPrisma();
  const cutoff = new Date(now.getTime() - 30 * DAY);
  const dayAgo = new Date(now.getTime() - DAY);
  const [sessions, keys, challenges, resets, limits] = await Promise.all([
    prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }, { idleExpiresAt: { lt: cutoff } }] } }),
    prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.loginChallenge.deleteMany({ where: { expiresAt: { lt: dayAgo } } }),
    prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: dayAgo } } }),
    prisma.rateLimitBucket.deleteMany({ where: { resetAt: { lt: now } } }),
  ]);
  return {
    sessions: sessions.count,
    idempotencyKeys: keys.count,
    loginChallenges: challenges.count,
    passwordResetTokens: resets.count,
    rateLimits: limits.count,
  };
}
