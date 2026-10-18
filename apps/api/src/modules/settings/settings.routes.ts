import { Router } from 'express';
import { z } from 'zod';
import {
  locationInputSchema,
  locationUpdateSchema,
  settingsPatchSchema,
  taxRateInputSchema,
  taxRateUpdateSchema,
} from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requireAuth, requirePermission } from '../auth/auth.middleware';
import {
  createLocation,
  createTaxRate,
  getSettings,
  listLocations,
  listTaxRates,
  updateLocation,
  updateSettings,
  updateTaxRate,
} from './settings.service';

const idParams = z.object({ id: z.uuid() });

registry.registerPath({ method: 'get', path: '/settings', tags: ['Settings'], summary: 'Business settings (settings.view)', responses: { 200: { description: 'Settings' } } });
registry.registerPath({
  method: 'patch',
  path: '/settings',
  tags: ['Settings'],
  summary: 'Replace one or more settings sections (settings.manage)',
  request: { body: { content: { 'application/json': { schema: settingsPatchSchema } } } },
  responses: { 200: { description: 'Updated settings' } },
});
registry.registerPath({ method: 'get', path: '/tax-rates', tags: ['Settings'], summary: 'Tax rates (any signed-in user)', responses: { 200: { description: 'Tax rates' } } });
registry.registerPath({
  method: 'post',
  path: '/tax-rates',
  tags: ['Settings'],
  summary: 'Create a tax rate (taxes.manage)',
  request: { body: { content: { 'application/json': { schema: taxRateInputSchema } } } },
  responses: { 201: { description: 'Created' } },
});
registry.registerPath({
  method: 'patch',
  path: '/tax-rates/{id}',
  tags: ['Settings'],
  summary: 'Update a tax rate; applies to new transactions only (taxes.manage)',
  request: { params: idParams, body: { content: { 'application/json': { schema: taxRateUpdateSchema } } } },
  responses: { 200: { description: 'Updated' } },
});
registry.registerPath({ method: 'get', path: '/locations', tags: ['Settings'], summary: 'Locations (any signed-in user)', responses: { 200: { description: 'Locations' } } });
registry.registerPath({
  method: 'post',
  path: '/locations',
  tags: ['Settings'],
  summary: 'Create a location (locations.manage)',
  request: { body: { content: { 'application/json': { schema: locationInputSchema } } } },
  responses: { 201: { description: 'Created' } },
});
registry.registerPath({
  method: 'patch',
  path: '/locations/{id}',
  tags: ['Settings'],
  summary: 'Update or deactivate a location (locations.manage)',
  request: { params: idParams, body: { content: { 'application/json': { schema: locationUpdateSchema } } } },
  responses: { 200: { description: 'Updated' } },
});

export const settingsRouter = Router();

settingsRouter.get('/settings', ...requirePermission('settings.view'), async (_req, res) => {
  res.json({ data: await getSettings() });
});

settingsRouter.patch('/settings', ...requirePermission('settings.manage'), async (req, res) => {
  const patch = parse(settingsPatchSchema, req.body);
  res.json({ data: await updateSettings(patch, requestContext(req)) });
});

settingsRouter.get('/tax-rates', requireAuth(), async (_req, res) => {
  res.json({ data: await listTaxRates() });
});

settingsRouter.post('/tax-rates', ...requirePermission('taxes.manage'), async (req, res) => {
  const input = parse(taxRateInputSchema, req.body);
  res.status(201).json({ data: await createTaxRate(input, requestContext(req)) });
});

settingsRouter.patch('/tax-rates/:id', ...requirePermission('taxes.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const input = parse(taxRateUpdateSchema, req.body);
  res.json({ data: await updateTaxRate(id, input, requestContext(req)) });
});

settingsRouter.get('/locations', requireAuth(), async (_req, res) => {
  res.json({ data: await listLocations() });
});

settingsRouter.post('/locations', ...requirePermission('locations.manage'), async (req, res) => {
  const input = parse(locationInputSchema, req.body);
  res.status(201).json({ data: await createLocation(input, requestContext(req)) });
});

settingsRouter.patch('/locations/:id', ...requirePermission('locations.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const input = parse(locationUpdateSchema, req.body);
  res.json({ data: await updateLocation(id, input, requestContext(req)) });
});
