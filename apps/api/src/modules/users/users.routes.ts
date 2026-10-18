import { Router } from 'express';
import { z } from 'zod';
import { createUserSchema, resetPasswordSchema, updateUserSchema, userListQuerySchema } from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { listEnvelope } from '../../lib/pagination';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requirePermission } from '../auth/auth.middleware';
import { createUser, getUser, listUsers, resetUserPassword, updateUser } from './users.service';

const idParams = z.object({ id: z.uuid() });

registry.registerPath({
  method: 'get',
  path: '/users',
  tags: ['Users'],
  summary: 'List staff users (users.view)',
  request: { query: userListQuerySchema },
  responses: { 200: { description: 'Paginated users' } },
});
registry.registerPath({
  method: 'post',
  path: '/users',
  tags: ['Users'],
  summary: 'Create a staff user (users.manage)',
  request: { body: { content: { 'application/json': { schema: createUserSchema } } } },
  responses: { 201: { description: 'Created' }, 409: { description: 'Email already in use' } },
});
registry.registerPath({
  method: 'patch',
  path: '/users/{id}',
  tags: ['Users'],
  summary: 'Update name, status, roles or locations (users.manage). Users are disabled, never deleted.',
  request: { params: idParams, body: { content: { 'application/json': { schema: updateUserSchema } } } },
  responses: { 200: { description: 'Updated' } },
});
registry.registerPath({
  method: 'post',
  path: '/users/{id}/reset-password',
  tags: ['Users'],
  summary: 'Set a temporary password; the user must change it at next login (users.manage)',
  request: { params: idParams, body: { content: { 'application/json': { schema: resetPasswordSchema } } } },
  responses: { 204: { description: 'Password reset' } },
});

export const usersRouter = Router();

usersRouter.get('/users', ...requirePermission('users.view'), async (req, res) => {
  const query = parse(userListQuerySchema, req.query);
  const { rows, total } = await listUsers(query);
  res.json(listEnvelope(rows, total, query));
});

usersRouter.get('/users/:id', ...requirePermission('users.view'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await getUser(id) });
});

usersRouter.post('/users', ...requirePermission('users.manage'), async (req, res) => {
  const input = parse(createUserSchema, req.body);
  res.status(201).json({ data: await createUser(input, req.auth!, requestContext(req)) });
});

usersRouter.patch('/users/:id', ...requirePermission('users.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const input = parse(updateUserSchema, req.body);
  res.json({ data: await updateUser(id, input, req.auth!, requestContext(req)) });
});

usersRouter.post('/users/:id/reset-password', ...requirePermission('users.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { newPassword } = parse(resetPasswordSchema, req.body);
  await resetUserPassword(id, newPassword, req.auth!, requestContext(req));
  res.status(204).end();
});
