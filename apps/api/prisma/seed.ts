import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { emailSchema, passwordSchema } from '@rhoyards/shared';
import { hashPassword } from '../src/modules/auth/password';
import { seedBase } from './seed/base';

const prisma = new PrismaClient();

/** Creates the first owner account from SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD if no user has that email. */
async function seedOwner() {
  const rawEmail = process.env.SEED_OWNER_EMAIL;
  const rawPassword = process.env.SEED_OWNER_PASSWORD;
  if (!rawEmail || !rawPassword) {
    console.log('SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD not set — skipping owner account.');
    return;
  }
  const email = emailSchema.parse(rawEmail);
  const password = passwordSchema.parse(rawPassword);

  if (await prisma.user.findUnique({ where: { email } })) {
    console.log(`Owner ${email} already exists — unchanged.`);
    return;
  }
  const [owner, main] = await Promise.all([
    prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } }),
    prisma.location.findUniqueOrThrow({ where: { code: 'MAIN' } }),
  ]);
  await prisma.user.create({
    data: {
      email,
      fullName: 'Store Owner',
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
      roles: { create: { roleId: owner.id } },
      locations: { create: { locationId: main.id } },
    },
  });
  console.log(`Created owner account ${email} (password change required at first login).`);
}

async function main() {
  await seedBase(prisma);
  console.log('Reference data seeded.');
  await seedOwner();
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
