import { Prisma, type StockMovementType } from '@prisma/client';
import { dec, Decimal, roundCost, roundMoney, ZERO } from '@rhoyards/shared';
import { AppError } from '../../lib/errors';

type Tx = Prisma.TransactionClient;

/**
 * The inventory engine. All stock quantities change here and nowhere else.
 *
 * Costing: moving weighted-average per variant, company-wide. The variant row holds stock_qty and
 * stock_value (Σ of non-transfer movement values); avg_cost = stock_value / stock_qty. Issuing the whole
 * remaining quantity releases the whole remaining value, so rounding never accumulates.
 *
 * Concurrency: openStockSession() locks the variant rows (FOR UPDATE, ordered by id) and then the balance
 * rows (ordered by variant, location). Every stock operation on a variant is therefore serialised, and
 * because locks are always taken in the same order, two transactions cannot deadlock on each other.
 */

export interface StockKey {
  variantId: string;
  locationId: string;
}

export interface MovementSource {
  type: string;
  id: string;
  lineId?: string;
}

export type ExpiredPolicy = 'block' | 'allow';

export interface ReceiveInput {
  variantId: string;
  locationId: string;
  qty: Decimal;
  unitCost: Decimal;
  type: StockMovementType;
  source: MovementSource;
  batch?: { lotNumber?: string | undefined; mfgDate?: Date | undefined; expiryDate?: Date | undefined } | undefined;
  note?: string | undefined;
}

export interface IssueInput {
  variantId: string;
  locationId: string;
  qty: Decimal;
  type: StockMovementType;
  source: MovementSource;
  /** Take from this lot only (batch-tracked items). Otherwise lots are picked first-expiry-first-out. */
  lotNumber?: string | undefined;
  /** Only when settings allow it and the actor holds stock.negative.allow; never for batch-tracked items. */
  allowNegative?: boolean;
  expired?: ExpiredPolicy;
  /** Respect quantities reserved for online orders (default true). */
  respectReservations?: boolean;
  note?: string | undefined;
}

export interface MovementResult {
  movementId: string;
  batchId: string | null;
  lotNumber: string | null;
  qtyChange: Decimal;
  totalCost: Decimal;
}

export interface IssueResult {
  movements: MovementResult[];
  qty: Decimal;
  totalCost: Decimal;
  /** Average unit cost of this issue (total / qty, 4 dp). */
  unitCost: Decimal;
}

interface VariantState {
  id: string;
  sku: string;
  name: string;
  productName: string;
  isBatchTracked: boolean;
  isExpiryTracked: boolean;
  stockQty: Decimal;
  stockValue: Decimal;
  avgCost: Decimal;
}

interface BalanceState {
  id: string;
  qtyOnHand: Decimal;
  qtyReserved: Decimal;
}

const insufficient = (message: string, details: unknown) => new AppError(409, 'INSUFFICIENT_STOCK', message, details);
const invalid = (message: string, details?: unknown) => new AppError(400, 'VALIDATION_ERROR', message, details);

const keyOf = (variantId: string, locationId: string) => `${variantId}:${locationId}`;

function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export class StockSession {
  private readonly today: Date;

  constructor(
    private readonly tx: Tx,
    private readonly actorId: string,
    private readonly variants: Map<string, VariantState>,
    private readonly balances: Map<string, BalanceState>,
    now: Date,
  ) {
    this.today = dateOnly(now);
  }

  variant(variantId: string): VariantState {
    const v = this.variants.get(variantId);
    if (!v) throw new Error(`Variant ${variantId} was not locked in this stock session`);
    return v;
  }

  private balance(variantId: string, locationId: string): BalanceState {
    const b = this.balances.get(keyOf(variantId, locationId));
    if (!b) throw new Error(`Balance ${variantId}@${locationId} was not locked in this stock session`);
    return b;
  }

  qtyOnHand(variantId: string, locationId: string): Decimal {
    return this.balance(variantId, locationId).qtyOnHand;
  }

  private async writeVariant(v: VariantState) {
    await this.tx.productVariant.update({
      where: { id: v.id },
      data: {
        stockQty: new Prisma.Decimal(v.stockQty.toFixed(3)),
        stockValue: new Prisma.Decimal(v.stockValue.toFixed(2)),
        avgCost: new Prisma.Decimal(v.avgCost.toFixed(4)),
      },
    });
  }

  private async writeBalance(b: BalanceState) {
    await this.tx.inventoryBalance.update({
      where: { id: b.id },
      data: { qtyOnHand: new Prisma.Decimal(b.qtyOnHand.toFixed(3)), qtyReserved: new Prisma.Decimal(b.qtyReserved.toFixed(3)) },
    });
  }

  private async createMovement(data: {
    variant: VariantState;
    locationId: string;
    batchId: string | null;
    type: StockMovementType;
    qtyChange: Decimal;
    unitCost: Decimal;
    totalCost: Decimal;
    qtyAfter: Decimal;
    source: MovementSource;
    note?: string | undefined;
  }) {
    const m = await this.tx.stockMovement.create({
      data: {
        variantId: data.variant.id,
        locationId: data.locationId,
        batchId: data.batchId,
        type: data.type,
        qtyChange: new Prisma.Decimal(data.qtyChange.toFixed(3)),
        unitCost: new Prisma.Decimal(roundCost(data.unitCost).toFixed(4)),
        totalCost: new Prisma.Decimal(data.totalCost.toFixed(2)),
        qtyAfter: new Prisma.Decimal(data.qtyAfter.toFixed(3)),
        avgCostAfter: new Prisma.Decimal(data.variant.avgCost.toFixed(4)),
        sourceType: data.source.type,
        sourceId: data.source.id,
        sourceLineId: data.source.lineId ?? null,
        note: data.note ?? null,
        createdById: this.actorId,
      },
      select: { id: true },
    });
    return m.id;
  }

  /** Resolves the lot for an inbound movement of a batch-tracked item, creating it if new. */
  private async inboundBatch(v: VariantState, locationId: string, batch: ReceiveInput['batch'], qty: Decimal) {
    if (!v.isBatchTracked) return null;
    const expiry = batch?.expiryDate ? dateOnly(batch.expiryDate) : undefined;
    if (v.isExpiryTracked && !expiry) {
      throw invalid(`${v.sku}: an expiry date is required for this product`, { variantId: v.id, field: 'expiryDate' });
    }
    const lotNumber = batch?.lotNumber?.trim() || (expiry ? `EXP-${isoDate(expiry)}` : undefined);
    if (!lotNumber) throw invalid(`${v.sku}: a lot number is required for this product`, { variantId: v.id, field: 'lotNumber' });

    const existing = await this.tx.inventoryBatch.findUnique({
      where: { variantId_locationId_lotNumber: { variantId: v.id, locationId, lotNumber } },
    });
    if (existing) {
      if (expiry && existing.expiryDate && isoDate(existing.expiryDate) !== isoDate(expiry)) {
        throw new AppError(409, 'CONFLICT', `${v.sku}: lot ${lotNumber} already exists with expiry ${isoDate(existing.expiryDate)}`, {
          variantId: v.id,
          field: 'expiryDate',
        });
      }
      const updated = await this.tx.inventoryBatch.update({
        where: { id: existing.id },
        data: { qtyOnHand: { increment: new Prisma.Decimal(qty.toFixed(3)) } },
      });
      return { id: updated.id, lotNumber };
    }
    const created = await this.tx.inventoryBatch.create({
      data: {
        variantId: v.id,
        locationId,
        lotNumber,
        expiryDate: expiry ?? null,
        mfgDate: batch?.mfgDate ? dateOnly(batch.mfgDate) : null,
        qtyOnHand: new Prisma.Decimal(qty.toFixed(3)),
      },
    });
    return { id: created.id, lotNumber };
  }

  /** Stock in with a cost: updates the moving average. */
  async receive(input: ReceiveInput): Promise<MovementResult> {
    if (input.qty.lte(ZERO)) throw invalid('Received quantity must be positive');
    if (input.unitCost.isNegative()) throw invalid('Unit cost cannot be negative');
    const v = this.variant(input.variantId);
    const bal = this.balance(input.variantId, input.locationId);
    const batch = await this.inboundBatch(v, input.locationId, input.batch, input.qty);

    const valueIn = roundMoney(input.qty.times(input.unitCost));
    const newQty = v.stockQty.plus(input.qty);
    const newValue = v.stockValue.plus(valueIn);
    v.stockQty = newQty;
    v.stockValue = newValue;
    v.avgCost = newQty.gt(ZERO) && newValue.gte(ZERO) ? roundCost(newValue.dividedBy(newQty)) : roundCost(input.unitCost);
    bal.qtyOnHand = bal.qtyOnHand.plus(input.qty);

    await this.writeVariant(v);
    await this.writeBalance(bal);
    const movementId = await this.createMovement({
      variant: v,
      locationId: input.locationId,
      batchId: batch?.id ?? null,
      type: input.type,
      qtyChange: input.qty,
      unitCost: input.unitCost,
      totalCost: valueIn,
      qtyAfter: bal.qtyOnHand,
      source: input.source,
      note: input.note,
    });
    return { movementId, batchId: batch?.id ?? null, lotNumber: batch?.lotNumber ?? null, qtyChange: input.qty, totalCost: valueIn };
  }

  /** Picks lots for an outbound quantity (FEFO unless a lot is named). */
  private async allocateBatches(v: VariantState, locationId: string, qty: Decimal, lotNumber: string | undefined, expired: ExpiredPolicy) {
    const batches = await this.tx.inventoryBatch.findMany({
      where: {
        variantId: v.id,
        locationId,
        qtyOnHand: { gt: 0 },
        status: 'AVAILABLE',
        ...(lotNumber ? { lotNumber } : {}),
      },
      orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { receivedAt: 'asc' }],
    });
    const isExpired = (b: { expiryDate: Date | null }) => b.expiryDate !== null && b.expiryDate < this.today;
    const usable = expired === 'block' ? batches.filter((b) => !isExpired(b)) : batches;

    const allocations: { id: string; lotNumber: string; qty: Decimal }[] = [];
    let remaining = qty;
    for (const b of usable) {
      if (remaining.lte(ZERO)) break;
      const take = Decimal.min(remaining, dec(b.qtyOnHand.toString()));
      allocations.push({ id: b.id, lotNumber: b.lotNumber, qty: take });
      remaining = remaining.minus(take);
    }
    if (remaining.gt(ZERO)) {
      const usableQty = qty.minus(remaining);
      const expiredQty = batches.filter(isExpired).reduce((s, b) => s.plus(b.qtyOnHand.toString()), ZERO);
      const details = { variantId: v.id, sku: v.sku, requested: qty.toFixed(3), available: usableQty.toFixed(3), ...(lotNumber ? { lotNumber } : {}) };
      if (expired === 'block' && expiredQty.gt(ZERO)) {
        throw new AppError(409, 'INSUFFICIENT_STOCK', `${v.sku}: only ${usableQty.toFixed(3)} unexpired in stock (${expiredQty.toFixed(3)} expired and blocked from use)`, {
          ...details,
          expired: expiredQty.toFixed(3),
        });
      }
      throw insufficient(`${v.sku}: only ${usableQty.toFixed(3)} available${lotNumber ? ` in lot ${lotNumber}` : ''}`, details);
    }
    return allocations;
  }

  /**
   * Holds quantity for an online order: raises qty_reserved, which every other issue respects (POS included),
   * so both channels sell from one pool. For batch-tracked items only usable lots count (expired lots are excluded
   * when the expired policy blocks them). No stock moves and nothing is valued until the reservation is consumed.
   */
  async reserve(input: { variantId: string; locationId: string; qty: Decimal; expired?: ExpiredPolicy }): Promise<void> {
    if (input.qty.lte(ZERO)) throw invalid('Reserved quantity must be positive');
    const v = this.variant(input.variantId);
    const bal = this.balance(input.variantId, input.locationId);
    let available = bal.qtyOnHand.minus(bal.qtyReserved);
    if (v.isBatchTracked) {
      const lots = await this.tx.inventoryBatch.aggregate({
        where: {
          variantId: v.id,
          locationId: input.locationId,
          status: 'AVAILABLE',
          qtyOnHand: { gt: 0 },
          ...((input.expired ?? 'block') === 'block' ? { OR: [{ expiryDate: null }, { expiryDate: { gte: this.today } }] } : {}),
        },
        _sum: { qtyOnHand: true },
      });
      available = Decimal.min(available, dec(lots._sum.qtyOnHand?.toString() ?? 0).minus(bal.qtyReserved));
    }
    if (input.qty.gt(available)) {
      throw insufficient(`${v.sku}: only ${Decimal.max(available, ZERO).toFixed(3)} available`, {
        variantId: v.id,
        sku: v.sku,
        requested: input.qty.toFixed(3),
        available: Decimal.max(available, ZERO).toFixed(3),
      });
    }
    bal.qtyReserved = bal.qtyReserved.plus(input.qty);
    await this.writeBalance(bal);
  }

  /** Gives reserved quantity back to the pool (order cancelled or expired, or about to be issued). */
  async release(input: { variantId: string; locationId: string; qty: Decimal }): Promise<void> {
    const bal = this.balance(input.variantId, input.locationId);
    bal.qtyReserved = Decimal.max(bal.qtyReserved.minus(input.qty), ZERO);
    await this.writeBalance(bal);
  }

  /** Stock out valued at the moving average. */
  async issue(input: IssueInput): Promise<IssueResult> {
    if (input.qty.lte(ZERO)) throw invalid('Issued quantity must be positive');
    const v = this.variant(input.variantId);
    const bal = this.balance(input.variantId, input.locationId);
    const allowNegative = Boolean(input.allowNegative) && !v.isBatchTracked;
    const reserved = input.respectReservations === false ? ZERO : bal.qtyReserved;
    const available = bal.qtyOnHand.minus(reserved);
    if (!v.isBatchTracked && input.qty.gt(available) && !allowNegative) {
      throw insufficient(`${v.sku}: only ${Decimal.max(available, ZERO).toFixed(3)} available`, {
        variantId: v.id,
        sku: v.sku,
        requested: input.qty.toFixed(3),
        available: available.toFixed(3),
      });
    }
    if (v.isBatchTracked && input.qty.gt(available)) {
      throw insufficient(`${v.sku}: only ${Decimal.max(available, ZERO).toFixed(3)} available`, {
        variantId: v.id,
        sku: v.sku,
        requested: input.qty.toFixed(3),
        available: available.toFixed(3),
      });
    }

    // Cost: issuing exactly everything releases exactly the remaining value (no rounding residue).
    const totalCost = input.qty.equals(v.stockQty) ? v.stockValue : roundMoney(input.qty.times(v.avgCost));

    const parts = v.isBatchTracked
      ? await this.allocateBatches(v, input.locationId, input.qty, input.lotNumber, input.expired ?? 'block')
      : [{ id: null, lotNumber: null, qty: input.qty }];

    v.stockQty = v.stockQty.minus(input.qty);
    v.stockValue = v.stockValue.minus(totalCost);
    if (v.stockQty.isZero()) v.stockValue = ZERO;
    await this.writeVariant(v);

    const movements: MovementResult[] = [];
    let costLeft = totalCost;
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      const partCost = last ? costLeft : roundMoney(part.qty.times(v.avgCost));
      costLeft = costLeft.minus(partCost);
      bal.qtyOnHand = bal.qtyOnHand.minus(part.qty);
      if (part.id) {
        await this.tx.inventoryBatch.update({
          where: { id: part.id },
          data: { qtyOnHand: { decrement: new Prisma.Decimal(part.qty.toFixed(3)) } },
        });
      }
      const movementId = await this.createMovement({
        variant: v,
        locationId: input.locationId,
        batchId: part.id,
        type: input.type,
        qtyChange: part.qty.negated(),
        unitCost: v.avgCost,
        totalCost: partCost.negated(),
        qtyAfter: bal.qtyOnHand,
        source: input.source,
        note: input.note,
      });
      movements.push({ movementId, batchId: part.id, lotNumber: part.lotNumber, qtyChange: part.qty.negated(), totalCost: partCost.negated() });
    }
    await this.writeBalance(bal);

    return { movements, qty: input.qty, totalCost, unitCost: roundCost(totalCost.dividedBy(input.qty)) };
  }

  /**
   * Moves quantity out of a location without changing company-wide qty or value (stock is in transit).
   * Returns the lots taken so the same lots can be recreated at the destination.
   */
  async transferOut(input: Omit<IssueInput, 'allowNegative'>): Promise<{ lotNumber: string | null; expiryDate: string | null; mfgDate: string | null; qty: Decimal }[]> {
    const v = this.variant(input.variantId);
    const bal = this.balance(input.variantId, input.locationId);
    const available = bal.qtyOnHand.minus(bal.qtyReserved);
    if (input.qty.gt(available)) {
      throw insufficient(`${v.sku}: only ${Decimal.max(available, ZERO).toFixed(3)} available to transfer`, {
        variantId: v.id,
        sku: v.sku,
        requested: input.qty.toFixed(3),
        available: available.toFixed(3),
      });
    }
    const parts = v.isBatchTracked
      ? await this.allocateBatches(v, input.locationId, input.qty, input.lotNumber, input.expired ?? 'block')
      : [{ id: null as string | null, lotNumber: null as string | null, qty: input.qty }];

    const taken: { lotNumber: string | null; expiryDate: string | null; mfgDate: string | null; qty: Decimal }[] = [];
    for (const part of parts) {
      bal.qtyOnHand = bal.qtyOnHand.minus(part.qty);
      let expiryDate: string | null = null;
      let mfgDate: string | null = null;
      if (part.id) {
        const b = await this.tx.inventoryBatch.update({
          where: { id: part.id },
          data: { qtyOnHand: { decrement: new Prisma.Decimal(part.qty.toFixed(3)) } },
        });
        expiryDate = b.expiryDate ? isoDate(b.expiryDate) : null;
        mfgDate = b.mfgDate ? isoDate(b.mfgDate) : null;
      }
      await this.createMovement({
        variant: v,
        locationId: input.locationId,
        batchId: part.id,
        type: 'TRANSFER_OUT',
        qtyChange: part.qty.negated(),
        unitCost: v.avgCost,
        totalCost: roundMoney(part.qty.times(v.avgCost)).negated(),
        qtyAfter: bal.qtyOnHand,
        source: input.source,
        note: input.note,
      });
      taken.push({ lotNumber: part.lotNumber, expiryDate, mfgDate, qty: part.qty });
    }
    await this.writeBalance(bal);
    return taken;
  }

  /** Puts transferred quantity into the destination, recreating its lots. Company qty/value unchanged. */
  async transferIn(input: {
    variantId: string;
    locationId: string;
    parts: { lotNumber: string | null; expiryDate: string | null; mfgDate: string | null; qty: Decimal }[];
    source: MovementSource;
    note?: string | undefined;
  }) {
    const v = this.variant(input.variantId);
    const bal = this.balance(input.variantId, input.locationId);
    for (const part of input.parts) {
      const batch = part.lotNumber
        ? await this.inboundBatch(
            v,
            input.locationId,
            {
              lotNumber: part.lotNumber,
              expiryDate: part.expiryDate ? new Date(`${part.expiryDate}T00:00:00Z`) : undefined,
              mfgDate: part.mfgDate ? new Date(`${part.mfgDate}T00:00:00Z`) : undefined,
            },
            part.qty,
          )
        : null;
      bal.qtyOnHand = bal.qtyOnHand.plus(part.qty);
      await this.createMovement({
        variant: v,
        locationId: input.locationId,
        batchId: batch?.id ?? null,
        type: 'TRANSFER_IN',
        qtyChange: part.qty,
        unitCost: v.avgCost,
        totalCost: roundMoney(part.qty.times(v.avgCost)),
        qtyAfter: bal.qtyOnHand,
        source: input.source,
        note: input.note,
      });
    }
    await this.writeBalance(bal);
  }
}

/**
 * Locks everything a stock operation will touch and returns a session to perform it.
 * Must be called inside a transaction; locks are held until it commits or rolls back.
 */
export async function openStockSession(tx: Tx, keys: StockKey[], actorId: string, now = new Date()): Promise<StockSession> {
  const variantIds = [...new Set(keys.map((k) => k.variantId))].sort();
  const pairs = [...new Map(keys.map((k) => [keyOf(k.variantId, k.locationId), k])).values()].sort(
    (a, b) => a.variantId.localeCompare(b.variantId) || a.locationId.localeCompare(b.locationId),
  );
  if (variantIds.length === 0) throw invalid('Nothing to process');

  const lockedVariants = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "product_variants" WHERE "id" = ANY(${variantIds}::uuid[]) ORDER BY "id" FOR UPDATE`;
  if (lockedVariants.length !== variantIds.length) throw invalid('One or more products do not exist');

  const vIds = pairs.map((p) => p.variantId);
  const lIds = pairs.map((p) => p.locationId);
  await tx.$executeRaw`
    INSERT INTO "inventory_balances" ("id", "variant_id", "location_id", "qty_on_hand", "qty_reserved", "updated_at")
    SELECT gen_random_uuid(), t.v, t.l, 0, 0, now() FROM unnest(${vIds}::uuid[], ${lIds}::uuid[]) AS t(v, l)
    ON CONFLICT ("variant_id", "location_id") DO NOTHING`;
  const balanceRows = await tx.$queryRaw<{ id: string; variant_id: string; location_id: string; qty_on_hand: string; qty_reserved: string }[]>`
    SELECT b."id", b."variant_id", b."location_id", b."qty_on_hand"::text, b."qty_reserved"::text
    FROM "inventory_balances" b
    JOIN unnest(${vIds}::uuid[], ${lIds}::uuid[]) AS t(v, l) ON b."variant_id" = t.v AND b."location_id" = t.l
    ORDER BY b."variant_id", b."location_id"
    FOR UPDATE OF b`;

  const variantRows = await tx.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: {
      id: true,
      sku: true,
      name: true,
      stockQty: true,
      stockValue: true,
      avgCost: true,
      product: { select: { name: true, isBatchTracked: true, isExpiryTracked: true } },
    },
  });

  const variants = new Map<string, VariantState>(
    variantRows.map((v) => [
      v.id,
      {
        id: v.id,
        sku: v.sku,
        name: v.name,
        productName: v.product.name,
        isBatchTracked: v.product.isBatchTracked,
        isExpiryTracked: v.product.isExpiryTracked,
        stockQty: dec(v.stockQty.toString()),
        stockValue: dec(v.stockValue.toString()),
        avgCost: dec(v.avgCost.toString()),
      },
    ]),
  );
  const balances = new Map<string, BalanceState>(
    balanceRows.map((b) => [
      keyOf(b.variant_id, b.location_id),
      { id: b.id, qtyOnHand: dec(b.qty_on_hand), qtyReserved: dec(b.qty_reserved) },
    ]),
  );
  return new StockSession(tx, actorId, variants, balances, now);
}
