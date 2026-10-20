import type { Request, RequestHandler } from 'express';
import { OWNER_ROLE } from '@rhoyards/shared';
import { forbidden } from '../../lib/errors';
import type { AuthContext } from './auth.types';

/**
 * Store access for a business with several stores. A staff member assigned to particular stores (Staff users →
 * Locations) works only in those: their documents, sales and shifts, and every action that moves stock or money
 * there. Someone with no store assigned (head office) and every Owner works in all stores. Stock levels stay
 * visible everywhere, so staff can see where to transfer stock from.
 */

/** The stores this person may work in, or null for all of them. */
export function locationScope(auth: AuthContext | undefined): string[] | null {
  if (!auth || auth.user.roles.some((r) => r.code === OWNER_ROLE)) return null;
  return auth.user.locationIds.length > 0 ? auth.user.locationIds : null;
}

export const NOT_YOUR_STORE = 'This belongs to a store you are not assigned to';

/** Passes when at least one of the stores is the person's (a transfer belongs to both of its stores). */
export function assertLocationAccess(auth: AuthContext | undefined, ...locationIds: (string | null | undefined)[]): void {
  const scope = locationScope(auth);
  if (!scope) return;
  if (!locationIds.some((id) => id && scope.includes(id))) throw forbidden(NOT_YOUR_STORE);
}

/** Prisma filter limiting a list to the person's stores (no filter for all-store access). */
export function scopeWhere(scope: string[] | null, field = 'locationId'): Record<string, { in: string[] }> {
  return scope ? { [field]: { in: scope } } : {};
}

/**
 * Route guard: the document named by `:id` must belong to one of the person's stores. `load` returns the
 * document's store id(s), or null when there is no such document (the handler then answers 404 itself).
 */
export function documentStore(load: (id: string) => Promise<(string | null | undefined)[] | null>): RequestHandler {
  return async (req, _res, next) => {
    if (!locationScope(req.auth)) return next();
    const id = String(req.params.id ?? '');
    const stores = /^[0-9a-f-]{36}$/i.test(id) ? await load(id) : null;
    if (stores) assertLocationAccess(req.auth, ...stores);
    next();
  };
}

/** Route guard for creating or changing a document: the store named in the request body must be the person's. */
export function bodyStore(pick: (body: Record<string, unknown>) => unknown): RequestHandler {
  return (req: Request, _res, next) => {
    const store = pick((req.body ?? {}) as Record<string, unknown>);
    // A missing or malformed store id is left for validation to report.
    if (typeof store === 'string' && store) assertLocationAccess(req.auth, store);
    next();
  };
}
