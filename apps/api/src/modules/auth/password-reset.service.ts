import { randomBytes } from 'node:crypto';
import type { SessionRealm } from '@prisma/client';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { businessRule } from '../../lib/errors';
import type { MailMessage, Mailer } from '../../lib/mailer';
import { getPrisma, transaction } from '../../lib/prisma';
import { SYSTEM_USER_EMAIL } from '../../lib/system-user';
import { identifierWhere } from './auth.service';
import type { AuthConfig } from './auth.types';
import { hashPassword } from './password';
import { hashToken, revokeUserSessions } from './session.service';

/**
 * "Forgot password" for staff and shoppers: a single-use link, valid for 30 minutes, emailed to the account's address.
 * Only the token's hash is stored. Requests never reveal whether an account exists (the caller answers the same way
 * before any lookup happens). For staff a reset changes only the password: the authenticator app is still needed.
 */

const RESET_MINUTES = 30;
/** More requests than this per account per hour are dropped silently (protects inboxes from being flooded). */
const MAX_REQUESTS_PER_HOUR = 3;
export const INVALID_RESET_LINK = 'This reset link is invalid or has expired. Please request a new one.';

interface Recipient {
  realm: SessionRealm;
  ownerId: string;
  email: string;
  name: string;
}

const owner = (r: Pick<Recipient, 'realm' | 'ownerId'>) => (r.realm === 'STAFF' ? { userId: r.ownerId } : { customerAccountId: r.ownerId });

/** Creates a token and emails the link; no-op when the account has asked too often. */
async function issueResetLink(recipient: Recipient, meta: RequestContext, link: (token: string) => string, mailer: Mailer, audience: string) {
  const prisma = getPrisma();
  const now = new Date();
  const recent = await prisma.passwordResetToken.count({
    where: { ...owner(recipient), createdAt: { gt: new Date(now.getTime() - 3_600_000) } },
  });
  if (recent >= MAX_REQUESTS_PER_HOUR) return;

  const token = randomBytes(32).toString('base64url');
  await transaction(async (tx) => {
    // Only the newest link works. Older ones are kept (marked used) so they still count toward the hourly limit.
    await tx.passwordResetToken.updateMany({ where: { ...owner(recipient), usedAt: null }, data: { usedAt: now } });
    await tx.passwordResetToken.create({
      data: {
        tokenHash: hashToken(token),
        realm: recipient.realm,
        ...owner(recipient),
        ip: meta.ip ?? null,
        expiresAt: new Date(now.getTime() + RESET_MINUTES * 60_000),
      },
    });
    await writeAudit(tx, meta, {
      action: 'auth.password_reset_requested',
      entityType: recipient.realm === 'STAFF' ? 'user' : 'customer_account',
      entityId: recipient.ownerId,
    });
  });
  await mailer.send({
    to: recipient.email,
    subject: 'Reset your Rhoyards password',
    text: [
      `Hello ${recipient.name},`,
      '',
      `Someone (hopefully you) asked to reset the password for your ${audience}.`,
      '',
      `Choose a new password here. The link works once, for ${RESET_MINUTES} minutes:`,
      link(token),
      '',
      ...(recipient.realm === 'STAFF' ? ['You will still need your authenticator app to sign in.', ''] : []),
      'If you did not ask for this, you can ignore this email: your password has not changed.',
    ].join('\n'),
  });
}

/** Staff: by email or username. Run it after answering the request (it may take a moment to send the email). */
export async function requestStaffPasswordReset(identifier: string, meta: RequestContext, cfg: AuthConfig, mailer: Mailer) {
  const user = await getPrisma().user.findUnique({ where: identifierWhere(identifier) });
  if (!user || user.status !== 'ACTIVE' || user.email === SYSTEM_USER_EMAIL) return;
  // The link goes in the URL fragment, which browsers never send to servers or in Referer headers.
  await issueResetLink(
    { realm: 'STAFF', ownerId: user.id, email: user.email, name: user.fullName },
    meta,
    (token) => `${cfg.backofficeUrl}/reset-password#token=${token}`,
    mailer,
    'Rhoyards back-office account',
  );
}

export async function requestCustomerPasswordReset(email: string, meta: RequestContext, cfg: AuthConfig, mailer: Mailer) {
  const account = await getPrisma().customerAccount.findUnique({ where: { email }, include: { customer: true } });
  if (!account || account.status !== 'ACTIVE' || !account.customer.isActive) return;
  await issueResetLink(
    { realm: 'CUSTOMER', ownerId: account.id, email: account.email, name: account.customer.name },
    meta,
    (token) => `${cfg.storefrontUrl}/account/reset-password#token=${token}`,
    mailer,
    'Rhoyards shop account',
  );
}

/** Uses up a valid token of the realm (inside the caller's transaction) or fails with one generic message. */
async function takeToken(tx: Parameters<Parameters<typeof transaction>[0]>[0], token: string, realm: SessionRealm, now: Date) {
  const row = await tx.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.realm !== realm || row.usedAt || row.expiresAt <= now) throw businessRule(INVALID_RESET_LINK);
  const used = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
  if (used.count !== 1) throw businessRule(INVALID_RESET_LINK);
  return row;
}

const changedNotice = (name: string, what: string) =>
  [
    `Hello ${name},`,
    '',
    `The password for your ${what} was just changed using a reset link, and every device was signed out.`,
    '',
    'If this was not you, contact the shop straight away.',
  ].join('\n');

/** Returns the "password changed" notice for the caller to send (a mail outage must not undo a finished reset). */
export async function confirmStaffPasswordReset(input: { token: string; newPassword: string }, meta: RequestContext): Promise<MailMessage> {
  const passwordHash = await hashPassword(input.newPassword);
  const now = new Date();
  const user = await transaction(async (tx) => {
    const row = await takeToken(tx, input.token, 'STAFF', now);
    const target = await tx.user.findUniqueOrThrow({ where: { id: row.userId! } });
    if (target.status !== 'ACTIVE') throw businessRule(INVALID_RESET_LINK);
    await tx.user.update({
      where: { id: target.id },
      data: { passwordHash, mustChangePassword: false, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
    });
    await tx.passwordResetToken.updateMany({ where: { userId: target.id, usedAt: null }, data: { usedAt: now } });
    // Half-finished sign-ins started with the old password must not complete.
    await tx.loginChallenge.updateMany({ where: { userId: target.id, consumedAt: null }, data: { consumedAt: now } });
    await revokeUserSessions(tx, target.id);
    await writeAudit(tx, { ...meta, actorId: target.id }, { action: 'auth.password_reset_completed', entityType: 'user', entityId: target.id });
    return target;
  });
  return { to: user.email, subject: 'Your Rhoyards password was changed', text: changedNotice(user.fullName, 'Rhoyards back-office account') };
}

export async function confirmCustomerPasswordReset(input: { token: string; newPassword: string }, meta: RequestContext): Promise<MailMessage> {
  const passwordHash = await hashPassword(input.newPassword);
  const now = new Date();
  const account = await transaction(async (tx) => {
    const row = await takeToken(tx, input.token, 'CUSTOMER', now);
    const target = await tx.customerAccount.findUniqueOrThrow({ where: { id: row.customerAccountId! }, include: { customer: true } });
    if (target.status !== 'ACTIVE' || !target.customer.isActive) throw businessRule(INVALID_RESET_LINK);
    await tx.customerAccount.update({ where: { id: target.id }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
    await tx.passwordResetToken.updateMany({ where: { customerAccountId: target.id, usedAt: null }, data: { usedAt: now } });
    await tx.session.updateMany({ where: { customerAccountId: target.id, revokedAt: null }, data: { revokedAt: now } });
    await writeAudit(tx, meta, { action: 'auth.password_reset_completed', entityType: 'customer_account', entityId: target.id });
    return target;
  });
  return { to: account.email, subject: 'Your Rhoyards password was changed', text: changedNotice(account.customer.name, 'Rhoyards shop account') };
}
