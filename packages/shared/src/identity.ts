import { z } from 'zod';
import { listQuerySchema } from './api';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(254));

/** Password policy: length over complexity (NIST SP 800-63B). */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters');

/** Staff sign-in name: lower case, and never containing "@" so it cannot be mistaken for an email. */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, 'Use 3–32 letters, digits, dots, dashes or underscores, starting with a letter or digit');

/** Email or username. */
const identifierSchema = z.string().trim().toLowerCase().min(1, 'Enter your email or username').max(254);

export const loginSchema = z.object({
  identifier: identifierSchema,
  password: z.string().min(1, 'Password is required').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** A 6-digit authenticator code or a 10-character backup code; spaces and dashes are ignored. */
export const twoFactorCodeSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, '').toLowerCase())
  .pipe(z.string().regex(/^(\d{6}|[a-z0-9]{10})$/, 'Enter the 6-digit code from your app, or a backup code'));

/** Only an authenticator-app code (setting up or changing the app proves it works). */
export const totpCodeSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/\s/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your app'));

const challengeTokenSchema = z.string().min(20).max(200);

export const twoFactorLoginSchema = z.object({ challengeToken: challengeTokenSchema, code: twoFactorCodeSchema });
export const twoFactorSetupSchema = z.object({ challengeToken: challengeTokenSchema, code: totpCodeSchema });
export const regenerateBackupCodesSchema = z.object({ code: twoFactorCodeSchema });
export const authenticatorChangeStartSchema = z.object({ password: z.string().min(1, 'Password is required').max(128) });

export const passwordResetRequestSchema = z.object({ identifier: identifierSchema });
export const passwordResetConfirmSchema = z.object({ token: challengeTokenSchema, newPassword: passwordSchema });
export type PasswordResetConfirmInput = z.infer<typeof passwordResetConfirmSchema>;

export interface TwoFactorSetup {
  /** Base32 secret, for typing into an app when the QR code cannot be scanned. */
  secret: string;
  /** otpauth:// URI the QR code encodes. */
  otpauthUri: string;
}

/** What `POST /auth/login` returns: the password was right; a second step is needed before a session exists. */
export type LoginStep =
  | { next: 'TWO_FACTOR'; challengeToken: string; expiresAt: string }
  | { next: 'TWO_FACTOR_SETUP'; challengeToken: string; expiresAt: string; setup: TwoFactorSetup };

export interface AuthenticatorChange {
  challengeToken: string;
  expiresAt: string;
  setup: TwoFactorSetup;
}

export interface BackupCodes {
  backupCodes: string[];
}

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required').max(128),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'New password must differ from the current password',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const userStatusSchema = z.enum(['ACTIVE', 'DISABLED']);

const uuidList = z.array(z.uuid()).max(50);

export const createUserSchema = z.object({
  email: emailSchema,
  username: usernameSchema.optional(),
  fullName: z.string().trim().min(1, 'Full name is required').max(120),
  password: passwordSchema,
  roleIds: uuidList.min(1, 'Assign at least one role'),
  locationIds: uuidList.default([]),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120).optional(),
    username: usernameSchema.nullable().optional(),
    status: userStatusSchema.optional(),
    roleIds: uuidList.min(1, 'Assign at least one role').optional(),
    locationIds: uuidList.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const resetPasswordSchema = z.object({ newPassword: passwordSchema });

export const userListQuerySchema = listQuerySchema.extend({
  status: userStatusSchema.optional(),
  roleId: z.uuid().optional(),
});

export const roleInputSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Use UPPER_SNAKE_CASE, e.g. SENIOR_CASHIER'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(z.string()).max(200),
});
export const roleUpdateSchema = roleInputSchema.omit({ code: true }).partial();

export interface AuthUser {
  id: string;
  email: string;
  username: string | null;
  fullName: string;
  mustChangePassword: boolean;
  roles: { id: string; code: string; name: string }[];
  locationIds: string[];
  permissions: string[];
}

export interface AuthSession {
  user: AuthUser;
  csrfToken: string;
  expiresAt: string;
}

export interface UserSummary {
  id: string;
  email: string;
  username: string | null;
  fullName: string;
  status: 'ACTIVE' | 'DISABLED';
  mustChangePassword: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  roles: { id: string; code: string; name: string }[];
  locations: { id: string; code: string; name: string }[];
}

export interface RoleSummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}
