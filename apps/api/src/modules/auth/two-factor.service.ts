import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { LoginChallengeKind } from '@prisma/client';
import { ErrorCode, type AuthenticatorChange, type AuthSession, type LoginStep } from '@rhoyards/shared';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, businessRule } from '../../lib/errors';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { decryptSecret, encryptSecret } from '../../lib/secret-box';
import type { AuthConfig, AuthContext } from './auth.types';
import { authUserInclude, effectivePermissions, toAuthUser, type UserWithAuth } from './auth-user';
import { verifyPassword } from './password';
import { createStaffSession, hashToken, revokeUserSessions, type NewSession } from './session.service';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp';

/**
 * Two-factor sign-in for staff (authenticator app + one-time backup codes). It is required: a correct password only
 * opens a short-lived challenge, and the session is created once the second factor checks out. Someone who has not
 * set up an app yet does so as part of their first sign-in.
 */

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
/** Codes that may be tried against one challenge (the account lockout also counts them). */
export const MAX_CODE_ATTEMPTS = 5;
const CHALLENGE_MINUTES = 10;
const SETUP_MINUTES = 15;
export const BACKUP_CODE_COUNT = 10;
/** No look-alike characters (0/o, 1/l/i). */
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const RESTART = 'This sign-in has expired. Please sign in again.';
const WRONG_CODE = 'That code is not right. Check your authenticator app and try again.';

type Meta = RequestContext & { userAgent?: string };

/** 401 that tells the client to go back to the password step. */
const restart = () => new AppError(401, ErrorCode.UNAUTHENTICATED, RESTART, { restart: true });
const wrongCode = () => new AppError(401, ErrorCode.UNAUTHENTICATED, WRONG_CODE);

const minutesFrom = (now: Date, n: number) => new Date(now.getTime() + n * 60_000);

export const hashBackupCode = (code: string) => createHash('sha256').update(code.replace(/[\s-]/g, '').toLowerCase()).digest('hex');

/** Ten fresh codes, shown once as `xxxxx-xxxxx`. */
export function generateBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const chars = Array.from({ length: 10 }, () => BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

async function replaceBackupCodes(db: Db, userId: string): Promise<string[]> {
  const codes = generateBackupCodes();
  await db.userBackupCode.deleteMany({ where: { userId } });
  await db.userBackupCode.createMany({ data: codes.map((c) => ({ userId, codeHash: hashBackupCode(c) })) });
  return codes;
}

/** Counts a failed password or code toward the account lockout (atomically, so parallel guesses all count). */
export async function countFailedAttempt(userId: string, now: Date): Promise<void> {
  const prisma = getPrisma();
  const { failedLoginCount } = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  if (failedLoginCount >= MAX_FAILED_LOGINS) {
    await prisma.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: minutesFrom(now, LOCKOUT_MINUTES) } });
  }
}

async function createChallenge(userId: string, kind: LoginChallengeKind, meta: Meta, pendingSecretEnc: string | null, minutes: number) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = minutesFrom(new Date(), minutes);
  await getPrisma().loginChallenge.create({
    data: { tokenHash: hashToken(token), userId, kind, pendingSecretEnc, ip: meta.ip ?? null, expiresAt },
  });
  return { challengeToken: token, expiresAt: expiresAt.toISOString() };
}

function newSetup(email: string, cfg: AuthConfig) {
  const secret = generateTotpSecret();
  return { secret, sealed: encryptSecret(secret, cfg.twoFactorKey), setup: { secret, otpauthUri: otpauthUri(secret, email, cfg.issuer) } };
}

/** Called once the password is right: what the user must do next. */
export async function startSignInChallenge(
  user: { id: string; email: string; totpEnabledAt: Date | null },
  meta: Meta,
  cfg: AuthConfig,
): Promise<LoginStep> {
  if (user.totpEnabledAt) {
    return { next: 'TWO_FACTOR', ...(await createChallenge(user.id, 'TWO_FACTOR', meta, null, CHALLENGE_MINUTES)) };
  }
  const { sealed, setup } = newSetup(user.email, cfg);
  return { next: 'TWO_FACTOR_SETUP', ...(await createChallenge(user.id, 'TWO_FACTOR_SETUP', meta, sealed, SETUP_MINUTES)), setup };
}

/**
 * Loads a live challenge and reserves one attempt on it before any code is checked, so parallel requests cannot
 * exceed the attempt budget.
 */
async function openChallenge(token: string, kinds: LoginChallengeKind[], now: Date) {
  const prisma = getPrisma();
  const challenge = await prisma.loginChallenge.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: authUserInclude } },
  });
  if (!challenge || !kinds.includes(challenge.kind) || challenge.consumedAt || challenge.expiresAt <= now) throw restart();
  const { user } = challenge;
  if (user.status !== 'ACTIVE' || (user.lockedUntil && user.lockedUntil > now)) throw restart();
  const reserved = await prisma.loginChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null, attempts: { lt: MAX_CODE_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (reserved.count === 0) throw restart();
  return challenge;
}

type Factor = { method: 'totp'; step: number } | { method: 'backup_code'; codeId: string };

/** Checks an authenticator code or an unused backup code. Nothing is marked used here. */
async function checkSecondFactor(user: UserWithAuth, code: string, now: Date, cfg: AuthConfig): Promise<Factor | null> {
  if (/^\d{6}$/.test(code)) {
    if (!user.totpSecretEnc) return null;
    const step = verifyTotp(decryptSecret(user.totpSecretEnc, cfg.twoFactorKey), code, now, user.totpLastStep);
    return step === null ? null : { method: 'totp', step };
  }
  const row = await getPrisma().userBackupCode.findFirst({
    where: { userId: user.id, codeHash: hashBackupCode(code), usedAt: null },
    select: { id: true },
  });
  return row ? { method: 'backup_code', codeId: row.id } : null;
}

/** Marks the factor used inside the caller's transaction; false if a parallel request used it first. */
async function consumeFactor(tx: Db, userId: string, factor: Factor, now: Date): Promise<boolean> {
  if (factor.method === 'totp') {
    const res = await tx.user.updateMany({
      where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: factor.step } }] },
      data: { totpLastStep: factor.step },
    });
    return res.count === 1;
  }
  const res = await tx.userBackupCode.updateMany({ where: { id: factor.codeId, usedAt: null }, data: { usedAt: now } });
  return res.count === 1;
}

async function consumeChallenge(tx: Db, id: string, now: Date) {
  const res = await tx.loginChallenge.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: now } });
  if (res.count !== 1) throw restart();
}

async function failCode(user: UserWithAuth, meta: Meta, now: Date, action = 'auth.two_factor_failed'): Promise<never> {
  await countFailedAttempt(user.id, now);
  await writeAudit(getPrisma(), { ...meta, actorId: user.id }, { action, entityType: 'user', entityId: user.id });
  throw wrongCode();
}

function sessionResult(user: UserWithAuth, session: NewSession): AuthSession {
  return { user: toAuthUser(user, effectivePermissions(user)), csrfToken: session.csrfToken, expiresAt: session.expiresAt.toISOString() };
}

const signedInData = (now: Date) => ({ lastLoginAt: now, failedLoginCount: 0, lockedUntil: null });

/** Second step of sign-in: an authenticator or backup code. Creates the session. */
export async function completeTwoFactorSignIn(
  input: { challengeToken: string; code: string },
  meta: Meta,
  cfg: AuthConfig,
): Promise<{ session: NewSession; auth: AuthSession }> {
  const now = new Date();
  const challenge = await openChallenge(input.challengeToken, ['TWO_FACTOR'], now);
  const { user } = challenge;
  const factor = await checkSecondFactor(user, input.code, now, cfg);
  if (!factor) return failCode(user, meta, now);

  const session = await transaction(async (tx) => {
    await consumeChallenge(tx, challenge.id, now);
    if (!(await consumeFactor(tx, user.id, factor, now))) throw wrongCode();
    await tx.user.update({ where: { id: user.id }, data: signedInData(now) });
    const created = await createStaffSession(tx, user.id, meta, cfg.session);
    const remaining = factor.method === 'backup_code' ? await tx.userBackupCode.count({ where: { userId: user.id, usedAt: null } }) : undefined;
    await writeAudit(tx, { ...meta, actorId: user.id }, {
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      after: { method: factor.method, ...(remaining === undefined ? {} : { backupCodesLeft: remaining }) },
    });
    return created;
  });
  return { session, auth: sessionResult(user, session) };
}

/** First sign-in: proves the new authenticator works, turns two-factor on, and returns the backup codes (once). */
export async function completeTwoFactorSetup(
  input: { challengeToken: string; code: string },
  meta: Meta,
  cfg: AuthConfig,
): Promise<{ session: NewSession; auth: AuthSession & { backupCodes: string[] } }> {
  const now = new Date();
  const challenge = await openChallenge(input.challengeToken, ['TWO_FACTOR_SETUP'], now);
  const { user } = challenge;
  const sealed = challenge.pendingSecretEnc!;
  const step = verifyTotp(decryptSecret(sealed, cfg.twoFactorKey), input.code, now, null);
  // The person holding this challenge already knows the secret: a wrong code here is a typo, not a guess.
  if (step === null) throw wrongCode();

  const { session, backupCodes } = await transaction(async (tx) => {
    await consumeChallenge(tx, challenge.id, now);
    const enabled = await tx.user.updateMany({
      where: { id: user.id, totpEnabledAt: null },
      data: { totpSecretEnc: sealed, totpEnabledAt: now, totpLastStep: step, ...signedInData(now) },
    });
    if (enabled.count !== 1) throw restart(); // set up meanwhile from another sign-in
    const codes = await replaceBackupCodes(tx, user.id);
    const created = await createStaffSession(tx, user.id, meta, cfg.session);
    const ctx = { ...meta, actorId: user.id };
    await writeAudit(tx, ctx, { action: 'auth.two_factor_enabled', entityType: 'user', entityId: user.id });
    await writeAudit(tx, ctx, { action: 'auth.login', entityType: 'user', entityId: user.id, after: { method: 'totp' } });
    return { session: created, backupCodes: codes };
  });
  return { session, auth: { ...sessionResult(user, session), backupCodes } };
}

// ── Signed-in self-service ────────────────────────────────────────────────

export async function twoFactorStatus(userId: string) {
  const prisma = getPrisma();
  const [user, backupCodesLeft] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { totpEnabledAt: true } }),
    prisma.userBackupCode.count({ where: { userId, usedAt: null } }),
  ]);
  return { enabledAt: user.totpEnabledAt?.toISOString() ?? null, backupCodesLeft };
}

/** New backup codes (the old ones stop working). Needs a current code, so a stolen session alone cannot do it. */
export async function regenerateBackupCodes(auth: AuthContext, code: string, ctx: RequestContext, cfg: AuthConfig): Promise<string[]> {
  const now = new Date();
  const user = await getPrisma().user.findUniqueOrThrow({ where: { id: auth.user.id }, include: authUserInclude });
  const factor = await checkSecondFactor(user, code, now, cfg);
  if (!factor) {
    await writeAudit(getPrisma(), ctx, { action: 'auth.two_factor_failed', entityType: 'user', entityId: user.id });
    throw businessRule(WRONG_CODE, { field: 'code' });
  }
  return transaction(async (tx) => {
    if (!(await consumeFactor(tx, user.id, factor, now))) throw businessRule(WRONG_CODE, { field: 'code' });
    const codes = await replaceBackupCodes(tx, user.id);
    await writeAudit(tx, ctx, { action: 'auth.backup_codes_regenerated', entityType: 'user', entityId: user.id });
    return codes;
  });
}

/** Moving to a new phone: after the password, returns a new secret to scan. Nothing changes until it is confirmed. */
export async function startAuthenticatorChange(auth: AuthContext, password: string, meta: Meta, cfg: AuthConfig): Promise<AuthenticatorChange> {
  const user = await getPrisma().user.findUniqueOrThrow({ where: { id: auth.user.id } });
  if (!(await verifyPassword(user.passwordHash, password))) throw businessRule('Password is incorrect', { field: 'password' });
  const { sealed, setup } = newSetup(user.email, cfg);
  return { ...(await createChallenge(user.id, 'AUTHENTICATOR_CHANGE', meta, sealed, SETUP_MINUTES)), setup };
}

/** Confirms the new authenticator with a code from it; other sessions are signed out and new backup codes issued. */
export async function confirmAuthenticatorChange(
  auth: AuthContext,
  input: { challengeToken: string; code: string },
  ctx: RequestContext,
  cfg: AuthConfig,
): Promise<string[]> {
  const now = new Date();
  const challenge = await openChallenge(input.challengeToken, ['AUTHENTICATOR_CHANGE'], now);
  if (challenge.userId !== auth.user.id) throw restart();
  const sealed = challenge.pendingSecretEnc!;
  const step = verifyTotp(decryptSecret(sealed, cfg.twoFactorKey), input.code, now, null);
  if (step === null) throw businessRule(WRONG_CODE, { field: 'code' });
  return transaction(async (tx) => {
    await consumeChallenge(tx, challenge.id, now);
    await tx.user.update({ where: { id: auth.user.id }, data: { totpSecretEnc: sealed, totpEnabledAt: now, totpLastStep: step } });
    const codes = await replaceBackupCodes(tx, auth.user.id);
    await revokeUserSessions(tx, auth.user.id, auth.sessionId);
    await writeAudit(tx, ctx, { action: 'auth.authenticator_changed', entityType: 'user', entityId: auth.user.id });
    return codes;
  });
}

/** Administrator action for someone who lost their phone and codes: they set up a new app at their next sign-in. */
export async function clearTwoFactor(tx: Db, userId: string): Promise<void> {
  await tx.user.update({ where: { id: userId }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null } });
  await tx.userBackupCode.deleteMany({ where: { userId } });
  await tx.loginChallenge.deleteMany({ where: { userId } });
  await revokeUserSessions(tx, userId);
}
