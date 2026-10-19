import type { z } from 'zod';
import {
  dec,
  Decimal,
  priceSale,
  sum,
  ZERO,
  type CartProblem,
  type CartQuote,
  type cartItemsSchema,
  type ShippingMethodRow,
} from '@rhoyards/shared';
import { AppError } from '../../lib/errors';
import type { Db } from '../../lib/prisma';
import { fileUrl } from '../files/files.service';
import { getSettings } from '../settings/settings.service';
import { fulfilmentLocation } from './catalog.service';

/**
 * Prices a cart the same way at quote and at checkout: the client sends only variant ids and quantities, and every
 * price, VAT amount and delivery fee comes from the database here. Delivery is a VAT-able line at the standard rate,
 * charged in the store's pricing mode like the products.
 */

type Items = z.infer<typeof cartItemsSchema>;

export const toShippingRow = (m: {
  id: string;
  name: string;
  description: string | null;
  fee: { toFixed(dp: number): string };
  freeOver: { toFixed(dp: number): string } | null;
  states: string[];
  isPickup: boolean;
  isActive: boolean;
  sortOrder: number;
}): ShippingMethodRow => ({
  id: m.id,
  name: m.name,
  description: m.description,
  fee: m.fee.toFixed(2),
  freeOver: m.freeOver?.toFixed(2) ?? null,
  states: m.states,
  isPickup: m.isPickup,
  isActive: m.isActive,
  sortOrder: m.sortOrder,
});

export async function priceCart(db: Db, rawItems: Items, opts: { shippingMethodId?: string | undefined; state?: string | undefined }) {
  // The same variant twice is one line.
  const merged = new Map<string, Decimal>();
  for (const i of rawItems) merged.set(i.variantId, (merged.get(i.variantId) ?? ZERO).plus(i.qty));
  const items = [...merged.entries()].map(([variantId, qty]) => ({ variantId, qty }));

  const [settings, location] = await Promise.all([getSettings(db), fulfilmentLocation(db)]);
  const [variants, methods, standardVat] = await Promise.all([
    db.productVariant.findMany({
      where: { id: { in: items.map((i) => i.variantId) } },
      include: {
        product: { include: { taxRate: true, unit: true, images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
        balances: { where: { locationId: location.id } },
      },
    }),
    db.shippingMethod.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    db.taxRate.findFirst({ where: { kind: 'STANDARD', isActive: true }, orderBy: { createdAt: 'asc' } }),
  ]);
  const byId = new Map(variants.map((v) => [v.id, v]));
  const vat = (rate: { toString(): string } | undefined) => (settings.business.vatRegistered && rate ? dec(rate.toString()) : ZERO);

  const lines = items.map((item, i) => {
    const v = byId.get(item.variantId);
    const visible = v && v.status === 'ACTIVE' && !v.archivedAt && v.product.status === 'ACTIVE' && v.product.onlineVisible && !v.product.archivedAt;
    if (v && !v.product.unit.allowsFraction && !item.qty.isInteger()) {
      throw new AppError(400, 'VALIDATION_ERROR', `${v.product.name}: order whole units`, { line: i + 1, field: 'qty' });
    }
    const b = v?.balances[0];
    const available = visible && b ? Decimal.max(dec(b.qtyOnHand.toString()).minus(b.qtyReserved.toString()), ZERO) : ZERO;
    const problem: CartProblem | null = !visible ? 'UNAVAILABLE' : available.isZero() ? 'OUT_OF_STOCK' : item.qty.gt(available) ? 'INSUFFICIENT' : null;
    return { item, variant: v, visible: Boolean(visible), available, problem, taxRate: v ? vat(v.product.taxRate.rate) : ZERO };
  });

  // Items first, to know the items total that decides free delivery.
  const itemsPricing = priceSale(
    lines.map((l) => ({ qty: l.item.qty, unitPrice: l.variant ? l.variant.sellingPrice.toString() : '0', taxRate: l.taxRate })),
    settings.pricing.pricesIncludeTax,
  );
  const itemsTotal = itemsPricing.total;

  const serves = (m: { states: string[]; isPickup: boolean }) => m.isPickup || !opts.state || m.states.length === 0 || m.states.includes(opts.state);
  const feeFor = (m: (typeof methods)[number]) => (m.freeOver && itemsTotal.gte(m.freeOver.toString()) ? ZERO : dec(m.fee.toString()));
  const options = methods.filter(serves).map((m) => ({ ...toShippingRow(m), feeForCart: feeFor(m).toFixed(2) }));
  const chosen = opts.shippingMethodId ? methods.find((m) => m.id === opts.shippingMethodId && serves(m)) : undefined;
  const shippingFee = chosen ? feeFor(chosen) : ZERO;

  const pricing = priceSale(
    [
      ...lines.map((l) => ({ qty: l.item.qty, unitPrice: l.variant ? l.variant.sellingPrice.toString() : '0', taxRate: l.taxRate })),
      ...(chosen ? [{ qty: '1', unitPrice: shippingFee, taxRate: vat(standardVat?.rate) }] : []),
    ],
    settings.pricing.pricesIncludeTax,
  );
  const shippingLine = chosen ? pricing.lines.at(-1)! : null;

  const quote: CartQuote = {
    lines: lines.map((l, i) => {
      const p = pricing.lines[i]!;
      return {
        variantId: l.item.variantId,
        sku: l.variant?.sku ?? '',
        name: l.variant?.name ?? 'No longer available',
        productName: l.variant?.product.name ?? '',
        slug: l.visible ? l.variant!.product.slug : null,
        imageUrl: l.variant?.product.images[0] ? fileUrl(l.variant.product.images[0].fileId) : null,
        qty: l.item.qty.toFixed(3),
        unitPrice: l.variant?.sellingPrice.toFixed(2) ?? '0.00',
        net: p.net.toFixed(2),
        tax: p.tax.toFixed(2),
        total: p.total.toFixed(2),
        available: l.available.toFixed(3),
        problem: l.problem,
      };
    }),
    itemsTotal: itemsTotal.toFixed(2),
    shipping: chosen ? { methodId: chosen.id, name: chosen.name, fee: shippingFee.toFixed(2), isPickup: chosen.isPickup } : null,
    shippingOptions: options,
    subtotal: pricing.subtotal.toFixed(2),
    taxTotal: pricing.taxTotal.toFixed(2),
    total: pricing.total.toFixed(2),
    pricesIncludeTax: settings.pricing.pricesIncludeTax,
    ok: lines.every((l) => !l.problem) && Boolean(chosen),
  };

  return {
    quote,
    settings,
    location,
    chosen: chosen ?? null,
    shipping: shippingLine ? { fee: shippingFee, net: shippingLine.net, tax: shippingLine.tax } : { fee: ZERO, net: ZERO, tax: ZERO },
    lines: lines.map((l, i) => ({ ...l, priced: pricing.lines[i]! })),
    itemsNet: sum(lines.map((_, i) => pricing.lines[i]!.net)),
    pricing,
  };
}
