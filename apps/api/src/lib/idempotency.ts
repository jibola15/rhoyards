import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AppError, conflict } from './errors';
import { getPrisma } from './prisma';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const TTL_MS = 24 * 3_600_000;

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Runs a money-moving operation at most once per (scope, Idempotency-Key).
 * - Same key, same request → the stored response is returned without re-running.
 * - Same key, different request → 409.
 * - Same key while the first request is still running → 409 (the client should retry later).
 * The key row is claimed before the work starts (unique constraint), so concurrent duplicates cannot both run.
 */
export async function withIdempotency<T>(
  scope: string,
  key: string | undefined,
  request: unknown,
  run: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  if (!key) throw new AppError(400, 'VALIDATION_ERROR', 'An Idempotency-Key header is required for this request');
  if (!KEY_PATTERN.test(key)) throw new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key must be 8–100 letters, digits, dashes or underscores');

  const prisma = getPrisma();
  const requestHash = createHash('sha256').update(JSON.stringify(request ?? null)).digest('hex');
  try {
    await prisma.idempotencyKey.create({ data: { scope, key, requestHash, expiresAt: new Date(Date.now() + TTL_MS) } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    const existing = await prisma.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope, key } } });
    if (existing.requestHash !== requestHash) throw conflict('This Idempotency-Key was already used for a different request');
    if (existing.statusCode === null) throw conflict('A request with this Idempotency-Key is still being processed; retry shortly');
    return { status: existing.statusCode, body: existing.response as T, replayed: true };
  }

  try {
    const result = await run();
    await prisma.idempotencyKey.update({
      where: { scope_key: { scope, key } },
      data: { statusCode: result.status, response: JSON.parse(JSON.stringify(result.body)) as Prisma.InputJsonValue },
    });
    return { ...result, replayed: false };
  } catch (err) {
    // The operation rolled back; release the key so a corrected retry can proceed.
    await prisma.idempotencyKey.delete({ where: { scope_key: { scope, key } } }).catch(() => undefined);
    throw err;
  }
}
