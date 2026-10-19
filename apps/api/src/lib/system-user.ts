import type { Db } from './prisma';

/**
 * A disabled staff record that authors automatic work with no person behind it, such as a sale created when a
 * payment webhook arrives. It cannot sign in (disabled, unusable password hash) and is hidden from staff screens.
 */
export const SYSTEM_USER_EMAIL = 'system@rhoyards.invalid';

let cachedId: string | undefined;

export async function systemUserId(db: Db): Promise<string> {
  cachedId ??= (await db.user.findUniqueOrThrow({ where: { email: SYSTEM_USER_EMAIL }, select: { id: true } })).id;
  return cachedId;
}

/** Tests truncate and re-seed the database, which gives the system user a new id. */
export function forgetSystemUser(): void {
  cachedId = undefined;
}
