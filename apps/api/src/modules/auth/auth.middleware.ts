import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { ErrorCode, type Permission } from '@rhoyards/shared';
import { AppError, forbidden, unauthenticated } from '../../lib/errors';
import { getPrisma } from '../../lib/prisma';
import type { SessionConfig } from './auth.types';
import { authUserInclude, effectivePermissions, toAuthUser } from './auth-user';
import { hashToken, idleExpiry, sessionCookieName } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Avoid a write on every request: extend the idle window at most once a minute. */
const TOUCH_INTERVAL_MS = 60_000;

/** Resolves the session cookie into `req.auth`. Invalid or expired sessions are treated as anonymous. */
export function loadSession(cfg: SessionConfig): RequestHandler {
  const cookieName = sessionCookieName(cfg);
  return async (req, res, next) => {
    const token: unknown = req.cookies?.[cookieName];
    if (typeof token !== 'string' || token.length === 0 || token.length > 200) {
      next();
      return;
    }

    const prisma = getPrisma();
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { include: authUserInclude } },
    });
    const now = new Date();
    const valid =
      session &&
      session.realm === 'STAFF' &&
      !session.revokedAt &&
      session.expiresAt > now &&
      session.idleExpiresAt > now &&
      session.user?.status === 'ACTIVE';

    if (!valid || !session.user) {
      res.clearCookie(cookieName, { path: '/' });
      next();
      return;
    }

    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: now, idleExpiresAt: idleExpiry(now, session.expiresAt, cfg) },
      });
    }

    const permissions = effectivePermissions(session.user);
    req.auth = {
      sessionId: session.id,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      user: toAuthUser(session.user, permissions),
      permissions,
    };
    next();
  };
}

interface RequireAuthOptions {
  /** Routes a user may reach while a password change is pending (me, logout, change-password). */
  allowPendingPasswordChange?: boolean;
}

export function requireAuth(options: RequireAuthOptions = {}): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw unauthenticated();
    if (req.auth.user.mustChangePassword && !options.allowPendingPasswordChange) {
      throw new AppError(403, ErrorCode.PASSWORD_CHANGE_REQUIRED, 'You must change your password before continuing');
    }
    next();
  };
}

/** Requires an authenticated user holding every listed permission. Enforced server-side for every protected route. */
export function requirePermission(...required: Permission[]): RequestHandler[] {
  return [
    requireAuth(),
    (req, _res, next) => {
      const missing = required.filter((p) => !req.auth!.permissions.has(p));
      if (missing.length > 0) throw forbidden();
      next();
    },
  ];
}

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Synchronizer-token CSRF check for authenticated state-changing requests. */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method) || !req.auth) {
    next();
    return;
  }
  const header = req.get('x-csrf-token');
  if (!header || !tokensMatch(header, req.auth.csrfToken)) {
    throw new AppError(403, ErrorCode.CSRF_INVALID, 'Missing or invalid CSRF token');
  }
  next();
};

/** Rejects cross-site state-changing requests that announce a foreign Origin (defence in depth, incl. login CSRF). */
export function originCheck(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    const origin = req.get('origin');
    if (SAFE_METHODS.has(req.method) || !origin) {
      next();
      return;
    }
    const sameOrigin = origin === `${req.protocol}://${req.get('host')}`;
    if (!sameOrigin && !allowed.has(origin)) throw forbidden('Cross-origin request rejected');
    next();
  };
}
