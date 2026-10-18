import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { listQuerySchema } from '@rhoyards/shared';
import { listEnvelope, pageArgs } from '../../lib/pagination';
import { getPrisma } from '../../lib/prisma';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requirePermission } from '../auth/auth.middleware';

const auditQuerySchema = listQuerySchema.omit({ sort: true }).extend({
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(60).optional(),
  actorUserId: z.uuid().optional(),
  action: z.string().max(80).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

registry.registerPath({
  method: 'get',
  path: '/audit-logs',
  tags: ['Audit'],
  summary: 'Audit trail, newest first (audit.view)',
  request: { query: auditQuerySchema },
  responses: { 200: { description: 'Paginated audit records' } },
});

export const auditRouter = Router();

auditRouter.get('/audit-logs', ...requirePermission('audit.view'), async (req, res) => {
  const q = parse(auditQuerySchema, req.query);
  const where: Prisma.AuditLogWhereInput = {
    ...(q.entityType ? { entityType: q.entityType } : {}),
    ...(q.entityId ? { entityId: q.entityId } : {}),
    ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
    ...(q.action ? { action: { startsWith: q.action } } : {}),
    ...(q.from || q.to
      ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
      : {}),
  };
  const prisma = getPrisma();
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { id: true, fullName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(q),
    }),
    prisma.auditLog.count({ where }),
  ]);
  res.json(listEnvelope(rows, total, q));
});
