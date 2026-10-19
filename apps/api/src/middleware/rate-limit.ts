import { rateLimit } from 'express-rate-limit';
import { ErrorCode, type ErrorBody } from '@rhoyards/shared';
import { PostgresRateLimitStore } from '../lib/rate-limit-store';

interface LimiterOptions {
  /** Unique per limiter: names its counters in the shared store. */
  name: string;
  windowMs: number;
  limit: number;
  /** Count in the database (shared by every API instance) instead of this process's memory. */
  shared: boolean;
}

/** Rate limiter that responds with the standard error envelope. */
export function createRateLimiter({ name, windowMs, limit, shared }: LimiterOptions) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(shared ? { store: new PostgresRateLimitStore(name) } : {}),
    handler: (req, res) => {
      const payload: ErrorBody = {
        error: {
          code: ErrorCode.RATE_LIMITED,
          message: 'Too many requests, please try again later',
          ...(req.id ? { requestId: String(req.id) } : {}),
        },
      };
      res.status(429).json(payload);
    },
  });
}
