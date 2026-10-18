import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions } from 'express';
import type { Db } from '../../lib/prisma';
import type { SessionConfig } from './auth.types';

/** `__Host-` cookies must be Secure with Path=/ and no Domain, which pins them to this exact origin. */
export function sessionCookieName(cfg: SessionConfig): string {
  return cfg.secureCookie ? '__Host-rh_sid' : 'rh_sid';
}

export function sessionCookieOptions(cfg: SessionConfig, expiresAt: Date): CookieOptions {
  return { httpOnly: true, secure: cfg.secureCookie, sameSite: 'lax', path: '/', expires: expiresAt };
}

/** Only the SHA-256 of the session token is stored, so a database leak does not expose live sessions. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const minutes = (n: number) => n * 60_000;

export function idleExpiry(now: Date, absolute: Date, cfg: SessionConfig): Date {
  return new Date(Math.min(now.getTime() + minutes(cfg.idleMinutes), absolute.getTime()));
}

export interface NewSession {
  id: string;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createStaffSession(
  db: Db,
  userId: string,
  meta: { ip?: string; userAgent?: string },
  cfg: SessionConfig,
): Promise<NewSession> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + cfg.absoluteHours * 3_600_000);
  const session = await db.session.create({
    data: {
      tokenHash: hashToken(token),
      realm: 'STAFF',
      userId,
      csrfToken,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      idleExpiresAt: idleExpiry(now, expiresAt, cfg),
      expiresAt,
    },
  });
  return { id: session.id, token, csrfToken, expiresAt };
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Revokes every live session of a user, optionally keeping the current one. */
export async function revokeUserSessions(db: Db, userId: string, exceptSessionId?: string): Promise<number> {
  const result = await db.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return result.count;
}
