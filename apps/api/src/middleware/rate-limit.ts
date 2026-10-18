import { rateLimit } from 'express-rate-limit';
import { ErrorCode, type ErrorBody } from '@rhoyards/shared';

interface LimiterOptions {
  windowMs: number;
  limit: number;
}

/** Rate limiter that responds with the standard error envelope. */
export function createRateLimiter({ windowMs, limit }: LimiterOptions) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
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
