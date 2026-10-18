import type { ListEnvelope, ListQuery } from '@rhoyards/shared';
import { AppError } from './errors';

export function pageArgs(query: Pick<ListQuery, 'page' | 'pageSize'>) {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

/**
 * Translates `field:dir` into a Prisma orderBy using an allow-list of sortable fields.
 * Unknown fields are rejected rather than silently ignored.
 */
export function orderBy<T extends string>(
  sort: string | undefined,
  allowed: Record<T, (dir: 'asc' | 'desc') => object>,
  fallback: object,
): object {
  if (!sort) return fallback;
  const [field, dir] = sort.split(':') as [string, 'asc' | 'desc'];
  const build = (allowed as Record<string, ((d: 'asc' | 'desc') => object) | undefined>)[field];
  if (!build) {
    throw new AppError(400, 'VALIDATION_ERROR', `Cannot sort by "${field}"`, {
      allowed: Object.keys(allowed),
    });
  }
  return build(dir);
}

export function listEnvelope<T>(data: T[], total: number, query: Pick<ListQuery, 'page' | 'pageSize'>): ListEnvelope<T> {
  return { data, meta: { page: query.page, pageSize: query.pageSize, total } };
}
