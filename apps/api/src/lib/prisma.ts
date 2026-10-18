import { PrismaClient, type Prisma } from '@prisma/client';

let client: PrismaClient | undefined;

/** Lazily-created singleton so modules can import it without connecting at import time. */
export function getPrisma(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

/** Either the root client or an interactive-transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient;

/** Standard transaction settings: generous timeouts because Neon is reached over the network. */
export function transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return getPrisma().$transaction(fn, { maxWait: 10_000, timeout: 20_000 });
}
