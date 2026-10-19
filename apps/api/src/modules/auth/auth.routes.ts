import { Router, type Request, type Response } from 'express';
import {
  authenticatorChangeStartSchema,
  changePasswordSchema,
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  regenerateBackupCodesSchema,
  twoFactorLoginSchema,
  twoFactorSetupSchema,
  type AuthSession,
  type DataEnvelope,
  type LoginStep,
} from '@rhoyards/shared';
import type { Env } from '../../config/env';
import { requestContext } from '../../lib/audit';
import type { Mailer, MailMessage } from '../../lib/mailer';
import { parse } from '../../lib/validation';
import { createRateLimiter } from '../../middleware/rate-limit';
import { registry } from '../../openapi/registry';
import { requireAuth } from './auth.middleware';
import { changePassword, login, logout, sessionPayload } from './auth.service';
import type { AuthConfig } from './auth.types';
import { confirmStaffPasswordReset, requestStaffPasswordReset } from './password-reset.service';
import { sessionCookieName, sessionCookieOptions, type NewSession } from './session.service';
import {
  completeTwoFactorSetup,
  completeTwoFactorSignIn,
  confirmAuthenticatorChange,
  regenerateBackupCodes,
  startAuthenticatorChange,
  twoFactorStatus,
} from './two-factor.service';

registry.registerPath({
  method: 'post',
  path: '/auth/login',
  tags: ['Auth'],
  summary:
    'Staff sign-in, step 1: email or username + password. Returns a challenge: an authenticator code is required next (or, the first time, setting up an authenticator app). No session yet.',
  request: { body: { content: { 'application/json': { schema: loginSchema } } } },
  responses: { 200: { description: 'Password accepted; second step required' }, 401: { description: 'Invalid credentials or locked' } },
});
registry.registerPath({
  method: 'post',
  path: '/auth/login/two-factor',
  tags: ['Auth'],
  summary: 'Staff sign-in, step 2: a 6-digit authenticator code or a backup code. Sets the HttpOnly session cookie and returns the CSRF token.',
  request: { body: { content: { 'application/json': { schema: twoFactorLoginSchema } } } },
  responses: { 200: { description: 'Signed in' }, 401: { description: 'Wrong code, or the challenge expired (details.restart)' } },
});
registry.registerPath({
  method: 'post',
  path: '/auth/login/two-factor-setup',
  tags: ['Auth'],
  summary: 'First sign-in: confirm the new authenticator app with a code from it. Signs in and returns one-time backup codes (shown once).',
  request: { body: { content: { 'application/json': { schema: twoFactorSetupSchema } } } },
  responses: { 200: { description: 'Two-factor enabled and signed in' }, 401: { description: 'Wrong code or expired' } },
});
registry.registerPath({
  method: 'post',
  path: '/auth/password-reset',
  tags: ['Auth'],
  summary: 'Forgot password: emails a single-use reset link if an active account matches. Always answers 202.',
  request: { body: { content: { 'application/json': { schema: passwordResetRequestSchema } } } },
  responses: { 202: { description: 'Accepted' } },
});
registry.registerPath({
  method: 'post',
  path: '/auth/password-reset/confirm',
  tags: ['Auth'],
  summary: 'Set a new password with a reset token; every session is signed out. Two-factor is still required to sign in.',
  request: { body: { content: { 'application/json': { schema: passwordResetConfirmSchema } } } },
  responses: { 204: { description: 'Password changed' }, 422: { description: 'Invalid or expired link' } },
});
registry.registerPath({
  method: 'get',
  path: '/auth/me',
  tags: ['Auth'],
  summary: 'Current user, permissions and CSRF token',
  responses: { 200: { description: 'Session' }, 401: { description: 'Not signed in' } },
});
registry.registerPath({
  method: 'post',
  path: '/auth/logout',
  tags: ['Auth'],
  summary: 'End the current session',
  responses: { 204: { description: 'Signed out' } },
});
registry.registerPath({
  method: 'post',
  path: '/auth/change-password',
  tags: ['Auth'],
  summary: "Change the current user's password; other sessions are signed out",
  request: { body: { content: { 'application/json': { schema: changePasswordSchema } } } },
  responses: { 204: { description: 'Password changed' } },
});
registry.registerPath({
  method: 'get',
  path: '/auth/two-factor',
  tags: ['Auth'],
  summary: 'Two-factor status of the current user: when it was set up and how many backup codes are left',
  responses: { 200: { description: 'Status' } },
});
registry.registerPath({
  method: 'post',
  path: '/auth/two-factor/backup-codes',
  tags: ['Auth'],
  summary: 'Replace the backup codes (needs a current authenticator or backup code). The new codes are shown once.',
  request: { body: { content: { 'application/json': { schema: regenerateBackupCodesSchema } } } },
  responses: { 200: { description: 'New backup codes' }, 422: { description: 'Wrong code' } },
});
registry.registerPath({
  method: 'post',
  path: '/auth/two-factor/change',
  tags: ['Auth'],
  summary: 'Move to a new authenticator app, step 1 (needs the password): returns a new secret to scan',
  request: { body: { content: { 'application/json': { schema: authenticatorChangeStartSchema } } } },
  responses: { 200: { description: 'New secret and challenge' }, 422: { description: 'Wrong password' } },
});
registry.registerPath({
  method: 'post',
  path: '/auth/two-factor/change/confirm',
  tags: ['Auth'],
  summary: 'Move to a new authenticator app, step 2: a code from the new app. Other sessions are signed out; new backup codes returned.',
  request: { body: { content: { 'application/json': { schema: twoFactorSetupSchema } } } },
  responses: { 200: { description: 'New backup codes' }, 422: { description: 'Wrong code' } },
});

const userAgentOf = (req: Request) => (req.get('user-agent') ? { userAgent: req.get('user-agent') } : {});

export function authRouter(cfg: AuthConfig, env: Pick<Env, 'LOGIN_RATE_LIMIT' | 'RATE_LIMIT_STORE'>, mailer: Mailer) {
  const router = Router();
  const cookieName = sessionCookieName(cfg.session);
  const shared = env.RATE_LIMIT_STORE === 'database';
  const window = 15 * 60_000;
  const loginLimiter = createRateLimiter({ name: 'staff-login', windowMs: window, limit: env.LOGIN_RATE_LIMIT, shared });
  // Code attempts are also capped per challenge and count toward the account lockout.
  const codeLimiter = createRateLimiter({ name: 'staff-2fa', windowMs: window, limit: env.LOGIN_RATE_LIMIT * 2, shared });
  const resetLimiter = createRateLimiter({ name: 'staff-password-reset', windowMs: window, limit: env.LOGIN_RATE_LIMIT, shared });

  const signedIn = (res: Response, session: NewSession) => res.cookie(cookieName, session.token, sessionCookieOptions(cfg.session, session.expiresAt));
  const sendInBackground = (req: Request, message: MailMessage) => {
    mailer.send(message).catch((err: unknown) => req.log.error({ err }, 'Sending email failed'));
  };

  router.post('/auth/login', loginLimiter, async (req, res) => {
    const input = parse(loginSchema, req.body);
    const step = await login(input, { ...requestContext(req), ...userAgentOf(req) }, cfg);
    const payload: DataEnvelope<LoginStep> = { data: step };
    res.json(payload);
  });

  router.post('/auth/login/two-factor', codeLimiter, async (req, res) => {
    const input = parse(twoFactorLoginSchema, req.body);
    const { session, auth } = await completeTwoFactorSignIn(input, { ...requestContext(req), ...userAgentOf(req) }, cfg);
    signedIn(res, session);
    const payload: DataEnvelope<AuthSession> = { data: auth };
    res.json(payload);
  });

  router.post('/auth/login/two-factor-setup', codeLimiter, async (req, res) => {
    const input = parse(twoFactorSetupSchema, req.body);
    const { session, auth } = await completeTwoFactorSetup(input, { ...requestContext(req), ...userAgentOf(req) }, cfg);
    signedIn(res, session);
    res.json({ data: auth });
  });

  router.post('/auth/password-reset', resetLimiter, (req, res) => {
    const { identifier } = parse(passwordResetRequestSchema, req.body);
    // Answer first, then look the account up: the response (and its timing) is the same whether or not it exists.
    requestStaffPasswordReset(identifier, requestContext(req), cfg, mailer).catch((err: unknown) =>
      req.log.error({ err }, 'Password reset request failed'),
    );
    res.status(202).json({ data: { message: 'If an account matches, a link to reset the password has been emailed.' } });
  });

  router.post('/auth/password-reset/confirm', resetLimiter, async (req, res) => {
    const input = parse(passwordResetConfirmSchema, req.body);
    sendInBackground(req, await confirmStaffPasswordReset(input, requestContext(req)));
    res.status(204).end();
  });

  router.get('/auth/me', requireAuth({ allowPendingPasswordChange: true }), (req, res) => {
    res.json({ data: sessionPayload(req.auth!) });
  });

  router.post('/auth/logout', requireAuth({ allowPendingPasswordChange: true }), async (req, res) => {
    await logout(req.auth!, requestContext(req));
    res.clearCookie(cookieName, { path: '/' });
    res.status(204).end();
  });

  router.post('/auth/change-password', requireAuth({ allowPendingPasswordChange: true }), async (req, res) => {
    const input = parse(changePasswordSchema, req.body);
    await changePassword(req.auth!, input, requestContext(req));
    res.status(204).end();
  });

  router.get('/auth/two-factor', requireAuth({ allowPendingPasswordChange: true }), async (req, res) => {
    res.json({ data: await twoFactorStatus(req.auth!.user.id) });
  });

  router.post('/auth/two-factor/backup-codes', codeLimiter, requireAuth(), async (req, res) => {
    const { code } = parse(regenerateBackupCodesSchema, req.body);
    res.json({ data: { backupCodes: await regenerateBackupCodes(req.auth!, code, requestContext(req), cfg) } });
  });

  router.post('/auth/two-factor/change', loginLimiter, requireAuth(), async (req, res) => {
    const { password } = parse(authenticatorChangeStartSchema, req.body);
    res.json({ data: await startAuthenticatorChange(req.auth!, password, { ...requestContext(req), ...userAgentOf(req) }, cfg) });
  });

  router.post('/auth/two-factor/change/confirm', codeLimiter, requireAuth(), async (req, res) => {
    const input = parse(twoFactorSetupSchema, req.body);
    res.json({ data: { backupCodes: await confirmAuthenticatorChange(req.auth!, input, requestContext(req), cfg) } });
  });

  return router;
}
