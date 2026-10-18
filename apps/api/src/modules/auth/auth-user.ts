import type { Prisma } from '@prisma/client';
import { ALL_PERMISSIONS, OWNER_ROLE, type AuthUser } from '@rhoyards/shared';

export const authUserInclude = {
  roles: {
    include: {
      role: {
        select: {
          id: true,
          code: true,
          name: true,
          permissions: { select: { permission: { select: { code: true } } } },
        },
      },
    },
  },
  locations: { select: { locationId: true } },
} satisfies Prisma.UserInclude;

export type UserWithAuth = Prisma.UserGetPayload<{ include: typeof authUserInclude }>;

/** Effective permissions are the union over all roles; the Owner role always has every permission. */
export function effectivePermissions(user: UserWithAuth): Set<string> {
  if (user.roles.some((r) => r.role.code === OWNER_ROLE)) return new Set(ALL_PERMISSIONS);
  return new Set(user.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.code)));
}

export function toAuthUser(user: UserWithAuth, permissions: ReadonlySet<string>): AuthUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    mustChangePassword: user.mustChangePassword,
    roles: user.roles.map((r) => ({ id: r.role.id, code: r.role.code, name: r.role.name })),
    locationIds: user.locations.map((l) => l.locationId),
    permissions: [...permissions].sort(),
  };
}
