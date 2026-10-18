import type { Db } from './prisma';

interface SequenceRow {
  value: number;
  prefix: string;
  padding: number;
}

/**
 * Next gap-free document number, e.g. JE-000001. Single atomic statement: the row lock is held
 * until the surrounding transaction ends, so a rolled-back transaction does not consume a number.
 */
export async function nextDocumentNumber(db: Db, key: string, defaultPrefix: string): Promise<string> {
  const rows = await db.$queryRaw<SequenceRow[]>`
    INSERT INTO "document_sequences" ("key", "prefix", "next_value", "padding")
    VALUES (${key}, ${defaultPrefix}, 2, 6)
    ON CONFLICT ("key") DO UPDATE SET "next_value" = "document_sequences"."next_value" + 1
    RETURNING "next_value" - 1 AS "value", "prefix", "padding"`;
  const row = rows[0];
  if (!row) throw new Error(`Sequence ${key} did not return a value`);
  return `${row.prefix}${String(row.value).padStart(row.padding, '0')}`;
}
