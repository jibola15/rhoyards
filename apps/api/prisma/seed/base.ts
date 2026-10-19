import { Prisma, type PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, DEFAULT_SETTINGS, PERMISSIONS, ROLE_CODES, SYSTEM_ROLES } from '@rhoyards/shared';
import { CHART_OF_ACCOUNTS } from './chart-of-accounts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utcDate(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

/** Creates a fiscal year with 12 monthly periods if it does not exist. */
export async function ensureFiscalYear(prisma: PrismaClient, startYear: number, startMonth: number) {
  const start = utcDate(startYear, startMonth - 1, 1);
  const end = utcDate(startYear + 1, startMonth - 1, 0);
  const name = startMonth === 1 ? `FY${startYear}` : `FY${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`;
  const existing = await prisma.fiscalYear.findUnique({ where: { name } });
  if (existing) return existing;

  return prisma.fiscalYear.create({
    data: {
      name,
      startDate: start,
      endDate: end,
      periods: {
        create: Array.from({ length: 12 }, (_, i) => {
          const m = startMonth - 1 + i;
          const pStart = utcDate(startYear, m, 1);
          const pEnd = utcDate(startYear, m + 1, 0);
          return {
            name: `${MONTHS[pStart.getUTCMonth()]} ${pStart.getUTCFullYear()}`,
            startDate: pStart,
            endDate: pEnd,
          };
        }),
      },
    },
  });
}

/**
 * Reference data every environment needs. Idempotent: existing rows are left as they are,
 * so re-running never overwrites settings, accounts or role permissions edited by users.
 */
export async function seedBase(prisma: PrismaClient, now = new Date()) {
  const knownBefore = new Set((await prisma.permission.findMany({ select: { code: true } })).map((p) => p.code));
  await prisma.permission.createMany({
    data: ALL_PERMISSIONS.map((code) => ({ code, module: code.split('.')[0]!, description: PERMISSIONS[code] })),
    skipDuplicates: true,
  });

  await prisma.role.createMany({
    data: ROLE_CODES.map((code) => ({
      code,
      name: SYSTEM_ROLES[code].name,
      description: SYSTEM_ROLES[code].description,
      isSystem: true,
    })),
    skipDuplicates: true,
  });

  const [roles, permissions] = await Promise.all([
    prisma.role.findMany({ where: { code: { in: [...ROLE_CODES] } } }),
    prisma.permission.findMany(),
  ]);
  const permId = new Map(permissions.map((p) => [p.code, p.id]));
  const rolePermRows = roles.flatMap((role) =>
    SYSTEM_ROLES[role.code as keyof typeof SYSTEM_ROLES].permissions.map((code) => ({
      roleId: role.id,
      permissionId: permId.get(code)!,
    })),
  );
  // Defaults go only to system roles that have no permissions yet (so edits survive re-seeding);
  // OWNER is always topped up to every permission.
  const existingAssignments = await prisma.rolePermission.findMany({
    where: { roleId: { in: roles.map((r) => r.id) } },
    select: { roleId: true },
    distinct: ['roleId'],
  });
  const configured = new Set(existingAssignments.map((r) => r.roleId));
  const ownerId = roles.find((r) => r.code === 'OWNER')?.id;
  // Permissions introduced since the last seed are granted to the system roles whose defaults include them;
  // existing role edits are left alone.
  const newPermIds = new Set(permissions.filter((p) => !knownBefore.has(p.code)).map((p) => p.id));
  await prisma.rolePermission.createMany({
    data: rolePermRows.filter(
      (r) => r.roleId === ownerId || !configured.has(r.roleId) || (knownBefore.size > 0 && newPermIds.has(r.permissionId)),
    ),
    skipDuplicates: true,
  });

  await prisma.account.createMany({
    data: CHART_OF_ACCOUNTS.map((a) => ({ ...a, systemKey: a.systemKey ?? null })),
    skipDuplicates: true,
  });

  const vatOut = await prisma.account.findUnique({ where: { systemKey: 'VAT_OUTPUT' } });
  const vatIn = await prisma.account.findUnique({ where: { systemKey: 'VAT_INPUT' } });
  await prisma.taxRate.createMany({
    data: [
      {
        code: 'VAT',
        name: 'VAT (standard rate)',
        kind: 'STANDARD',
        // Default only; editable under Settings → Tax rates.
        rate: new Prisma.Decimal('7.5'),
        outputAccountId: vatOut?.id ?? null,
        inputAccountId: vatIn?.id ?? null,
      },
      { code: 'ZERO', name: 'Zero-rated', kind: 'ZERO_RATED', rate: new Prisma.Decimal(0) },
      { code: 'EXEMPT', name: 'VAT exempt', kind: 'EXEMPT', rate: new Prisma.Decimal(0) },
    ],
    skipDuplicates: true,
  });

  await prisma.setting.createMany({
    data: Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value: value as Prisma.InputJsonValue })),
    skipDuplicates: true,
  });

  await prisma.unit.createMany({
    data: [
      { code: 'PC', name: 'Piece' },
      { code: 'SET', name: 'Set' },
      { code: 'PACK', name: 'Pack' },
      { code: 'ML', name: 'Millilitre', allowsFraction: true },
      { code: 'L', name: 'Litre', allowsFraction: true },
      { code: 'G', name: 'Gram', allowsFraction: true },
      { code: 'KG', name: 'Kilogram', allowsFraction: true },
    ],
    skipDuplicates: true,
  });

  await prisma.location.createMany({
    data: [
      {
        code: 'MAIN',
        name: 'Main Store',
        type: 'STORE',
        isPosEnabled: true,
        isOnlineFulfilment: true,
      },
    ],
    skipDuplicates: true,
  });

  // Payment methods, each debiting its ledger account when a sale is paid.
  const accountId = async (key: string) => (await prisma.account.findUniqueOrThrow({ where: { systemKey: key } })).id;
  await prisma.paymentMethod.createMany({
    data: [
      { code: 'CASH', name: 'Cash', kind: 'CASH', accountId: await accountId('CASH_ON_HAND'), sortOrder: 1 },
      { code: 'CARD', name: 'Card (POS terminal)', kind: 'CARD', accountId: await accountId('CARD_CLEARING'), sortOrder: 2 },
      { code: 'TRANSFER', name: 'Bank transfer', kind: 'BANK_TRANSFER', accountId: await accountId('BANK_MAIN'), requiresReference: true, sortOrder: 3 },
    ],
    skipDuplicates: true,
  });
  const main = await prisma.location.findUniqueOrThrow({ where: { code: 'MAIN' } });
  await prisma.register.createMany({ data: [{ locationId: main.id, name: 'Till 1' }], skipDuplicates: true });

  const startMonth = DEFAULT_SETTINGS.fiscal.yearStartMonth;
  const fyStartYear = now.getUTCMonth() + 1 >= startMonth ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  await ensureFiscalYear(prisma, fyStartYear, startMonth);
}
