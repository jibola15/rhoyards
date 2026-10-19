import type { RoleCode } from '@rhoyards/shared';
import { seedBase } from '../../prisma/seed/base';
import { getPrisma } from '../../src/lib/prisma';
import { forgetSystemUser } from '../../src/lib/system-user';
import { loadEnv } from '../../src/config/env';
import { encryptSecret } from '../../src/lib/secret-box';
import { hashPassword } from '../../src/modules/auth/password';
import { generateTotpSecret } from '../../src/modules/auth/totp';

/**
 * Empties every table in the test database and re-seeds reference data.
 * The database check and the TRUNCATE run in one transaction (one connection), so the
 * check is about the exact connection that truncates.
 */
export async function resetDatabase(): Promise<void> {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const [{ db }] = await tx.$queryRaw<[{ db: string }]>`SELECT current_database() AS db`;
    if (!db.includes('test')) {
      throw new Error(`Refusing to truncate tables in database "${db}" — not a test database.`);
    }
    const tables = await tx.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    if (tables.length > 0) {
      await tx.$executeRawUnsafe(
        `TRUNCATE ${tables.map((t) => `public."${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
      );
    }
    // A generous limit: if the client gave up early, the TRUNCATE would still finish on the server later and wipe
    // the data the next test file had just seeded.
  }, { maxWait: 30_000, timeout: 120_000 });
  await seedBase(prisma);
  forgetSystemUser();
}

let counter = 0;
const passwordHashCache = new Map<string, Promise<string>>();

export const TEST_PASSWORD = 'correct-horse-battery';

/**
 * Creates an active staff user holding one role, ready to log in. Two-factor is already set up (with `totpSecret`)
 * unless `twoFactor: false`, in which case the first sign-in sets it up.
 */
export async function createStaff(
  roleCode: RoleCode | string,
  opts: { password?: string; mustChangePassword?: boolean; fullName?: string; username?: string; twoFactor?: boolean } = {},
) {
  const prisma = getPrisma();
  const password = opts.password ?? TEST_PASSWORD;
  if (!passwordHashCache.has(password)) passwordHashCache.set(password, hashPassword(password));
  counter += 1;
  const email = `${roleCode.toLowerCase()}.${counter}.${Date.now()}@test.local`;
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const totpSecret = opts.twoFactor === false ? null : generateTotpSecret();
  const user = await prisma.user.create({
    data: {
      email,
      username: opts.username ?? null,
      ...(totpSecret ? { totpSecretEnc: encryptSecret(totpSecret, loadEnv({ NODE_ENV: 'test' }).TWO_FACTOR_KEY), totpEnabledAt: new Date() } : {}),
      fullName: opts.fullName ?? `${roleCode} User ${counter}`,
      passwordHash: await passwordHashCache.get(password)!,
      mustChangePassword: opts.mustChangePassword ?? false,
      roles: { create: { roleId: role.id } },
    },
  });
  return { user, email, password, totpSecret };
}
