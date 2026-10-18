import { Router } from 'express';
import { changePasswordSchema, loginSchema, type DataEnvelope, type AuthSession } from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { parse } from '../../lib/validation';
import { createRateLimiter } from '../../middleware/rate-limit';
import { registry } from '../../openapi/registry';
import { requireAuth } from './auth.middleware';
import { changePassword, login, logout, sessionPayload } from './auth.service';
import type { SessionConfig } from './auth.types';
import { sessionCookieName, sessionCookieOptions } from './session.service';

registry.registerPath({
  method: 'post',
  path: '/auth/login',
  tags: ['Auth'],
  summary: 'Staff login; sets an HttpOnly session cookie and returns the CSRF token',
  request: { body: { content: { 'application/json': { schema: loginSchema } } } },
  responses: { 200: { description: 'Signed in' }, 401: { description: 'Invalid credentials or locked' } },
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

export function authRouter(cfg: SessionConfig, loginLimit: number) {
  const router = Router();
  const cookieName = sessionCookieName(cfg);
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60_000, limit: loginLimit });

  router.post('/auth/login', loginLimiter, async (req, res) => {
    const input = parse(loginSchema, req.body);
    const { session, auth } = await login(
      input,
      { ...requestContext(req), ...(req.get('user-agent') ? { userAgent: req.get('user-agent') } : {}) },
      cfg,
    );
    res.cookie(cookieName, session.token, sessionCookieOptions(cfg, session.expiresAt));
    const payload: DataEnvelope<AuthSession> = { data: auth };
    res.json(payload);
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

  return router;
}
