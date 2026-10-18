import type { AuthSession, ChangePasswordInput, LoginInput } from '@rhoyards/shared';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { businessRule, unauthenticated } from '../../lib/errors';
import { getPrisma, transaction } from '../../lib/prisma';
import type { AuthContext, SessionConfig } from './auth.types';
import { authUserInclude, effectivePermissions, toAuthUser } from './auth-user';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password';
import { createStaffSession, revokeSession, revokeUserSessions, type NewSession } from './session.service';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
const INVALID_LOGIN = 'Invalid email or password, or the account is temporarily locked';

interface LoginMeta extends RequestContext {
  userAgent?: string;
}

export async function login(
  input: LoginInput,
  meta: LoginMeta,
  cfg: SessionConfig,
): Promise<{ session: NewSession; auth: AuthSession }> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { email: input.email }, include: authUserInclude });
  const now = new Date();

  if (!user) {
    await verifyAgainstDummy(input.password);
    await writeAudit(prisma, meta, { action: 'auth.login_failed', entityType: 'user', after: { email: input.email } });
    throw unauthenticated(INVALID_LOGIN);
  }

  if (user.lockedUntil && user.lockedUntil > now) {
    await verifyAgainstDummy(input.password);
    await writeAudit(prisma, meta, { action: 'auth.login_locked', entityType: 'user', entityId: user.id });
    throw unauthenticated(INVALID_LOGIN);
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);
  if (!passwordOk || user.status !== 'ACTIVE') {
    if (!passwordOk) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await prisma.user.update({
        where: { id: user.id },
        data: lock
          ? { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MINUTES * 60_000) }
          : { failedLoginCount: failed },
      });
    }
    await writeAudit(prisma, meta, {
      action: passwordOk ? 'auth.login_disabled' : 'auth.login_failed',
      entityType: 'user',
      entityId: user.id,
    });
    throw unauthenticated(INVALID_LOGIN);
  }

  const session = await transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: now, failedLoginCount: 0, lockedUntil: null },
    });
    const created = await createStaffSession(tx, user.id, { ...meta }, cfg);
    await writeAudit(tx, { ...meta, actorId: user.id }, { action: 'auth.login', entityType: 'user', entityId: user.id });
    return created;
  });

  const permissions = effectivePermissions(user);
  return {
    session,
    auth: {
      user: toAuthUser(user, permissions),
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    },
  };
}

export async function logout(auth: AuthContext, ctx: RequestContext): Promise<void> {
  await transaction(async (tx) => {
    await revokeSession(tx, auth.sessionId);
    await writeAudit(tx, ctx, { action: 'auth.logout', entityType: 'user', entityId: auth.user.id });
  });
}

/** Changes the caller's password and signs out their other sessions. */
export async function changePassword(auth: AuthContext, input: ChangePasswordInput, ctx: RequestContext) {
  const prisma = getPrisma();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw businessRule('Current password is incorrect');
  }
  const passwordHash = await hashPassword(input.newPassword);
  await transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
    });
    await revokeUserSessions(tx, user.id, auth.sessionId);
    await writeAudit(tx, ctx, { action: 'auth.password_changed', entityType: 'user', entityId: user.id });
  });
}

export function sessionPayload(auth: AuthContext): AuthSession {
  return { user: auth.user, csrfToken: auth.csrfToken, expiresAt: auth.expiresAt.toISOString() };
}
