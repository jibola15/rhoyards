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

/** Everything the staff sign-in, two-factor and password-reset flows need. */
export interface AuthConfig {
  session: SessionConfig;
  /** Encrypts authenticator secrets at rest. */
  twoFactorKey: Buffer;
  /** Shown as the account's issuer in authenticator apps. */
  issuer: string;
  backofficeUrl: string;
  storefrontUrl: string;
}
