import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import type { Db } from './prisma';

export interface RequestContext {
  actorId: string | null;
  ip?: string;
  requestId?: string;
}

export function requestContext(req: Request): RequestContext {
  return {
    actorId: req.auth?.user.id ?? null,
    ...(req.ip ? { ip: req.ip } : {}),
    ...(req.id ? { requestId: String(req.id) } : {}),
  };
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Pass only safe, business-relevant fields — never password hashes or tokens. */
  before?: unknown;
  after?: unknown;
}

const toJson = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));

/** Writes an audit record. Call with the transaction client so the record commits or rolls back with the change. */
export async function writeAudit(db: Db, ctx: RequestContext, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorUserId: ctx.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: toJson(entry.before),
      after: toJson(entry.after),
      ip: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    },
  });
}
