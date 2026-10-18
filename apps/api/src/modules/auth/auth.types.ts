import type { AuthUser } from '@rhoyards/shared';

export interface AuthContext {
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
  user: AuthUser;
  permissions: ReadonlySet<string>;
}

export interface SessionConfig {
  idleMinutes: number;
  absoluteHours: number;
  secureCookie: boolean;
}
