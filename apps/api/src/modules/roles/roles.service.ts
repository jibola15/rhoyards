import type { Prisma } from '@prisma/client';
import { ALL_PERMISSIONS, OWNER_ROLE, PERMISSIONS, type RoleSummary, type roleInputSchema, type roleUpdateSchema } from '@rhoyards/shared';
import type { z } from 'zod';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, businessRule, conflict, forbidden, notFound } from '../../lib/errors';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import type { AuthContext } from '../auth/auth.types';

const roleInclude = {
  permissions: { select: { permission: { select: { code: true } } } },
  _count: { select: { users: true } },
} satisfies Prisma.RoleInclude;

type RoleRow = Prisma.RoleGetPayload<{ include: typeof roleInclude }>;

function toSummary(r: RoleRow): RoleSummary {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    isSystem: r.isSystem,
    permissions: r.code === OWNER_ROLE ? [...ALL_PERMISSIONS] : r.permissions.map((p) => p.permission.code).sort(),
    userCount: r._count.users,
  };
}

export async function listRoles(): Promise<RoleSummary[]> {
  const roles = await getPrisma().role.findMany({ include: roleInclude, orderBy: [{ isSystem: 'desc' }, { name: 'asc' }] });
  return roles.map(toSummary);
}

export function permissionCatalogue() {
  return ALL_PERMISSIONS.map((code) => ({ code, module: code.split('.')[0]!, description: PERMISSIONS[code] }));
}

async function getRole(db: Db, id: string) {
  const role = await db.role.findUnique({ where: { id }, include: roleInclude });
  if (!role) throw notFound('Role');
  return role;
}

async function permissionIds(db: Db, codes: string[], actor: AuthContext): Promise<string[]> {
  const unique = [...new Set(codes)];
  const unknown = unique.filter((c) => !(c in PERMISSIONS));
  if (unknown.length > 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Unknown permissions', { unknown });
  }
  const notHeld = unique.filter((c) => !actor.permissions.has(c));
  if (notHeld.length > 0) {
    throw forbidden('You cannot grant permissions you do not hold yourself');
  }
  const rows = await db.permission.findMany({ where: { code: { in: unique } }, select: { id: true } });
  return rows.map((r) => r.id);
}

export async function createRole(input: z.infer<typeof roleInputSchema>, actor: AuthContext, ctx: RequestContext) {
  return transaction(async (tx) => {
    if (await tx.role.findUnique({ where: { code: input.code } })) {
      throw conflict('A role with this code already exists', { field: 'code' });
    }
    const ids = await permissionIds(tx, input.permissions, actor);
    const role = await tx.role.create({
      data: {
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        permissions: { create: ids.map((permissionId) => ({ permissionId })) },
      },
      include: roleInclude,
    });
    const summary = toSummary(role);
    await writeAudit(tx, ctx, { action: 'role.created', entityType: 'role', entityId: role.id, after: summary });
    return summary;
  });
}

export async function updateRole(
  id: string,
  input: z.infer<typeof roleUpdateSchema>,
  actor: AuthContext,
  ctx: RequestContext,
) {
  return transaction(async (tx) => {
    const existing = await getRole(tx, id);
    if (existing.code === OWNER_ROLE) {
      throw businessRule('The Owner role always has every permission and cannot be edited');
    }
    const before = toSummary(existing);
    await tx.role.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
    if (input.permissions) {
      const ids = await permissionIds(tx, input.permissions, actor);
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId: id, permissionId })) });
    }
    const after = toSummary(await getRole(tx, id));
    await writeAudit(tx, ctx, { action: 'role.updated', entityType: 'role', entityId: id, before, after });
    return after;
  });
}

export async function deleteRole(id: string, ctx: RequestContext) {
  await transaction(async (tx) => {
    const role = await getRole(tx, id);
    if (role.isSystem) throw businessRule('System roles cannot be deleted');
    if (role._count.users > 0) throw businessRule('Remove this role from all users before deleting it');
    await tx.role.delete({ where: { id } });
    await writeAudit(tx, ctx, { action: 'role.deleted', entityType: 'role', entityId: id, before: toSummary(role) });
  });
}
