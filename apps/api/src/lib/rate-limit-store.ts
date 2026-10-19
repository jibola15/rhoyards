import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import { getPrisma } from './prisma';

interface Row {
  hits: number;
  reset_at: Date;
}

/**
 * express-rate-limit store backed by the `rate_limits` table, so every API instance counts against the same limit.
 * One upsert per request: a fixed window that restarts when it has expired.
 */
export class PostgresRateLimitStore implements Store {
  /** Counts live in the database, not in this process. */
  readonly localKeys = false;
  private windowMs = 60_000;

  constructor(readonly prefix: string) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private key(key: string) {
    return `${this.prefix}:${key}`;
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const rows = await getPrisma().$queryRaw<Row[]>`
      SELECT "hits", "reset_at" FROM "rate_limits" WHERE "key" = ${this.key(key)} AND "reset_at" > now()`;
    const row = rows[0];
    return row ? { totalHits: row.hits, resetTime: row.reset_at } : undefined;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const rows = await getPrisma().$queryRaw<Row[]>`
      INSERT INTO "rate_limits" ("key", "hits", "reset_at")
      VALUES (${this.key(key)}, 1, now() + ${this.windowMs}::int * interval '1 millisecond')
      ON CONFLICT ("key") DO UPDATE SET
        "hits" = CASE WHEN "rate_limits"."reset_at" <= now() THEN 1 ELSE "rate_limits"."hits" + 1 END,
        "reset_at" = CASE WHEN "rate_limits"."reset_at" <= now() THEN EXCLUDED."reset_at" ELSE "rate_limits"."reset_at" END
      RETURNING "hits", "reset_at"`;
    const row = rows[0]!;
    return { totalHits: row.hits, resetTime: row.reset_at };
  }

  async decrement(key: string): Promise<void> {
    await getPrisma().$executeRaw`
      UPDATE "rate_limits" SET "hits" = GREATEST("hits" - 1, 0) WHERE "key" = ${this.key(key)}`;
  }

  async resetKey(key: string): Promise<void> {
    await getPrisma().$executeRaw`DELETE FROM "rate_limits" WHERE "key" = ${this.key(key)}`;
  }
}
