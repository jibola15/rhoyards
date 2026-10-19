import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { CookieOptions, RequestHandler } from 'express';
import { ErrorCode, type CustomerRegisterInput, type StoreSession } from '@rhoyards/shared';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, conflict, unauthenticated } from '../../lib/errors';
import { getPrisma, transaction } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/sequences';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../auth/password';
import { hashToken } from '../auth/session.service';

/**
 * Storefront sign-in. Customers have their own accounts, cookie and sessions (realm CUSTOMER), entirely separate
 * from staff: a staff cookie means nothing on /store routes and a customer cookie means nothing on staff routes.
 */

export interface CustomerContext {
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
  accountId: string;
  customerId: string;
  email: string;
  name: string;
  phone: string | null;
}

const IDLE_DAYS = 14;
const ABSOLUTE_DAYS = 60;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const TOUCH_INTERVAL_MS = 60_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const INVALID_LOGIN = 'Invalid email or password, or the account is temporarily locked';
const days = (n: number) => n * 86_400_000;

export const customerCookieName = (secure: boolean) => (secure ? '__Host-rh_cid' : 'rh_cid');
export const customerCookieOptions = (secure: boolean, expiresAt: Date): CookieOptions => ({
  httpOnly: true,
  secure,
  sameSite: 'lax',
  path: '/',
  expires: expiresAt,
});

const idleExpiry = (now: Date, absolute: Date) => new Date(Math.min(now.getTime() + days(IDLE_DAYS), absolute.getTime()));

export function storeSessionPayload(c: CustomerContext): StoreSession {
  return {
    customer: { id: c.customerId, name: c.name, email: c.email, phone: c.phone },
    csrfToken: c.csrfToken,
    expiresAt: c.expiresAt.toISOString(),
  };
}

/** Resolves the customer cookie into `req.customer`; anything invalid is treated as a guest. */
export function loadCustomerSession(secure: boolean): RequestHandler {
  const cookieName = customerCookieName(secure);
  return async (req, res, next) => {
    const token: unknown = req.cookies?.[cookieName];
    if (typeof token !== 'string' || token.length === 0 || token.length > 200) return next();
    const prisma = getPrisma();
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { customerAccount: { include: { customer: true } } },
    });
    const now = new Date();
    const account = session?.customerAccount;
    if (
      !session ||
      session.realm !== 'CUSTOMER' ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.idleExpiresAt <= now ||
      !account ||
      account.status !== 'ACTIVE' ||
      !account.customer.isActive
    ) {
      res.clearCookie(cookieName, { path: '/' });
      return next();
    }
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now, idleExpiresAt: idleExpiry(now, session.expiresAt) } });
    }
    req.customer = {
      sessionId: session.id,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      accountId: account.id,
      customerId: account.customerId,
      email: account.email,
      name: account.customer.name,
      phone: account.customer.phone,
    };
    next();
  };
}

/** Synchronizer-token CSRF check for signed-in customers' state-changing requests. */
export const customerCsrf: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method) || !req.customer) return next();
  const header = req.get('x-csrf-token') ?? '';
  const a = Buffer.from(header);
  const b = Buffer.from(req.customer.csrfToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(403, ErrorCode.CSRF_INVALID, 'Missing or invalid CSRF token');
  next();
};

export const requireCustomer: RequestHandler = (req, _res, next) => {
  if (!req.customer) throw unauthenticated('Please sign in to continue');
  next();
};

async function createCustomerSession(accountId: string, meta: { ip?: string; userAgent?: string }) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days(ABSOLUTE_DAYS));
  const session = await getPrisma().session.create({
    data: {
      tokenHash: hashToken(token),
      realm: 'CUSTOMER',
      customerAccountId: accountId,
      csrfToken,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      idleExpiresAt: idleExpiry(now, expiresAt),
      expiresAt,
    },
  });
  return { id: session.id, token, csrfToken, expiresAt };
}

type Meta = RequestContext & { userAgent?: string };

async function contextFor(accountId: string, session: { id: string; csrfToken: string; expiresAt: Date }): Promise<CustomerContext> {
  const account = await getPrisma().customerAccount.findUniqueOrThrow({ where: { id: accountId }, include: { customer: true } });
  return {
    sessionId: session.id,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    accountId,
    customerId: account.customerId,
    email: account.email,
    name: account.customer.name,
    phone: account.customer.phone,
  };
}

/** Creates the customer record and its sign-in in one go, then signs the new customer in. */
export async function registerCustomer(input: CustomerRegisterInput, meta: Meta) {
  const passwordHash = await hashPassword(input.password);
  const account = await transaction(async (tx) => {
    if (await tx.customerAccount.findUnique({ where: { email: input.email }, select: { id: true } })) {
      throw conflict('An account with this email already exists. Sign in instead.', { field: 'email' });
    }
    const customer = await tx.customer.create({
      data: { code: await nextDocumentNumber(tx, 'CUSTOMER', 'CUS-'), name: input.name, email: input.email, phone: input.phone.replace(/\s+/g, '') },
    });
    const created = await tx.customerAccount
      .create({ data: { customerId: customer.id, email: input.email, passwordHash } })
      .catch((e: unknown) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('An account with this email already exists. Sign in instead.', { field: 'email' });
        throw e;
      });
    await writeAudit(tx, meta, { action: 'customer.registered', entityType: 'customer', entityId: customer.id, after: { email: input.email } });
    return created;
  });
  const session = await createCustomerSession(account.id, meta);
  return { session, context: await contextFor(account.id, session) };
}

export async function loginCustomer(input: { email: string; password: string }, meta: Meta) {
  const prisma = getPrisma();
  const account = await prisma.customerAccount.findUnique({ where: { email: input.email }, include: { customer: true } });
  const now = new Date();
  if (!account || (account.lockedUntil && account.lockedUntil > now)) {
    await verifyAgainstDummy(input.password);
    throw unauthenticated(INVALID_LOGIN);
  }
  const ok = await verifyPassword(account.passwordHash, input.password);
  if (!ok || account.status !== 'ACTIVE' || !account.customer.isActive) {
    if (!ok) {
      const failed = account.failedLoginCount + 1;
      await prisma.customerAccount.update({
        where: { id: account.id },
        data: failed >= MAX_FAILED_LOGINS ? { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MINUTES * 60_000) } : { failedLoginCount: failed },
      });
    }
    throw unauthenticated(INVALID_LOGIN);
  }
  await prisma.customerAccount.update({ where: { id: account.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } });
  const session = await createCustomerSession(account.id, meta);
  return { session, context: await contextFor(account.id, session) };
}

export async function logoutCustomer(sessionId: string) {
  await getPrisma().session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}
