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

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

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
  fullName: z.string().trim().min(1, 'Full name is required').max(120),
  password: passwordSchema,
  roleIds: uuidList.min(1, 'Assign at least one role'),
  locationIds: uuidList.default([]),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120).optional(),
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
  fullName: string;
  status: 'ACTIVE' | 'DISABLED';
  mustChangePassword: boolean;
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
