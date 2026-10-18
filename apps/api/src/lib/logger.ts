import { pino, type Logger } from 'pino';
import type { Env } from '../config/env';

export function createLogger(env: Pick<Env, 'LOG_LEVEL'>): Logger {
  return pino({
    level: env.LOG_LEVEL,
    // Credentials and session cookies must never reach the logs.
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.passwordHash',
      ],
      censor: '[REDACTED]',
    },
  });
}
