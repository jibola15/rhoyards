import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { ErrorCode, type ErrorBody } from '@rhoyards/shared';
import { AppError } from '../lib/errors';

function body(code: string, message: string, requestId: unknown, details?: unknown): ErrorBody {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      ...(requestId ? { requestId: String(requestId) } : {}),
    },
  };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(body(ErrorCode.NOT_FOUND, `Route ${req.method} ${req.path} not found`, req.id));
};

interface BodyParserError {
  type?: string;
  status?: number;
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (err instanceof AppError) {
      res.status(err.status).json(body(err.code, err.message, req.id, err.details));
      return;
    }

    if (err instanceof ZodError) {
      const details = err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
      res.status(400).json(body(ErrorCode.VALIDATION_ERROR, 'Request validation failed', req.id, details));
      return;
    }

    const parserType = (err as BodyParserError | null)?.type;
    if (parserType === 'entity.parse.failed') {
      res.status(400).json(body(ErrorCode.VALIDATION_ERROR, 'Malformed JSON request body', req.id));
      return;
    }
    if (parserType === 'entity.too.large') {
      res.status(413).json(body(ErrorCode.PAYLOAD_TOO_LARGE, 'Request body is too large', req.id));
      return;
    }

    // Unexpected: log full detail server-side, return nothing internal to the client.
    logger.error({ err, requestId: req.id }, 'Unhandled error');
    res.status(500).json(body(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred', req.id));
  };
}
