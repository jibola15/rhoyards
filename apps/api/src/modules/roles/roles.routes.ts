import { Router } from 'express';
import { z } from 'zod';
import { roleInputSchema, roleUpdateSchema } from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requirePermission } from '../auth/auth.middleware';
import { createRole, deleteRole, listRoles, permissionCatalogue, updateRole } from './roles.service';

const idParams = z.object({ id: z.uuid() });

registry.registerPath({ method: 'get', path: '/roles', tags: ['Roles'], summary: 'List roles (users.view)', responses: { 200: { description: 'Roles' } } });
registry.registerPath({ method: 'get', path: '/permissions', tags: ['Roles'], summary: 'Permission catalogue (users.view)', responses: { 200: { description: 'Permissions' } } });
registry.registerPath({
  method: 'post',
  path: '/roles',
  tags: ['Roles'],
  summary: 'Create a custom role (roles.manage)',
  request: { body: { content: { 'application/json': { schema: roleInputSchema } } } },
  responses: { 201: { description: 'Created' } },
});
registry.registerPath({
  method: 'patch',
  path: '/roles/{id}',
  tags: ['Roles'],
  summary: 'Rename a role or replace its permissions (roles.manage). The Owner role is fixed.',
  request: { params: idParams, body: { content: { 'application/json': { schema: roleUpdateSchema } } } },
  responses: { 200: { description: 'Updated' } },
});
registry.registerPath({
  method: 'delete',
  path: '/roles/{id}',
  tags: ['Roles'],
  summary: 'Delete an unused custom role (roles.manage)',
  request: { params: idParams },
  responses: { 204: { description: 'Deleted' } },
});

export const rolesRouter = Router();

rolesRouter.get('/roles', ...requirePermission('users.view'), async (_req, res) => {
  res.json({ data: await listRoles() });
});

rolesRouter.get('/permissions', ...requirePermission('users.view'), (_req, res) => {
  res.json({ data: permissionCatalogue() });
});

rolesRouter.post('/roles', ...requirePermission('roles.manage'), async (req, res) => {
  const input = parse(roleInputSchema, req.body);
  res.status(201).json({ data: await createRole(input, req.auth!, requestContext(req)) });
});

rolesRouter.patch('/roles/:id', ...requirePermission('roles.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const input = parse(roleUpdateSchema, req.body);
  res.json({ data: await updateRole(id, input, req.auth!, requestContext(req)) });
});

rolesRouter.delete('/roles/:id', ...requirePermission('roles.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await deleteRole(id, requestContext(req));
  res.status(204).end();
});
