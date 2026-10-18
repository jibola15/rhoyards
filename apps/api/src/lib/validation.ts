import type { z } from 'zod';

/**
 * Parse untrusted input with a Zod schema. Throws ZodError on failure, which the
 * central error handler turns into a 400 VALIDATION_ERROR response.
 */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  return schema.parse(value);
}
