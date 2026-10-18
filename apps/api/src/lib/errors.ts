import { ErrorCode } from '@rhoyards/shared';

/** An expected, client-facing error. Anything else thrown is treated as an internal error. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'Resource') => new AppError(404, ErrorCode.NOT_FOUND, `${what} not found`);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, ErrorCode.FORBIDDEN, message);
export const unauthenticated = (message = 'Authentication required') =>
  new AppError(401, ErrorCode.UNAUTHENTICATED, message);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, ErrorCode.CONFLICT, message, details);
export const businessRule = (message: string, details?: unknown) =>
  new AppError(422, ErrorCode.BUSINESS_RULE, message, details);
