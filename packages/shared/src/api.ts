import { z } from 'zod';

/** Machine-readable error codes returned in `error.code`. */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  BUSINESS_RULE: 'BUSINESS_RULE',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

export const paginationMetaSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
});
export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

/** Zod schema for a `{ data: T }` response, used for OpenAPI docs and client-side parsing. */
export const dataEnvelopeSchema = <T extends z.ZodType>(data: T) => z.object({ data });

export interface DataEnvelope<T> {
  data: T;
}

export interface ListEnvelope<T> {
  data: T[];
  meta: PaginationMeta;
}

/** Standard list query parameters: `?page=1&pageSize=25&sort=name:asc&q=lipstick`. */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z
    .string()
    .regex(/^[a-zA-Z0-9_.]+:(asc|desc)$/)
    .optional(),
  q: z.string().trim().max(200).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const healthSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number(),
  time: z.string(),
});
export type Health = z.infer<typeof healthSchema>;
