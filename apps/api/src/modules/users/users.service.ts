import { Prisma } from '@prisma/client';
import {
  OWNER_ROLE,
  type CreateUserInput,
  type UpdateUserInput,
  type UserSummary,
  type userListQuerySchema,
} from '@rhoyards/shared';
import type { z } from 'zod';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, businessRule, conflict, forbidden, notFound } from '../../lib/errors';
import { orderBy, pageArgs } from '../../lib/pagination';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { SYSTEM_USER_EMAIL } from '../../lib/system-user';
import type { AuthContext } from '../auth/auth.types';
import { hashPassword } from '../auth/password';
import { revokeUserSessions } from '../auth/session.service';
import { clearTwoFactor } from '../auth/two-factor.service';

const summarySelect = {
  id: true,
  email: true,
  username: true,
  fullName: true,
  status: true,
  mustChangePassword: true,
  totpEnabledAt: true,
  lastLoginAt: true,
  createdAt: true,
  roles: { select: { role: { select: { id: true, code: true, name: true } } } },
  locations: { select: { location: { select: { id: true, code: true, name: true } } } },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof summarySelect }>;

function toSummary(u: UserRow): UserSummary {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    fullName: u.fullName,
    status: u.status,
    mustChangePassword: u.mustChangePassword,
    twoFactorEnabled: u.totpEnabledAt !== null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    roles: u.roles.map((r) => r.role).sort((a, b) => a.name.localeCompare(b.name)),
    locations: u.locations.map((l) => l.location),
  };
}

const isOwner = (auth: AuthContext) => auth.user.roles.some((r) => r.code === OWNER_ROLE);

export async function listUsers(query: z.infer<typeof userListQuerySchema>) {
  const where: Prisma.UserWhereInput = {
    email: { not: SYSTEM_USER_EMAIL },
    ...(query.q
      ? {
          OR: [
            { fullName: { contains: query.q, mode: 'insensitive' } },
            { email: { contains: query.q, mode: 'insensitive' } },
            { username: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.roleId ? { roles: { some: { roleId: query.roleId } } } : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: summarySelect,
      orderBy: orderBy(
        query.sort,
        {
          fullName: (d) => ({ fullName: d }),
          email: (d) => ({ email: d }),
          createdAt: (d) => ({ createdAt: d }),
          lastLoginAt: (d) => ({ lastLoginAt: { sort: d, nulls: 'last' } }),
        },
        { fullName: 'asc' },
      ),
      ...pageArgs(query),
    }),
    prisma.user.count({ where }),
  ]);
  return { rows: rows.map(toSummary), total };
}

export async function getUser(id: string, db: Db = getPrisma()): Promise<UserSummary> {
  // The system user is not a person: it is never listed, edited, re-enabled or given a password.
  const user = await db.user.findFirst({ where: { id, email: { not: SYSTEM_USER_EMAIL } }, select: summarySelect });
  if (!user) throw notFound('User');
  return toSummary(user);
}

/**
 * Loads the requested roles and blocks privilege escalation: a non-owner may only assign roles
 * whose permissions they hold themselves, and only an owner may grant the Owner role.
 */
async function resolveRoles(db: Db, roleIds: string[], actor: AuthContext) {
  const roles = await db.role.findMany({
    where: { id: { in: roleIds } },
    include: { permissions: { select: { permission: { select: { code: true } } } } },
  });
  if (roles.length !== new Set(roleIds).size) {
    throw new AppError(400, 'VALIDATION_ERROR', 'One or more roles do not exist', { field: 'roleIds' });
  }
  if (!isOwner(actor)) {
    for (const role of roles) {
      if (role.code === OWNER_ROLE) throw forbidden('Only an owner can grant the Owner role');
      const exceeds = role.permissions.some((p) => !actor.permissions.has(p.permission.code));
      if (exceeds) throw forbidden(`You cannot assign the ${role.name} role because it has permissions you do not hold`);
    }
  }
  return roles;
}

async function assertLocations(db: Db, locationIds: string[]) {
  const count = await db.location.count({ where: { id: { in: locationIds } } });
  if (count !== new Set(locationIds).size) {
    throw new AppError(400, 'VALIDATION_ERROR', 'One or more locations do not exist', { field: 'locationIds' });
  }
}

/** Serialises changes that could affect the set of active owners (prevents losing the last owner under concurrency). */
async function lockOwnerRole(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT "id" FROM "roles" WHERE "code" = ${OWNER_ROLE} FOR UPDATE`;
}

const USERNAME_TAKEN = 'This username is already taken';

async function assertUsernameFree(db: Db, username: string, exceptId?: string) {
  const other = await db.user.findUnique({ where: { username }, select: { id: true } });
  if (other && other.id !== exceptId) throw conflict(USERNAME_TAKEN, { field: 'username' });
}

/** A concurrent insert can still win the unique index: report it as the same field conflict. */
function usernameRace(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict(USERNAME_TAKEN, { field: 'username' });
  throw e;
}

export async function createUser(input: CreateUserInput, actor: AuthContext, ctx: RequestContext) {
  const passwordHash = await hashPassword(input.password);
  return transaction(async (tx) => {
    if (await tx.user.findUnique({ where: { email: input.email }, select: { id: true } })) {
      throw conflict('A user with this email already exists', { field: 'email' });
    }
    if (input.username) await assertUsernameFree(tx, input.username);
    await resolveRoles(tx, input.roleIds, actor);
    await assertLocations(tx, input.locationIds);

    const created = await tx.user.create({
      data: {
        email: input.email,
        username: input.username ?? null,
        fullName: input.fullName,
        passwordHash,
        // The administrator chose this password, so the user must replace it at first login.
        mustChangePassword: true,
        createdById: actor.user.id,
        roles: { create: [...new Set(input.roleIds)].map((roleId) => ({ roleId, assignedById: actor.user.id })) },
        locations: { create: [...new Set(input.locationIds)].map((locationId) => ({ locationId })) },
      },
      select: summarySelect,
    }).catch(usernameRace);
    const summary = toSummary(created);
    await writeAudit(tx, ctx, { action: 'user.created', entityType: 'user', entityId: created.id, after: summary });
    return summary;
  });
}

export async function updateUser(id: string, input: UpdateUserInput, actor: AuthContext, ctx: RequestContext) {
  return transaction(async (tx) => {
    await lockOwnerRole(tx);
    const before = await getUser(id, tx);
    const wasActiveOwner = before.status === 'ACTIVE' && before.roles.some((r) => r.code === OWNER_ROLE);

    if (input.status === 'DISABLED' && id === actor.user.id) {
      throw businessRule('You cannot disable your own account');
    }

    if (before.roles.some((r) => r.code === OWNER_ROLE) && !isOwner(actor)) {
      throw forbidden('Only an owner can change an owner account');
    }
    let nextRoleCodes = before.roles.map((r) => r.code);
    if (input.roleIds) {
      const roles = await resolveRoles(tx, input.roleIds, actor);
      nextRoleCodes = roles.map((r) => r.code);
    }
    if (input.locationIds) await assertLocations(tx, input.locationIds);
    if (input.username) await assertUsernameFree(tx, input.username, id);

    const willBeActiveOwner = (input.status ?? before.status) === 'ACTIVE' && nextRoleCodes.includes(OWNER_ROLE);
    if (wasActiveOwner && !willBeActiveOwner) {
      const otherOwners = await tx.user.count({
        where: { id: { not: id }, status: 'ACTIVE', roles: { some: { role: { code: OWNER_ROLE } } } },
      });
      if (otherOwners === 0) throw businessRule('At least one active owner account is required');
    }

    await tx.user.update({
      where: { id },
      data: {
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    }).catch(usernameRace);
    if (input.roleIds) {
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({
        data: [...new Set(input.roleIds)].map((roleId) => ({ userId: id, roleId, assignedById: actor.user.id })),
      });
    }
    if (input.locationIds) {
      await tx.userLocation.deleteMany({ where: { userId: id } });
      await tx.userLocation.createMany({ data: [...new Set(input.locationIds)].map((locationId) => ({ userId: id, locationId })) });
    }
    if (input.status === 'DISABLED' && before.status !== 'DISABLED') {
      await revokeUserSessions(tx, id);
    }

    const after = await getUser(id, tx);
    await writeAudit(tx, ctx, { action: 'user.updated', entityType: 'user', entityId: id, before, after });
    return after;
  });
}

export async function resetUserPassword(id: string, newPassword: string, actor: AuthContext, ctx: RequestContext) {
  const passwordHash = await hashPassword(newPassword);
  await transaction(async (tx) => {
    const target = await getUser(id, tx);
    if (target.roles.some((r) => r.code === OWNER_ROLE) && !isOwner(actor)) {
      throw forbidden("Only an owner can reset an owner's password");
    }
    await tx.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: new Date() },
    });
    await revokeUserSessions(tx, id);
    await writeAudit(tx, ctx, { action: 'user.password_reset', entityType: 'user', entityId: id });
  });
}

/**
 * For someone who lost their phone and backup codes: removes their authenticator and signs them out everywhere. They
 * set up a new app at their next sign-in (after the password, so a reset alone does not let anyone else in).
 */
export async function resetUserTwoFactor(id: string, actor: AuthContext, ctx: RequestContext) {
  await transaction(async (tx) => {
    const target = await getUser(id, tx);
    if (id === actor.user.id) {
      throw businessRule('To change your own authenticator, use Account security (you will need your password).');
    }
    if (target.roles.some((r) => r.code === OWNER_ROLE) && !isOwner(actor)) {
      throw forbidden("Only an owner can reset an owner's two-factor sign-in");
    }
    await clearTwoFactor(tx, id);
    await writeAudit(tx, ctx, { action: 'user.two_factor_reset', entityType: 'user', entityId: id });
  });
}
