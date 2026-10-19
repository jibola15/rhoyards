import type { AuthSession, ChangePasswordInput, LoginInput, LoginStep } from '@rhoyards/shared';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { businessRule, unauthenticated } from '../../lib/errors';
import { getPrisma, transaction } from '../../lib/prisma';
import type { AuthConfig, AuthContext } from './auth.types';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password';
import { revokeSession, revokeUserSessions } from './session.service';
import { countFailedAttempt, startSignInChallenge } from './two-factor.service';

export { LOCKOUT_MINUTES, MAX_FAILED_LOGINS } from './two-factor.service';
export const INVALID_LOGIN = 'Invalid email, username or password, or the account is temporarily locked';

interface LoginMeta extends RequestContext {
  userAgent?: string;
}

/** Staff sign in with their email or their username; usernames never contain "@". */
export const identifierWhere = (identifier: string) => (identifier.includes('@') ? { email: identifier } : { username: identifier });

/**
 * First step of staff sign-in: checks the password. On success no session is created yet — the result says which
 * second step (authenticator code, or setting one up) completes the sign-in.
 */
export async function login(input: LoginInput, meta: LoginMeta, cfg: AuthConfig): Promise<LoginStep> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: identifierWhere(input.identifier) });
  const now = new Date();

  if (!user) {
    await verifyAgainstDummy(input.password);
    await writeAudit(prisma, meta, { action: 'auth.login_failed', entityType: 'user', after: { identifier: input.identifier } });
    throw unauthenticated(INVALID_LOGIN);
  }

  if (user.lockedUntil && user.lockedUntil > now) {
    await verifyAgainstDummy(input.password);
    await writeAudit(prisma, meta, { action: 'auth.login_locked', entityType: 'user', entityId: user.id });
    throw unauthenticated(INVALID_LOGIN);
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);
  if (!passwordOk || user.status !== 'ACTIVE') {
    if (!passwordOk) await countFailedAttempt(user.id, now);
    await writeAudit(prisma, meta, {
      action: passwordOk ? 'auth.login_disabled' : 'auth.login_failed',
      entityType: 'user',
      entityId: user.id,
    });
    throw unauthenticated(INVALID_LOGIN);
  }

  // The failure count is cleared only once the second factor succeeds, so codes cannot be guessed by re-entering
  // the password between attempts.
  return startSignInChallenge(user, meta, cfg);
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
