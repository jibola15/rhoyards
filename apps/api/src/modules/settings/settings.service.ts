import { Prisma } from '@prisma/client';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  settingsSchema,
  type LocationSummary,
  type Settings,
  type SettingsPatch,
  type TaxRateSummary,
  type locationInputSchema,
  type locationUpdateSchema,
  type taxRateInputSchema,
  type taxRateUpdateSchema,
} from '@rhoyards/shared';
import type { z } from 'zod';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { businessRule, conflict, notFound } from '../../lib/errors';
import { getPrisma, transaction, type Db } from '../../lib/prisma';

// ── Business settings ────────────────────────────────────────────────────────

/** Stored values merged over defaults, so a newly-added section always has a valid value. */
export async function getSettings(db: Db = getPrisma()): Promise<Settings> {
  const rows = await db.setting.findMany({ where: { key: { in: SETTINGS_KEYS } } });
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const merged = Object.fromEntries(
    SETTINGS_KEYS.map((key) => [key, { ...DEFAULT_SETTINGS[key], ...((stored[key] as object | undefined) ?? {}) }]),
  );
  return settingsSchema.parse(merged);
}

export async function updateSettings(patch: SettingsPatch, ctx: RequestContext): Promise<Settings> {
  return transaction(async (tx) => {
    const before = await getSettings(tx);
    const changed: Partial<Settings> = {};
    for (const key of SETTINGS_KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      await tx.setting.upsert({
        where: { key },
        create: { key, value: value as Prisma.InputJsonValue, updatedById: ctx.actorId },
        update: { value: value as Prisma.InputJsonValue, updatedById: ctx.actorId },
      });
      Object.assign(changed, { [key]: value });
    }
    const after = await getSettings(tx);
    const beforeChanged = Object.fromEntries(Object.keys(changed).map((k) => [k, before[k as keyof Settings]]));
    await writeAudit(tx, ctx, { action: 'settings.updated', entityType: 'settings', before: beforeChanged, after: changed });
    return after;
  });
}

// ── Tax rates ────────────────────────────────────────────────────────────────

type TaxRow = Prisma.TaxRateGetPayload<object>;
const toTax = (t: TaxRow): TaxRateSummary => ({
  id: t.id,
  code: t.code,
  name: t.name,
  kind: t.kind,
  rate: t.rate.toFixed(4),
  isActive: t.isActive,
});

export async function listTaxRates(): Promise<TaxRateSummary[]> {
  const rows = await getPrisma().taxRate.findMany({ orderBy: [{ isActive: 'desc' }, { code: 'asc' }] });
  return rows.map(toTax);
}

export async function createTaxRate(input: z.infer<typeof taxRateInputSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    if (await tx.taxRate.findUnique({ where: { code: input.code } })) {
      throw conflict('A tax rate with this code already exists', { field: 'code' });
    }
    // Standard rates post to the system VAT accounts by default.
    const [vatOut, vatIn] = await Promise.all([
      tx.account.findUnique({ where: { systemKey: 'VAT_OUTPUT' } }),
      tx.account.findUnique({ where: { systemKey: 'VAT_INPUT' } }),
    ]);
    const created = await tx.taxRate.create({
      data: {
        code: input.code,
        name: input.name,
        kind: input.kind,
        rate: new Prisma.Decimal(input.rate),
        isActive: input.isActive,
        outputAccountId: input.kind === 'STANDARD' ? (vatOut?.id ?? null) : null,
        inputAccountId: input.kind === 'STANDARD' ? (vatIn?.id ?? null) : null,
      },
    });
    const summary = toTax(created);
    await writeAudit(tx, ctx, { action: 'tax_rate.created', entityType: 'tax_rate', entityId: created.id, after: summary });
    return summary;
  });
}

export async function updateTaxRate(id: string, input: z.infer<typeof taxRateUpdateSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const existing = await tx.taxRate.findUnique({ where: { id } });
    if (!existing) throw notFound('Tax rate');
    if (input.rate !== undefined && existing.kind !== 'STANDARD' && !new Prisma.Decimal(input.rate).isZero()) {
      throw businessRule('Zero-rated and exempt taxes must have a 0% rate');
    }
    // Rate changes apply to new transactions only: documents snapshot the rate they were taxed at.
    const updated = await tx.taxRate.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.rate !== undefined ? { rate: new Prisma.Decimal(input.rate) } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    const after = toTax(updated);
    await writeAudit(tx, ctx, { action: 'tax_rate.updated', entityType: 'tax_rate', entityId: id, before: toTax(existing), after });
    return after;
  });
}

// ── Locations ────────────────────────────────────────────────────────────────

type LocationRow = Prisma.LocationGetPayload<object>;
const toLocation = (l: LocationRow): LocationSummary => ({
  id: l.id,
  code: l.code,
  name: l.name,
  type: l.type,
  isPosEnabled: l.isPosEnabled,
  isOnlineFulfilment: l.isOnlineFulfilment,
  address: l.address,
  phone: l.phone,
  isActive: l.isActive,
});

export async function listLocations(): Promise<LocationSummary[]> {
  const rows = await getPrisma().location.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
  return rows.map(toLocation);
}

/**
 * The online shop sells the stock of one store. Choosing a new one moves the shop there; orders already placed keep
 * the store they reserved stock at.
 */
async function makeOnlyOnlineStore(tx: Prisma.TransactionClient, id: string) {
  await tx.location.updateMany({ where: { id: { not: id }, isOnlineFulfilment: true }, data: { isOnlineFulfilment: false } });
}

export async function createLocation(input: z.infer<typeof locationInputSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    if (await tx.location.findUnique({ where: { code: input.code } })) {
      throw conflict('A location with this code already exists', { field: 'code' });
    }
    const created = await tx.location.create({
      data: { ...input, address: input.address ?? null, phone: input.phone ?? null },
    });
    if (created.isOnlineFulfilment) await makeOnlyOnlineStore(tx, created.id);
    const summary = toLocation(created);
    await writeAudit(tx, ctx, { action: 'location.created', entityType: 'location', entityId: created.id, after: summary });
    return summary;
  });
}

export async function updateLocation(id: string, input: z.infer<typeof locationUpdateSchema>, ctx: RequestContext) {
  return transaction(async (tx) => {
    const existing = await tx.location.findUnique({ where: { id } });
    if (!existing) throw notFound('Location');
    if (input.isActive === false && existing.isActive) {
      const otherActive = await tx.location.count({ where: { id: { not: id }, isActive: true } });
      if (otherActive === 0) throw businessRule('At least one active location is required');
    }
    const updated = await tx.location.update({ where: { id }, data: input });
    if (input.isOnlineFulfilment) await makeOnlyOnlineStore(tx, id);
    const after = toLocation(updated);
    await writeAudit(tx, ctx, { action: 'location.updated', entityType: 'location', entityId: id, before: toLocation(existing), after });
    return after;
  });
}
